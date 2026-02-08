import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

describe('commitsApi.mergeBranch changelog + bump coverage', () => {
  const projectId = 999;
  const branchName = 'agent/feature';

  let core;
  let runProjectGit;
  let getProjectContext;
  let getBranchByName;
  let listBranchChangedPaths;
  let tmpDir;

  beforeEach(() => {
    runProjectGit = vi.fn();
    getProjectContext = vi.fn();
    getBranchByName = vi.fn().mockResolvedValue({
      id: 123,
      name: branchName,
      type: 'feature',
      status: 'ready-for-merge'
    });
    listBranchChangedPaths = vi.fn().mockResolvedValue(['CHANGELOG.md']);

    core = {
      withStatusCode,
      ensureMainBranch: vi.fn().mockResolvedValue({ id: 1, name: 'main', type: 'main' }),
      getProjectContext,
      runProjectGit,
      normalizeCommitLimit: () => 50,
      parseGitLog: () => [],
      getBranchByName,
      cancelScheduledAutoTests: vi.fn(),
      isCssOnlyBranchDiff: vi.fn().mockResolvedValue(false),
      listBranchChangedPaths,
      ensureGitBranchExists: vi.fn().mockResolvedValue(undefined),
      checkoutGitBranch: vi.fn(),
      run: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ status: 'passed' }),
      setCurrentBranch: vi.fn().mockResolvedValue(undefined),
      fs,
      path
    };
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  const api = () => createBranchWorkflowCommits(core);

  it('covers defensive non-string inputs in semver/changelog helpers', () => {
    const { __testOnly } = api();
    expect(__testOnly.incrementPatch(123)).toBe(null);
    expect(__testOnly.extractUnreleasedEntries(null)).toEqual({ hasHeading: false, entries: [], body: '' });
    expect(__testOnly.rollChangelogToVersion(undefined, '0.1.1')).toBe('');
  });

  it('rollChangelogToVersion returns the original text when no Unreleased heading exists', () => {
    const { __testOnly } = api();
    const input = ['# Changelog', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n');
    expect(__testOnly.rollChangelogToVersion(input, '0.1.1')).toBe(input);
  });

  it('rollChangelogToVersion preserves CRLF and returns original when Unreleased has no entries (next heading present)', () => {
    const { __testOnly } = api();
    const input = ['# Changelog', '', '## Unreleased', '', '-   ', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\r\n');
    expect(__testOnly.rollChangelogToVersion(input, '0.1.1')).toBe(input);
  });

  it('rollChangelogToVersion rolls entries when Unreleased has entries and no next heading', () => {
    const { __testOnly } = api();
    const input = ['# Changelog', '', '## Unreleased', '', '- Added thing', ''].join('\n');
    const output = __testOnly.rollChangelogToVersion(input, '0.1.1');
    expect(output).toMatch(/##\s+0\.1\.1\s+\(/);
  });

  it('enforceChangelogForMerge handles non-string/undefined stdout and falsy changed paths', async () => {
    const { __testOnly } = api();
    const context = { gitReady: true, projectPath: 'X' };

    listBranchChangedPaths.mockResolvedValueOnce([null, 'CHANGELOG.md']);

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // First call: probe stdout is non-string (truthy)
        // Second call: stdout is undefined (non-string falsy), exercises the fallback side of `|| ''`.
        if (runProjectGit.mock.calls.length === 1) {
          return { stdout: Buffer.from('tracked') };
        }
        return {};
      }
      return { stdout: '' };
    });

    await expect(__testOnly.enforceChangelogForMerge(context, branchName)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Unreleased/i)
    });
  });

  it('enforceChangelogForMerge accepts Buffer stdout for the changelog body', async () => {
    const { __testOnly } = api();
    const context = { gitReady: true, projectPath: 'X' };

    listBranchChangedPaths.mockResolvedValueOnce(['CHANGELOG.md']);

    const changelog = ['# Changelog', '', '## Unreleased', '', '- fix: buffered', ''].join('\n');
    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // Probe and then read the full file.
        return { stdout: Buffer.from(changelog) };
      }
      return { stdout: '' };
    });

    await expect(__testOnly.enforceChangelogForMerge(context, branchName)).resolves.toBeUndefined();
  });

  it('enforceChangelogForMerge covers probe stdout fallback when stdout is undefined', async () => {
    const { __testOnly } = api();
    const context = { gitReady: true, projectPath: 'X' };

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        return {};
      }
      return { stdout: '' };
    });

    await expect(__testOnly.enforceChangelogForMerge(context, branchName)).resolves.toBeUndefined();
  });

  it('bumpVersionAfterMerge handles empty VERSION file content', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: empty version', ''].join('\n'),
      'utf8'
    );

    runProjectGit.mockResolvedValue({ stdout: '' });

    const { __testOnly } = api();
    const result = await __testOnly.bumpVersionAfterMerge({ gitReady: true, projectPath: tmpDir }, branchName);
    expect(result).toMatchObject({ next: '0.1.0' });
  });

  it('bumpVersionAfterMerge returns null when the project path does not exist', async () => {
    const { __testOnly } = api();
    const missingPath = path.join(os.tmpdir(), `lucidcoder-missing-project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await expect(__testOnly.bumpVersionAfterMerge({ gitReady: true, projectPath: missingPath }, branchName))
      .resolves.toBe(null);
  });

  it('bumpVersionAfterMerge returns null when CHANGELOG.md is missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');

    runProjectGit.mockResolvedValue({ stdout: '' });
    const { __testOnly } = api();

    await expect(__testOnly.bumpVersionAfterMerge({ gitReady: true, projectPath: tmpDir }, branchName)).resolves.toBe(null);
  });

  it('bumpVersionAfterMerge uses default VERSION when missing and stages package.json files when present', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'backend'), { recursive: true });

    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'frontend', 'package.json'),
      JSON.stringify({ name: 'frontend', version: '0.1.0' }, null, 2) + '\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'backend', 'package.json'),
      JSON.stringify({ name: 'backend', version: '0.1.0' }, null, 2) + '\n',
      'utf8'
    );

    runProjectGit.mockResolvedValue({ stdout: '' });
    const { __testOnly } = api();
    const result = await __testOnly.bumpVersionAfterMerge({ gitReady: true, projectPath: tmpDir }, branchName);

    expect(result).toMatchObject({ next: '0.1.1' });

    const addCalls = runProjectGit.mock.calls
      .map((call) => call[1])
      .filter((args) => args[0] === 'add');
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls[0]).toEqual(expect.arrayContaining(['frontend/package.json', 'backend/package.json']));
  });

  it('merges and bumps VERSION but does not roll changelog when Unreleased has no entries and changelog is not tracked in git', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '-   ', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // Probe in enforceChangelogForMerge: simulate missing changelog in git.
        throw new Error('missing');
      }
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      if (cmd.startsWith('add ')) return { stdout: '' };
      if (cmd.startsWith('commit -m')) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await mergeBranch(projectId, branchName);

    const bumped = await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8');
    expect(bumped.trim()).toBe('0.1.1');

    const changelog = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).not.toMatch(/##\s+0\.1\.1\s+\(/);
  });

  it('auto-bumps and merges when changelog is tracked but not initially touched on the branch', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- something', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    // First call (pre-bump): branch doesn't include the required files.
    // Second call (enforcement after bump): simulate that they now exist.
    listBranchChangedPaths
      .mockResolvedValueOnce(['README.md'])
      .mockResolvedValueOnce(['CHANGELOG.md', 'VERSION']);

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        return { stdout: ['# Changelog', '', '## Unreleased', '', '- something', ''].join('\n') };
      }
      if (cmd === `show ${branchName}:VERSION`) {
        return { stdout: '0.1.0\n' };
      }
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      if (cmd.startsWith('add ')) return { stdout: '' };
      if (cmd.startsWith('commit -m')) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).resolves.toMatchObject({ mergedBranch: branchName, current: 'main' });

    const bumpCommits = runProjectGit.mock.calls
      .map((call) => call[1].join(' '))
      .filter((cmd) => cmd.startsWith('commit -m chore: bump version'));
    expect(bumpCommits.length).toBeGreaterThan(0);
  });

  it('continues merging when projectPath is missing (post-merge bump is skipped)', async () => {
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: undefined });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // Skip enforcement (simulate older projects without tracked changelog).
        throw new Error('missing');
      }
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await mergeBranch(projectId, branchName);

    const bumpCommits = runProjectGit.mock.calls
      .map((call) => call[1].join(' '))
      .filter((cmd) => cmd.startsWith('commit -m chore: bump version'));
    expect(bumpCommits).toHaveLength(0);
  });

  it('falls back to 0.1.0 when VERSION is not valid semver', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), 'dev\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: something', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // Skip enforcement: simulate missing changelog in git.
        throw new Error('missing');
      }
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      if (cmd.startsWith('add ')) return { stdout: '' };
      if (cmd.startsWith('commit -m')) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await mergeBranch(projectId, branchName);

    const bumped = await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8');
    expect(bumped.trim()).toBe('0.1.0');
  });

  it('skips reset when bump fails and the pre-merge sha is unavailable', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: bump failure path', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        // Skip enforcement: simulate missing changelog in git.
        throw new Error('missing');
      }
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd.startsWith('add ')) throw new Error('git add failed');
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/Failed to update changelog\/version before merge/i)
    });

    expect(runProjectGit).not.toHaveBeenCalledWith(expect.anything(), ['reset', '--hard', expect.any(String)]);
    expect(runProjectGit).not.toHaveBeenCalledWith(expect.anything(), ['merge', '--no-ff', branchName]);
  });

  it('uses default VERSION (0.1.0) when VERSION file is missing', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: initial', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      if (cmd.startsWith('add ')) return { stdout: '' };
      if (cmd.startsWith('commit -m')) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await mergeBranch(projectId, branchName);

    const bumped = await fs.readFile(path.join(tmpDir, 'VERSION'), 'utf8');
    expect(bumped.trim()).toBe('0.1.1');
  });

  it('preserves CRLF when updating package.json versions and changelog', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.mkdir(path.join(tmpDir, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: windows eol', ''].join('\r\n'),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'frontend', 'package.json'),
      '{\r\n  "name": "frontend",\r\n  "version": "0.1.0"\r\n}\r\n',
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd === 'rev-parse HEAD') return { stdout: 'abc123\n' };
      if (cmd === `merge --no-ff ${branchName}`) return { stdout: '' };
      if (cmd.startsWith('add ')) return { stdout: '' };
      if (cmd.startsWith('commit -m')) return { stdout: '' };
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await mergeBranch(projectId, branchName);

    const pkg = await fs.readFile(path.join(tmpDir, 'frontend', 'package.json'), 'utf8');
    expect(pkg).toContain('\r\n');
    expect(pkg).toMatch(/"version": "0\.1\.1"/);

    const changelog = await fs.readFile(path.join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('\r\n');
  });

  it('falls back to empty changed-path list when listBranchChangedPaths is not provided', async () => {
    core.listBranchChangedPaths = undefined;
    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: 'X' });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) {
        return { stdout: ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n') };
      }
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/CHANGELOG\.md must be updated/i)
    });
  });

  it('does not attempt reset when pre-merge bump fails (merge not attempted)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-commits-'));
    await fs.writeFile(path.join(tmpDir, 'VERSION'), '0.1.0\n', 'utf8');
    await fs.writeFile(
      path.join(tmpDir, 'CHANGELOG.md'),
      ['# Changelog', '', '## Unreleased', '', '- fix: bump fail reset', ''].join('\n'),
      'utf8'
    );

    getProjectContext.mockResolvedValueOnce({ gitReady: true, projectPath: tmpDir });

    runProjectGit.mockImplementation(async (_ctx, args) => {
      const cmd = args.join(' ');
      if (cmd === `show ${branchName}:CHANGELOG.md`) throw new Error('missing');
      if (cmd === 'status --porcelain') return { stdout: '' };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n' };
      if (cmd === `checkout ${branchName}`) return { stdout: '' };
      if (cmd === 'checkout main') return { stdout: '' };
      if (cmd.startsWith('add ')) throw new Error('git add failed');
      return { stdout: '' };
    });

    const { mergeBranch } = api();
    await expect(mergeBranch(projectId, branchName)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringMatching(/Failed to update changelog\/version before merge/i)
    });
    expect(runProjectGit).not.toHaveBeenCalledWith(expect.anything(), ['reset', '--hard', expect.any(String)]);
    expect(runProjectGit).not.toHaveBeenCalledWith(expect.anything(), ['merge', '--no-ff', branchName]);
  });
});
