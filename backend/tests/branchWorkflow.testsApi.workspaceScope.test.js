import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { createBranchWorkflowTests } from '../services/branchWorkflow/testsApi.js';

const createInMemoryFs = (initialFiles = new Map()) => {
  const files = new Map(initialFiles);

  return {
    __files: files,
    async access(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: no such file or directory, access '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
    },
    async readFile(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    }
  };
};

describe('branchWorkflow testsApi: workspaceScope', () => {
  it('runs only the relevant workspace when workspaceScope=changed and changes are prefixed (performance)', async () => {
    const projectRoot = 'C:\\tmp\\project-scope-1';
    const frontendPath = path.join(projectRoot, 'frontend');
    const backendPath = path.join(projectRoot, 'backend');

    const fs = createInMemoryFs();

    // workspace detection
    fs.__files.set(path.join(frontendPath, 'package.json'), JSON.stringify({ scripts: { 'test:coverage': 'vitest --coverage' } }));
    fs.__files.set(path.join(backendPath, 'package.json'), JSON.stringify({ scripts: { 'test:coverage': 'vitest --coverage' } }));

    // coverage outputs (frontend)
    fs.__files.set(
      path.join(frontendPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        },
        'src/App.jsx': {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        }
      })
    );
    fs.__files.set(
      path.join(frontendPath, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        'src/App.jsx': {
          l: { 1: 1 }
        }
      })
    );

    // coverage outputs (backend) - should not be read when filtered out, but safe if implementation reads anyway.
    fs.__files.set(
      path.join(backendPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        }
      })
    );

    const startedJobs = [];

    const testsApi = createBranchWorkflowTests({
      AUTO_TEST_DEBOUNCE_MS: 0,
      autoTestTimers: new Map(),
      autoTestKey: () => 'key',
      isTestMode: () => false,
      ensureProjectExists: async () => {},
      ensureMainBranch: async () => ({ id: 1, name: 'main', staged_files: '[]', ahead_commits: 0 }),
      getBranchByName: async (_projectId, name) => ({ id: 2, name, staged_files: '[]', ahead_commits: 0 }),
      getProjectContext: async () => ({ projectPath: projectRoot, gitReady: false }),
      listBranchChangedPaths: async () => [],
      parseStagedFiles: () => [],
      resolveCoveragePolicy: () => ({
        globalThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
        changedFileThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
        enforceChangedFileCoverage: true
      }),
      runProjectGit: async () => ({ stdout: '' }),
      run: async (sql) => {
        if (String(sql).includes('INSERT INTO test_runs')) {
          return { lastID: 123 };
        }
        return { lastID: 0 };
      },
      get: async (sql) => {
        if (String(sql).includes('FROM test_runs tr')) {
          return { id: 123, branch_name: 'feature/ui', status: 'passed' };
        }
        return null;
      },
      serializeTestRun: (row) => ({ id: row.id, branch: row.branch_name, success: true }),
      buildTestResultPayload: () => ({
        status: 'passed',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, coverage: { thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }, passed: true } },
        tests: [],
        workspaceRuns: []
      }),
      withStatusCode: (error, statusCode) => {
        error.statusCode = statusCode;
        return error;
      },
      startJob: (job) => {
        startedJobs.push(job);
        return { id: startedJobs.length };
      },
      waitForJobCompletion: async () => ({ status: 'succeeded', exitCode: 0, logs: [] }),
      JOB_STATUS: { SUCCEEDED: 'succeeded' },
      fs,
      path
    });

    await testsApi.runTestsForBranch(1, 'feature/ui', {
      workspaceScope: 'changed',
      changedPaths: ['frontend/src/App.jsx']
    });

    const jobCwds = startedJobs.map((job) => job.cwd);
    expect(jobCwds).toHaveLength(1);
    expect(jobCwds[0]).toBe(frontendPath);
  });

  it('runs all workspaces when workspaceScope=changed but paths are not prefixed (safe fallback)', async () => {
    const projectRoot = 'C:\\tmp\\project-scope-2';
    const frontendPath = path.join(projectRoot, 'frontend');
    const backendPath = path.join(projectRoot, 'backend');

    const fs = createInMemoryFs();

    fs.__files.set(path.join(frontendPath, 'package.json'), JSON.stringify({ scripts: { 'test:coverage': 'vitest --coverage' } }));
    fs.__files.set(path.join(backendPath, 'package.json'), JSON.stringify({ scripts: { 'test:coverage': 'vitest --coverage' } }));

    fs.__files.set(
      path.join(frontendPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        }
      })
    );
    fs.__files.set(
      path.join(backendPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        }
      })
    );

    const startedJobs = [];

    const testsApi = createBranchWorkflowTests({
      AUTO_TEST_DEBOUNCE_MS: 0,
      autoTestTimers: new Map(),
      autoTestKey: () => 'key',
      isTestMode: () => false,
      ensureProjectExists: async () => {},
      ensureMainBranch: async () => ({ id: 1, name: 'main', staged_files: '[]', ahead_commits: 0 }),
      getBranchByName: async (_projectId, name) => ({ id: 2, name, staged_files: '[]', ahead_commits: 0 }),
      getProjectContext: async () => ({ projectPath: projectRoot, gitReady: false }),
      listBranchChangedPaths: async () => [],
      parseStagedFiles: () => [],
      resolveCoveragePolicy: () => ({
        globalThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
        changedFileThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
        enforceChangedFileCoverage: false
      }),
      runProjectGit: async () => ({ stdout: '' }),
      run: async (sql) => {
        if (String(sql).includes('INSERT INTO test_runs')) {
          return { lastID: 456 };
        }
        return { lastID: 0 };
      },
      get: async (sql) => {
        if (String(sql).includes('FROM test_runs tr')) {
          return { id: 456, branch_name: 'feature/api', status: 'passed' };
        }
        return null;
      },
      serializeTestRun: (row) => ({ id: row.id, branch: row.branch_name, success: true }),
      buildTestResultPayload: () => ({
        status: 'passed',
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, coverage: { thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }, passed: true } },
        tests: [],
        workspaceRuns: []
      }),
      withStatusCode: (error, statusCode) => {
        error.statusCode = statusCode;
        return error;
      },
      startJob: (job) => {
        startedJobs.push(job);
        return { id: startedJobs.length };
      },
      waitForJobCompletion: async () => ({ status: 'succeeded', exitCode: 0, logs: [] }),
      JOB_STATUS: { SUCCEEDED: 'succeeded' },
      fs,
      path
    });

    await testsApi.runTestsForBranch(1, 'feature/api', {
      workspaceScope: 'changed',
      changedPaths: ['README.md']
    });

    const jobCwds = startedJobs.map((job) => job.cwd).sort();
    expect(jobCwds).toEqual([backendPath, frontendPath].sort());
  });

  it('re-fetches the project context inside collectWorkspaceResults when none is supplied', async () => {
    const projectRoot = 'C:\\tmp\\project-context-fallback';
    const frontendPath = path.join(projectRoot, 'frontend');

    const fs = createInMemoryFs();
    fs.__files.set(
      path.join(frontendPath, 'package.json'),
      JSON.stringify({ scripts: { 'test:coverage': 'vitest --coverage' } })
    );
    fs.__files.set(
      path.join(frontendPath, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: {
          lines: { pct: 100 },
          statements: { pct: 100 },
          functions: { pct: 100 },
          branches: { pct: 100 }
        }
      })
    );
    fs.__files.set(
      path.join(frontendPath, 'coverage', 'coverage-final.json'),
      JSON.stringify({ 'src/App.jsx': { l: { 1: 1 } } })
    );

    const getProjectContext = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ projectPath: projectRoot, gitReady: false });

    const startedJobs = [];

    const testsApi = createBranchWorkflowTests({
      AUTO_TEST_DEBOUNCE_MS: 0,
      autoTestTimers: new Map(),
      autoTestKey: () => 'key',
      isTestMode: () => false,
      ensureProjectExists: async () => {},
      ensureMainBranch: async () => ({ id: 1, name: 'main', staged_files: '[]', ahead_commits: 0 }),
      getBranchByName: async (_projectId, name) => ({ id: 2, name, staged_files: '[]', ahead_commits: 0 }),
      getProjectContext,
      listBranchChangedPaths: async () => [],
      parseStagedFiles: () => [],
      resolveCoveragePolicy: () => ({
        globalThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
        changedFileThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
        enforceChangedFileCoverage: false
      }),
      runProjectGit: async () => ({ stdout: '' }),
      run: async (sql) => {
        if (String(sql).includes('INSERT INTO test_runs')) {
          return { lastID: 789 };
        }
        return { lastID: 0 };
      },
      get: async (sql) => {
        if (String(sql).includes('FROM test_runs tr')) {
          return { id: 789, branch_name: 'feature/context', status: 'passed' };
        }
        return null;
      },
      getJob: () => null,
      serializeTestRun: (row) => row,
      buildTestResultPayload: () => ({ status: 'passed', summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 }, tests: [], workspaceRuns: [] }),
      withStatusCode: (error, status) => Object.assign(error, { statusCode: status }),
      startJob: (job) => {
        startedJobs.push(job);
        return { id: startedJobs.length };
      },
      waitForJobCompletion: async () => ({ status: 'succeeded', exitCode: 0, logs: [] }),
      JOB_STATUS: { SUCCEEDED: 'succeeded' },
      fs,
      path
    });

    await testsApi.runTestsForBranch(1, 'feature/context');

    expect(getProjectContext).toHaveBeenCalledTimes(2);
    expect(startedJobs).toHaveLength(1);
    expect(startedJobs[0].cwd).toBe(frontendPath);
  });
});

const setupTestsApi = (overrides = {}) => {
  const autoTestTimers = overrides.autoTestTimers ?? new Map();
  const core = {
    AUTO_TEST_DEBOUNCE_MS: 0,
    autoTestTimers,
    autoTestKey: (projectId, branchName = '') => `${projectId}:${branchName || ''}`,
    isTestMode: () => false,
    ensureProjectExists: async () => {},
    ensureMainBranch: async () => ({ id: 1, name: 'main', staged_files: '[]', ahead_commits: 0 }),
    getBranchByName: async (_projectId, name = 'feature/test') => ({ id: 2, name, staged_files: '[]', ahead_commits: 0 }),
    getProjectContext: async () => ({ projectPath: '', gitReady: false }),
    listBranchChangedPaths: async () => [],
    parseStagedFiles: () => [],
    resolveCoveragePolicy: () => ({ globalThresholds: {}, changedFileThresholds: {}, enforceChangedFileCoverage: false }),
    runProjectGit: async () => ({ stdout: '' }),
    run: vi.fn().mockResolvedValue({ lastID: 1 }),
    get: vi.fn().mockResolvedValue(null),
    getJob: () => null,
    serializeTestRun: (row) => row,
    buildTestResultPayload: () => ({
      status: 'passed',
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0, coverage: { passed: true } },
      tests: [],
      workspaceRuns: []
    }),
    withStatusCode: (error, status) => Object.assign(error, { statusCode: status }),
    startJob: vi.fn(),
    waitForJobCompletion: vi.fn(),
    JOB_STATUS: { SUCCEEDED: 'succeeded' },
    fs: { readFile: vi.fn(), access: vi.fn() },
    path,
    ...overrides,
    autoTestTimers
  };

  const testsApi = createBranchWorkflowTests(core);
  return { testsApi, core };
};

describe('branchWorkflow testsApi: css-only helpers and scheduling', () => {
  it('does not schedule auto tests without a branch name', () => {
    const autoTestTimers = new Map();
    const { testsApi, core } = setupTestsApi({ autoTestTimers });

    testsApi.scheduleAutoTests(1, null);
    testsApi.scheduleAutoTests(1, '');

    expect(core.autoTestTimers.size).toBe(0);
  });

  it('treats staged entries without paths as non css-only branches', async () => {
    const parseStagedFiles = vi.fn(() => [{ /* missing path */ }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: false }));
    const { testsApi } = setupTestsApi({ parseStagedFiles, getProjectContext });

    const result = await testsApi.determineCssOnlyStatus(1, { name: 'feature/missing-path', staged_files: '[]' });

    expect(result).toMatchObject({ isCssOnly: false, indicator: null });
    expect(parseStagedFiles).toHaveBeenCalled();
  });

  it('uses staged indicators when git diffs return no changes', async () => {
    const parseStagedFiles = vi.fn(() => [{ path: 'styles/app.css' }]);
    const getProjectContext = vi.fn(async () => ({ gitReady: true }));
    const listBranchChangedPaths = vi.fn(async () => []);
    const { testsApi } = setupTestsApi({ parseStagedFiles, getProjectContext, listBranchChangedPaths });

    const status = await testsApi.determineCssOnlyStatus(1, { name: 'feature/css', staged_files: '[]' });

    expect(status).toMatchObject({ isCssOnly: true, indicator: 'staged' });
    expect(listBranchChangedPaths).toHaveBeenCalled();
  });

  it('records css-only skip runs with default indicator labels when omitted', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ lastID: 99 })
      .mockResolvedValue({ lastID: 0 });
    const get = vi.fn(async () => ({ id: 99, branch_name: 'feature/css', status: 'skipped' }));
    const serializeTestRun = vi.fn((row) => ({ serializedId: row.id }));

    const { testsApi } = setupTestsApi({ run, get, serializeTestRun });

    const result = await testsApi.__testHooks.recordCssOnlySkipRun({
      projectId: 1,
      branch: { id: 2, name: 'feature/css' }
    });

    expect(result).toEqual({ serializedId: 99 });
    expect(serializeTestRun).toHaveBeenCalledWith({ id: 99, branch_name: 'feature/css', status: 'skipped' });

    const insertParams = run.mock.calls[0][1];
    const summaryPayload = JSON.parse(insertParams[2]);
    const detailsPayload = JSON.parse(insertParams[3]);

    expect(summaryPayload.coverage.source).toBe('css-only');
    expect(detailsPayload.skipReason).toBe('css-only');
  });

  it('surfaces configuration errors when no workspace manifests exist', async () => {
    const fs = {
      readFile: vi.fn(async () => {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }),
      access: vi.fn(async () => {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      })
    };

    const { testsApi } = setupTestsApi({
      fs,
      getProjectContext: async () => ({ projectPath: 'C:/tmp/empty-project', gitReady: false })
    });

    await expect(
      testsApi.runTestsForBranch(1, 'feature/missing-workspace')
    ).rejects.toMatchObject({
      message: 'Test runner not configured (no package.json or requirements.txt found)',
      statusCode: 400
    });

    expect(fs.access).toHaveBeenCalled();
  });
});

describe('branchWorkflow testsApi: recordJobProofForBranch', () => {
  const buildTestsApi = ({ jobMap = new Map(), serialize = (row) => row, getJobImpl } = {}) => {
    const runCalls = [];
    let nextRunId = 100;

    const run = vi.fn(async (sql, params = []) => {
      runCalls.push({ sql, params });
      if (String(sql).includes('INSERT INTO test_runs')) {
        return { lastID: nextRunId++ };
      }
      return { lastID: 0 };
    });

    const get = vi.fn(async (sql, params = []) => {
      if (String(sql).includes('FROM test_runs tr')) {
        return {
          id: params[0],
          branch_name: 'feature/proof',
          status: 'passed',
          summary: '{}',
          details: '[]'
        };
      }
      return null;
    });

    const testsApi = createBranchWorkflowTests({
      AUTO_TEST_DEBOUNCE_MS: 0,
      autoTestTimers: new Map(),
      autoTestKey: () => 'key',
      isTestMode: () => false,
      ensureProjectExists: async () => {},
      ensureMainBranch: async () => ({ id: 1, name: 'main', staged_files: '[]', ahead_commits: 0 }),
      getBranchByName: async () => ({ id: 2, name: 'feature/proof', staged_files: '[]', ahead_commits: 0 }),
      getProjectContext: async () => ({ projectPath: '', gitReady: false }),
      listBranchChangedPaths: async () => [],
      parseStagedFiles: () => [],
      resolveCoveragePolicy: () => ({ globalThresholds: {}, changedFileThresholds: {}, enforceChangedFileCoverage: false }),
      runProjectGit: async () => ({ stdout: '' }),
      run,
      get,
      getJob: getJobImpl !== undefined ? getJobImpl : ((jobId) => jobMap.get(jobId) || null),
      serializeTestRun: serialize,
      buildTestResultPayload: () => ({}),
      withStatusCode: (error, status) => Object.assign(error, { statusCode: status }),
      startJob: vi.fn(),
      waitForJobCompletion: vi.fn(),
      JOB_STATUS: { SUCCEEDED: 'succeeded' },
      fs: { readFile: vi.fn(), access: vi.fn() },
      path
    });

    return { testsApi, run, get, runCalls };
  };

  it('records a passing proof from completed jobs', async () => {
    const jobMap = new Map([
      ['job-proof', {
        id: 'job-proof',
        projectId: 1,
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:30.000Z'
      }]
    ]);

    const serialize = vi.fn((row) => ({ id: row.id, branch: row.branch_name }));
    const { testsApi, run, runCalls } = buildTestsApi({ jobMap, serialize });

    const result = await testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['job-proof'] });

    expect(result).toEqual({ id: expect.any(Number), branch: 'feature/proof' });
    expect(run).toHaveBeenCalled();
    const insertCall = runCalls.find(({ sql }) => String(sql).includes('INSERT INTO test_runs'));
    expect(insertCall).toBeDefined();
    const updateCall = runCalls.find(({ sql }) => String(sql).includes('UPDATE branches'));
    expect(updateCall).toBeDefined();
    expect(serialize).toHaveBeenCalled();
  });

  it('throws when a referenced job cannot be found', async () => {
    const { testsApi } = buildTestsApi();

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['missing'] })
    ).rejects.toThrow('Job missing not found');
  });

  it('fails when job inspection is unavailable', async () => {
    const { testsApi } = buildTestsApi({ getJobImpl: null });

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['job-proof'] })
    ).rejects.toThrow('Test job inspection unavailable');
  });

  it('requires at least one completed test job id', async () => {
    const { testsApi } = buildTestsApi();

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', {})
    ).rejects.toThrow('Provide at least one completed test job id');
  });

  it('rejects jobs that belong to a different project', async () => {
    const jobMap = new Map([
      ['job-foreign', {
        id: 'job-foreign',
        projectId: 99,
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project'
      }]
    ]);

    const { testsApi } = buildTestsApi({ jobMap });

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['job-foreign'] })
    ).rejects.toThrow('Test job does not belong to this project');
  });

  it('rejects jobs that are not explicit test runs', async () => {
    const jobMap = new Map([
      ['job-build', {
        id: 'job-build',
        projectId: 1,
        type: 'frontend:build',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'build'],
        cwd: '/tmp/project'
      }]
    ]);

    const { testsApi } = buildTestsApi({ jobMap });

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['job-build'] })
    ).rejects.toThrow('Only completed test jobs can prove a branch');
  });

  it('rejects jobs that have not completed successfully', async () => {
    const jobMap = new Map([
      ['job-running', {
        id: 'job-running',
        projectId: 1,
        type: 'backend:test',
        status: 'running',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project'
      }]
    ]);

    const { testsApi } = buildTestsApi({ jobMap });

    await expect(
      testsApi.recordJobProofForBranch(1, 'feature/proof', { jobIds: ['job-running'] })
    ).rejects.toThrow('Job job-running has not completed successfully');
  });

  it('deduplicates job ids from multiple option fields', async () => {
    const jobMap = new Map([
      ['job-one', {
        id: 'job-one',
        projectId: 1,
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project/frontend',
        startedAt: '2024-02-01T00:00:00.000Z',
        completedAt: '2024-02-01T00:02:00.000Z'
      }],
      ['job-two', {
        id: 'job-two',
        projectId: 1,
        type: 'backend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project/backend',
        startedAt: '2024-02-01T00:05:00.000Z',
        completedAt: '2024-02-01T00:07:30.000Z'
      }],
      ['job-three', {
        id: 'job-three',
        projectId: 1,
        type: 'test-run',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        startedAt: '2024-02-01T00:10:00.000Z',
        completedAt: '2024-02-01T00:11:00.000Z'
      }]
    ]);

    const { testsApi, runCalls } = buildTestsApi({ jobMap });

    await testsApi.recordJobProofForBranch(1, 'feature/proof', {
      frontendJobId: '  job-one  ',
      backendJobId: 'job-two',
      jobIds: ['job-three', 'job-one', 'job-two', 'job-three']
    });

    const insertCall = runCalls.find(({ sql }) => String(sql).includes('INSERT INTO test_runs'));
    expect(insertCall).toBeDefined();
    const details = JSON.parse(insertCall.params[3]);
    expect(details.workspaceRuns).toHaveLength(3);
    expect(details.workspaceRuns.map((run) => run.workspace)).toEqual(
      expect.arrayContaining(['frontend', 'backend', 'test-run'])
    );
  });

  it('normalizes proof candidate ids from mixed option inputs', () => {
    const { testsApi } = buildTestsApi();
    const hooks = testsApi.__testHooks;

    const result = hooks.collectJobProofCandidates({
      frontendJobId: ' job-alpha ',
      backendJobId: 'job-beta',
      jobIds: ['job-alpha', 77, null, undefined, '  ', '77']
    });

    expect(result).toEqual(['job-alpha', 'job-beta', '77']);
  });

  it('resolves workspace labels for known prefixes and falls back to test-run', () => {
    const { testsApi } = buildTestsApi();
    const hooks = testsApi.__testHooks;

    expect(hooks.resolveWorkspaceLabel('Frontend:lint')).toBe('frontend');
    expect(hooks.resolveWorkspaceLabel('backend:test')).toBe('backend');
    expect(hooks.resolveWorkspaceLabel('custom-suite')).toBe('custom-suite');
    expect(hooks.resolveWorkspaceLabel()).toBe('test-run');
  });

  it('records workspace runs with duration and cwd fallbacks', async () => {
    const jobMap = new Map([
      ['job-duration', {
        id: 'job-duration',
        projectId: 1,
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project/frontend',
        startedAt: '2024-02-01T00:00:00.000Z',
        completedAt: '2024-02-01T00:02:00.000Z'
      }],
      ['77', {
        id: '77',
        projectId: 1,
        type: 'test-run',
        status: 'succeeded',
        command: 'python',
        args: null,
        cwd: undefined,
        startedAt: null,
        completedAt: null
      }]
    ]);

    const { testsApi, runCalls } = buildTestsApi({ jobMap });

    await testsApi.recordJobProofForBranch(1, 'feature/proof', {
      frontendJobId: '  job-duration  ',
      jobIds: [77, null, 'job-duration']
    });

    const insertCall = runCalls.find(({ sql }) => String(sql).includes('INSERT INTO test_runs'));
    expect(insertCall).toBeDefined();

    const summary = JSON.parse(insertCall.params[2]);
    const details = JSON.parse(insertCall.params[3]);

    expect(details.workspaceRuns).toEqual([
      expect.objectContaining({
        jobId: 'job-duration',
        workspace: 'frontend',
        durationMs: 120000,
        command: 'npm run test',
        cwd: '/tmp/project/frontend'
      }),
      expect.objectContaining({
        jobId: '77',
        workspace: 'test-run',
        durationMs: null,
        command: 'python',
        cwd: null
      })
    ]);

    expect(summary.coverage.jobs).toEqual([
      expect.objectContaining({ jobId: 'job-duration', durationMs: 120000 }),
      expect.objectContaining({ jobId: '77', durationMs: null })
    ]);
    expect(summary.duration).toBeCloseTo(120);
  });
});
