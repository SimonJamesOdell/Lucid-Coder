import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowStaging } from '../services/branchWorkflow/stagingApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

const makeMinimalApi = ({ fsImpl } = {}) => {
  const core = {
    fs: fsImpl || fs,
    path,
    withStatusCode
  };

  return createBranchWorkflowStaging(core);
};

describe('stagingApi internal helpers branch coverage', () => {
  it('covers parseSemver branches (non-string, invalid, overflow)', () => {
    const api = makeMinimalApi();

    expect(api.__testOnly.parseSemver(123)).toBe(null);
    expect(api.__testOnly.parseSemver('nope')).toBe(null);

    const hugeMajor = `${'9'.repeat(400)}.1.1`;
    expect(api.__testOnly.parseSemver(hugeMajor)).toBe(null);

    expect(api.__testOnly.parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('covers extractUnreleasedEntries branches (non-string + missing heading)', () => {
    const api = makeMinimalApi();

    expect(api.__testOnly.extractUnreleasedEntries(null)).toEqual({ hasHeading: false, entries: [] });

    expect(api.__testOnly.extractUnreleasedEntries('# Changelog\n\n## 0.1.0 (2026-01-01)\n- init\n')).toEqual({
      hasHeading: false,
      entries: []
    });

    const extracted = api.__testOnly.extractUnreleasedEntries(
      ['# Changelog', '', '## Unreleased', '', '- one', '- two', '', '## 0.1.0 (2026-01-01)', '', '- init'].join('\n')
    );
    expect(extracted.hasHeading).toBe(true);
    expect(extracted.entries).toEqual(['- one', '- two']);
  });

  it('covers rollChangelogToVersion branches (non-string, empty entries, heading-case mismatch)', () => {
    const api = makeMinimalApi();

    expect(api.__testOnly.rollChangelogToVersion(null, '1.2.3')).toBe('');

    const noEntries = ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n');
    expect(api.__testOnly.rollChangelogToVersion(noEntries, '0.1.1')).toBe(noEntries);

    // Hit the `if (!match) return input` branch by using an indented heading:
    // extractUnreleasedEntries trims lines (so it detects Unreleased), but rollChangelogToVersion
    // matches heading at the start of the line, so the exec() fails.
    const indentedHeading = ['# Changelog', '', '   ## Unreleased', '', '- entry', ''].join('\n');
    expect(api.__testOnly.rollChangelogToVersion(indentedHeading, '0.1.1')).toBe(indentedHeading);

    const normal = ['# Changelog', '', '## Unreleased', '', '- entry', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n');
    const rolled = api.__testOnly.rollChangelogToVersion(normal, '0.1.1');
    expect(rolled).toMatch(/##\s+0\.1\.1\s+\(\d{4}-\d{2}-\d{2}\)/);
    expect(rolled).toMatch(/\n##\s+Unreleased\s*\n/);
  });

  it('covers normalizeChangelogBullet truncation branch (> 140 chars)', () => {
    const api = makeMinimalApi();

    const longText = `- ${'a'.repeat(200)}`;
    const normalized = api.__testOnly.normalizeChangelogBullet(longText);
    expect(normalized.endsWith('...')).toBe(true);
    expect(normalized.length).toBe(140);
  });

  it('covers coerceSingleLine non-string branch', () => {
    const api = makeMinimalApi();

    expect(api.__testOnly.coerceSingleLine(123)).toBe('');
  });
});

describe('stagingApi changelog/version helpers edge branches', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-staging-branches-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    vi.restoreAllMocks();
  });

  it('covers ensureChangelogUnreleasedEntry projectPath non-string branch', async () => {
    const api = makeMinimalApi();

    const result = await api.__testOnly.ensureChangelogUnreleasedEntry(null, 'x');
    expect(result).toEqual({ updated: false });
  });

  it('covers ensureChangelogUnreleasedEntry title insertion path when title has newline', async () => {
    const api = makeMinimalApi();

    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    await fs.writeFile(changelogPath, ['# Changelog', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'), 'utf8');

    const result = await api.__testOnly.ensureChangelogUnreleasedEntry(tmpDir, 'Add entry');
    expect(result.updated).toBe(true);

    const updated = await fs.readFile(changelogPath, 'utf8');
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(/-\s+Add entry/);
  });

  it('covers ensureChangelogUnreleasedEntry Unreleased-heading insertion path', async () => {
    const api = makeMinimalApi();

    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    await fs.writeFile(
      changelogPath,
      ['# Changelog', '', '## Unreleased', '', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const result = await api.__testOnly.ensureChangelogUnreleasedEntry(tmpDir, 'Inserted under heading');
    expect(result.updated).toBe(true);

    const updated = await fs.readFile(changelogPath, 'utf8');
    expect(updated).toMatch(/##\s+Unreleased[\s\S]*-\s+Inserted under heading/);
  });

  it('covers ensureChangelogUnreleasedEntry no-title insertion branch', async () => {
    const api = makeMinimalApi();

    const changelogPath = path.join(tmpDir, 'CHANGELOG.md');
    await fs.writeFile(changelogPath, ['## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'), 'utf8');

    const result = await api.__testOnly.ensureChangelogUnreleasedEntry(tmpDir, 'Prefixed changelog');
    expect(result.updated).toBe(true);

    const updated = await fs.readFile(changelogPath, 'utf8');
    expect(updated).toMatch(/^#\s+Changelog/m);
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(/-\s+Prefixed changelog/);
  });

  it('covers updatePackageVersionIfPresent eol branch when readFile returns non-string', async () => {
    const writes = [];
    const fsMock = {
      readFile: vi.fn(async () => Buffer.from('{"name":"x","version":"0.0.1"}')),
      writeFile: vi.fn(async (filePath, content) => {
        writes.push({ filePath, content: String(content) });
      })
    };

    const api = makeMinimalApi({ fsImpl: fsMock });

    const ok = await api.__testOnly.updatePackageVersionIfPresent('/fake/package.json', '1.2.3');
    expect(ok).toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0].content.includes('\r\n')).toBe(false);
    expect(writes[0].content.endsWith('\n')).toBe(true);
    expect(JSON.parse(writes[0].content).version).toBe('1.2.3');
  });

  it('covers updatePackageVersionIfPresent raw||"" fallback branch when readFile returns an empty string', async () => {
    const fsMock = {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn()
    };

    const api = makeMinimalApi({ fsImpl: fsMock });

    const ok = await api.__testOnly.updatePackageVersionIfPresent('/fake/package.json', '1.2.3');
    expect(ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('covers bumpVersionAndRollChangelog fallbacks (empty VERSION + missing CHANGELOG)', async () => {
    const api = makeMinimalApi();

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '', 'utf8');

    const result = await api.__testOnly.bumpVersionAndRollChangelog(tmpDir, '   ');
    expect(result.updated).toBe(true);
    expect(result.version).toBe('0.1.1');
  });

  it('covers bumpVersionAndRollChangelog incrementPatch fallback on invalid VERSION', async () => {
    const api = makeMinimalApi();

    await fs.writeFile(path.join(tmpDir, 'VERSION'), 'not-a-version\n', 'utf8');

    const result = await api.__testOnly.bumpVersionAndRollChangelog(tmpDir, '   ');
    expect(result.updated).toBe(true);
    expect(result.version).toBe('0.1.0');
  });

  it('covers bumpVersionAndRollChangelog catch fallback when ensureChangelogUnreleasedEntry rejects', async () => {
    const fsMock = {
      readFile: vi.fn(async (absolutePath, encoding) => {
        const filePath = String(absolutePath);
        if (filePath.endsWith('CHANGELOG.md')) {
          const error = new Error('missing changelog');
          error.code = 'ENOENT';
          throw error;
        }
        if (filePath.endsWith('VERSION')) {
          return '0.1.0\n';
        }
        throw new Error(`unexpected readFile(${filePath}, ${encoding})`);
      }),
      writeFile: vi.fn(async (absolutePath) => {
        const filePath = String(absolutePath);
        if (filePath.endsWith('CHANGELOG.md')) {
          throw new Error('write changelog failed');
        }
        if (filePath.endsWith('VERSION')) {
          return;
        }
        return;
      })
    };

    const api = makeMinimalApi({ fsImpl: fsMock });

    const result = await api.__testOnly.bumpVersionAndRollChangelog(tmpDir, 'Some entry');
    expect(result).toEqual({ updated: true, version: '0.1.1' });
  });

  it('covers bumpVersionAndRollChangelog basePath non-string branch', async () => {
    const api = makeMinimalApi();

    const result = await api.__testOnly.bumpVersionAndRollChangelog(undefined, 'x');
    expect(result).toEqual({ updated: false, version: null });
  });
});

describe('stagingApi.commitBranchChanges remaining branch paths', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-staging-commit-branches-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    vi.restoreAllMocks();
  });

  const makeCommitApi = ({ stagedFiles, revParseStdout = 'abc123\n' } = {}) => {
    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse HEAD') return { stdout: revParseStdout };
      if (cmd === 'status --porcelain') return { stdout: '' };
      return { stdout: '' };
    });

    const getProjectContext = vi.fn().mockResolvedValue({
      gitReady: true,
      projectPath: tmpDir
    });

    const getBranchByName = vi.fn().mockResolvedValue({
      id: 7,
      name: 'feature/auto-changelog',
      type: 'feature',
      status: 'ready-for-merge',
      ahead_commits: 0,
      staged_files: JSON.stringify(stagedFiles)
    });

    const get = vi.fn().mockResolvedValue({
      id: 7,
      name: 'feature/auto-changelog',
      type: 'feature',
      status: 'ready-for-merge',
      ahead_commits: 1,
      staged_files: '[]'
    });

    const core = {
      fs,
      path,
      withStatusCode,
      MAX_FILE_DIFF_CHARS: 1000,
      MAX_AGGREGATE_DIFF_CHARS: 2000,
      trimDiff: (t) => t,
      ensureProjectExists: vi.fn(),
      ensureMainBranch: vi.fn().mockResolvedValue(undefined),
      getProjectContext,
      getBranchByName,
      getActiveWorkingBranchRow: vi.fn(),
      generateAutoBranchName: vi.fn(),
      createWorkingBranch: vi.fn(),
      parseStagedFiles: (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      },
      serializeBranchRow: (row) => row,
      runProjectGit,
      listGitStagedPaths: vi.fn().mockResolvedValue([]),
      listGitStagedStatusMap: vi.fn().mockResolvedValue({}),
      run: vi.fn().mockResolvedValue(undefined),
      get,
      scheduleAutoTests: vi.fn(),
      checkoutBranch: vi.fn(),
      resolveProjectGitSettings: vi.fn().mockResolvedValue({}),
      buildCommitMessage: ({ requestedMessage }) => requestedMessage || 'chore: commit',
      ensureGitBranchExists: vi.fn().mockResolvedValue(undefined),
      checkoutGitBranch: vi.fn().mockResolvedValue(undefined),
      commitAllChanges: vi.fn().mockResolvedValue(true),
      isCssOnlyBranchDiff: vi.fn().mockResolvedValue(false)
    };

    return {
      api: createBranchWorkflowStaging(core),
      core,
      runProjectGit
    };
  };

  it('returns null commit sha when rev-parse produces blank stdout', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), ['# Changelog', '', '## Unreleased', ''].join('\n'), 'utf8');

    const { api } = makeCommitApi({
      stagedFiles: [{ path: 'src/foo.js', source: 'ai', timestamp: new Date().toISOString() }],
      revParseStdout: '\n'
    });

    const result = await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat: test empty sha',
      autoChangelog: false
    });

    expect(result.commit.sha).toBe(null);
    expect(result.commit.shortSha).toBe(null);
  });

  it('does not re-add CHANGELOG.md / VERSION to stagedFiles when already present', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const timestamp = new Date().toISOString();
    const { api } = makeCommitApi({
      stagedFiles: [
        { path: 'CHANGELOG.md', source: 'ai', timestamp },
        { path: 'VERSION', source: 'ai', timestamp },
        { path: 'src/foo.js', source: 'ai', timestamp }
      ]
    });

    const result = await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat: already staged changelog/version',
      autoChangelog: true,
      changelogEntry: 'Already staged entry'
    });

    const changelogCount = result.commit.files.filter((entry) => entry.path === 'CHANGELOG.md').length;
    const versionCount = result.commit.files.filter((entry) => entry.path === 'VERSION').length;

    expect(changelogCount).toBe(1);
    expect(versionCount).toBe(1);
  });

  it('falls back to commitMessage when autoChangelog is requested without changelogEntry', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const commitMessage = 'feat: use commit message as changelog entry';

    const { api } = makeCommitApi({
      stagedFiles: [{ path: 'src/foo.js', source: 'ai', timestamp: new Date().toISOString() }]
    });

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: commitMessage,
      autoChangelog: true
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/-\s+feat: use commit message as changelog entry/);
  });

  it('covers commitBranchChanges catch fallback when bumpVersionAndRollChangelog rejects', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', ''].join('\n'),
      'utf8'
    );

    const runProjectGit = vi.fn(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === 'status --porcelain') return { stdout: '' };
      return { stdout: '' };
    });

    const getProjectContext = vi.fn().mockResolvedValue({
      gitReady: true,
      projectPath: tmpDir
    });

    const getBranchByName = vi.fn().mockResolvedValue({
      id: 7,
      name: 'feature/auto-changelog',
      type: 'feature',
      status: 'ready-for-merge',
      ahead_commits: 0,
      staged_files: JSON.stringify([{ path: 'src/foo.js', source: 'ai', timestamp: new Date().toISOString() }])
    });

    const get = vi.fn().mockResolvedValue({
      id: 7,
      name: 'feature/auto-changelog',
      type: 'feature',
      status: 'ready-for-merge',
      ahead_commits: 1,
      staged_files: '[]'
    });

    const fsFailVersionWrite = {
      ...fs,
      writeFile: vi.fn(async (absolutePath, content, encoding) => {
        const filePath = String(absolutePath);
        if (filePath.endsWith(`${path.sep}VERSION`)) {
          throw new Error('version write failed');
        }
        return fs.writeFile(absolutePath, content, encoding);
      })
    };

    const core = {
      fs: fsFailVersionWrite,
      path,
      withStatusCode,
      MAX_FILE_DIFF_CHARS: 1000,
      MAX_AGGREGATE_DIFF_CHARS: 2000,
      trimDiff: (t) => t,
      ensureProjectExists: vi.fn(),
      ensureMainBranch: vi.fn().mockResolvedValue(undefined),
      getProjectContext,
      getBranchByName,
      getActiveWorkingBranchRow: vi.fn(),
      generateAutoBranchName: vi.fn(),
      createWorkingBranch: vi.fn(),
      parseStagedFiles: (value) => {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      },
      serializeBranchRow: (row) => row,
      runProjectGit,
      listGitStagedPaths: vi.fn().mockResolvedValue([]),
      listGitStagedStatusMap: vi.fn().mockResolvedValue({}),
      run: vi.fn().mockResolvedValue(undefined),
      get,
      scheduleAutoTests: vi.fn(),
      checkoutBranch: vi.fn(),
      resolveProjectGitSettings: vi.fn().mockResolvedValue({}),
      buildCommitMessage: ({ requestedMessage }) => requestedMessage || 'chore: commit',
      ensureGitBranchExists: vi.fn().mockResolvedValue(undefined),
      checkoutGitBranch: vi.fn().mockResolvedValue(undefined),
      commitAllChanges: vi.fn().mockResolvedValue(true),
      isCssOnlyBranchDiff: vi.fn().mockResolvedValue(false)
    };

    const api = createBranchWorkflowStaging(core);

    const result = await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat: force bump failure',
      autoChangelog: true,
      changelogEntry: 'This will not be used'
    });

    expect(core.commitAllChanges).toHaveBeenCalled();
    expect(result.commit.sha).toBe('abc123');
  });
});
