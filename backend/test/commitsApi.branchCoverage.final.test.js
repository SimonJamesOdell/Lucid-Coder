import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('commitsApi remaining branch coverage', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  const makeApi = ({ runProjectGit, llmClient } = {}) => createBranchWorkflowCommits({
    withStatusCode,
    ensureMainBranch: vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' }),
    getProjectContext: vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' }),
    runProjectGit: runProjectGit ?? vi.fn().mockResolvedValue({ stdout: '' }),
    llmClient,
    normalizeCommitLimit: (n) => n,
    parseGitLog: () => [],
    getBranchByName: vi.fn(),
    cancelScheduledAutoTests: vi.fn(),
    isCssOnlyBranchDiff: vi.fn(),
    listBranchChangedPaths: vi.fn(),
    ensureGitBranchExists: vi.fn(),
    checkoutGitBranch: vi.fn(),
    run: vi.fn(),
    get: vi.fn(),
    setCurrentBranch: vi.fn(),
    fs,
    path
  });

  it('safeGitStdout uses fallback "" when stdout is null', async () => {
    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('log --no-merges')) return { stdout: null };
      if (cmd.startsWith('diff --name-status')) return { stdout: null };
      return { stdout: '' };
    });

    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('{"entry":"Fixed null stdout"}')
    };

    const api = makeApi({ runProjectGit, llmClient });
    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Fixed null stdout');
  });

  it('buildChangelogEntryFromBranchChanges repair path stringifies non-string raw (truthy and falsy)', async () => {
    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });

    const llmClient = {
      generateResponse: vi.fn()
        .mockResolvedValueOnce({ not: 'a string' })
        .mockResolvedValueOnce('{"entry":"Repaired"}')
    };

    const api = makeApi({ runProjectGit, llmClient });
    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Repaired');

    llmClient.generateResponse
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('{"entry":"Repaired again"}');

    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Repaired again');
  });

  it('ensureChangelogUnreleasedEntry preserves CRLF output', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');

    await fs.writeFile(
      changelogPath,
      ['# Changelog', '', '## Unreleased', '', '- Existing', ''].join('\r\n'),
      'utf8'
    );

    const api = makeApi();
    await expect(api.__testOnly.ensureChangelogUnreleasedEntry(tmpDir, 'Inserted')).resolves.toEqual({ updated: true });

    const updated = await fs.readFile(changelogPath, 'utf8');
    expect(updated).toContain('\r\n');
  });

  it('preMergeBumpVersionAndChangelog falls back to 0.1.0 when VERSION is empty', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '', 'utf8');

    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit });

    const result = await api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath: tmpDir },
      { name: 'feature/x', description: '' },
      { changelogTracked: false }
    );

    expect(result).toEqual({ previous: '0.1.0', next: '0.1.1' });
  });

  it('preMergeBumpVersionAndChangelog uses "feature branch" fallback name when description is default', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit });

    await expect(api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath: tmpDir },
      { name: '', description: 'AI generated feature branch' },
      { changelogTracked: true }
    )).resolves.toMatchObject({ next: '0.1.1' });
  });

  it('preMergeBumpVersionAndChangelog uses LLM-generated entry when available', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- note\n', 'utf8');

    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('log --no-merges')) return { stdout: '' };
      if (cmd.startsWith('diff --name-status')) return { stdout: '' };
      return { stdout: '' };
    });

    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('{"entry":"LLM entry"}')
    };

    const api = makeApi({ runProjectGit, llmClient });
    const result = await api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath: tmpDir },
      { name: 'feature/x', description: '' },
      { changelogTracked: true }
    );

    expect(result).toMatchObject({ next: '0.1.1' });
  });
});

describe('commitsApi: type-coercion branch coverage in commit APIs', () => {
  let runProjectGit;
  let getProjectContext;
  let ensureMainBranch;

  const projectId = 777;

  beforeEach(() => {
    runProjectGit = vi.fn();
    getProjectContext = vi.fn().mockResolvedValue({ gitReady: true, projectPath: 'X' });
    ensureMainBranch = vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' });
  });

  const api = () => createBranchWorkflowCommits({
    withStatusCode,
    ensureMainBranch,
    getProjectContext,
    runProjectGit,
    llmClient: null,
    normalizeCommitLimit: (n) => n,
    parseGitLog: () => [],
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

  it('getCommitDetails rejects non-string commitSha (type coercion)', async () => {
    const { getCommitDetails } = api();
    await expect(getCommitDetails(projectId, 123)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getCommitDetails uses fallbacks when metadata fields are missing', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:')) {
        return { stdout: [''].join('') };
      }
      if (cmd.startsWith('diff-tree')) {
        return { stdout: ['M file.txt', ''].join('\n') };
      }
      return { stdout: '' };
    });

    const { getCommitDetails } = api();
    const result = await getCommitDetails(projectId, 'abc');

    expect(result.author.name).toBe('Unknown');
    expect(result.author.email).toBe('');
    expect(result.message).toBe('');
  });

  it('getCommitFileDiffContent rejects non-string inputs (type coercion)', async () => {
    const { getCommitFileDiffContent } = api();

    await expect(getCommitFileDiffContent(projectId, 123, 'x')).rejects.toMatchObject({ statusCode: 400 });
    await expect(getCommitFileDiffContent(projectId, 'abc', 456)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getCommitFileDiffContent handles empty parent output and non-string show stdout', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:%P')) {
        return { stdout: '\n' };
      }
      if (cmd === 'show abc:path.txt') {
        return { stdout: Buffer.from('new') };
      }
      return { stdout: null };
    });

    const { getCommitFileDiffContent } = api();
    const result = await getCommitFileDiffContent(projectId, 'abc', 'path.txt');

    expect(result.originalLabel).toBe('Empty');
    expect(result.modified).toBe('new');
  });

  it('getCommitFileDiffContent covers nullish parent stdout and nullish show stdout', async () => {
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('show abc --quiet --pretty=format:%P')) {
        return { stdout: null };
      }
      if (cmd === 'show abc:path.txt') {
        return { stdout: null };
      }
      return { stdout: '' };
    });

    const { getCommitFileDiffContent } = api();
    const result = await getCommitFileDiffContent(projectId, 'abc', 'path.txt');

    expect(result.originalLabel).toBe('Empty');
    expect(result.modified).toBe('');
  });

  it('revertCommit rejects non-string commitSha (type coercion)', async () => {
    const { revertCommit } = api();
    await expect(revertCommit(projectId, 123)).rejects.toMatchObject({ statusCode: 400 });
  });
});
