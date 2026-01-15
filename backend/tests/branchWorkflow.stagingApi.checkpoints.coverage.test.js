import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { createBranchWorkflowStaging } from '../services/branchWorkflow/stagingApi.js';

const withStatusCode = (error, statusCode) => {
  error.statusCode = statusCode;
  return error;
};

const buildCore = ({
  gitReady = true,
  branchType = 'feature',
  branchName = 'agent/branch',
  runProjectGitImpl,
  checkoutBranchImpl,
  listGitStagedPathsImpl
} = {}) => {
  const fs = {
    mkdtemp: vi.fn().mockResolvedValue('C:/tmp/project/.lucidcoder-patch-123'),
    writeFile: vi.fn().mockResolvedValue(null),
    rm: vi.fn().mockResolvedValue(null)
  };

  const run = vi.fn().mockResolvedValue(null);

  const updatedRow = {
    id: 123,
    name: branchName,
    status: 'active',
    type: branchType,
    staged_files: '[]',
    ahead_commits: 0
  };

  const get = vi.fn().mockResolvedValue(updatedRow);

  const getProjectContext = vi.fn().mockResolvedValue({
    projectPath: 'C:/tmp/project',
    gitReady
  });

  const getBranchByName = vi.fn().mockResolvedValue({
    id: 123,
    name: branchName,
    type: branchType,
    status: 'active',
    staged_files: '[]',
    ahead_commits: 0
  });

  const checkoutBranch = checkoutBranchImpl ? vi.fn(checkoutBranchImpl) : vi.fn().mockResolvedValue(null);

  const ensureMainBranch = vi.fn().mockResolvedValue(null);

  const ensureGitBranchExists = vi.fn().mockResolvedValue(null);
  const checkoutGitBranch = vi.fn().mockResolvedValue(null);

  const runProjectGit = runProjectGitImpl ? vi.fn(runProjectGitImpl) : vi.fn().mockResolvedValue({ stdout: '' });

  const parseStagedFiles = vi.fn(() => []);

  const serializeBranchRow = vi.fn((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type
  }));

  const listGitStagedPaths = listGitStagedPathsImpl ? vi.fn(listGitStagedPathsImpl) : vi.fn().mockResolvedValue([]);
  const listGitStagedStatusMap = vi.fn().mockResolvedValue(new Map());

  return {
    fs,
    path,
    withStatusCode,
    MAX_FILE_DIFF_CHARS: 10,
    MAX_AGGREGATE_DIFF_CHARS: 10,
    trimDiff: (value) => value,
    ensureProjectExists: vi.fn().mockResolvedValue({ id: 1, path: 'C:/tmp/project' }),
    ensureMainBranch,
    getProjectContext,
    getBranchByName,
    getActiveWorkingBranchRow: vi.fn().mockResolvedValue(null),
    generateAutoBranchName: vi.fn(() => 'agent/auto'),
    createWorkingBranch: vi.fn().mockResolvedValue({ id: 123, name: branchName }),
    parseStagedFiles,
    serializeBranchRow,
    runProjectGit,
    listGitStagedPaths,
    listGitStagedStatusMap,
    run,
    get,
    scheduleAutoTests: vi.fn(),
    checkoutBranch,
    resolveProjectGitSettings: vi.fn().mockResolvedValue({}),
    buildCommitMessage: vi.fn().mockResolvedValue('msg'),
    ensureGitBranchExists,
    checkoutGitBranch,
    commitAllChanges: vi.fn().mockResolvedValue({ stdout: '' }),
    isCssOnlyBranchDiff: vi.fn().mockResolvedValue(false)
  };
};

describe('branchWorkflow stagingApi checkpoint helpers (coverage)', () => {
  it('getBranchStagedPatch throws 400 when branchName is missing', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.getBranchStagedPatch(1, '')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getBranchStagedPatch throws 400 when branchName is not a string', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.getBranchStagedPatch(1, 123)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getBranchStagedPatch throws 400 when branch is main', async () => {
    const staging = createBranchWorkflowStaging(buildCore({ branchType: 'main' }));

    await expect(staging.getBranchStagedPatch(1, 'main')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getBranchStagedPatch returns null patch when git is not ready', async () => {
    const core = buildCore({ gitReady: false });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.getBranchStagedPatch(1, 'agent/branch');
    expect(result).toEqual({ patch: null, files: [] });
    expect(core.runProjectGit).not.toHaveBeenCalled();
  });

  it('getBranchStagedPatch returns files but null patch when diff is empty', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'diff' && args?.[1] === '--cached' && args?.[2] === '--name-only') {
          return { stdout: 'src/a.js\n' };
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.getBranchStagedPatch(1, 'agent/branch');
    expect(result).toEqual({ patch: null, files: ['src/a.js'] });
  });

  it('getBranchStagedPatch returns patch + files when git is ready and diff is present', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'diff' && args?.[1] === '--cached' && args?.[2] === '--name-only') {
          return { stdout: 'src/a.js\nsrc/b.js\n' };
        }
        if (args?.[0] === 'diff' && args?.[1] === '--cached') {
          return { stdout: 'diff --git a/src/a.js b/src/a.js\n' };
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.getBranchStagedPatch(1, 'agent/branch');
    expect(result.patch).toContain('diff --git');
    expect(result.files).toEqual(['src/a.js', 'src/b.js']);
    expect(core.checkoutBranch).toHaveBeenCalled();
    expect(core.checkoutGitBranch).toHaveBeenCalled();
  });

  it('getBranchStagedPatch tolerates git diff failures and returns empty snapshot', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'diff') {
          throw new Error('git diff failed');
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.getBranchStagedPatch(1, 'agent/branch');
    expect(result).toEqual({ patch: null, files: [] });
  });

  it('applyBranchPatch returns applied=false when patch is blank', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    const result = await staging.applyBranchPatch(1, 'agent/branch', { patch: '   ' });
    expect(result).toEqual({ applied: false, files: [] });
  });

  it('applyBranchPatch returns applied=false when patch is not a string', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    const result = await staging.applyBranchPatch(1, 'agent/branch', { patch: 123 });
    expect(result).toEqual({ applied: false, files: [] });
  });

  it('applyBranchPatch throws 400 when branchName is not a string', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.applyBranchPatch(1, 123, { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('applyBranchPatch throws 400 when branchName is missing', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.applyBranchPatch(1, '', { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('applyBranchPatch throws 400 when branch is main', async () => {
    const staging = createBranchWorkflowStaging(buildCore({ branchType: 'main' }));

    await expect(staging.applyBranchPatch(1, 'main', { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('applyBranchPatch throws 400 when git is not ready', async () => {
    const core = buildCore({ gitReady: false });
    const staging = createBranchWorkflowStaging(core);

    await expect(staging.applyBranchPatch(1, 'agent/branch', { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('applyBranchPatch throws 500 when git apply fails and cleans temp directory', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'apply') {
          throw new Error('apply failed');
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    await expect(staging.applyBranchPatch(1, 'agent/branch', { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 500 });
    expect(core.fs.rm).toHaveBeenCalled();
  });

  it('applyBranchPatch uses fallback error message when git apply throws without message', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'apply') {
          throw {};
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    await expect(staging.applyBranchPatch(1, 'agent/branch', { patch: 'diff --git a/a b/a\n' })).rejects.toMatchObject({ statusCode: 500 });
  });

  it('applyBranchPatch applies patch and stages listed files', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'apply') {
          return { stdout: '' };
        }
        if (args?.[0] === 'add') {
          return { stdout: '' };
        }
        if (args?.[0] === 'diff' && args?.[1] === '--cached' && args?.[2] === '--name-only') {
          return { stdout: args?.[args.length - 1] || '' };
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);

    const result = await staging.applyBranchPatch(1, 'agent/branch', {
      patch: 'diff --git a/src/a.js b/src/a.js\n',
      files: ['src/a.js', null],
      status: '   '
    });

    expect(result).toMatchObject({ applied: true, files: ['src/a.js'] });
    expect(core.runProjectGit).toHaveBeenCalledWith(expect.anything(), ['apply', '--whitespace=nowarn', expect.stringContaining('checkpoint.patch')]);
    expect(core.fs.writeFile).toHaveBeenCalled();
    expect(core.run).toHaveBeenCalled();

    const runArgs = core.run.mock.calls.at(-1)?.[1];
    expect(runArgs?.[0]).toBe('active');
  });

  it('applyBranchPatch swallows tmp cleanup errors after applying patch', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'apply') {
          return { stdout: '' };
        }
        if (args?.[0] === 'add') {
          return { stdout: '' };
        }
        return { stdout: '' };
      }
    });

    core.fs.rm.mockRejectedValueOnce(new Error('rm failed'));

    const staging = createBranchWorkflowStaging(core);

    const result = await staging.applyBranchPatch(1, 'agent/branch', {
      patch: 'diff --git a/src/a.js b/src/a.js\n',
      files: [],
      status: 'active'
    });

    expect(result.applied).toBe(true);
  });

  it('applyBranchPatch treats non-array file payloads as empty lists', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'apply') {
          return { stdout: '' };
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);

    const result = await staging.applyBranchPatch(1, 'agent/branch', {
      patch: 'diff --git a/src/a.js b/src/a.js\n',
      files: 'src/a.js',
      status: 'active'
    });

    expect(result).toMatchObject({ applied: true, files: [] });
  });

  it('getBranchHeadSha throws 400 when branchName is missing', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.getBranchHeadSha(1, '')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getBranchHeadSha throws 400 when branch is main', async () => {
    const staging = createBranchWorkflowStaging(buildCore({ branchType: 'main' }));

    await expect(staging.getBranchHeadSha(1, 'main')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getBranchHeadSha returns null when git is not ready', async () => {
    const core = buildCore({ gitReady: false });
    const staging = createBranchWorkflowStaging(core);

    const sha = await staging.getBranchHeadSha(1, 'agent/branch');
    expect(sha).toBe(null);
    expect(core.ensureGitBranchExists).not.toHaveBeenCalled();
    expect(core.runProjectGit).not.toHaveBeenCalled();
  });

  it('getBranchHeadSha returns the current HEAD sha when git is ready', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'rev-parse') {
          return { stdout: 'abc123\n' };
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);
    const sha = await staging.getBranchHeadSha(1, 'agent/branch');

    expect(sha).toBe('abc123');
    expect(core.ensureGitBranchExists).toHaveBeenCalled();
    expect(core.checkoutGitBranch).toHaveBeenCalled();
  });

  it('getBranchHeadSha returns null when HEAD stdout is empty', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'rev-parse') {
          return { stdout: '   \n' };
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);
    const sha = await staging.getBranchHeadSha(1, 'agent/branch');

    expect(sha).toBe(null);
  });

  it('getBranchHeadSha returns null when HEAD stdout is not a string', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'rev-parse') {
          return { stdout: 123 };
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);
    const sha = await staging.getBranchHeadSha(1, 'agent/branch');

    expect(sha).toBe(null);
  });

  it('resetBranchToCommit throws 400 when branchName is missing', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.resetBranchToCommit(1, '', { commitSha: 'abc' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('resetBranchToCommit throws 400 when commitSha is missing', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.resetBranchToCommit(1, 'agent/branch', { commitSha: '   ' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('resetBranchToCommit throws 400 when commitSha is not a string', async () => {
    const staging = createBranchWorkflowStaging(buildCore());

    await expect(staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 123 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('resetBranchToCommit throws 400 when branch is main', async () => {
    const staging = createBranchWorkflowStaging(buildCore({ branchType: 'main' }));

    await expect(staging.resetBranchToCommit(1, 'main', { commitSha: 'abc' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('resetBranchToCommit skips git operations when git is not ready', async () => {
    const core = buildCore({ gitReady: false });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 'abc', status: 'active' });

    expect(core.checkoutBranch).toHaveBeenCalled();
    expect(core.runProjectGit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reset: true,
      git: { ready: false, head: null, error: null }
    });
  });

  it('resetBranchToCommit throws 500 when git reset fails', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'reset') {
          throw new Error('reset failed');
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    await expect(staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 'abc', status: 'active' })).rejects.toMatchObject({
      statusCode: 500
    });
  });

  it('resetBranchToCommit uses fallback error message when git reset throws without message', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'reset') {
          throw {};
        }
        return { stdout: '' };
      }
    });

    const staging = createBranchWorkflowStaging(core);

    await expect(staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 'abc' })).rejects.toMatchObject({
      statusCode: 500
    });
  });

  it('resetBranchToCommit returns resolved HEAD sha when git reset succeeds', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'rev-parse') {
          return { stdout: 'newsha\n' };
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 'abc', status: 'active' });

    expect(core.runProjectGit).toHaveBeenCalledWith(expect.anything(), ['reset', '--hard', 'abc']);
    expect(core.runProjectGit).toHaveBeenCalledWith(expect.anything(), ['clean', '-fd']);
    expect(result).toMatchObject({
      reset: true,
      git: { ready: true, head: 'newsha', error: null }
    });
  });

  it('resetBranchToCommit falls back to commitSha when resolved HEAD is missing and defaults status', async () => {
    const core = buildCore({
      gitReady: true,
      runProjectGitImpl: async (_context, args) => {
        if (args?.[0] === 'rev-parse') {
          return {};
        }
        return { stdout: '' };
      }
    });
    const staging = createBranchWorkflowStaging(core);

    const result = await staging.resetBranchToCommit(1, 'agent/branch', { commitSha: 'abc' });

    expect(result).toMatchObject({
      reset: true,
      git: { ready: true, head: 'abc', error: null }
    });
    expect(core.run).toHaveBeenCalled();
    const params = core.run.mock.calls.at(-1)?.[1];
    expect(params?.[0]).toBe('active');
  });
});
