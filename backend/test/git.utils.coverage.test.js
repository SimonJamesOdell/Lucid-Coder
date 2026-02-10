import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnQueue = [];
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  __esModule: true,
  spawn: (...args) => spawnMock(...args)
}));

const queueSpawnResult = (config) => {
  spawnQueue.push(config);
};

const createMockChild = (config = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
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

const git = await import('../utils/git.js');

beforeEach(() => {
  spawnQueue.length = 0;
  spawnMock.mockReset();
  attachSpawnImplementation();
});

describe('git utils coverage', () => {
  it('commitAllChanges returns false for nothing-to-commit errors', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stderr: 'nothing to commit, working tree clean', code: 1 });

    await expect(git.commitAllChanges('/repo', 'noop')).resolves.toBe(false);
  });

  it('commitAllChanges returns false when nothing-to-commit is on stdout', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ stdout: 'nothing to commit, working tree clean', stderr: '', code: 1 });

    await expect(git.commitAllChanges('/repo', 'noop')).resolves.toBe(false);
  });

  it('discardWorkingTree runs reset and clean', async () => {
    queueSpawnResult({ code: 0 });
    queueSpawnResult({ code: 0 });

    await expect(git.discardWorkingTree('/repo')).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toEqual(['reset', '--hard']);
    expect(spawnMock.mock.calls[1][1]).toEqual(['clean', '-fd']);
  });
});
