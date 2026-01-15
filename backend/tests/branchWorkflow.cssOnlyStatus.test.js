import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import db, { initializeDatabase, closeDatabase, createProject } from '../database.js';
import { describeBranchCssOnlyStatus, createWorkingBranch } from '../services/branchWorkflow.js';
import { createBranchWorkflowTests } from '../services/branchWorkflow/testsApi.js';

const exec = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const resetTables = async () => {
  await exec('DELETE FROM test_runs');
  await exec('DELETE FROM branches');
  await exec('DELETE FROM projects');
};

const makeCore = () => {
  const autoTestTimers = new Map();
  const run = vi.fn(async () => ({ lastID: 99 }));
  const get = vi.fn(async () => ({ id: 99, branch_name: 'feature/css' }));
  const parseStagedFiles = vi.fn(() => []);
  const getProjectContext = vi.fn(async () => ({ gitReady: false }));
  const listBranchChangedPaths = vi.fn(async () => []);
  const serializeTestRun = vi.fn((row) => row);

  return {
    AUTO_TEST_DEBOUNCE_MS: 1,
    autoTestTimers,
    autoTestKey: (projectId, branchName = '') => `${projectId}:${branchName || ''}`,
    isTestMode: () => false,
    ensureProjectExists: vi.fn(async () => {}),
    ensureMainBranch: vi.fn(async () => ({ id: 1, name: 'main' })),
    getBranchByName: vi.fn(async () => ({ id: 5, name: 'feature/css', staged_files: '[]' })),
    getProjectContext,
    listBranchChangedPaths,
    parseStagedFiles,
    resolveCoveragePolicy: vi.fn(() => ({
      globalThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
      changedFileThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
      enforceChangedFileCoverage: false
    })),
    runProjectGit: vi.fn(),
    run,
    get,
    getJob: vi.fn(),
    serializeTestRun,
    buildTestResultPayload: vi.fn((branchName, forceFail) => ({
      status: forceFail ? 'failed' : 'passed',
      summary: { total: 0, passed: 0, failed: forceFail ? 1 : 0, skipped: 0, duration: 0 },
      tests: [],
      workspaceRuns: []
    })),
    withStatusCode: (error, statusCode) => Object.assign(error, { statusCode }),
    startJob: vi.fn((payload) => ({ id: `job-${Date.now()}`, ...payload })),
    waitForJobCompletion: vi.fn(async () => ({ id: 'job-1', status: 'succeeded', exitCode: 0, logs: [] })),
    JOB_STATUS: { SUCCEEDED: 'succeeded' },
    fs: {
      readFile: vi.fn(async () => JSON.stringify({ scripts: {} })),
      access: vi.fn(async () => {})
    },
    path
  };
};

const makeTestsApi = (overrides = {}) => {
  const baseCore = makeCore();
  const core = { ...baseCore, ...overrides };
  const api = createBranchWorkflowTests(core);
  return { api, core };
};

describe('describeBranchCssOnlyStatus', () => {
  let project;

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    await resetTables();
    project = await createProject({
      name: `css-only-${Date.now()}`,
      description: 'css-only probe',
      language: 'javascript',
      framework: 'react',
      path: path.join(process.cwd(), 'virtual-project')
    });
  });

  afterAll(async () => {
    await resetTables();
    await closeDatabase();
  });

  it('falls back to the main branch when no working branch is active', async () => {
    const status = await describeBranchCssOnlyStatus(project.id);

    expect(status).toMatchObject({ branch: 'main', isCssOnly: false, indicator: null });
  });

  it('uses the active working branch when no branch name is supplied', async () => {
    const workingBranch = await createWorkingBranch(project.id, {
      name: `feature/css-only-${Date.now()}`
    });

    await exec('UPDATE branches SET staged_files = ?, is_current = 1 WHERE id = ?', [
      JSON.stringify([{ path: 'frontend/styles.css' }]),
      workingBranch.id
    ]);

    const status = await describeBranchCssOnlyStatus(project.id);

    expect(status).toMatchObject({ branch: workingBranch.name, isCssOnly: true, indicator: 'staged' });
  });

  it('reports a null branch name when the active working branch name is empty', async () => {
    const workingBranch = await createWorkingBranch(project.id, {
      name: `feature/blank-${Date.now()}`
    });

    await exec('UPDATE branches SET name = ? WHERE id = ?', ['', workingBranch.id]);

    const status = await describeBranchCssOnlyStatus(project.id);

    expect(status).toMatchObject({ branch: null, isCssOnly: false, indicator: null });
  });

  it('uses explicit branch arguments and surfaces staged indicators', async () => {
    // Ensure the main branch row exists before mutating staged files.
    await describeBranchCssOnlyStatus(project.id);

    await exec(
      'UPDATE branches SET staged_files = ? WHERE project_id = ? AND name = ?',
      [JSON.stringify([{ path: 'frontend/src/app.css' }]), project.id, 'main']
    );

    const status = await describeBranchCssOnlyStatus(project.id, 'main');

    expect(status).toMatchObject({ branch: 'main', isCssOnly: true, indicator: 'staged' });
  });
});

describe('createBranchWorkflowTests css-only helpers', () => {
  it('detects staged css-only branches when git is unavailable', async () => {
    const parseStagedFiles = vi.fn(() => [{ path: 'styles/app.css' }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: false }));
    const { api } = makeTestsApi({ parseStagedFiles, getProjectContext });

    const status = await api.determineCssOnlyStatus(1, { name: 'feature/css', staged_files: '[]' });

    expect(status).toMatchObject({ isCssOnly: true, indicator: 'staged' });
    expect(parseStagedFiles).toHaveBeenCalled();
    expect(getProjectContext).toHaveBeenCalled();
  });

  it('uses git diffs to label css-only branches when all changes are styles', async () => {
    const parseStagedFiles = vi.fn(() => [{ path: 'styles/app.css' }, { path: 'src/app.js' }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: true }));
    const listBranchChangedPaths = vi.fn(async () => ['frontend/App.css', 'frontend/theme.css']);
    const { api } = makeTestsApi({ parseStagedFiles, getProjectContext, listBranchChangedPaths });

    const status = await api.determineCssOnlyStatus(1, { name: 'feature/css-diff', staged_files: '[]' });

    expect(status).toMatchObject({ isCssOnly: true, indicator: 'git-diff' });
    expect(listBranchChangedPaths).toHaveBeenCalled();
  });

  it('falls back to staged detection when git diff resolution fails', async () => {
    const parseStagedFiles = vi.fn(() => [{ path: 'styles/only.css' }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: true }));
    const listBranchChangedPaths = vi.fn(async () => {
      throw new Error('git diff failed');
    });
    const { api } = makeTestsApi({ parseStagedFiles, getProjectContext, listBranchChangedPaths });

    const status = await api.determineCssOnlyStatus(1, { name: 'feature/css', staged_files: '[]' });

    expect(status).toMatchObject({ isCssOnly: true, indicator: 'staged' });
  });

  it('treats mixed diffs as non-css-only branches', async () => {
    const getProjectContext = vi.fn(async () => ({ gitReady: true }));
    const listBranchChangedPaths = vi.fn(async () => ['frontend/App.css', 'frontend/App.jsx']);
    const { api } = makeTestsApi({ getProjectContext, listBranchChangedPaths });

    const status = await api.determineCssOnlyStatus(1, { name: 'feature/mixed', staged_files: '[]' });

    expect(status).toMatchObject({ isCssOnly: false, indicator: null });
  });

  it('records css-only skip runs when tests would otherwise execute', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ lastID: 321 })
      .mockResolvedValue({});
    const get = vi.fn(async () => ({ id: 321, branch_name: 'feature/css' }));
    const serializeTestRun = vi.fn((row) => ({ serializedId: row.id }));
    const parseStagedFiles = vi.fn(() => [{ path: 'frontend/App.css' }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: false }));
    const getBranchByName = vi.fn(async () => ({ id: 7, name: 'feature/css', staged_files: '[]' }));

    const { api, core } = makeTestsApi({ run, get, serializeTestRun, parseStagedFiles, getProjectContext, getBranchByName });

    const result = await api.runTestsForBranch(99, 'feature/css');

    expect(result).toEqual({ serializedId: 321 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(core.startJob).not.toHaveBeenCalled();
  });

  it('propagates project-path errors from collectWorkspaceResults (covers guard)', async () => {
    const run = vi.fn().mockResolvedValueOnce({ lastID: 11 });
    const getProjectContext = vi.fn(async () => ({ gitReady: true, projectPath: null }));
    const parseStagedFiles = vi.fn(() => []);
    const listBranchChangedPaths = vi.fn(async () => ['src/App.jsx']);

    const { api } = makeTestsApi({ run, getProjectContext, parseStagedFiles, listBranchChangedPaths });

    await expect(api.runTestsForBranch(1, 'feature/noncss')).rejects.toMatchObject({
      message: 'Project path not found',
      statusCode: 400
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
