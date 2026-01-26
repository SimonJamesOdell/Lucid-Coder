import { describe, it, expect, afterEach, vi } from 'vitest';

const dbGetMock = vi.fn();
const dbRunMock = vi.fn();

vi.mock('../database.js', () => ({
  default: {
    get: (...args) => dbGetMock(...args),
    run: (...args) => dbRunMock(...args)
  },
  getGitSettings: vi.fn(),
  getProjectGitSettings: vi.fn()
}));

vi.mock('../utils/git.js', () => ({
  getCurrentBranch: vi.fn(async () => 'feature-1'),
  runGitCommand: vi.fn(async (_projectPath, args) => {
    const joined = Array.isArray(args) ? args.join(' ') : '';

    if (joined.includes('diff --cached --name-only')) {
      return { stdout: 'styles.css\n' };
    }
    if (joined.includes('diff --cached --name-status')) {
      return { stdout: 'A\tstyles.css\n' };
    }

    return { stdout: '' };
  })
}));

import { syncCurrentBranchStagedFilesFromGit } from '../services/branchWorkflow/context.js';

describe('branchWorkflow context coverage (null staged file entry)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('filters out invalid staged_files entries and still updates snapshots', async () => {
    dbGetMock.mockImplementation((_sql, _params, cb) => {
      cb(null, {
        id: 7,
        status: 'active',
        staged_files: JSON.stringify([null])
      });
    });

    dbRunMock.mockImplementation((_sql, _params, cb) => {
      cb.call({ lastID: 1, changes: 1 }, null);
    });

    await syncCurrentBranchStagedFilesFromGit(123, {
      gitReady: true,
      projectPath: 'C:\\repo'
    });

    expect(dbGetMock).toHaveBeenCalled();
    expect(dbRunMock).toHaveBeenCalled();
  });
});
