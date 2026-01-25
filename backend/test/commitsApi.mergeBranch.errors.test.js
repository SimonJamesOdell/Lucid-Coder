import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('commitsApi.mergeBranch error-path coverage', () => {
  const projectId = 100;
  const branchName = 'feature/x';

  let tmpDir;
  let core;
  let runProjectGit;
  let getProjectContext;
  let getBranchByName;

  beforeEach(() => {
    tmpDir = null;

    runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    getProjectContext = vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' });
    getBranchByName = vi.fn().mockResolvedValue({
      id: 1,
      name: branchName,
      type: 'feature',
      status: 'ready-for-merge'
    });

    core = {
      withStatusCode,
      ensureMainBranch: vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' }),
      getProjectContext,
      runProjectGit,
      llmClient: null,
      normalizeCommitLimit: (n) => n,
      parseGitLog: () => [],
      getBranchByName,
      cancelScheduledAutoTests: vi.fn(),
      isCssOnlyBranchDiff: vi.fn().mockResolvedValue(false),
      listBranchChangedPaths: vi.fn().mockResolvedValue(['CHANGELOG.md', 'VERSION']),
      ensureGitBranchExists: vi.fn().mockResolvedValue(undefined),
      checkoutGitBranch: vi.fn(),
      run: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ status: 'passed' }),
      setCurrentBranch: vi.fn().mockResolvedValue(undefined),
      fs,
      path
    };
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  const api = () => createBranchWorkflowCommits(core);

  it('uses allowCssOnlyMerge=false when css-only detection throws', async () => {
    core.isCssOnlyBranchDiff.mockRejectedValueOnce(new Error('nope'));
    getBranchByName.mockResolvedValueOnce({ id: 1, name: branchName, type: 'feature', status: 'ready-for-merge' });

    const { mergeBranch } = api();

    // Stop early by making latest run not passed.
    core.get.mockResolvedValueOnce({ status: 'failed' });

    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Latest test run must pass/i)
    });
  });

  it('rejects merging the main branch', async () => {
    getBranchByName.mockResolvedValueOnce({ id: 1, name: 'main', type: 'main', status: 'ready-for-merge' });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, 'main')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Main branch cannot be merged/i)
    });
  });

  it('requires tests to pass unless css-only merge is allowed', async () => {
    getBranchByName.mockResolvedValueOnce({ id: 1, name: branchName, type: 'feature', status: 'testing' });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/must pass tests/i)
    });
  });

  it('rejects when latest test run is missing', async () => {
    core.get.mockResolvedValueOnce(null);

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Latest test run must pass/i)
    });
  });

  it('allows css-only merge and skips git operations when git is not ready', async () => {
    core.isCssOnlyBranchDiff.mockResolvedValueOnce(true);
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    getBranchByName.mockResolvedValueOnce({ id: 1, name: branchName, type: 'feature', status: 'testing' });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).resolves.toMatchObject({ mergedBranch: branchName, current: 'main' });
    expect(runProjectGit).not.toHaveBeenCalled();
  });

  it('does not attempt reset when post-merge bump fails and rev-parse outputs are non-strings', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        return { stdout: '# Changelog\n\n## Unreleased\n\n- note\n' };
      }
      if (cmd === `show ${branchName}:VERSION`) {
        // Disable VERSION enforcement so enforceChangelogForMerge can pass.
        return { stdout: '   \n' };
      }

      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 0 };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 0 };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };

      // Make bumpVersionAfterMerge throw by failing git add.
      if (cmd.startsWith('add ')) throw new Error('add failed');

      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({ statusCode: 500 });

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds.some((c) => c.startsWith('reset --hard'))).toBe(false);
  });

  it('coerces non-string changelog probe stdout (Buffer) when detecting tracked changelog', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: undefined });
    core.listBranchChangedPaths.mockResolvedValueOnce([]);

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) return { stdout: Buffer.from('tracked') };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('handles falsy non-string changelog probe stdout (0) when detecting tracked changelog', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: undefined });
    core.listBranchChangedPaths.mockResolvedValueOnce([]);

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) return { stdout: 0 };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).resolves.toMatchObject({
      current: 'main',
      mergedBranch: branchName
    });
  });

  it('runs checkout(main) in finally and ignores checkout failure during auto-bump', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    // Force enforcement error 400 (missing changed paths), so auto-bump triggers.
    core.listBranchChangedPaths.mockResolvedValueOnce(['README.md']);

    // Make changelog tracked.
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) return { stdout: '# Changelog\n\n## Unreleased\n\n- note\n' };
      if (cmd === `show ${branchName}:VERSION`) return { stdout: '0.1.0\n' };

      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') throw new Error('checkout failed');

      // Fail the pre-merge bump by failing git add.
      if (cmd.startsWith('add ')) throw new Error('add failed');

      return { stdout: '' };
    });

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/Failed to update changelog\/version before merge/i)
    });

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds).toContain('checkout main');
  });

  it('resets main when post-merge bump fails and a pre-merge sha is known', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    // Disable auto-bump so the post-merge bump path executes.
    core.listBranchChangedPaths = undefined;

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    // Skip enforcement by simulating missing changelog in git.
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');

      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') throw new Error('no head');
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'preSha\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };

      // Make bumpVersionAfterMerge throw by failing git add.
      if (cmd.startsWith('add ')) throw new Error('add failed');
      if (cmd === 'reset --hard preSha') throw new Error('reset failed');

      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({ statusCode: 500 });

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds).toContain('reset --hard preSha');
  });

  it('treats blank current-branch stdout as null', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');

      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: '\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'preSha\n' };
      if (cmd === `merge --no-ff ${branchName}`) throw new Error('merge conflict');

      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({ statusCode: 500 });
  });

  it('attempts reset when post-merge bump fails and reset succeeds', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    // Disable auto-bump so the post-merge bump path executes.
    core.listBranchChangedPaths = undefined;

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    // Skip enforcement by simulating missing changelog in git.
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');

      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: '\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'preSha\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };

      // Make bumpVersionAfterMerge throw by failing git add.
      if (cmd.startsWith('add ')) throw new Error('add failed');
      if (cmd === 'reset --hard preSha') return { stdout: '' };

      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({ statusCode: 500 });

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds).toContain('reset --hard preSha');
  });

  it('wraps a raw git merge failure as statusCode 500', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');

      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') throw new Error('no sha');
      if (cmd === `merge --no-ff ${branchName}`) throw new Error('merge conflict');

      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/Git merge failed/i)
    });
  });
});
