import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowStaging } from '../services/branchWorkflow/stagingApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('stagingApi.commitBranchChanges autoChangelog', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-staging-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    vi.restoreAllMocks();
  });

  const makeApi = ({ changelogBody, fsImpl } = {}) => {
    const fsApi = fsImpl || fs;
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
      staged_files: JSON.stringify([
        {
          path: 'src/foo.js',
          source: 'ai',
          timestamp: new Date().toISOString()
        }
      ])
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
      fs: fsApi,
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
      runProjectGit,
      getProjectContext,
      getBranchByName,
      get
    };
  };

  it('adds an Unreleased bullet when autoChangelog is requested', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const { api, core } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): update UI spacing',
      autoChangelog: true,
      changelogEntry: 'Update UI spacing'
    });

    expect(core.commitAllChanges).toHaveBeenCalled();

    const nextVersion = (await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim();
    expect(nextVersion).toBe('0.1.1');

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(/##\s+0\.1\.1\s+\(\d{4}-\d{2}-\d{2}\)/);
    expect(updated).toMatch(/-\s+Update UI spacing/);
  });

  it('handles an Unreleased heading without a trailing newline (and CRLF input)', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      '# Changelog\r\n\r\n## Unreleased',
      'utf8'
    );

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): add missing newline coverage',
      autoChangelog: true,
      changelogEntry: 'Add missing newline coverage'
    });

    const nextVersion = (await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim();
    expect(nextVersion).toBe('0.1.1');

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(/-\s+Add missing newline coverage/);
  });

  it('adds a trailing newline when CHANGELOG.md does not end with one', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init'].join('\n'),
      'utf8'
    );

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): ensure trailing newline',
      autoChangelog: true,
      changelogEntry: 'Ensure trailing newline'
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/-\s+Ensure trailing newline/);
    expect(updated.endsWith('\n')).toBe(true);
  });

  it('updates frontend and backend package.json versions when present', async () => {
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    await fs.writeFile(
      path.join(tmpDir, 'frontend', 'package.json'),
      '{\r\n  "name": "frontend",\r\n  "version": "0.1.0"\r\n}\r\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'backend', 'package.json'),
      '{\n  "name": "backend",\n  "version": "0.1.0"\n}\n',
      'utf8'
    );

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): bump version everywhere',
      autoChangelog: true,
      changelogEntry: 'Bump version everywhere'
    });

    const nextVersion = (await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim();
    expect(nextVersion).toBe('0.1.1');

    const frontendRaw = await fs.readFile(path.join(tmpDir, 'frontend', 'package.json'), 'utf8');
    expect(frontendRaw.includes('\r\n')).toBe(true);
    expect(frontendRaw.endsWith('\r\n')).toBe(true);
    expect(JSON.parse(frontendRaw).version).toBe('0.1.1');

    const backendRaw = await fs.readFile(path.join(tmpDir, 'backend', 'package.json'), 'utf8');
    expect(backendRaw.includes('\r\n')).toBe(false);
    expect(backendRaw.endsWith('\n')).toBe(true);
    expect(JSON.parse(backendRaw).version).toBe('0.1.1');
  });

  it('skips package.json updates when JSON parses to a non-object', async () => {
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const weirdFrontend = '"not-an-object"\n';
    await fs.writeFile(path.join(tmpDir, 'frontend', 'package.json'), weirdFrontend, 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'backend', 'package.json'),
      '{\n  "name": "backend",\n  "version": "0.1.0"\n}\n',
      'utf8'
    );

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): tolerate weird package json',
      autoChangelog: true,
      changelogEntry: 'Tolerate weird package json'
    });

    const frontendRaw = await fs.readFile(path.join(tmpDir, 'frontend', 'package.json'), 'utf8');
    expect(frontendRaw).toBe(weirdFrontend);

    const backendRaw = await fs.readFile(path.join(tmpDir, 'backend', 'package.json'), 'utf8');
    expect(JSON.parse(backendRaw).version).toBe('0.1.1');
  });

  it('does not roll changelog when Unreleased has no bullet entries', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    const changelog = ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), changelog, 'utf8');

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): bump only version',
      autoChangelog: true,
      changelogEntry: '   '
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toBe(changelog);
  });

  it('skips multiple blank lines after Unreleased before inserting a bullet', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): handle extra blank lines',
      autoChangelog: true,
      changelogEntry: 'Handle extra blank lines'
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/-\s+Handle extra blank lines/);
  });

  it('does not crash autoChangelog when projectPath is blank', async () => {
    const { api, core, getProjectContext } = makeApi();
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: '   ' });

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): blank path',
      autoChangelog: true,
      changelogEntry: 'Should be ignored'
    });

    expect(core.commitAllChanges).toHaveBeenCalled();
  });

  it('creates CHANGELOG.md when missing and autoChangelog is requested', async () => {
    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): turn background green',
      autoChangelog: true,
      changelogEntry: 'Turn background green'
    });

    const nextVersion = (await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim();
    expect(nextVersion).toMatch(/\d+\.\d+\.\d+/);

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/#\s+Changelog/);
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(new RegExp(`##\\s+${nextVersion.replace(/\./g, '\\.')}`));
    expect(updated).toMatch(/-\s+Turn background green/);
  });

  it('replaces an empty CHANGELOG.md with an Unreleased section', async () => {
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '', 'utf8');

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): tune spacing',
      autoChangelog: true,
      changelogEntry: 'Tune spacing'
    });

    const nextVersion = (await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8')).trim();
    expect(nextVersion).toMatch(/\d+\.\d+\.\d+/);

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/#\s+Changelog/);
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(new RegExp(`##\\s+${nextVersion.replace(/\./g, '\\.')}`));
    expect(updated).toMatch(/-\s+Tune spacing/);
  });

  it('tolerates non-ENOENT CHANGELOG.md read failures during autoChangelog', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    let changelogReads = 0;
    const fsImpl = {
      ...fs,
      readFile: async (filePath, encoding) => {
        if (String(filePath).endsWith('CHANGELOG.md') && encoding === 'utf8') {
          changelogReads += 1;
          if (changelogReads === 1) {
            const error = new Error('no access');
            error.code = 'EACCES';
            throw error;
          }
        }
        return fs.readFile(filePath, encoding);
      }
    };

    const { api } = makeApi({ fsImpl });

    await expect(api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): tolerate changelog read errors',
      autoChangelog: true,
      changelogEntry: 'Tolerate changelog read errors'
    })).resolves.toBeTruthy();
  });

  it('inserts an Unreleased section when changelog only contains a title line', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '# Changelog', 'utf8');

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): insert unreleased on title-only changelog',
      autoChangelog: true,
      changelogEntry: 'Insert unreleased on title-only changelog'
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toMatch(/##\s+Unreleased/);
    expect(updated).toMatch(/-\s+Insert unreleased on title-only changelog/);
  });

  it('does not duplicate an existing bullet entry when changelog already equals that bullet', async () => {
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'CHANGELOG.md'), '- Duplicate entry', 'utf8');

    const { api } = makeApi();

    await api.commitBranchChanges(123, 'feature/auto-changelog', {
      message: 'feat(autopilot): should not duplicate bullet',
      autoChangelog: true,
      changelogEntry: 'Duplicate entry'
    });

    const updated = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    const occurrences = (updated.match(/-\s+Duplicate entry/g) || []).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('does not allow autoChangelog to bypass tests via css-only shortcut', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    const { api, getBranchByName } = makeApi();
    getBranchByName.mockResolvedValueOnce({
      id: 7,
      name: 'feature/auto-changelog',
      type: 'feature',
      status: 'active',
      ahead_commits: 0,
      staged_files: JSON.stringify([
        {
          path: 'src/styles.css',
          source: 'ai',
          timestamp: new Date().toISOString()
        }
      ])
    });

    await expect(
      api.commitBranchChanges(123, 'feature/auto-changelog', {
        message: 'feat: css tweak',
        autoChangelog: true,
        changelogEntry: 'CSS tweak'
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Run tests/i)
    });
  });
});
