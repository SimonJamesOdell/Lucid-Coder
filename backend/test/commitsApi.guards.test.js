import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => { error.statusCode = code; return error; };

describe('commitsApi core guards', () => {
  let core;
  let runProjectGit;
  let ensureMainBranch;
  let getProjectContext;

  const projectId = 456;

  beforeEach(() => {
    runProjectGit = vi.fn();
    ensureMainBranch = vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' });
    getProjectContext = vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' });

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
      setCurrentBranch: vi.fn()
    };
  });

  const api = () => createBranchWorkflowCommits(core);

  it('getCommitDetails: commitSha is required', async () => {
    const { getCommitDetails } = api();
    await expect(getCommitDetails(projectId, ''))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/commitSha is required/i) });
  });

  it('getCommitFileDiffContent: commitSha is required', async () => {
    const { getCommitFileDiffContent } = api();
    await expect(getCommitFileDiffContent(projectId, '', 'path.txt'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/commitSha is required/i) });
  });

  it('getCommitFileDiffContent: filePath is required', async () => {
    const { getCommitFileDiffContent } = api();
    await expect(getCommitFileDiffContent(projectId, 'abc123', ''))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/filePath is required/i) });
  });

  it('revertCommit: commitSha is required', async () => {
    const { revertCommit } = api();
    await expect(revertCommit(projectId, ''))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/commitSha is required/i) });
  });

  it('squashCommits: rejects when git is not ready', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    const { squashCommits } = api();
    await expect(squashCommits(projectId, { olderSha: 'abc', newerSha: 'def' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Git repository unavailable/i) });
  });
});
