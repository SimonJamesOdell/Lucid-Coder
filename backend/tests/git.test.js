import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';

const spawnQueue = [];
const spawnMock = vi.fn();
const statMock = vi.fn();

vi.mock('child_process', () => ({
  __esModule: true,
  spawn: (...args) => spawnMock(...args)
}));

vi.mock('fs/promises', () => ({
  __esModule: true,
  default: {
    stat: (...args) => statMock(...args)
  }
}));

const git = await import('../utils/git.js');

const queueSpawnResult = (config) => {
  spawnQueue.push(config);
};

const createMockChild = (config = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (config.error) {
      child.emit('error', config.error);
      return;
    }
    if (config.stdout !== undefined) {
      child.stdout.emit('data', Buffer.from(config.stdout));
    }
    if (config.stderr !== undefined) {
      child.stderr.emit('data', Buffer.from(config.stderr));
    }
    child.emit('close', config.code ?? 0);
  }, 0);
  return child;
};

const attachSpawnImplementation = () => {
  spawnMock.mockImplementation(() => {
    if (!spawnQueue.length) {
      throw new Error('No spawn result queued');
    }
    return createMockChild(spawnQueue.shift());
  });
};

beforeEach(() => {
  spawnQueue.length = 0;
  spawnMock.mockReset();
  statMock.mockReset();
  attachSpawnImplementation();
});

describe('runGitCommand', () => {
  test('resolves stdout and stderr when command succeeds', async () => {
    queueSpawnResult({ stdout: 'main\n', stderr: '', code: 0 });
    const result = await git.runGitCommand('/repo', ['status']);
    expect(result.stdout).toBe('main\n');
    expect(spawnMock).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({ cwd: '/repo' }));
  });

  test('rejects when command exits with non-zero code', async () => {
    queueSpawnResult({ stderr: 'fatal: not a git repository', code: 128 });
    await expect(git.runGitCommand('/repo', ['status'])).rejects.toThrow(/not a git repository/);
  });

  test('prefers stdout text when stderr is empty on failure', async () => {
    queueSpawnResult({ stdout: 'fatal from stdout', stderr: '', code: 1 });
    await expect(git.runGitCommand('/repo', ['status'])).rejects.toThrow(/fatal from stdout/);
  });

  test('falls back to default failure message when no output is present', async () => {
    queueSpawnResult({ stdout: '', stderr: '', code: 42 });
    await expect(git.runGitCommand('/repo', ['status'])).rejects.toThrow(/git status failed with code 42/);
  });

  test('resolves even on failure when allowFailure is true', async () => {
    queueSpawnResult({ stderr: 'fatal', code: 1 });
    const result = await git.runGitCommand('/repo', ['status'], { allowFailure: true });
    expect(result.code).toBe(1);
  });

  test('throws friendly error when git is missing', async () => {
    queueSpawnResult({ error: { code: 'ENOENT' } });
    await expect(git.runGitCommand('/repo', ['status'])).rejects.toMatchObject({ code: 'GIT_MISSING' });
  });

  test('propagates unexpected child process errors', async () => {
    queueSpawnResult({ error: { code: 'EPERM', message: 'fatal crash' } });
    await expect(git.runGitCommand('/repo', ['status'])).rejects.toMatchObject({ code: 'EPERM', message: 'fatal crash' });
  });

  test('requires project path', async () => {
    await expect(git.runGitCommand('', ['status'])).rejects.toThrow('Cannot run git command without project path');
  });
});

describe('git helpers', () => {
  const expectSpawnArgs = (index) => spawnMock.mock.calls[index]?.[1];

  test('ensureGitRepository requires project path', async () => {
    await expect(git.ensureGitRepository()).rejects.toThrow('Project path is required to ensure git repository');
  });

  test('ensureGitRepository returns early when repo already exists', async () => {
    queueSpawnResult({ stdout: 'true\n', code: 0 });
    await git.ensureGitRepository('/repo');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(expectSpawnArgs(0)).toEqual(['rev-parse', '--is-inside-work-tree']);
  });

  test('ensureGitRepository rethrows unexpected rev-parse errors', async () => {
    queueSpawnResult({ stderr: 'fatal', code: 1 });
    await expect(git.ensureGitRepository('/repo')).rejects.toThrow(/fatal/);
  });

  test('ensureGitRepository initializes repository with default branch', async () => {
    queueSpawnResult({ stderr: 'fatal', code: 128 });
    queueSpawnResult({ stdout: '', code: 0 });
    await git.ensureGitRepository('/repo', { defaultBranch: 'develop' });
    expect(expectSpawnArgs(0)).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(expectSpawnArgs(1)).toEqual(['init', '-b', 'develop']);
  });

  test('ensureGitRepository falls back when init -b is unsupported', async () => {
    queueSpawnResult({ stderr: 'fatal', code: 128 });
    queueSpawnResult({ stderr: 'unknown flag', code: 129 });
    queueSpawnResult({ stdout: '', code: 0 });
    queueSpawnResult({ stdout: '', code: 0 });
    await git.ensureGitRepository('/repo', { defaultBranch: 'main' });
    expect(expectSpawnArgs(2)).toEqual(['init']);
    expect(expectSpawnArgs(3)).toEqual(['checkout', '-B', 'main']);
  });

  test('ensureGitRepository rethrows init errors it cannot handle', async () => {
    queueSpawnResult({ stderr: 'fatal', code: 128 });
    queueSpawnResult({ stderr: 'boom', code: 255 });
    await expect(git.ensureGitRepository('/repo', { defaultBranch: 'main' })).rejects.toThrow(/boom/);
  });

  test('configureGitUser uses defaults when values missing', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    await git.configureGitUser('/repo');
    expect(expectSpawnArgs(0)).toEqual(['config', 'user.name', 'LucidCoder']);
    expect(expectSpawnArgs(1)).toEqual(['config', 'user.email', 'dev@lucidcoder.local']);
  });

  test('configureGitUser trims custom values', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    await git.configureGitUser('/repo', { name: '  Jane Dev  ', email: '  jane@example.com ' });
    expect(expectSpawnArgs(0)).toEqual(['config', 'user.name', 'Jane Dev']);
    expect(expectSpawnArgs(1)).toEqual(['config', 'user.email', 'jane@example.com']);
  });

  test('ensureInitialCommit commits when changes exist', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    await git.ensureInitialCommit('/repo', 'Bootstrap');
    expect(expectSpawnArgs(0)).toEqual(['add', '--all']);
    expect(expectSpawnArgs(1)).toEqual(['commit', '-m', 'Bootstrap']);
  });

  test('ensureInitialCommit ignores nothing to commit errors', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stderr: 'nothing to commit, working tree clean', code: 1 });
    await expect(git.ensureInitialCommit('/repo')).resolves.toBeUndefined();
  });

  test('ensureInitialCommit rethrows unexpected commit failures', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stderr: 'permission denied', code: 1 });
    await expect(git.ensureInitialCommit('/repo')).rejects.toThrow(/permission denied/);
  });

  test('getCurrentBranch trims stdout', async () => {
    queueSpawnResult({ stdout: 'feature/login\n', code: 0 });
    const branch = await git.getCurrentBranch('/repo');
    expect(branch).toBe('feature/login');
  });

  test('hasWorkingTreeChanges reflects git status output', async () => {
    queueSpawnResult({ stdout: '', code: 0 });
    queueSpawnResult({ stdout: ' M file.js', code: 0 });
    expect(await git.hasWorkingTreeChanges('/repo')).toBe(false);
    expect(await git.hasWorkingTreeChanges('/repo')).toBe(true);
  });

  test('stashWorkingTree returns null when branch missing or clean', async () => {
    expect(await git.stashWorkingTree('/repo')).toBeNull();
    queueSpawnResult({ stdout: '', code: 0 });
    expect(await git.stashWorkingTree('/repo', 'feature')).toBeNull();
  });

  test('stashWorkingTree stashes changes with label', async () => {
    queueSpawnResult({ stdout: ' M index.js', code: 0 });
    queueSpawnResult({ code: 0 });
    const label = await git.stashWorkingTree('/repo', 'feature/login');
    expect(label).toBe('lucidcoder-auto/feature/login');
    expect(expectSpawnArgs(1)).toEqual([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'lucidcoder-auto/feature/login'
    ]);
  });

  test('popBranchStash returns false when branch name missing', async () => {
    expect(await git.popBranchStash('/repo')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('popBranchStash returns false when label missing', async () => {
    queueSpawnResult({ stdout: '', code: 0 });
    expect(await git.popBranchStash('/repo', 'feature')).toBe(false);
  });

  test('popBranchStash pops label when present', async () => {
    queueSpawnResult({ stdout: 'stash@{0}: On main: work lucidcoder-auto/feature\n', code: 0 });
    queueSpawnResult({ code: 0 });
    expect(await git.popBranchStash('/repo', 'feature')).toBe(true);
    expect(expectSpawnArgs(1)).toEqual(['stash', 'pop', 'stash@{0}']);
  });

  test('popBranchStash returns false when stash entry lacks reference', async () => {
    queueSpawnResult({ stdout: 'random lucidcoder-auto/feature\n', code: 0 });
    expect(await git.popBranchStash('/repo', 'feature')).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('commitAllChanges returns true when commit succeeds', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    expect(await git.commitAllChanges('/repo', 'feat: add UI')).toBe(true);
    expect(expectSpawnArgs(0)).toEqual(['add', '--all']);
    expect(expectSpawnArgs(1)).toEqual(['commit', '-m', 'feat: add UI']);
  });

  test('commitAllChanges returns false for empty commits', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stderr: 'nothing to commit, working tree clean', code: 1 });
    expect(await git.commitAllChanges('/repo', 'noop')).toBe(false);
  });

  test('commitAllChanges rethrows unexpected commit failures', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stderr: 'fatal error', code: 1 });
    await expect(git.commitAllChanges('/repo', 'msg')).rejects.toThrow(/fatal error/);
  });

  test('ensureWorktreeClean skips when tree clean', async () => {
    queueSpawnResult({ stdout: '', code: 0 });
    expect(await git.ensureWorktreeClean('/repo')).toBe(false);
  });

  test('ensureWorktreeClean commits dirty tree with default message', async () => {
    queueSpawnResult({ stdout: '?? new.txt', code: 0 });
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    expect(await git.ensureWorktreeClean('/repo', 'feature/login')).toBe(true);
    expect(expectSpawnArgs(1)).toEqual(['add', '--all']);
    expect(expectSpawnArgs(2)).toEqual(['commit', '-m', 'chore(feature/login): auto-save']);
  });

  test('ensureWorktreeClean uses provided commit message', async () => {
    queueSpawnResult({ stdout: ' M staged.js', code: 0 });
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    const custom = 'docs: refresh README';
    expect(await git.ensureWorktreeClean('/repo', 'feature/login', custom)).toBe(true);
    expect(expectSpawnArgs(2)).toEqual(['commit', '-m', custom]);
  });

  test('ensureWorktreeClean falls back to workspace label when branch missing', async () => {
    queueSpawnResult({ stdout: ' M staged.js', code: 0 });
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    expect(await git.ensureWorktreeClean('/repo')).toBe(true);
    expect(expectSpawnArgs(2)).toEqual(['commit', '-m', 'chore(workspace): auto-save']);
  });

  test('removeBranchStashes skips when branch missing', async () => {
    await git.removeBranchStashes('/repo');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('removeBranchStashes drops each matching stash', async () => {
    queueSpawnResult({
      stdout: [
        'stash@{0}: On feature: first lucidcoder-auto/feature',
        'stash@{1}: On feature: other lucidcoder-auto/feature'
      ].join('\n'),
      code: 0
    });
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });
    await git.removeBranchStashes('/repo', 'feature');
    expect(expectSpawnArgs(1)).toEqual(['stash', 'drop', 'stash@{0}']);
    expect(expectSpawnArgs(2)).toEqual(['stash', 'drop', 'stash@{1}']);
  });

  test('removeBranchStashes skips non matching lines and malformed entries', async () => {
    queueSpawnResult({
      stdout: [
        'stash@{0}: On feature: unrelated change',
        'malformed entry lucidcoder-auto/feature'
      ].join('\n'),
      code: 0
    });
    await git.removeBranchStashes('/repo', 'feature');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('fileExistsInProject returns false without relative path', async () => {
    expect(await git.fileExistsInProject('/repo')).toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  test('fileExistsInProject resolves true when stat reports file', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true });
    const exists = await git.fileExistsInProject('/repo', 'README.md');
    expect(exists).toBe(true);
    expect(statMock).toHaveBeenCalledWith(path.join('/repo', 'README.md'));
  });

  test('fileExistsInProject returns false on ENOENT', async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    statMock.mockRejectedValueOnce(error);
    expect(await git.fileExistsInProject('/repo', 'README.md')).toBe(false);
  });

  test('fileExistsInProject rethrows unexpected fs errors', async () => {
    const error = new Error('boom');
    error.code = 'EACCES';
    statMock.mockRejectedValueOnce(error);
    await expect(git.fileExistsInProject('/repo', 'README.md')).rejects.toThrow('boom');
  });
});
