import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

const makeApi = ({ runProjectGit, llmClient, fs: fsOverride, path: pathOverride } = {}) => {
  const api = createBranchWorkflowCommits({
    withStatusCode,
    ensureMainBranch: vi.fn(),
    getProjectContext: vi.fn(),
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
    fs: fsOverride ?? fs,
    path: pathOverride ?? path
  });

  return api;
};

describe('commitsApi changelog helper coverage', () => {
  it('extractFirstJsonObject handles empty, full JSON, and embedded JSON', () => {
    const api = makeApi();

    expect(api.__testOnly.extractFirstJsonObject('')).toBe(null);
    expect(api.__testOnly.extractFirstJsonObject('   ')).toBe(null);
    expect(api.__testOnly.extractFirstJsonObject(null)).toBe(null);

    expect(api.__testOnly.extractFirstJsonObject('{"entry":"Hello"}')).toBe('{"entry":"Hello"}');
    expect(api.__testOnly.extractFirstJsonObject('prefix {"entry":"Hi"} suffix')).toBe('{"entry":"Hi"}');
  });

  it('parseChangelogEntryJson cleans and validates entry', () => {
    const api = makeApi();

    expect(api.__testOnly.parseChangelogEntryJson('')).toBe(null);
    expect(api.__testOnly.parseChangelogEntryJson('{"entry": 123}')).toBe(null);
    expect(api.__testOnly.parseChangelogEntryJson('{"entry":"- bad"}')).toBe(null);
    expect(api.__testOnly.parseChangelogEntryJson('{')).toBe(null);
    expect(api.__testOnly.parseChangelogEntryJson('{bad json}')).toBe(null);

    expect(api.__testOnly.parseChangelogEntryJson('{"entry":"- Fixed   spacing"}')).toBe('Fixed spacing');
  });

  it('buildChangelogEntryFromBranchChanges returns null for missing context/branch/llm', async () => {
    const apiNoLlm = makeApi({ llmClient: null });

    await expect(apiNoLlm.__testOnly.buildChangelogEntryFromBranchChanges({ gitReady: false }, { name: 'x' }))
      .resolves.toBe(null);
    await expect(apiNoLlm.__testOnly.buildChangelogEntryFromBranchChanges({ gitReady: true }, { name: '' }))
      .resolves.toBe(null);
    await expect(apiNoLlm.__testOnly.buildChangelogEntryFromBranchChanges({ gitReady: true }, { name: 'x' }))
      .resolves.toBe(null);
  });

  it('buildChangelogEntryFromBranchChanges parses JSON and normalizes entry', async () => {
    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('log --no-merges')) return { stdout: 'feat: add thing\nfix: bug\n' };
      if (cmd.startsWith('diff --name-status')) return { stdout: 'M fileA.js\nA fileB.js\n' };
      return { stdout: '' };
    });

    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('Here you go: {"entry":"- Added new thing"}')
    };

    const api = makeApi({ runProjectGit, llmClient });

    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '  Some hint  ' }
    )).resolves.toBe('Added new thing');

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('buildChangelogEntryFromBranchChanges retries with a repair prompt when initial output is invalid', async () => {
    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });

    const llmClient = {
      generateResponse: vi.fn()
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce('{"entry":"Fixed issue"}')
    };

    const api = makeApi({ runProjectGit, llmClient });

    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Fixed issue');

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
  });

  it('buildChangelogEntryFromBranchChanges tolerates git failures via safeGitStdout fallback', async () => {
    const runProjectGit = vi.fn(async () => {
      throw new Error('git exploded');
    });

    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('{"entry":"Fixed something"}')
    };

    const api = makeApi({ runProjectGit, llmClient });
    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Fixed something');
  });

  it('buildChangelogEntryFromBranchChanges returns null when LLM throws', async () => {
    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });

    const llmClient = {
      generateResponse: vi.fn().mockRejectedValue(new Error('boom'))
    };

    const api = makeApi({ runProjectGit, llmClient });

    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe(null);
  });

  it('buildChangelogEntryFromBranchChanges returns null when LLM rejects with a non-Error value', async () => {
    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });

    const llmClient = {
      generateResponse: vi.fn().mockRejectedValue(0)
    };

    const api = makeApi({ runProjectGit, llmClient });

    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe(null);
  });

  it('buildChangelogEntryFromBranchChanges coerces non-string git stdout', async () => {
    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('log --no-merges')) return { stdout: Buffer.from('feat: buffer\n') };
      if (cmd.startsWith('diff --name-status')) return { stdout: Buffer.from('M fileA.js\n') };
      return { stdout: '' };
    });

    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('{"entry":"Fixed from buffer"}')
    };

    const api = makeApi({ runProjectGit, llmClient });
    await expect(api.__testOnly.buildChangelogEntryFromBranchChanges(
      { gitReady: true },
      { name: 'feature/x', description: '' }
    )).resolves.toBe('Fixed from buffer');
  });
});

describe('commitsApi.ensureChangelogUnreleasedEntry', () => {
  let tmpDir;

  const makeHelper = () => makeApi().__testOnly.ensureChangelogUnreleasedEntry;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns updated:false for empty inputs', async () => {
    const ensure = makeHelper();
    await expect(ensure(null, 'x')).resolves.toEqual({ updated: false });
    await expect(ensure('', 'x')).resolves.toEqual({ updated: false });
    await expect(ensure('   ', 'x')).resolves.toEqual({ updated: false });

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await expect(ensure(tmpDir, '')).resolves.toEqual({ updated: false });
    await expect(ensure(tmpDir, '   ')).resolves.toEqual({ updated: false });
  });

  it('creates a new changelog when missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'Added feature')).resolves.toEqual({ updated: true });

    const text = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(text).toMatch(/# Changelog/);
    expect(text).toMatch(/## Unreleased/);
    expect(text).toMatch(/- Added feature/);
  });

  it('does not duplicate an existing bullet', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Added feature\n', 'utf8');

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'Added feature')).resolves.toEqual({ updated: false });
  });

  it('inserts an Unreleased section after title when missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0 (2026-01-01)\n\n- init\n', 'utf8');

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'New note')).resolves.toEqual({ updated: true });

    const text = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(text).toMatch(/# Changelog[\s\S]*## Unreleased[\s\S]*- New note/);
  });

  it('inserts a title when no title and no Unreleased exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '## 0.1.0 (2026-01-01)\n\n- init\n', 'utf8');

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'New note')).resolves.toEqual({ updated: true });

    const text = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(text).toMatch(/^# Changelog/m);
    expect(text).toMatch(/## Unreleased/);
    expect(text).toMatch(/- New note/);
  });

  it('inserts before existing bullets, skipping blank lines', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '', '- Existing', ''].join('\n'),
      'utf8'
    );

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'Inserted')).resolves.toEqual({ updated: true });

    const text = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    const unreleasedIndex = text.indexOf('## Unreleased');
    expect(unreleasedIndex).toBeGreaterThanOrEqual(0);

    const after = text.slice(unreleasedIndex);
    expect(after).toMatch(/## Unreleased[\s\S]*- Inserted\n- Existing/);
  });

  it('inserts into Unreleased when the next content is not a bullet and ensures trailing newline', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', 'Some text without trailing newline'].join('\n'),
      'utf8'
    );

    const ensure = makeHelper();
    await expect(ensure(tmpDir, 'Inserted')).resolves.toEqual({ updated: true });

    const text = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(text).toMatch(/## Unreleased[\s\S]*\n- Inserted\nSome text/);
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('commitsApi.preMergeBumpVersionAndChangelog', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = null;
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('bumps VERSION even when changelogTracked is false', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');

    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit });

    const result = await api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath: tmpDir },
      { name: 'feature/x', description: '' },
      { changelogTracked: false }
    );

    expect(result).toEqual({ previous: '0.1.0', next: '0.1.1' });
    expect((await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim()).toBe('0.1.1');

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds.some((c) => c.startsWith('add VERSION'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('commit -m chore: bump version to 0.1.1'))).toBe(true);
  });

  it('bumps version and rolls changelog when changelogTracked is true', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'backend', 'package.json'),
      JSON.stringify({ name: 'backend', version: '0.1.0' }, null, 2) + '\n',
      'utf8'
    );

    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit });

    const result = await api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath: tmpDir },
      { name: 'feature/x', description: 'desc' },
      { changelogTracked: true }
    );

    expect(result).toEqual({ previous: '0.1.0', next: '0.1.1' });

    const changelog = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/##\s+0\.1\.1\s+\(/);

    const cmds = runProjectGit.mock.calls.map((c) => c[1].join(' '));
    expect(cmds.some((c) => c.startsWith('add VERSION'))).toBe(true);
    expect(cmds.some((c) => c.includes('CHANGELOG.md'))).toBe(true);
    expect(cmds.some((c) => c.includes('backend/package.json'))).toBe(true);
  });

  it('returns null when preMerge bump is called without gitReady', async () => {
    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit });

    await expect(api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: false, projectPath: 'X' },
      { name: 'feature/x', description: '' },
      { changelogTracked: false }
    )).resolves.toBe(null);
  });

  it('swallows changelog update failures and still bumps VERSION', async () => {
    const projectPath = 'X';

    const writes = new Map();
    const fakeFs = {
      stat: vi.fn(async (p) => {
        if (p === projectPath) return { isDirectory: () => true };
        if (String(p).endsWith('CHANGELOG.md')) throw new Error('no changelog');
        throw new Error('missing');
      }),
      readFile: vi.fn(async (p) => {
        if (String(p).endsWith('VERSION')) return '0.1.0\n';
        if (String(p).endsWith('CHANGELOG.md')) throw new Error('no changelog');
        throw new Error('missing');
      }),
      writeFile: vi.fn(async (p, content) => {
        if (String(p).endsWith('CHANGELOG.md')) throw new Error('cannot write changelog');
        writes.set(String(p), String(content));
      })
    };

    const runProjectGit = vi.fn().mockResolvedValue({ stdout: '' });
    const api = makeApi({ runProjectGit, fs: fakeFs, path });

    const result = await api.__testOnly.preMergeBumpVersionAndChangelog(
      { gitReady: true, projectPath },
      { name: 'feature/x', description: '' },
      { changelogTracked: true }
    );

    expect(result).toEqual({ previous: '0.1.0', next: '0.1.1' });
    expect(writes.get(path.join(projectPath, 'VERSION'))).toBe('0.1.1\n');

    // CHANGELOG.md should not be staged because fs.stat(CHANGELOG.md) fails.
    const addArgs = runProjectGit.mock.calls.find((c) => c[1][0] === 'add')?.[1] ?? [];
    expect(addArgs).toEqual(['add', 'VERSION']);
  });
});
