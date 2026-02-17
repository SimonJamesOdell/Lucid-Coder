import {
  extractFirstJsonObject,
  extractUnreleasedEntries,
  incrementPatch,
  parseChangelogEntryJson,
  parseSemver,
  rollChangelogToVersion
} from './commitsApi/changelogUtils.js';

export const createBranchWorkflowCommits = (core) => {
  const {
    withStatusCode,
    ensureMainBranch,
    getProjectContext,
    runProjectGit,
    llmClient,
    normalizeCommitLimit,
    parseGitLog,
    getBranchByName,
    cancelScheduledAutoTests,
    isCssOnlyBranchDiff,
    listBranchChangedPaths,
    resolveProjectGitSettings,
    ensureGitBranchExists,
    checkoutGitBranch,
    run,
    get,
    setCurrentBranch
  } = core;

  const fs = core.fs;
  const path = core.path;

  const readJsonFile = async (absolutePath) => {
    const raw = await fs.readFile(absolutePath, 'utf8');
    return JSON.parse(raw);
  };

  const writeJsonFile = async (absolutePath, value) => {
    let prev = null;
    try {
      prev = await fs.readFile(absolutePath, 'utf8');
    } catch {
      /* c8 ignore next */
      prev = null;
    }
    const eol = typeof prev === 'string' && prev.includes('\r\n') ? '\r\n' : '\n';
    const next = JSON.stringify(value, null, 2) + '\n';
    await fs.writeFile(absolutePath, next.replace(/\n/g, eol), 'utf8');
  };

  const updatePackageVersionIfPresent = async (absolutePath, newVersion) => {
    try {
      const pkg = await readJsonFile(absolutePath);
      await writeJsonFile(absolutePath, { ...pkg, version: newVersion });
      return true;
    } catch {
      return false;
    }
  };

  const safeGitStdout = async (context, args, fallback = '') => {
    try {
      const result = await runProjectGit(context, args);
      return typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout || '');
    } catch {
      return fallback;
    }
  };


  const buildChangelogEntryFromBranchChanges = async (context, branch) => {
    const branchName = String(branch?.name || '').trim();
    if (!context?.gitReady || !branchName) {
      return null;
    }

    if (!llmClient || typeof llmClient.generateResponse !== 'function') {
      return null;
    }

    // Summarize *committed* changes on the branch compared to main.
    const commitSubjectsText = await safeGitStdout(
      context,
      ['log', '--no-merges', '--pretty=format:%s', `main..${branchName}`],
      ''
    );
    const commitSubjects = commitSubjectsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);

    const fileStatusText = await safeGitStdout(context, ['diff', '--name-status', `main..${branchName}`], '');
    const fileStatuses = fileStatusText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 40);

    const assistantHint = String(branch?.description || '').replace(/\s+/g, ' ').trim();

    const systemMessage = {
      role: 'system',
      content:
        'You write release notes for a software project. ' +
        'Return ONLY valid JSON with one key: {"entry":"..."}. No other keys, no markdown, no prose. ' +
        'The entry must be ONE changelog bullet describing what changed (do NOT include a leading "-"). ' +
        'Plain English, past tense, user-facing when possible. Max 140 chars. ' +
        'Do not mention commit subjects, filenames, branch names, rules, tests, or version numbers.'
    };

    const userMessage = {
      role: 'user',
      content:
        `Branch description (hint): ${assistantHint || '(none)'}\n` +
        `Commit subjects (${commitSubjects.length}):\n` +
        (commitSubjects.length ? commitSubjects.map((s) => `- ${s}`).join('\n') : '(none)') +
        `\n\nChanged files (${fileStatuses.length}):\n` +
        (fileStatuses.length ? fileStatuses.join('\n') : '(none)')
    };

    const callOptions = {
      max_tokens: 120,
      temperature: 0,
      __lucidcoderDisableToolBridge: true,
      __lucidcoderPhase: 'changelog',
      __lucidcoderRequestType: 'changelog_entry'
    };

    try {
      const raw = await llmClient.generateResponse([systemMessage, userMessage], callOptions);
      const parsed = parseChangelogEntryJson(raw);
      if (parsed) {
        return parsed;
      }

      // One repair attempt: re-emit ONLY the expected JSON.
      const repairSystem = {
        role: 'system',
        content:
          'Your previous response was not valid for the required schema. ' +
          'Return ONLY valid JSON of the exact form {"entry":"..."}. No prose, no markdown, no extra keys.'
      };
      const assistantDraft = { role: 'assistant', content: typeof raw === 'string' ? raw : String(raw || '') };
      const repairUser = {
        role: 'user',
        content:
          'Rewrite as a single JSON object with key "entry" containing one concise changelog bullet (no leading "-").'
      };

      const repaired = await llmClient.generateResponse(
        [systemMessage, userMessage, repairSystem, assistantDraft, repairUser],
        { ...callOptions, __lucidcoderRequestType: 'changelog_entry_repair' }
      );

      return parseChangelogEntryJson(repaired);
    } catch (error) {
      console.warn(`[BranchWorkflow] Failed to generate changelog entry via LLM: ${error?.message || error}`);
      return null;
    }
  };

  const ensureChangelogUnreleasedEntry = async (projectPath, entryText) => {
    const basePath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!basePath) {
      return { updated: false };
    }

    const cleaned = String(entryText || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return { updated: false };
    }

    const changelogPath = path.join(basePath, 'CHANGELOG.md');
    const bulletLine = `- ${cleaned}`;

    const existing = await fs.readFile(changelogPath, 'utf8').catch(() => null);
    if (typeof existing !== 'string') {
      const fresh = `# Changelog\n\n## Unreleased\n\n${bulletLine}\n`;
      await fs.writeFile(changelogPath, fresh, 'utf8');
      return { updated: true };
    }

    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const normalized = existing.replace(/\r\n/g, '\n');

    if (
      normalized.includes(`\n${bulletLine}\n`) ||
      normalized.startsWith(`${bulletLine}\n`) ||
      normalized.endsWith(`\n${bulletLine}`) ||
      normalized === bulletLine
    ) {
      return { updated: false };
    }

    let next = normalized;
    const unreleasedHeadingRe = /^##\s+Unreleased\s*$/im;
    const match = unreleasedHeadingRe.exec(next);

    if (!match) {
      const changelogTitleRe = /^#\s+Changelog\s*$/im;
      const titleMatch = changelogTitleRe.exec(next);
      if (titleMatch) {
        const insertPos = titleMatch.index + titleMatch[0].length;
        next = `${next.slice(0, insertPos)}\n\n## Unreleased\n\n${bulletLine}\n${next.slice(insertPos).replace(/^\n+/, '\n')}`;
      } else {
        next = `# Changelog\n\n## Unreleased\n\n${bulletLine}\n\n${next.replace(/^\n+/, '')}`;
      }
    } else {
      let insertPos = match.index + match[0].length;
      while (next[insertPos] === '\n') {
        insertPos += 1;
      }

      if (next[insertPos] !== '-') {
        next = `${next.slice(0, insertPos)}\n${bulletLine}\n${next.slice(insertPos)}`;
      } else {
        next = `${next.slice(0, insertPos)}${bulletLine}\n${next.slice(insertPos)}`;
      }
    }

    if (!next.endsWith('\n')) {
      next += '\n';
    }

    const finalText = eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next;
    const updated = finalText !== existing;
    if (updated) {
      await fs.writeFile(changelogPath, finalText, 'utf8');
    }
    return { updated };
  };

  const preMergeBumpVersionAndChangelog = async (context, branch, { changelogTracked }) => {
    if (!context?.gitReady || !context.projectPath) {
      return null;
    }

    const stat = await fs.stat(context.projectPath).catch(() => null);
    if (!stat) {
      return null;
    }

    const versionPath = path.join(context.projectPath, 'VERSION');
    const changelogPath = path.join(context.projectPath, 'CHANGELOG.md');
    const frontendPkgPath = path.join(context.projectPath, 'frontend', 'package.json');
    const backendPkgPath = path.join(context.projectPath, 'backend', 'package.json');

    const currentVersionRaw = await fs.readFile(versionPath, 'utf8').catch(() => '0.1.0\n');
    const currentVersion = String(currentVersionRaw || '').trim() || '0.1.0';
    const nextVersion = incrementPatch(currentVersion) || '0.1.0';

    if (changelogTracked) {
      const description = String(branch?.description || '').replace(/\s+/g, ' ').trim();
      const defaultDescriptions = new Set(['ai generated feature branch', 'auto-generated feature branch']);

      const llmEntry = await buildChangelogEntryFromBranchChanges(context, branch);
      const entryText = llmEntry
        ? llmEntry
        : (description && !defaultDescriptions.has(description.toLowerCase())
          ? description
          : `Changes from ${branch?.name || 'feature branch'}`);

      await ensureChangelogUnreleasedEntry(context.projectPath, entryText).catch(() => ({ updated: false }));

      const changelogText = await fs.readFile(changelogPath, 'utf8').catch(() => null);
      if (typeof changelogText === 'string') {
        const rolled = rollChangelogToVersion(changelogText, nextVersion);
        await fs.writeFile(changelogPath, rolled, 'utf8');
      }
    }

    await fs.writeFile(versionPath, `${nextVersion}\n`, 'utf8');
    await updatePackageVersionIfPresent(frontendPkgPath, nextVersion);
    await updatePackageVersionIfPresent(backendPkgPath, nextVersion);

    const addPaths = ['VERSION'];
    if (changelogTracked && await fs.stat(changelogPath).catch(() => null)) {
      addPaths.push('CHANGELOG.md');
    }
    if (await fs.stat(frontendPkgPath).catch(() => null)) {
      addPaths.push('frontend/package.json');
    }
    if (await fs.stat(backendPkgPath).catch(() => null)) {
      addPaths.push('backend/package.json');
    }

    await runProjectGit(context, ['add', ...addPaths]);
    await runProjectGit(context, ['commit', '-m', `chore: bump version to ${nextVersion}`]);

    return { previous: currentVersion, next: nextVersion };
  };

  const enforceChangelogForMerge = async (context, branchName) => {
    if (!context?.gitReady) {
      return;
    }

    // Only enforce when the project actually has a changelog tracked in git.
    // (Older projects/tests may not have one yet.)
    try {
      const probe = await runProjectGit(context, ['show', `${branchName}:CHANGELOG.md`]);
      const probed = typeof probe?.stdout === 'string' ? probe.stdout : String(probe?.stdout || '');
      if (!probed.trim()) {
        return;
      }
    } catch {
      return;
    }

    let shouldEnforceVersion = true;
    try {
      const probe = await runProjectGit(context, ['show', `${branchName}:VERSION`]);
      const probed = typeof probe?.stdout === 'string' ? probe.stdout : String(probe?.stdout || '');
      if (!probed.trim()) {
        shouldEnforceVersion = false;
      }
    } catch {
      shouldEnforceVersion = false;
    }

    const changedPaths = await (typeof listBranchChangedPaths === 'function'
      ? listBranchChangedPaths(context, { branchRef: branchName })
      : Promise.resolve([]));

    const touchedChangelog = changedPaths.some((p) => String(p || '').toLowerCase() === 'changelog.md');
    if (!touchedChangelog) {
      throw withStatusCode(new Error('CHANGELOG.md must be updated before merging'), 400);
    }

    const touchedVersion = changedPaths.some((p) => String(p || '').toLowerCase() === 'version');
    if (shouldEnforceVersion && !touchedVersion) {
      throw withStatusCode(new Error('VERSION must be bumped before merging'), 400);
    }

    const result = await runProjectGit(context, ['show', `${branchName}:CHANGELOG.md`]);
    const changelogText = typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout || '');

    const extracted = extractUnreleasedEntries(changelogText);

    // Accept either:
    // 1) a traditional Unreleased section with entries, OR
    // 2) a rolled changelog where Unreleased is empty but a new version section exists.
    if (extracted.hasHeading && extracted.entries.length) {
      return;
    }

    if (!shouldEnforceVersion) {
      if (!extracted.hasHeading) {
        throw withStatusCode(new Error('CHANGELOG.md must include an "Unreleased" section'), 400);
      }
      throw withStatusCode(new Error('CHANGELOG.md must include at least one entry under Unreleased before merging'), 400);
    }

    const versionResult = await runProjectGit(context, ['show', `${branchName}:VERSION`]);
    const versionText = typeof versionResult?.stdout === 'string' ? versionResult.stdout : String(versionResult?.stdout || '');
    const version = String(versionText || '').trim();
    if (!version) {
      throw withStatusCode(new Error('VERSION must be bumped before merging'), 400);
    }

    const lines = String(changelogText || '').replace(/\r\n/g, '\n').split('\n');
    const headingRe = new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:\\s+\\(|\\s*$)`, 'i');
    const startIndex = lines.findIndex((line) => headingRe.test(line.trim()));
    if (startIndex === -1) {
      throw withStatusCode(new Error(`CHANGELOG.md must include a ${version} section before merging`), 400);
    }

    const entries = [];
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^##\s+/.test(line.trim())) {
        break;
      }
      if (/^[-*]\s+/.test(line.trim())) {
        entries.push(line.trim());
      }
    }

    if (!entries.length) {
      throw withStatusCode(
        new Error(`CHANGELOG.md must include at least one entry under ${version} before merging`),
        400
      );
    }
  };

  const bumpVersionAfterMerge = async (context, branchName) => {
    if (!context?.gitReady || !context.projectPath) {
      return null;
    }

    // If the project isn't on disk (unit tests often use fake paths), skip bumping.
    const stat = await fs.stat(context.projectPath).catch(() => null);
    if (!stat) {
      return null;
    }

    const versionPath = path.join(context.projectPath, 'VERSION');
    const changelogPath = path.join(context.projectPath, 'CHANGELOG.md');
    const frontendPkgPath = path.join(context.projectPath, 'frontend', 'package.json');
    const backendPkgPath = path.join(context.projectPath, 'backend', 'package.json');

    const currentVersionRaw = await fs.readFile(versionPath, 'utf8').catch(() => '0.1.0\n');
    const currentVersion = String(currentVersionRaw || '').trim();
    const nextVersion = incrementPatch(currentVersion) || '0.1.0';

    const changelogText = await fs.readFile(changelogPath, 'utf8').catch(() => null);
    if (typeof changelogText !== 'string') {
      return null;
    }

    // Roll Unreleased entries into the new version section.
    const updatedChangelog = rollChangelogToVersion(changelogText, nextVersion);
    await fs.writeFile(changelogPath, updatedChangelog, 'utf8');

    // Update VERSION + package.json versions.
    await fs.writeFile(versionPath, `${nextVersion}\n`, 'utf8');
    await updatePackageVersionIfPresent(frontendPkgPath, nextVersion);
    await updatePackageVersionIfPresent(backendPkgPath, nextVersion);

    const addPaths = ['CHANGELOG.md', 'VERSION'];
    if (await fs.stat(frontendPkgPath).catch(() => null)) {
      addPaths.push('frontend/package.json');
    }
    if (await fs.stat(backendPkgPath).catch(() => null)) {
      addPaths.push('backend/package.json');
    }

    try {
      await runProjectGit(context, ['add', ...addPaths]);

      const stagedResult = await runProjectGit(context, ['diff', '--cached', '--name-only', '--', ...addPaths]);
      const stagedText = String(stagedResult?.stdout || '');
      const hasStagedChanges = stagedText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some(Boolean);

      if (!hasStagedChanges) {
        return null;
      }

      await runProjectGit(context, ['commit', '-m', `chore: bump version to ${nextVersion}`]);
    } catch (error) {
      const message = String(error?.message || '');
      if (/nothing to commit|no changes added to commit/i.test(message)) {
        return null;
      }
      throw withStatusCode(new Error(`Failed to bump version after merge: ${error.message}`), 500);
    }

    return { previous: currentVersion, next: nextVersion, bumpedFromBranch: branchName };
  };

  const resolveGitSha = async (context, sha, label) => {
    /* c8 ignore next */
    const input = typeof sha === 'string' ? sha.trim() : '';
    /* c8 ignore next */
    if (!input) {
      throw withStatusCode(new Error(`${label} is required`), 400);
    }
    try {
      const result = await runProjectGit(context, ['rev-parse', input]);
      /* c8 ignore next */
      const resolved = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
      if (!resolved) {
        throw new Error('empty sha');
      }
      return resolved;
    } catch {
      throw withStatusCode(new Error(`${label} is invalid`), 400);
    }
  };

  const ensureCleanWorkingTree = async (context, message) => {
    let porcelain = '';
    try {
      const statusResult = await runProjectGit(context, ['status', '--porcelain', '--untracked-files=no']);
      /* c8 ignore next */
      porcelain = typeof statusResult?.stdout === 'string' ? statusResult.stdout.trim() : '';
    } catch {
      throw withStatusCode(new Error('Unable to verify git working tree status'), 500);
    }

    if (porcelain) {
      throw withStatusCode(new Error(message), 400);
    }
  };

  const ensureNoUntrackedMergeConflicts = async (context, branchName) => {
    try {
      const [untrackedResult, branchDiffResult] = await Promise.all([
        runProjectGit(context, ['status', '--porcelain', '--untracked-files=all']),
        runProjectGit(context, ['diff', '--name-only', `main..${branchName}`])
      ]);

      const untrackedPaths = String(untrackedResult?.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('?? '))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);

      if (untrackedPaths.length === 0) {
        return;
      }

      const branchPaths = new Set(
        String(branchDiffResult?.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      );

      const conflicting = untrackedPaths.filter((filePath) => branchPaths.has(filePath));
      if (conflicting.length === 0) {
        return;
      }

      const preview = conflicting.slice(0, 3).join(', ');
      const suffix = conflicting.length > 3 ? ' …' : '';
      throw withStatusCode(
        new Error(`Untracked files would be overwritten by merge: ${preview}${suffix}`),
        409
      );
    } catch (error) {
      if (error?.statusCode) {
        throw error;
      }
      throw withStatusCode(new Error('Unable to verify untracked merge conflicts'), 500);
    }
  };

  const buildCommitFilesArgs = (sha) => [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-status',
    '-r',
    sha
  ];

  const getCommitHistory = async (projectId, options = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!context.gitReady) {
      return [];
    }

    const limit = normalizeCommitLimit(options.limit);

    try {
      const { stdout } = await runProjectGit(context, [
        'log',
        `-${limit}`,
        '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e',
        '--date=iso'
      ]);
      return parseGitLog(stdout);
    } catch (error) {
      console.warn(`[CommitHistory] Failed to read commits for project ${projectId}: ${error.message}`);
      return [];
    }
  };

  const getCommitDetails = async (projectId, commitSha) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!context.gitReady) {
      throw withStatusCode(new Error('Git repository unavailable for this project'), 400);
    }

    const normalizedSha = typeof commitSha === 'string' ? commitSha.trim() : '';
    if (!normalizedSha) {
      throw withStatusCode(new Error('commitSha is required'), 400);
    }

    try {
      const metaResult = await runProjectGit(context, [
        'show',
        normalizedSha,
        '--quiet',
        '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1f%b',
        '--date=iso'
      ]);
      const [sha, authorName, authorEmail, authoredAt, subject, parents = '', body] = (metaResult.stdout || '').split('\x1f');
      const parentShas = parents
        .split(' ')
        .map((value) => value.trim())
        .filter(Boolean);
      const parentCount = parentShas.length;

      const filesResult = await runProjectGit(context, buildCommitFilesArgs(normalizedSha));
      const files = filesResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...pathParts] = line.split(/\s+/);
          return {
            path: pathParts.join(' '),
            status: status || 'M'
          };
        });

      return {
        sha,
        shortSha: sha?.slice(0, 7) || '',
        message: subject || '',
        body: (body || '').trim(),
        author: {
          name: authorName || 'Unknown',
          email: authorEmail || ''
        },
        authoredAt,
        parentShas,
        parentCount,
        canRevert: parentCount > 0,
        isInitialCommit: parentCount === 0,
        files
      };
    } catch (error) {
      console.warn(`[CommitHistory] Failed to load commit ${normalizedSha}: ${error.message}`);
      throw withStatusCode(new Error('Failed to load commit details'), 500);
    }
  };

  const getCommitFileDiffContent = async (projectId, commitSha, filePath) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!context.gitReady) {
      throw withStatusCode(new Error('Git repository unavailable for this project'), 400);
    }

    const normalizedSha = typeof commitSha === 'string' ? commitSha.trim() : '';
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';

    if (!normalizedSha) {
      throw withStatusCode(new Error('commitSha is required'), 400);
    }

    if (!normalizedPath) {
      throw withStatusCode(new Error('filePath is required'), 400);
    }

    // Determine parent sha (use first parent for merges).
    let parentSha = '';
    try {
      const parentsResult = await runProjectGit(context, [
        'show',
        normalizedSha,
        '--quiet',
        '--pretty=format:%P'
      ]);
      parentSha = (parentsResult.stdout || '').trim().split(/\s+/).filter(Boolean)[0] || '';
    } catch (error) {
      parentSha = '';
    }

    const safeShow = async (ref) => {
      try {
        const result = await runProjectGit(context, ['show', `${ref}:${normalizedPath}`]);
        return typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
      } catch (error) {
        return '';
      }
    };

    const [original, modified] = await Promise.all([
      parentSha ? safeShow(parentSha) : Promise.resolve(''),
      safeShow(normalizedSha)
    ]);

    return {
      path: normalizedPath,
      original,
      modified,
      originalLabel: parentSha ? parentSha.slice(0, 7) : 'Empty',
      modifiedLabel: normalizedSha.slice(0, 7)
    };
  };

  const revertCommit = async (projectId, commitSha) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!context.gitReady) {
      throw withStatusCode(new Error('Git repository unavailable for this project'), 400);
    }

    const normalizedSha = typeof commitSha === 'string' ? commitSha.trim() : '';
    if (!normalizedSha) {
      throw withStatusCode(new Error('commitSha is required'), 400);
    }

    try {
      await runProjectGit(context, ['revert', '--no-edit', normalizedSha]);
    } catch (error) {
      console.warn(`[CommitHistory] Failed to revert commit ${normalizedSha}: ${error.message}`);
      throw withStatusCode(new Error(`Failed to revert commit: ${error.message}`), 500);
    }

    return { reverted: normalizedSha };
  };

  const squashCommits = async (projectId, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!context.gitReady) {
      throw withStatusCode(new Error('Git repository unavailable for this project'), 400);
    }

    const olderSha = typeof payload?.olderSha === 'string' ? payload.olderSha.trim() : '';
    const newerSha = typeof payload?.newerSha === 'string' ? payload.newerSha.trim() : '';
    if (!olderSha || !newerSha) {
      throw withStatusCode(new Error('olderSha and newerSha are required'), 400);
    }

    await ensureCleanWorkingTree(context, 'Working tree must be clean before squashing commits');

    // Force operations onto main to match the commits UI and avoid rewriting unexpected branches.
    try {
      await ensureGitBranchExists(context, 'main');
      await runProjectGit(context, ['checkout', 'main']);
    } catch (error) {
      throw withStatusCode(new Error(`Unable to checkout main: ${error.message}`), 500);
    }

    const resolvedHead = await resolveGitSha(context, 'HEAD', 'HEAD');
    const resolvedNewer = await resolveGitSha(context, newerSha, 'newerSha');
    const resolvedOlder = await resolveGitSha(context, olderSha, 'olderSha');

    if (resolvedNewer === resolvedOlder) {
      throw withStatusCode(new Error('Cannot squash the same commit twice'), 400);
    }

    // MVP guardrail: only allow squashing the latest two commits on main.
    if (resolvedNewer !== resolvedHead) {
      throw withStatusCode(new Error('Only the latest commit on main can be squashed (select the top two commits).'), 400);
    }

    let headParents = [];
    try {
      const parentsResult = await runProjectGit(context, ['show', resolvedHead, '--quiet', '--pretty=format:%P']);
      headParents = (parentsResult.stdout || '').trim().split(/\s+/).filter(Boolean);
    } catch {
      headParents = [];
    }

    if (headParents.length !== 1) {
      throw withStatusCode(new Error('Only non-merge commits can be squashed'), 400);
    }

    const resolvedHeadParent = headParents[0];
    if (resolvedHeadParent !== resolvedOlder) {
      throw withStatusCode(new Error('Commits must be adjacent (select two consecutive commits).'), 400);
    }

    /* c8 ignore next */
    const messageDraft = typeof payload.message === 'string' ? payload.message.trim() : '';
    const defaultMessageResult = await runProjectGit(context, ['show', resolvedHead, '--quiet', '--pretty=format:%s']);
    /* c8 ignore next */
    const defaultMessage = typeof defaultMessageResult?.stdout === 'string' ? defaultMessageResult.stdout.trim() : '';
    const finalMessage = messageDraft || defaultMessage || 'Squashed commit';

    // Determine the parent of the older commit (HEAD^^). If it doesn't exist, this is a root squash.
    let baseSha = '';
    try {
      const baseResult = await runProjectGit(context, ['rev-parse', `${resolvedHead}^^`]);
      /* c8 ignore next */
      baseSha = typeof baseResult?.stdout === 'string' ? baseResult.stdout.trim() : '';
    } catch {
      baseSha = '';
    }

    let newSha = '';

    if (baseSha) {
      try {
        await runProjectGit(context, ['reset', '--soft', baseSha]);
        await runProjectGit(context, ['commit', '-m', finalMessage]);
        const newShaResult = await runProjectGit(context, ['rev-parse', 'HEAD']);
        /* c8 ignore next */
        newSha = typeof newShaResult?.stdout === 'string' ? newShaResult.stdout.trim() : '';
      } catch (error) {
        throw withStatusCode(new Error(`Failed to squash commits: ${error.message}`), 500);
      }
    } else {
      // Root squash: create a new root commit with the current tree, then move main to it.
      let treeSha = '';
      try {
        const treeResult = await runProjectGit(context, ['rev-parse', `${resolvedHead}^{tree}`]);
        /* c8 ignore next */
        treeSha = typeof treeResult?.stdout === 'string' ? treeResult.stdout.trim() : '';
      } catch {
        treeSha = '';
      }

      if (!treeSha) {
        // Preserve wrapped error shape for consistent API responses
        throw withStatusCode(new Error('Failed to squash commits: Unable to resolve tree SHA'), 500);
      }

      try {
        const commitTreeResult = await runProjectGit(context, ['commit-tree', treeSha, '-m', finalMessage]);
        /* c8 ignore next */
        newSha = typeof commitTreeResult?.stdout === 'string' ? commitTreeResult.stdout.trim() : '';
        if (!newSha) {
          throw new Error('Unable to create commit');
        }
        await runProjectGit(context, ['update-ref', 'refs/heads/main', newSha]);
        await runProjectGit(context, ['reset', '--hard', newSha]);
      } catch (error) {
        throw withStatusCode(new Error(`Failed to squash commits: ${error.message}`), 500);
      }
    }

    const mainBranch = await ensureMainBranch(projectId);
    await setCurrentBranch(projectId, mainBranch.id);

    return {
      squashed: {
        olderSha: resolvedOlder,
        newerSha: resolvedNewer,
        newSha
      }
    };
  };

  const mergeBranch = async (projectId, branchName) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    const branch = await getBranchByName(projectId, branchName);

    cancelScheduledAutoTests(projectId, branch.name);

    const allowCssOnlyMerge = await isCssOnlyBranchDiff(context, branch.name).catch(() => false);

    if (branch.type === 'main') {
      throw withStatusCode(new Error('Main branch cannot be merged'), 400);
    }

    if (branch.status !== 'ready-for-merge' && !allowCssOnlyMerge) {
      throw withStatusCode(new Error('Branch must pass tests before merging'), 400);
    }

    const latestRun = await get(
      `SELECT status
     FROM test_runs
     WHERE branch_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
      [branch.id]
    );

    if (!allowCssOnlyMerge) {
      if (latestRun) {
        if (latestRun.status !== 'passed') {
          throw withStatusCode(new Error('Latest test run must pass before merging'), 400);
        }
      } else {
        throw withStatusCode(new Error('Latest test run must pass before merging'), 400);
      }
    }

    let enforcementError = null;
    try {
      await enforceChangelogForMerge(context, branch.name);
    } catch (error) {
      enforcementError = error;
    }

    if (context.gitReady) {
      // Require a clean working tree before attempting any merge operations.
      // This keeps merges deterministic and avoids implicitly stashing changes.
      await ensureCleanWorkingTree(context, 'Working tree must be clean before merging');
      await ensureNoUntrackedMergeConflicts(context, branch.name);

      // Auto-bump is only safe when we can reliably inspect changed paths.
      const canAutoBump = typeof listBranchChangedPaths === 'function';

      // Determine whether the branch tracks CHANGELOG.md in git.
      // This intentionally does NOT treat on-disk files as "tracked".
      let changelogTracked = false;
      let changelogProbeFailed = false;
      try {
        const probe = await runProjectGit(context, ['show', `${branch.name}:CHANGELOG.md`]);
        const probed = typeof probe?.stdout === 'string' ? probe.stdout : String(probe?.stdout || '');
        changelogTracked = Boolean(probed.trim());
      } catch {
        changelogTracked = false;
        changelogProbeFailed = true;
      }

      const shouldAutoBumpBeforeMerge = Boolean(
        context.projectPath
        && canAutoBump
        && (
          (enforcementError && enforcementError?.statusCode === 400)
          || changelogProbeFailed
        )
      );

      let preMergeBumpPerformed = false;

      if (shouldAutoBumpBeforeMerge) {
        try {
          await ensureGitBranchExists(context, branch.name);
          await runProjectGit(context, ['checkout', branch.name]);
          await preMergeBumpVersionAndChangelog(context, branch, { changelogTracked });
          preMergeBumpPerformed = true;
        } catch (error) {
          throw withStatusCode(new Error(`Failed to update changelog/version before merge: ${error.message}`), 500);
        } finally {
          await runProjectGit(context, ['checkout', 'main']).catch(() => null);
        }

        if (enforcementError && enforcementError?.statusCode === 400) {
          // Re-validate after bump so merges remain deterministic.
          await enforceChangelogForMerge(context, branch.name);
        }
      } else if (enforcementError) {
        throw enforcementError;
      }

      try {
        const resolveCurrentGitBranch = async () => {
          try {
            const result = await runProjectGit(context, ['rev-parse', '--abbrev-ref', 'HEAD']);
            let name = '';
            if (typeof result?.stdout === 'string') {
              name = result.stdout.trim();
            }
            return name || null;
          } catch {
            return null;
          }
        };

        const currentBranch = await resolveCurrentGitBranch();
        await ensureGitBranchExists(context, branch.name);
        if (currentBranch !== 'main') {
          await runProjectGit(context, ['checkout', 'main']);
        }

        let preMergeSha = '';
        try {
          const preMerge = await runProjectGit(context, ['rev-parse', 'HEAD']);
          preMergeSha = '';
          if (typeof preMerge?.stdout === 'string') {
            preMergeSha = preMerge.stdout.trim();
          }
        } catch {
          preMergeSha = '';
        }

        try {
          await runProjectGit(context, ['merge', '--no-ff', branch.name]);
        } catch (error) {
          await runProjectGit(context, ['merge', '--abort']).catch(() => null);
          throw withStatusCode(
            new Error(`Git merge could not be completed automatically: ${error?.message || 'unknown merge failure'}`),
            409
          );
        }

        if (!preMergeBumpPerformed) {
          try {
            await bumpVersionAfterMerge(context, branch.name);
          } catch (error) {
            if (preMergeSha) {
              await runProjectGit(context, ['reset', '--hard', preMergeSha]).catch(() => null);
            }
            throw error;
          }
        }
      } catch (error) {
        if (error?.statusCode) {
          throw error;
        }

        console.warn(`[BranchWorkflow] Git merge failed for ${branch.name}: ${error.message}`);
        throw withStatusCode(new Error(`Git merge failed: ${error.message}`), 500);
      }

      try {
        const gitSettings = await resolveProjectGitSettings(projectId).catch(() => null);
        const shouldAutoPush = Boolean(
          gitSettings
          && gitSettings.workflow === 'cloud'
          && String(gitSettings.remoteUrl || '').trim()
        );

        if (shouldAutoPush) {
          await runProjectGit(context, ['push', 'origin', 'main']);
        }
      } catch (error) {
        console.warn(`[BranchWorkflow] Git push failed for ${branch.name}: ${error.message}`);
      }
    }

    await run(
      `UPDATE branches
     SET status = 'merged',
         ahead_commits = 0,
         behind_commits = 0,
         staged_files = '[]',
         is_current = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [branch.id]
    );

    // Archive/complete any goals tied to this branch so they don't remain active after merge.
    await run(
      `UPDATE agent_goals
       SET status = 'ready',
           lifecycle_state = 'merged',
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?
         AND branch_name = ?`,
      [projectId, branch.name]
    );

    const mainBranch = await ensureMainBranch(projectId);
    await setCurrentBranch(projectId, mainBranch.id);

    return { mergedBranch: branch.name, current: 'main' };
  };

  return {
    buildCommitFilesArgs,
    getCommitHistory,
    getCommitDetails,
    getCommitFileDiffContent,
    revertCommit,
    squashCommits,
    mergeBranch,
    __testOnly: {
      parseSemver,
      incrementPatch,
      extractUnreleasedEntries,
      rollChangelogToVersion,
      extractFirstJsonObject,
      parseChangelogEntryJson,
      buildChangelogEntryFromBranchChanges,
      ensureChangelogUnreleasedEntry,
      preMergeBumpVersionAndChangelog,
      enforceChangelogForMerge,
      bumpVersionAfterMerge
    }
  };
};
