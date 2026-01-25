export const createBranchWorkflowStaging = (core) => {
  const {
    fs,
    path,
    withStatusCode,
    MAX_FILE_DIFF_CHARS,
    MAX_AGGREGATE_DIFF_CHARS,
    trimDiff,
    ensureProjectExists,
    ensureMainBranch,
    getProjectContext,
    getBranchByName,
    getActiveWorkingBranchRow,
    generateAutoBranchName,
    createWorkingBranch,
    parseStagedFiles,
    serializeBranchRow,
    runProjectGit,
    listGitStagedPaths,
    listGitStagedStatusMap,
    run,
    get,
    scheduleAutoTests,
    checkoutBranch,
    resolveProjectGitSettings,
    buildCommitMessage,
    ensureGitBranchExists,
    checkoutGitBranch,
    commitAllChanges,
    isCssOnlyBranchDiff
  } = core;

  const parseSemver = (version) => {
    const input = typeof version === 'string' ? version.trim() : '';
    const match = input.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) {
      return null;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isFinite)) {
      return null;
    }
    return { major, minor, patch };
  };

  const incrementPatch = (version) => {
    const parsed = parseSemver(version);
    if (!parsed) {
      return null;
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  };

  const extractUnreleasedEntries = (text) => {
    const input = typeof text === 'string' ? text : '';
    const normalized = input.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const headingIndex = lines.findIndex((line) => /^##[ \t]+Unreleased[ \t]*$/i.test(line.trim()));
    if (headingIndex === -1) {
      return { hasHeading: false, entries: [] };
    }
    const entries = [];
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^##\s+/.test(line.trim())) {
        break;
      }
      if (/^[-*]\s+/.test(line.trim())) {
        entries.push(line.trim());
      }
    }
    return { hasHeading: true, entries };
  };

  const rollChangelogToVersion = (text, newVersion) => {
    const input = typeof text === 'string' ? text : '';
    const normalized = input.replace(/\r\n/g, '\n');
    const extracted = extractUnreleasedEntries(normalized);
    if (!extracted.hasHeading || !extracted.entries.length) {
      return input;
    }

    const date = new Date().toISOString().slice(0, 10);
    const injected = `\n\n## ${newVersion} (${date})\n\n${extracted.entries.join('\n')}\n`;

    // Replace Unreleased section contents with an empty section (keep heading).
    const unreleasedBlockRe = /(^##[ \t]+Unreleased[ \t]*$)[\s\S]*?(?=^##[ \t]+|\Z)/im;
    let next = normalized.replace(unreleasedBlockRe, `$1\n`);

    // Insert the new version section right after the Unreleased heading.
    const unreleasedHeadingRe = /^##[ \t]+Unreleased[ \t]*$/im;
    const match = unreleasedHeadingRe.exec(next);
    if (!match) {
      return input;
    }
    const insertAt = match.index + match[0].length;
    next = `${next.slice(0, insertAt)}${injected}${next.slice(insertAt)}`;

    return next;
  };

  const coerceSingleLine = (value) => {
    if (typeof value !== 'string') {
      return '';
    }
    return value
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  const normalizeChangelogBullet = (value) => {
    const singleLine = coerceSingleLine(value);
    if (!singleLine) {
      return '';
    }
    const withoutPrefix = singleLine.replace(/^[-*]\s+/, '').trim();
    const truncated = withoutPrefix.length > 140 ? `${withoutPrefix.slice(0, 137)}...` : withoutPrefix;
    return truncated;
  };

  const ensureChangelogUnreleasedEntry = async (projectPath, entryText) => {
    const basePath = typeof projectPath === 'string' ? projectPath.trim() : '';
    const entry = normalizeChangelogBullet(entryText);
    if (!basePath || !entry) {
      return { updated: false };
    }

    const changelogPath = path.join(basePath, 'CHANGELOG.md');
    const bulletLine = `- ${entry}`;

    let existing = '';
    try {
      existing = await fs.readFile(changelogPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { updated: false };
      }
    }

    if (typeof existing !== 'string' || !existing.trim()) {
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
    const unreleasedHeadingRe = /^##[ \t]+Unreleased[ \t]*$/im;
    const match = unreleasedHeadingRe.exec(next);

    if (!match) {
      const changelogTitleRe = /^#\s+Changelog\s*$/im;
      const titleMatch = changelogTitleRe.exec(next);
      if (titleMatch) {
        const titleLineEnd = next.indexOf('\n', titleMatch.index + titleMatch[0].length);
        const insertPos = titleLineEnd === -1 ? next.length : titleLineEnd;
        const prefix = next.slice(0, insertPos);
        const suffix = next.slice(insertPos);
        next = `${prefix}\n\n## Unreleased\n\n${bulletLine}\n${suffix.replace(/^\n+/, '\n')}`;
      } else {
        next = `# Changelog\n\n## Unreleased\n\n${bulletLine}\n\n${next.replace(/^\n+/, '')}`;
      }
    } else {
      const headingEndIndex = match.index + match[0].length;
      let insertPos = next.indexOf('\n', headingEndIndex);
      if (insertPos === -1) {
        next = `${next}\n`;
        insertPos = next.length - 1;
      }
      insertPos += 1;

      while (next[insertPos] === '\n') {
        insertPos += 1;
      }

      next = `${next.slice(0, insertPos)}${bulletLine}\n${next.slice(insertPos)}`;
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

  const updatePackageVersionIfPresent = async (absolutePath, newVersion) => {
    try {
      const raw = await fs.readFile(absolutePath, 'utf8');
      const prev = JSON.parse(String(raw || ''));
      if (!prev || typeof prev !== 'object') {
        return false;
      }
      const next = { ...prev, version: newVersion };
      const eol = typeof raw === 'string' && raw.includes('\r\n') ? '\r\n' : '\n';
      await fs.writeFile(absolutePath, JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol, 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  const bumpVersionAndRollChangelog = async (projectPath, entryText) => {
    const basePath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!basePath) {
      return { updated: false, version: null };
    }

    const versionPath = path.join(basePath, 'VERSION');
    const changelogPath = path.join(basePath, 'CHANGELOG.md');
    const frontendPkgPath = path.join(basePath, 'frontend', 'package.json');
    const backendPkgPath = path.join(basePath, 'backend', 'package.json');

    await ensureChangelogUnreleasedEntry(basePath, entryText).catch(() => ({ updated: false }));

    const currentVersionRaw = await fs.readFile(versionPath, 'utf8').catch(() => '0.1.0\n');
    const currentVersion = String(currentVersionRaw || '').trim() || '0.1.0';
    const nextVersion = incrementPatch(currentVersion) || '0.1.0';

    const changelogText = await fs.readFile(changelogPath, 'utf8').catch(() => null);
    if (typeof changelogText === 'string') {
      const rolled = rollChangelogToVersion(changelogText, nextVersion);
      await fs.writeFile(changelogPath, rolled, 'utf8');
    }

    await fs.writeFile(versionPath, `${nextVersion}\n`, 'utf8');

    await updatePackageVersionIfPresent(frontendPkgPath, nextVersion);
    await updatePackageVersionIfPresent(backendPkgPath, nextVersion);

    return { updated: true, version: nextVersion };
  };

  const stageWorkspaceChange = async (projectId, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    const filePath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
    if (!filePath) {
      throw withStatusCode(new Error('filePath is required'), 400);
    }

    const source = payload.source === 'ai' ? 'ai' : 'editor';
    const timestamp = payload.timestamp || new Date().toISOString();

    let branchRow;
    if (payload.branchName) {
      branchRow = await getBranchByName(projectId, payload.branchName);
    } else {
      branchRow = await getActiveWorkingBranchRow(projectId);
    }

    if (!branchRow || branchRow.type === 'main') {
      const desiredName = payload.branchName || generateAutoBranchName();
      const createdBranch = await createWorkingBranch(projectId, {
        name: desiredName,
        description: payload.description || 'Auto-generated feature branch',
        type: payload.type || 'feature'
      });
      branchRow = await get('SELECT * FROM branches WHERE id = ?', [createdBranch.id]);
    }

    const stagedFiles = parseStagedFiles(branchRow.staged_files);
    const filtered = stagedFiles.filter((entry) => entry.path !== filePath);
    const nextFiles = [
      ...filtered,
      {
        path: filePath,
        source,
        timestamp
      }
    ];

    await run(
      `UPDATE branches
     SET staged_files = ?,
         status = 'active',
         ahead_commits = ?,
         last_test_run_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [JSON.stringify(nextFiles), Math.max(nextFiles.length, 1), branchRow.id]
    );

    let didStageInGit = false;
    let stageGitError = null;

    if (context.gitReady) {
      try {
        // Use `git add -A` so deletes/renames are staged properly.
        await runProjectGit(context, ['add', '-A', '--', filePath]);
        const stagedResult = await runProjectGit(context, ['diff', '--cached', '--name-only', '--', filePath]).catch(
          () => null
        );
        didStageInGit = Boolean((stagedResult?.stdout || '').toString().trim());
      } catch (error) {
        stageGitError = error?.message || 'Failed to stage file in git';
        console.warn(`[BranchWorkflow] Failed to stage ${filePath} in git: ${stageGitError}`);
      }
    }

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branchRow.id]);

    if (payload.autoRun === true) {
      scheduleAutoTests(projectId, updatedRow.name, payload.autoRunDelayMs);
    }

    return {
      branch: serializeBranchRow(updatedRow),
      stagedFiles: parseStagedFiles(updatedRow.staged_files),
      git: {
        ready: Boolean(context.gitReady),
        staged: didStageInGit,
        error: stageGitError
      }
    };
  };

  const parseNumstatLine = (line = '') => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) {
      return null;
    }
    const [added, removed, ...pathParts] = parts;
    const additions = Number(added);
    const deletions = Number(removed);
    return {
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      path: pathParts.join(' ')
    };
  };

  const coerceReasonableSummary = (files) => {
    if (!Array.isArray(files) || !files.length) {
      return '';
    }
    return files
      .map((file, index) => {
        const stats = [];
        if (Number.isFinite(file.additions)) {
          stats.push(`+${file.additions}`);
        }
        if (Number.isFinite(file.deletions)) {
          stats.push(`-${file.deletions}`);
        }
        const statsText = stats.length ? ` (${stats.join(' / ')})` : '';
        return `${index + 1}. ${file.path || 'unknown file'}${statsText}`;
      })
      .join('\n');
  };

  const getBranchCommitContext = async (projectId, branchName) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    let branchRow;
    if (branchName) {
      branchRow = await getBranchByName(projectId, branchName);
    } else {
      branchRow = await getActiveWorkingBranchRow(projectId);
    }

    if (!branchRow || branchRow.type === 'main') {
      throw withStatusCode(new Error('Working branch not found'), 404);
    }

    const stagedFiles = parseStagedFiles(branchRow.staged_files) || [];
    const baseResponse = {
      branch: branchRow.name,
      totalFiles: stagedFiles.length,
      files: [],
      isGitAvailable: context.gitReady,
      summaryText: '',
      aggregateDiff: '',
      truncated: false
    };

    if (!stagedFiles.length) {
      return baseResponse;
    }

    const detailedFiles = [];
    const aggregateDiffSegments = [];

    if (context.gitReady) {
      for (const entry of stagedFiles) {
        const detail = {
          path: entry.path,
          source: entry.source || 'editor',
          timestamp: entry.timestamp || null,
          additions: null,
          deletions: null,
          diff: '',
          truncated: false
        };

        if (entry.path) {
          const statResult = await runProjectGit(context, [
            'diff',
            '--cached',
            '--numstat',
            '--',
            entry.path
          ]).catch(() => null);

          const statLine = statResult?.stdout
            ?.split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
          const parsedStat = statLine ? parseNumstatLine(statLine) : null;
          if (parsedStat) {
            detail.additions = parsedStat.additions;
            detail.deletions = parsedStat.deletions;
          }

          const diffResult = await runProjectGit(context, [
            'diff',
            '--cached',
            '--unified=5',
            '--',
            entry.path
          ]).catch(() => null);

          const diffText = diffResult?.stdout?.trim();
          if (diffText) {
            const didTruncate = diffText.length > MAX_FILE_DIFF_CHARS;
            detail.diff = didTruncate ? trimDiff(diffText, MAX_FILE_DIFF_CHARS) : diffText;
            detail.truncated = didTruncate;
            aggregateDiffSegments.push(diffText);
          }
        }

        detailedFiles.push(detail);
      }
    } else {
      stagedFiles.forEach((entry) => {
        detailedFiles.push({
          path: entry.path,
          source: entry.source || 'editor',
          timestamp: entry.timestamp || null,
          additions: null,
          deletions: null,
          diff: '',
          truncated: false
        });
      });
    }

    const aggregateCombined = aggregateDiffSegments.join('\n\n');
    const aggregateTruncated = aggregateCombined.length > MAX_AGGREGATE_DIFF_CHARS;
    const aggregateDiff = aggregateCombined
      ? aggregateTruncated
        ? trimDiff(aggregateCombined, MAX_AGGREGATE_DIFF_CHARS)
        : aggregateCombined
      : '';

    return {
      ...baseResponse,
      files: detailedFiles,
      summaryText: coerceReasonableSummary(detailedFiles),
      aggregateDiff,
      truncated: detailedFiles.some((file) => file.truncated) || aggregateTruncated
    };
  };

  const clearStagedChanges = async (projectId, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    const normalizeFilePath = (value) => String(value ?? '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .trim();

    let branchRow;
    if (payload.branchName) {
      branchRow = await getBranchByName(projectId, payload.branchName);
    } else {
      branchRow = await getActiveWorkingBranchRow(projectId);
    }

    if (!branchRow || branchRow.type === 'main') {
      throw withStatusCode(new Error('No working branch to clear'), 404);
    }

    const previouslyStaged = parseStagedFiles(branchRow.staged_files);
    const targetPath = normalizeFilePath(payload.filePath);
    const hasTargetPath = Boolean(targetPath);

    const normalizedDbPaths = previouslyStaged
      .map((entry) => normalizeFilePath(entry?.path))
      .filter(Boolean);

    const normalizedGitPaths = context.gitReady
      ? (await listGitStagedPaths(context)).map(normalizeFilePath).filter(Boolean)
      : [];

    const knownPaths = new Set([...normalizedDbPaths, ...normalizedGitPaths]);

    const nextFiles = hasTargetPath
      ? previouslyStaged.filter((entry) => normalizeFilePath(entry.path) !== targetPath)
      : [];

    await run(
      `UPDATE branches
     SET staged_files = ?,
         ahead_commits = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [JSON.stringify(nextFiles), nextFiles.length, branchRow.id]
    );

    const pathsToReset = hasTargetPath ? [targetPath] : Array.from(knownPaths);

    if (context.gitReady && pathsToReset.length) {
      const stagedStatusMap = await listGitStagedStatusMap(context).catch(() => new Map());

      for (const relative of pathsToReset) {
        // If the path does not exist in HEAD (e.g., a newly created file),
        // clearing staged changes should also remove the file from disk.
        // We only delete when we can prove the file is not tracked in HEAD.
        let shouldDeleteFromDisk = false;
        if (relative && !relative.includes('..') && !path.isAbsolute(relative)) {
          if (stagedStatusMap.get(relative) === 'A') {
            shouldDeleteFromDisk = true;
          }

          const headCheck = await runProjectGit(
            context,
            ['cat-file', '-e', `HEAD:${relative}`],
            { allowFailure: true }
          ).catch(() => null);

          if (headCheck && typeof headCheck.code === 'number' && headCheck.code !== 0) {
            shouldDeleteFromDisk = true;
          }
        }

        await runProjectGit(context, ['reset', 'HEAD', '--', relative]).catch(() => null);
        await runProjectGit(context, ['checkout', '--', relative]).catch(() => null);

        if (shouldDeleteFromDisk) {
          const fullPath = path.join(context.projectPath, relative);
          const resolvedPath = path.resolve(fullPath);
          const projectResolved = path.resolve(context.projectPath);

          if (resolvedPath.startsWith(projectResolved)) {
            await fs.rm(resolvedPath, { recursive: true, force: true }).catch(() => null);
          }
        }
      }

      const stagedPaths = await listGitStagedPaths(context);
      const normalizedStaged = new Set(stagedPaths.map(normalizeFilePath).filter(Boolean));
      const remaining = pathsToReset.filter((pathValue) => normalizedStaged.has(pathValue));

      if (remaining.length) {
        throw withStatusCode(
          new Error(`Failed to clear staged changes in git for: ${remaining[0]}`),
          500
        );
      }
    }

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branchRow.id]);
    return serializeBranchRow(updatedRow);
  };

  const rollbackBranchChanges = async (projectId, branchName, payload = {}) => {
    await ensureProjectExists(projectId);
    await ensureMainBranch(projectId);

    const normalizedBranchName = typeof branchName === 'string' ? branchName.trim() : '';
    if (!normalizedBranchName) {
      throw withStatusCode(new Error('Branch name is required to roll back changes'), 400);
    }

    const branch = await getBranchByName(projectId, normalizedBranchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot roll back the main branch'), 400);
    }

    // Ensure the branch is the active checkout before we mutate git state.
    await checkoutBranch(projectId, branch.name);

    const cleared = await clearStagedChanges(projectId, {
      branchName: branch.name
    });

    const nextStatus = typeof payload.status === 'string' && payload.status.trim() ? payload.status.trim() : 'active';

    await run(
      `UPDATE branches
     SET status = ?,
         last_test_run_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [nextStatus, branch.id]
    );

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);

    return {
      rolledBack: true,
      branch: serializeBranchRow(updatedRow),
      cleared
    };
  };

  const commitBranchChanges = async (projectId, branchName, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!branchName) {
      throw withStatusCode(new Error('Branch name is required to commit changes'), 400);
    }

    let branch = await getBranchByName(projectId, branchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot commit directly to the main branch'), 400);
    }

    let stagedFiles = parseStagedFiles(branch.staged_files);
    if (!stagedFiles.length && context.gitReady) {
      const statusResult = await runProjectGit(context, ['status', '--porcelain']).catch(() => null);
      const statusOutput = typeof statusResult?.stdout === 'string' ? statusResult.stdout.trim() : '';
      if (statusOutput) {
        try {
          await runProjectGit(context, ['add', '-A']);
          const stagedPaths = await listGitStagedPaths(context).catch(() => []);
          if (stagedPaths.length) {
            const timestamp = new Date().toISOString();
            stagedFiles = stagedPaths.map((filePath) => ({
              path: filePath,
              source: 'ai',
              timestamp
            }));
            await run(
              `UPDATE branches
     SET staged_files = ?,
         ahead_commits = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
              [JSON.stringify(stagedFiles), Math.max(stagedFiles.length, 1), branch.id]
            );
            branch = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);
          }
        } catch (error) {
          console.warn(`[BranchWorkflow] Auto-stage failed for ${branch.name}: ${error?.message || error}`);
        }
      }
    }

    if (!stagedFiles.length) {
      throw withStatusCode(new Error('No staged changes to commit'), 400);
    }

    const isCssOnlyStaged = stagedFiles.every((entry) => {
      const filePath = typeof entry?.path === 'string' ? entry.path.trim().toLowerCase() : '';
      return Boolean(filePath) && filePath.endsWith('.css');
    });

    const autoChangelogRequested = payload?.autoChangelog === true;
    const testsSatisfiedForCommit = branch.status === 'ready-for-merge' || (!autoChangelogRequested && isCssOnlyStaged);

    if (!testsSatisfiedForCommit) {
      const message = branch.status === 'needs-fix'
        ? 'Resolve failing tests and run tests again before committing.'
        : 'Run tests to prove this branch before committing.';
      throw withStatusCode(new Error(message), 400);
    }

    const gitSettings = await resolveProjectGitSettings(projectId);
    const commitMessage = buildCommitMessage({
      requestedMessage: payload.message,
      gitSettings,
      branchName: branch.name,
      stagedFiles
    });

    const resolveCommitSha = async () => {
      try {
        const result = await runProjectGit(context, ['rev-parse', 'HEAD']);
        const sha = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
        return sha || null;
      } catch {
        return null;
      }
    };

    let commitSha = null;

    if (context.gitReady) {
      try {
        await ensureGitBranchExists(context, branch.name);
        await checkoutGitBranch(context, branch.name);

        if (autoChangelogRequested) {
          const entryText = payload?.changelogEntry || commitMessage;
          const result = await bumpVersionAndRollChangelog(context.projectPath, entryText).catch(() => ({ updated: false }));
          if (result?.updated) {
            const timestamp = new Date().toISOString();
            if (!stagedFiles.some((entry) => entry?.path === 'CHANGELOG.md')) {
              stagedFiles = [...stagedFiles, { path: 'CHANGELOG.md', source: 'ai', timestamp }];
            }
            if (!stagedFiles.some((entry) => entry?.path === 'VERSION')) {
              stagedFiles = [...stagedFiles, { path: 'VERSION', source: 'ai', timestamp }];
            }
          }
        }

        await commitAllChanges(context.projectPath, commitMessage);

        commitSha = await resolveCommitSha();
      } catch (error) {
        console.warn(`[BranchWorkflow] Failed to commit for ${branch.name}: ${error.message}`);
        throw withStatusCode(new Error(`Failed to commit changes: ${error.message}`), 500);
      }
    }

    let nextStatus = branch.status;
    if (isCssOnlyStaged && context.gitReady) {
      const allowCssOnlyMerge = await isCssOnlyBranchDiff(context, branch.name).catch(() => false);
      if (allowCssOnlyMerge) {
        nextStatus = 'ready-for-merge';
      }
    }

    const nextAhead = Math.max((branch.ahead_commits || 0) + 1, 1);
    await run(
      `UPDATE branches
     SET staged_files = '[]',
         status = ?,
         ahead_commits = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [nextStatus, nextAhead, branch.id]
    );

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);
    return {
      branch: serializeBranchRow(updatedRow),
      commit: {
        sha: commitSha,
        shortSha: commitSha ? commitSha.slice(0, 7) : null,
        message: commitMessage,
        branch: branch.name,
        files: stagedFiles,
        createdAt: new Date().toISOString()
      }
    };
  };

  const getBranchHeadSha = async (projectId, branchName) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!branchName) {
      throw withStatusCode(new Error('Branch name is required'), 400);
    }

    const branch = await getBranchByName(projectId, branchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot query HEAD for the main branch'), 400);
    }

    if (!context.gitReady) {
      return null;
    }

    await ensureGitBranchExists(context, branch.name);
    await checkoutGitBranch(context, branch.name);

    const result = await runProjectGit(context, ['rev-parse', 'HEAD']);
    const sha = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
    return sha || null;
  };

  const resetBranchToCommit = async (projectId, branchName, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    if (!branchName) {
      throw withStatusCode(new Error('Branch name is required'), 400);
    }

    const commitSha = typeof payload.commitSha === 'string' ? payload.commitSha.trim() : '';
    if (!commitSha) {
      throw withStatusCode(new Error('commitSha is required'), 400);
    }

    const branch = await getBranchByName(projectId, branchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot reset the main branch'), 400);
    }

    // Ensure the branch is the active checkout before we mutate git state.
    await checkoutBranch(projectId, branch.name);

    const cleared = await clearStagedChanges(projectId, { branchName: branch.name });

    let gitReset = null;
    let gitError = null;

    if (context.gitReady) {
      try {
        await ensureGitBranchExists(context, branch.name);
        await checkoutGitBranch(context, branch.name);

        await runProjectGit(context, ['reset', '--hard', commitSha]);
        await runProjectGit(context, ['clean', '-fd']);

        const resolved = await runProjectGit(context, ['rev-parse', 'HEAD']);
        const sha = typeof resolved?.stdout === 'string' ? resolved.stdout.trim() : '';
        gitReset = sha || commitSha;
      } catch (error) {
        gitError = error?.message || 'Failed to reset branch in git';
        console.warn(`[BranchWorkflow] Failed to reset ${branch.name} to ${commitSha}: ${gitError}`);
        throw withStatusCode(new Error(`Failed to reset branch: ${gitError}`), 500);
      }
    }

    const nextStatus = typeof payload.status === 'string' && payload.status.trim() ? payload.status.trim() : 'active';
    await run(
      `UPDATE branches
     SET status = ?,
         staged_files = '[]',
         last_test_run_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [nextStatus, branch.id]
    );

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);

    return {
      reset: true,
      branch: serializeBranchRow(updatedRow),
      cleared,
      git: {
        ready: Boolean(context.gitReady),
        head: gitReset,
        error: gitError
      }
    };
  };

  const getBranchStagedPatch = async (projectId, branchName) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    const normalizedBranchName = typeof branchName === 'string' ? branchName.trim() : '';
    if (!normalizedBranchName) {
      throw withStatusCode(new Error('Branch name is required'), 400);
    }

    const branch = await getBranchByName(projectId, normalizedBranchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot build a patch for the main branch'), 400);
    }

    if (!context.gitReady) {
      return { patch: null, files: [] };
    }

    // Ensure the branch is the active checkout before we query git.
    await checkoutBranch(projectId, branch.name);
    await ensureGitBranchExists(context, branch.name);
    await checkoutGitBranch(context, branch.name);

    const patchResult = await runProjectGit(context, ['diff', '--cached']).catch(() => ({ stdout: '' }));
    const patch = (patchResult?.stdout || '').toString();

    const filesResult = await runProjectGit(context, ['diff', '--cached', '--name-only']).catch(() => ({ stdout: '' }));
    const files = (filesResult?.stdout || '')
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!patch.trim()) {
      return { patch: null, files };
    }

    return { patch, files };
  };

  const applyBranchPatch = async (projectId, branchName, payload = {}) => {
    const context = await getProjectContext(projectId);
    await ensureMainBranch(projectId);

    const normalizedBranchName = typeof branchName === 'string' ? branchName.trim() : '';
    if (!normalizedBranchName) {
      throw withStatusCode(new Error('Branch name is required'), 400);
    }

    const patch = typeof payload.patch === 'string' ? payload.patch : '';
    if (!patch.trim()) {
      return { applied: false, files: [] };
    }

    const branch = await getBranchByName(projectId, normalizedBranchName);
    if (branch.type === 'main') {
      throw withStatusCode(new Error('Cannot apply a patch to the main branch'), 400);
    }

    // Ensure the branch is the active checkout before we mutate git state.
    await checkoutBranch(projectId, branch.name);

    if (!context.gitReady) {
      throw withStatusCode(new Error('Git is not available for applying patch checkpoints'), 400);
    }

    await ensureGitBranchExists(context, branch.name);
    await checkoutGitBranch(context, branch.name);

    const tmpDir = await fs.mkdtemp(path.join(context.projectPath, '.lucidcoder-patch-'));
    const patchPath = path.join(tmpDir, 'checkpoint.patch');

    try {
      await fs.writeFile(patchPath, patch, 'utf8');
      await runProjectGit(context, ['apply', '--whitespace=nowarn', patchPath]);
    } catch (error) {
      const message = error?.message || 'Failed to apply patch checkpoint';
      throw withStatusCode(new Error(message), 500);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
    }

    const files = Array.isArray(payload.files)
      ? payload.files
          .map((file) => (typeof file === 'string' ? file.trim() : ''))
          .filter(Boolean)
      : [];

    for (const filePath of files) {
      await stageWorkspaceChange(projectId, {
        branchName: branch.name,
        filePath,
        source: 'ai',
        timestamp: new Date().toISOString(),
        autoRun: true
      });
    }

    const nextStatus = typeof payload.status === 'string' && payload.status.trim() ? payload.status.trim() : 'active';
    await run(
      `UPDATE branches
     SET status = ?,
         last_test_run_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [nextStatus, branch.id]
    );

    const updatedRow = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);

    return {
      applied: true,
      branch: serializeBranchRow(updatedRow),
      files
    };
  };

  return {
    stageWorkspaceChange,
    getBranchCommitContext,
    clearStagedChanges,
    rollbackBranchChanges,
    commitBranchChanges,
    getBranchHeadSha,
    resetBranchToCommit,
    getBranchStagedPatch,
    applyBranchPatch,
    parseNumstatLine,
    coerceReasonableSummary,
    __testOnly: {
      parseSemver,
      incrementPatch,
      extractUnreleasedEntries,
      rollChangelogToVersion,
      coerceSingleLine,
      normalizeChangelogBullet,
      ensureChangelogUnreleasedEntry,
      updatePackageVersionIfPresent,
      bumpVersionAndRollChangelog
    }
  };
};
