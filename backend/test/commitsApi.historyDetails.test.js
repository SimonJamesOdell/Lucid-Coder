import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('commitsApi history/details coverage', () => {
  let runProjectGit;
  let getProjectContext;
  let ensureMainBranch;
  let parseGitLog;

  const projectId = 42;

  beforeEach(() => {
    runProjectGit = vi.fn();
    getProjectContext = vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' });
    ensureMainBranch = vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' });
    parseGitLog = vi.fn().mockReturnValue([{ sha: 'abc' }]);
  });

  const api = () => createBranchWorkflowCommits({
    withStatusCode,
    ensureMainBranch,
    getProjectContext,
    runProjectGit,
    llmClient: null,
    normalizeCommitLimit: (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 50),
    parseGitLog,
    getBranchByName: vi.fn(),
    cancelScheduledAutoTests: vi.fn(),
    isCssOnlyBranchDiff: vi.fn(),
    listBranchChangedPaths: vi.fn(),
    ensureGitBranchExists: vi.fn(),
    checkoutGitBranch: vi.fn(),
    run: vi.fn(),
    get: vi.fn(),
    setCurrentBranch: vi.fn(),
    fs: null,
    path: null
  });

  it('getCommitHistory returns [] when git is not ready', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    const { getCommitHistory } = api();

    await expect(getCommitHistory(projectId)).resolves.toEqual([]);
  });

  it('getCommitHistory parses git log output', async () => {
    runProjectGit.mockResolvedValueOnce({ stdout: 'rawlog' });
    const { getCommitHistory } = api();

    await expect(getCommitHistory(projectId, { limit: 3 })).resolves.toEqual([{ sha: 'abc' }]);
    expect(parseGitLog).toHaveBeenCalledWith('rawlog');
  });

  it('getCommitHistory returns [] when git log fails', async () => {
    runProjectGit.mockRejectedValueOnce(new Error('git broke'));
    const { getCommitHistory } = api();

    await expect(getCommitHistory(projectId)).resolves.toEqual([]);
  });

  it('getCommitDetails throws 400 when git is not ready', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    const { getCommitDetails } = api();

    await expect(getCommitDetails(projectId, 'abc'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Git repository unavailable/i) });
  });

  it('getCommitDetails returns parsed metadata and files', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:')) {
        return { stdout: ['abc', 'Me', 'me@example.com', '2026-01-25', 'Subject', 'p1 p2', 'Body text'].join('\x1f') };
      }
      if (cmd.startsWith('diff-tree')) {
        return { stdout: ['M src/fileA.js', 'A path with spaces.txt', ''].join('\n') };
      }
      return { stdout: '' };
    });

    const { getCommitDetails } = api();
    const result = await getCommitDetails(projectId, 'abc');

    expect(result).toMatchObject({
      sha: 'abc',
      shortSha: 'abc',
      message: 'Subject',
      author: { name: 'Me', email: 'me@example.com' },
      parentCount: 2,
      canRevert: true,
      isInitialCommit: false
    });

    expect(result.files).toEqual([
      { path: 'src/fileA.js', status: 'M' },
      { path: 'path with spaces.txt', status: 'A' }
    ]);
  });

  it("getCommitDetails falls back file status to 'M' when diff-tree output omits it", async () => {
    const nativeTrim = String.prototype.trim;
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function mockTrim() {
      if (typeof this === 'string' && this.startsWith('PRESERVE:')) {
        return this.replace('PRESERVE:', '');
      }
      return nativeTrim.call(this);
    });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:')) {
        return { stdout: ['abc', 'Me', 'me@example.com', '2026-01-25', 'Subject', '', ''].join('\x1f') };
      }
      if (cmd.startsWith('diff-tree')) {
        return { stdout: 'PRESERVE:\tREADME.md' };
      }
      return { stdout: '' };
    });

    const { getCommitDetails } = api();
    const result = await getCommitDetails(projectId, 'abc');
    trimSpy.mockRestore();

    expect(result.files).toEqual([{ path: 'README.md', status: 'M' }]);
  });

  it('getCommitDetails throws 500 when git show fails', async () => {
    runProjectGit.mockRejectedValueOnce(new Error('nope'));
    const { getCommitDetails } = api();

    await expect(getCommitDetails(projectId, 'abc'))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to load commit details/i) });
  });

  it('getCommitFileDiffContent returns original/modified content and labels', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:%P')) {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'show parent123:path.txt') {
        return { stdout: 'old' };
      }
      if (cmd === 'show abc:path.txt') {
        return { stdout: 'new' };
      }
      return { stdout: '' };
    });

    const { getCommitFileDiffContent } = api();
    await expect(getCommitFileDiffContent(projectId, 'abc', 'path.txt')).resolves.toEqual({
      path: 'path.txt',
      original: 'old',
      modified: 'new',
      originalLabel: 'parent1',
      modifiedLabel: 'abc'
    });
  });

  it('getCommitFileDiffContent throws 400 when git is not ready', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    const { getCommitFileDiffContent } = api();

    await expect(getCommitFileDiffContent(projectId, 'abc', 'path.txt'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Git repository unavailable/i) });
  });

  it('getCommitFileDiffContent tolerates failures reading the original file', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:%P')) {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'show parent123:path.txt') {
        throw new Error('missing');
      }
      if (cmd === 'show abc:path.txt') {
        return { stdout: 'new' };
      }
      return { stdout: '' };
    });

    const { getCommitFileDiffContent } = api();
    const result = await getCommitFileDiffContent(projectId, 'abc', 'path.txt');
    expect(result.original).toBe('');
    expect(result.modified).toBe('new');
  });

  it('getCommitFileDiffContent falls back to Empty when parent sha lookup fails', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:%P')) {
        throw new Error('no parents');
      }
      if (cmd === 'show abc:path.txt') {
        return { stdout: 'new' };
      }
      return { stdout: '' };
    });

    const { getCommitFileDiffContent } = api();
    const result = await getCommitFileDiffContent(projectId, 'abc', 'path.txt');
    expect(result.originalLabel).toBe('Empty');
    expect(result.original).toBe('');
  });

  it('revertCommit throws 400 when git is not ready', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: false, projectPath: 'X' });
    const { revertCommit } = api();

    await expect(revertCommit(projectId, 'abc'))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Git repository unavailable/i) });
  });

  it('revertCommit returns reverted sha on success and throws 500 on failure', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show abc --quiet --pretty=format:%P') {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'revert --no-edit abc') {
        return { stdout: '' };
      }
      if (cmd === 'show def --quiet --pretty=format:%P') {
        return { stdout: 'parent456\n' };
      }
      if (cmd === 'revert --no-edit def') {
        throw new Error('revert failed');
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();

    await expect(revertCommit(projectId, 'abc')).resolves.toEqual({ reverted: 'abc' });

    await expect(revertCommit(projectId, 'def'))
      .rejects.toMatchObject({ statusCode: 500, message: expect.stringMatching(/Failed to revert commit/i) });
  });

  it('revertCommit handles failures without an explicit error message', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show nomsg --quiet --pretty=format:%P') {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'revert --no-edit nomsg') {
        throw {};
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();
    await expect(revertCommit(projectId, 'nomsg')).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/Failed to revert commit/i)
    });
  });

  it('revertCommit uses mainline parent when reverting merge commits', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show merge123 --quiet --pretty=format:%P') {
        return { stdout: 'parentA parentB\n' };
      }
      if (cmd === 'revert --no-edit -m 1 merge123') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();
    await expect(revertCommit(projectId, 'merge123')).resolves.toEqual({ reverted: 'merge123' });
  });

  it('revertCommit maps initial/root commit errors to 400', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show root123 --quiet --pretty=format:%P') {
        return { stdout: '' };
      }
      if (cmd === 'revert --no-edit root123') {
        throw new Error('cannot revert a root commit');
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();
    await expect(revertCommit(projectId, 'root123')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Initial commit cannot be reverted automatically/i)
    });
  });

  it('revertCommit returns noop when revert produces no changes', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show noop123 --quiet --pretty=format:%P') {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'revert --no-edit noop123') {
        throw new Error('nothing to commit, working tree clean');
      }
      if (cmd === 'revert --abort') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();
    await expect(revertCommit(projectId, 'noop123')).resolves.toEqual({ reverted: 'noop123', noop: true });
  });

  it('revertCommit still returns noop when revert --abort also fails', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'show noopAbort123 --quiet --pretty=format:%P') {
        return { stdout: 'parent123\n' };
      }
      if (cmd === 'revert --no-edit noopAbort123') {
        throw new Error('previous cherry-pick is now empty');
      }
      if (cmd === 'revert --abort') {
        throw new Error('abort failed');
      }
      return { stdout: '' };
    });

    const { revertCommit } = api();
    await expect(revertCommit(projectId, 'noopAbort123')).resolves.toEqual({
      reverted: 'noopAbort123',
      noop: true
    });
  });
});
