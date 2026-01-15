import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import db, { initializeDatabase, createProject } from '../database.js';
import * as branchWorkflow from '../services/branchWorkflow.js';
import * as gitUtils from '../utils/git.js';

const exec = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, (err) => {
    if (err) {
      reject(err);
      return;
    }
    resolve();
  });
});

describe('branchWorkflow commit history and details helpers', () => {
  let projectId;
  let projectPath;
  let gitSpy;

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    await exec('DELETE FROM test_runs');
    await exec('DELETE FROM branches');
    await exec('DELETE FROM projects');
    projectPath = `C:/tmp/history-${Date.now()}`;
    const project = await createProject({
      name: `History Project ${Date.now()}`,
      description: 'Tracks commit history helpers',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
    projectId = project.id;
    gitSpy = vi.spyOn(gitUtils, 'runGitCommand');
  });

  afterEach(() => {
    gitSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId, null);
  });

  it('returns empty commit history when git is unavailable', async () => {
    const history = await branchWorkflow.getCommitHistory(projectId);
    expect(history).toEqual([]);
    expect(gitSpy).not.toHaveBeenCalled();
  });

  it('parses git log output when repository is ready', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const entry = [
      'abc1234',
      'Ada Lovelace',
      'ada@example.com',
      '2024-10-01T12:00:00Z',
      'feat: add analytics',
      'parent1 parent2'
    ].join('\x1f');
    gitSpy.mockResolvedValue({ stdout: `${entry}\x1e` });

    const history = await branchWorkflow.getCommitHistory(projectId, { limit: 5 });

    expect(gitSpy).toHaveBeenCalledWith(
      projectPath,
      expect.arrayContaining(['log', '-5']),
      undefined
    );
    expect(history).toEqual([
      expect.objectContaining({
        sha: 'abc1234',
        shortSha: 'abc1234'.slice(0, 7),
        author: expect.objectContaining({ name: 'Ada Lovelace', email: 'ada@example.com' }),
        parentShas: ['parent1', 'parent2'],
        canRevert: true,
        isInitialCommit: false
      })
    ]);
  });

  it('returns empty history when git log command fails', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
    gitSpy.mockRejectedValueOnce(new Error('git log failed'));

    const history = await branchWorkflow.getCommitHistory(projectId);

    expect(history).toEqual([]);
  });

  it('throws when git repository is unavailable for commit details', async () => {
    await expect(branchWorkflow.getCommitDetails(projectId, 'abc123')).rejects.toThrow(/unavailable/i);
  });

  it('throws when commitSha is missing', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
    await expect(branchWorkflow.getCommitDetails(projectId)).rejects.toThrow(/commitSha is required/i);
  });

  it('returns parsed commit details from git output', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    gitSpy.mockImplementation(async (cwd, args) => {
      if (args[0] === 'show') {
        const meta = [
          'deadbeef',
          'Grace Hopper',
          'grace@example.com',
          '2024-09-10T15:30:00Z',
          'fix: squash bug',
          'parent-a parent-b',
          'Body line one\nBody line two'
        ].join('\x1f');
        return { stdout: meta };
      }

      if (args[0] === 'diff-tree') {
        return { stdout: 'M\tbackend/app.js\nA\tREADME.md' };
      }

      return { stdout: '' };
    });

    const details = await branchWorkflow.getCommitDetails(projectId, 'deadbeef');

    expect(details).toMatchObject({
      sha: 'deadbeef',
      shortSha: 'deadbee',
      message: 'fix: squash bug',
      author: { name: 'Grace Hopper', email: 'grace@example.com' },
      parentShas: ['parent-a', 'parent-b'],
      canRevert: true,
      isInitialCommit: false
    });
    expect(details.files).toEqual([
      { path: 'backend/app.js', status: 'M' },
      { path: 'README.md', status: 'A' }
    ]);
  });

  it('wraps git errors when commit details cannot be loaded', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
    gitSpy.mockRejectedValueOnce(new Error('show blew up'));

    await expect(branchWorkflow.getCommitDetails(projectId, 'deadbeef')).rejects.toThrow(/Failed to load commit details/i);
  });

  it('reverts commits via git when repository is ready', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
    gitSpy.mockResolvedValue({ stdout: '' });

    const result = await branchWorkflow.revertCommit(projectId, 'abc123');

    expect(result).toEqual({ reverted: 'abc123' });
    expect(gitSpy).toHaveBeenCalledWith(
      projectPath,
      ['revert', '--no-edit', 'abc123'],
      undefined
    );
  });

  it('requires commitSha when reverting commits with git access', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await expect(branchWorkflow.revertCommit(projectId)).rejects.toThrow(/commitSha is required/i);
  });

  it('throws when revert commit is requested without git context', async () => {
    await expect(branchWorkflow.revertCommit(projectId, 'abc123')).rejects.toThrow(/unavailable/i);
  });

  it('propagates git errors when revert fails', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
    gitSpy.mockRejectedValueOnce(new Error('revert conflict'));

    await expect(branchWorkflow.revertCommit(projectId, 'abc123')).rejects.toThrow(/Failed to revert commit/i);
  });
});
