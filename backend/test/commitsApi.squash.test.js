import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('commitsApi.squashCommits', () => {
  let core;
  let runProjectGit;
  let ensureMainBranch;
  let getProjectContext;
  let setCurrentBranch;

  const projectId = 123;

  beforeEach(() => {
    runProjectGit = vi.fn();
    ensureMainBranch = vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' });
    getProjectContext = vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' });
    setCurrentBranch = vi.fn().mockResolvedValue(undefined);

    core = {
      withStatusCode,
      ensureMainBranch,
      getProjectContext,
      runProjectGit,
      normalizeCommitLimit: (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 50),
      parseGitLog: () => [],
      getBranchByName: vi.fn(),
      cancelScheduledAutoTests: vi.fn(),
      isCssOnlyBranchDiff: vi.fn(),
      ensureGitBranchExists: vi.fn().mockResolvedValue(undefined),
      checkoutGitBranch: vi.fn(),
      run: vi.fn(),
      get: vi.fn(),
      setCurrentBranch
    };
  });

  const api = () => createBranchWorkflowCommits(core);

  it('squashes the latest two commits on main (soft reset path)', async () => {
    // Arrange
    // Status clean
    let revParseHeadCount = 0;
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd === 'checkout main') {
        return Promise.resolve({ stdout: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'def^^') {
        return Promise.resolve({ stdout: 'base123\n' });
      }
      if (cmd.startsWith('rev-parse')) {
        // rev-parse HEAD, newerSha, olderSha
        const ref = args[1];
        if (ref === 'HEAD') {
          revParseHeadCount += 1;
          // First HEAD resolve (guardrails) -> current HEAD = def
          // Second HEAD resolve (after commit) -> new head = newsha999
          return Promise.resolve({ stdout: revParseHeadCount === 1 ? 'def\n' : 'newsha999\n' });
        }
        if (ref === 'def') return Promise.resolve({ stdout: 'def\n' });
        if (ref === 'abc') return Promise.resolve({ stdout: 'abc\n' });
      }
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) {
        // Single parent equal to older
        return Promise.resolve({ stdout: 'abc\n' });
      }
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) {
        return Promise.resolve({ stdout: 'My message\n' });
      }
      if (cmd.startsWith('reset --soft base123')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd.startsWith('commit -m')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd === 'rev-parse HEAD') {
        return Promise.resolve({ stdout: 'newsha999\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();
    const customMessage = '  Custom squash message  ';
    const trimmedMessage = 'Custom squash message';

    // Act
    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def', message: customMessage });

    // Assert
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsha999' } });
    expect(ensureMainBranch).toHaveBeenCalledTimes(2);
    expect(setCurrentBranch).toHaveBeenCalledWith(projectId, 1);
    expect(runProjectGit).toHaveBeenCalledWith(expect.anything(), ['commit', '-m', trimmedMessage]);
  });

  it('falls back to generic squash message when git subject is unavailable', async () => {
    // Arrange
    let revParseHeadCount = 0;
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd === 'checkout main') {
        return Promise.resolve({ stdout: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'def^^') {
        return Promise.resolve({ stdout: 'base123\n' });
      }
      if (cmd.startsWith('rev-parse')) {
        const ref = args[1];
        if (ref === 'HEAD') {
          revParseHeadCount += 1;
          return Promise.resolve({ stdout: revParseHeadCount === 1 ? 'def\n' : 'newsha999\n' });
        }
        if (ref === 'def') return Promise.resolve({ stdout: 'def\n' });
        if (ref === 'abc') return Promise.resolve({ stdout: 'abc\n' });
      }
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) {
        return Promise.resolve({ stdout: 'abc\n' });
      }
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) {
        return Promise.resolve({});
      }
      if (cmd.startsWith('reset --soft base123')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd.startsWith('commit -m')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd === 'rev-parse HEAD') {
        return Promise.resolve({ stdout: 'newsha999\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    // Act
    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });

    // Assert
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsha999' } });
    expect(runProjectGit).toHaveBeenCalledWith(expect.anything(), ['commit', '-m', 'Squashed commit']);
  });

  it('fails if working tree is not clean', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) {
        return Promise.resolve({ stdout: ' M file.txt\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Working tree must be clean/i) });
  });

  it('throws 400 when git parent output is empty (treat as non-merge constraint)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');

      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd === 'checkout main') return Promise.resolve({ stdout: '' });

      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });

      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: '' });

      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Only non-merge commits can be squashed/i) });
  });

  it('reports invalid HEAD when rev-parse fails', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) {
        return Promise.resolve({ stdout: '' });
      }
      if (cmd.startsWith('rev-parse HEAD')) {
        return Promise.reject(new Error('bad ref'));
      }
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/HEAD is invalid/i) });
  });

  it('only allows squashing when newerSha is HEAD', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'zzz\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Only the latest commit/i) });
  });

  it('requires commits to be adjacent (older must be HEAD parent)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'xxx\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/must be adjacent/i) });
  });

  it('throws 500 if git status check fails (ensureCleanWorkingTree)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) throw new Error('status failed');
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Unable to verify git working tree status/i) });
  });

  it('throws 500 when unable to checkout main', async () => {
    // Make working tree clean, but fail during checkout of main.
    core.ensureGitBranchExists.mockRejectedValueOnce(new Error('branch missing'));

    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd === 'checkout main') return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Unable to checkout main/i) });
  });

  it('throws 400 when olderSha equals newerSha (same commit)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'def', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Cannot squash the same commit/i) });
  });

  it('throws 400 when HEAD is a merge commit (non-merge only)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc def\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Only non-merge commits can be squashed/i) });
  });

  it('throws 400 when newerSha is invalid', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'headsha\n' });
      if (cmd.startsWith('rev-parse badsha')) return Promise.reject(new Error('bad ref'));
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'badsha' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/newerSha is invalid/i) });
  });

  it('wraps errors during soft squash operations (reset/commit) with 500', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: 'base123\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (cmd.startsWith('reset --soft base123')) throw new Error('reset failed');
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to squash commits/i) });
  });

  it('performs root squash when no base exists (commit-tree path)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      // No base -> root squash
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha111\n' });
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: 'newsquash000\n' });
      if (args[0] === 'update-ref') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('reset --hard newsquash000')) return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsquash000' } });
  });

  it('wraps errors during root squash operations with 500', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      // Ensure the specific tree rev-parse handler runs before the generic 'rev-parse def'
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to squash commits/i) });
  });

  it('wraps errors when tree rev-parse throws (root squash)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      // Force root-squash path (no base)
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      // Throw during tree SHA resolution to hit catch assigning treeSha = '' (line ~312)
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.reject(new Error('tree rev-parse failed'));
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it('wraps error when root squash commit-tree returns empty (Unable to create commit)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha111\n' });
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to squash commits/i) });
  });

  it('requires olderSha and newerSha in payload', async () => {
    const { squashCommits } = api();
    await expect(squashCommits(projectId, {}))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/olderSha and newerSha are required/i) });
  });

  it('reports invalid newerSha when rev-parse returns empty stdout', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'headsha\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/newerSha is invalid/i) });
  });

  it('treats failing parent resolution as non-merge and throws 400', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.reject(new Error('show failed'));
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Only non-merge commits can be squashed/i) });
  });

  it('performs root squash when base rev-parse errors (commit-tree path via catch)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      // Cause baseSha catch branch
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.reject(new Error('bad base'));
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha111\n' });
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: 'newsquash001\n' });
      if (args[0] === 'update-ref') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('reset --hard newsquash001')) return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsquash001' } });
  });

  it('uses default "Squashed commit" message when none provided', async () => {
    const calls = [];
    runProjectGit.mockImplementation((ctx, args) => {
      calls.push(args);
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      // No base to force root-squash path
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      // Empty subject to force fallback
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha222\n' });
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: 'newsquash002\n' });
      if (args[0] === 'update-ref') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('reset --hard newsquash002')) return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsquash002' } });
    const commitTreeCall = calls.find((a) => a[0] === 'commit-tree');
    expect(commitTreeCall).toBeTruthy();
    // commit-tree <treeSha> -m "Squashed commit"
    expect(commitTreeCall).toEqual(expect.arrayContaining(['-m', 'Squashed commit']));
  });

  it('uses payload.message when provided (soft path)', async () => {
    const calls = [];
    let revParseHeadCount = 0;
    runProjectGit.mockImplementation((ctx, args) => {
      calls.push(args);
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        revParseHeadCount += 1;
        return Promise.resolve({ stdout: revParseHeadCount === 1 ? 'def\n' : 'newsha777\n' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: 'base123\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      // Default subject exists but should be ignored in favor of payload.message
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Ignored subject\n' });
      if (cmd.startsWith('reset --soft base123')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'commit') return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def', message: '  Custom Msg  ' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsha777' } });
    const commitCall = calls.find((a) => a[0] === 'commit');
    expect(commitCall).toBeTruthy();
    expect(commitCall).toEqual(expect.arrayContaining(['-m', 'Custom Msg']));
  });

  it('falls back when default subject stdout is non-string (root squash)', async () => {
    const calls = [];
    runProjectGit.mockImplementation((ctx, args) => {
      calls.push(args);
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      // Non-string to trigger defaultMessage else branch
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: null });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha333\n' });
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: 'newsquash003\n' });
      if (args[0] === 'update-ref') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('reset --hard newsquash003')) return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();

    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsquash003' } });
    const commitTreeCall = calls.find((a) => a[0] === 'commit-tree');
    expect(commitTreeCall).toBeTruthy();
    expect(commitTreeCall).toEqual(expect.arrayContaining(['-m', 'Squashed commit']));
  });

  it('wraps 500 when tree rev-parse returns non-string (root squash)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      // Non-string tree stdout to hit typeof false branch
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: null });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();
    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it('wraps 500 when commit-tree stdout is non-string (root squash)', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 'def\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (args[0] === 'rev-parse' && args[1] === 'def^{tree}') return Promise.resolve({ stdout: 'treesha444\n' });
      // Non-string commit-tree stdout to hit typeof false branch
      if (args[0] === 'commit-tree') return Promise.resolve({ stdout: null });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();
    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to squash commits/i) });
  });

  it('handles non-string porcelain output as clean', async () => {
    let revParseHeadCount = 0;
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: 123 });
      if (cmd.startsWith('checkout main')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        revParseHeadCount += 1;
        return Promise.resolve({ stdout: revParseHeadCount === 1 ? 'def\n' : 'newsha778\n' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'def^^') return Promise.resolve({ stdout: 'base123\n' });
      if (cmd.startsWith('rev-parse def')) return Promise.resolve({ stdout: 'def\n' });
      if (cmd.startsWith('rev-parse abc')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%P')) return Promise.resolve({ stdout: 'abc\n' });
      if (cmd.startsWith('show def --quiet --pretty=format:%s')) return Promise.resolve({ stdout: 'Default msg\n' });
      if (cmd.startsWith('reset --soft base123')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'commit') return Promise.resolve({ stdout: '' });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();
    const result = await squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' });
    expect(result).toEqual({ squashed: { olderSha: 'abc', newerSha: 'def', newSha: 'newsha778' } });
  });

  it('reports invalid HEAD when rev-parse returns non-string', async () => {
    runProjectGit.mockImplementation((ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('status --porcelain')) return Promise.resolve({ stdout: '' });
      if (cmd.startsWith('rev-parse HEAD')) return Promise.resolve({ stdout: 123 });
      return Promise.resolve({ stdout: '' });
    });

    const { squashCommits } = api();
    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/HEAD is invalid/i) });
  });
});
