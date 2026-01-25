import { describe, it, expect, vi } from 'vitest';
import { createBranchWorkflowCommits } from '../services/branchWorkflow/commitsApi.js';

const withStatusCode = (error, code) => {
  error.statusCode = code;
  return error;
};

const makeApi = ({
  changedPaths,
  branchVersion,
  branchChangelog,
  branchVersionProbe,
  branchVersionRead,
  branchChangelogProbe,
  branchChangelogRead,
  hasChangelog = true,
  hasVersion = true
} = {}) => {
  let changelogShows = 0;
  let versionShows = 0;

  const runProjectGit = vi.fn(async (_ctx, args) => {
    const cmd = args.join(' ');

    if (cmd.startsWith('show ')) {
      const spec = cmd.slice('show '.length);
      if (spec.endsWith(':CHANGELOG.md')) {
        changelogShows += 1;
        if (!hasChangelog) {
          throw new Error('missing changelog');
        }
        const probe = branchChangelogProbe ?? branchChangelog;
        const read = branchChangelogRead ?? branchChangelog;
        return { stdout: (changelogShows === 1 ? probe : read) ?? '' };
      }
      if (spec.endsWith(':VERSION')) {
        versionShows += 1;
        if (!hasVersion) {
          throw new Error('missing version');
        }
        const probe = branchVersionProbe ?? branchVersion;
        const read = branchVersionRead ?? branchVersion;
        return { stdout: (versionShows === 1 ? probe : read) ?? '' };
      }
    }

    return { stdout: '' };
  });

  const listBranchChangedPaths = vi.fn().mockResolvedValue(changedPaths ?? []);

  const api = createBranchWorkflowCommits({
    withStatusCode,
    ensureMainBranch: vi.fn(),
    getProjectContext: vi.fn(),
    runProjectGit,
    normalizeCommitLimit: (n) => n,
    parseGitLog: () => [],
    getBranchByName: vi.fn(),
    cancelScheduledAutoTests: vi.fn(),
    isCssOnlyBranchDiff: vi.fn(),
    listBranchChangedPaths,
    ensureGitBranchExists: vi.fn(),
    checkoutGitBranch: vi.fn(),
    run: vi.fn(),
    get: vi.fn(),
    setCurrentBranch: vi.fn(),
    fs: null,
    path: null
  });

  return { api, runProjectGit, listBranchChangedPaths };
};

describe('commitsApi.enforceChangelogForMerge', () => {
  it('returns early when git is not ready', async () => {
    const { api, runProjectGit, listBranchChangedPaths } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchChangelog: '# Changelog\n\n## Unreleased\n\n- note\n'
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: false }, 'feature/x')).resolves.toBeUndefined();
    expect(runProjectGit).not.toHaveBeenCalled();
    expect(listBranchChangedPaths).not.toHaveBeenCalled();
  });

  it('returns early when CHANGELOG.md is tracked but empty/blank', async () => {
    const { api, runProjectGit, listBranchChangedPaths } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchChangelogProbe: '   \n',
      branchChangelogRead: '   \n'
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
    expect(runProjectGit).toHaveBeenCalledTimes(1);
    expect(listBranchChangedPaths).not.toHaveBeenCalled();
  });

  it('rejects when VERSION is not enforced but Unreleased has no entries', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchVersionProbe: '   \n',
      branchChangelog: ['# Changelog', '', '## Unreleased', '', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/at least one entry under Unreleased/i)
    });
  });

  it('does not enforce VERSION when VERSION probe is blank (covers shouldEnforceVersion=false assignment)', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchVersionProbe: '',
      branchChangelog: ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('does not enforce VERSION when VERSION is missing (covers catch assignment)', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      hasVersion: false,
      branchChangelog: ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('accepts non-string VERSION probe output (Buffer) when VERSION is touched', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersionProbe: Buffer.from('0.1.1\n'),
      branchChangelog: ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('does not enforce VERSION when VERSION probe output is falsy non-string (covers `|| ""`)', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchVersionProbe: 0,
      branchChangelog: ['# Changelog', '', '## Unreleased', '', '- note', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('accepts Buffer VERSION reads when validating a rolled changelog version section', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersionProbe: '0.1.1\n',
      branchVersionRead: Buffer.from('0.1.1\n'),
      branchChangelog: [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '-   ',
        '',
        '## 0.1.1 (2026-01-25)',
        '',
        '- ok',
        ''
      ].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('accepts Buffer CHANGELOG.md output when Unreleased has entries', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchVersionProbe: '   \n',
      branchChangelog: Buffer.from('# Changelog\n\n## Unreleased\n\n- note\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('coerces falsy non-string VERSION reads (0) when validating VERSION text', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersionProbe: '0.1.1\n',
      branchVersionRead: 0,
      branchChangelog: ['# Changelog', '', '## Unreleased', '', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/VERSION must be bumped/i)
    });
  });

  it('covers changelog read fallback after a successful probe (second show returns empty)', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersion: '0.1.1\n',
      branchChangelogProbe: Buffer.from('tracked'),
      branchChangelogRead: undefined
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/must include a 0\.1\.1/i)
    });
  });

  it('accepts a rolled changelog when VERSION and CHANGELOG are touched', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersion: '0.1.1\n',
      branchChangelog: [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '## 0.1.1 (2026-01-25)',
        '',
        '- Turn background green',
        ''
      ].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).resolves.toBeUndefined();
  });

  it('rejects merge when VERSION is not touched', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md'],
      branchVersion: '0.1.1\n',
      branchChangelog: [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '## 0.1.1 (2026-01-25)',
        '',
        '- Turn background green',
        ''
      ].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/VERSION must be bumped/i)
    });
  });

  it('rejects merge when VERSION is tracked but empty', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersionProbe: '0.1.1\n',
      branchVersionRead: '\n',
      branchChangelog: [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '## 0.1.0 (2026-01-01)',
        '',
        '- init',
        ''
      ].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/VERSION must be bumped/i)
    });
  });

  it('rejects merge when changelog is missing the current VERSION section', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersion: '0.1.1\n',
      branchChangelog: ['# Changelog', '', '## Unreleased', '', '## 0.1.0 (2026-01-01)', '', '- init', ''].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/must include a 0\.1\.1 section/i)
    });
  });

  it('rejects merge when the VERSION section has no entries (stops at next heading)', async () => {
    const { api } = makeApi({
      changedPaths: ['CHANGELOG.md', 'VERSION'],
      branchVersion: '0.1.1\n',
      branchChangelog: [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '## 0.1.1 (2026-01-25)',
        '',
        '## 0.1.0 (2026-01-01)',
        '',
        '- init',
        ''
      ].join('\n')
    });

    await expect(api.__testOnly.enforceChangelogForMerge({ gitReady: true }, 'feature/x')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/must include at least one entry under 0\.1\.1/i)
    });
  });
});
