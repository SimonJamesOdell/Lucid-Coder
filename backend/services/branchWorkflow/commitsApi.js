export const createBranchWorkflowCommits = (core) => {
  const {
    withStatusCode,
    ensureMainBranch,
    getProjectContext,
    runProjectGit,
    normalizeCommitLimit,
    parseGitLog,
    getBranchByName,
    cancelScheduledAutoTests,
    isCssOnlyBranchDiff,
    ensureGitBranchExists,
    checkoutGitBranch,
    run,
    get,
    setCurrentBranch
  } = core;

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
      const statusResult = await runProjectGit(context, ['status', '--porcelain']);
      /* c8 ignore next */
      porcelain = typeof statusResult?.stdout === 'string' ? statusResult.stdout.trim() : '';
    } catch {
      throw withStatusCode(new Error('Unable to verify git working tree status'), 500);
    }

    if (porcelain) {
      throw withStatusCode(new Error(message), 400);
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

    if (context.gitReady) {
      // Require a clean working tree before attempting any merge operations.
      // This keeps merges deterministic and avoids implicitly stashing changes.
      let porcelain = '';
      try {
        const statusResult = await runProjectGit(context, ['status', '--porcelain']);
        porcelain = typeof statusResult?.stdout === 'string' ? statusResult.stdout.trim() : '';
      } catch {
        throw withStatusCode(new Error('Unable to verify git working tree status'), 500);
      }

      if (porcelain) {
        throw withStatusCode(new Error('Working tree must be clean before merging'), 400);
      }

      try {
        const resolveCurrentGitBranch = async () => {
          try {
            const result = await runProjectGit(context, ['rev-parse', '--abbrev-ref', 'HEAD']);
            const name = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
            return name || null;
          } catch {
            return null;
          }
        };

        const currentBranch = await resolveCurrentGitBranch();
        await ensureGitBranchExists(context, branch.name);
        await runProjectGit(context, ['checkout', branch.name]);
        await runProjectGit(context, ['checkout', 'main']);
        await runProjectGit(context, ['merge', '--no-ff', branch.name]);
      } catch (error) {
        console.warn(`[BranchWorkflow] Git merge failed for ${branch.name}: ${error.message}`);
        throw withStatusCode(new Error(`Git merge failed: ${error.message}`), 500);
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
    mergeBranch
  };
};
