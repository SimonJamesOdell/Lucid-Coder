import { describe, it, expect, vi } from 'vitest';

const normalize = (value) => String(value || '').replace(/\\/g, '/');

const makeFsMock = ({ accessible = [], files = {} } = {}) => {
  const accessibleSet = new Set(accessible.map(normalize));
  const fileMap = new Map(Object.entries(files).map(([key, content]) => [normalize(key), content]));

  const access = vi.fn(async (targetPath) => {
    const normalized = normalize(targetPath);
    if (accessibleSet.has(normalized)) {
      return undefined;
    }
    const error = new Error(`ENOENT: no such file or directory, access '${normalized}'`);
    error.code = 'ENOENT';
    throw error;
  });

  const readFile = vi.fn(async (targetPath) => {
    const normalized = normalize(targetPath);
    if (fileMap.has(normalized)) {
      return fileMap.get(normalized);
    }
    const error = new Error(`ENOENT: no such file or directory, open '${normalized}'`);
    error.code = 'ENOENT';
    throw error;
  });

  return { access, readFile };
};

const makeJobRunnerMock = () => {
  let nextId = 1;
  const started = [];

  const JOB_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
  };

  const startJob = vi.fn((payload) => {
    const job = {
      id: `job-${nextId++}`,
      status: JOB_STATUS.RUNNING,
      exitCode: null,
      logs: [],
      ...payload
    };
    started.push(job);
    return job;
  });

  const waitForJobCompletion = vi.fn(async (jobId) => {
    const base = started.find((job) => job.id === jobId) || { id: jobId };
    return {
      ...base,
      status: JOB_STATUS.SUCCEEDED,
      exitCode: 0,
      logs: [
        { stream: 'stdout', message: 'ok', timestamp: new Date().toISOString() },
        { stream: 'stderr', message: '', timestamp: new Date().toISOString() }
      ]
    };
  });

  const getJob = vi.fn(async () => null);

  return { JOB_STATUS, startJob, waitForJobCompletion, getJob };
};

const runScenario = async ({ fsMock, jobRunnerMock, gitMock, testBody }) => {
  vi.resetModules();

  vi.doMock('fs/promises', async () => {
    const actual = await vi.importActual('fs/promises');
    const baseDefault = actual?.default && typeof actual.default === 'object' ? actual.default : actual;

    return {
      ...actual,
      access: fsMock.access,
      readFile: fsMock.readFile,
      default: {
        ...baseDefault,
        access: fsMock.access,
        readFile: fsMock.readFile
      }
    };
  });

  vi.doMock('../services/jobRunner.js', () => ({
    JOB_STATUS: jobRunnerMock.JOB_STATUS,
    startJob: jobRunnerMock.startJob,
    waitForJobCompletion: jobRunnerMock.waitForJobCompletion,
    getJob: jobRunnerMock.getJob
  }));

  if (gitMock) {
    vi.doMock('../utils/git.js', () => gitMock);
  }

  const branchWorkflow = await import('../services/branchWorkflow.js');
  const databaseModule = await import('../database.js');
  const { default: dbInstance, initializeDatabase, createProject } = databaseModule;

  const exec = (sql, params = []) => new Promise((resolve, reject) => {
    dbInstance.run(sql, params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  try {
    await initializeDatabase();
    await exec('DELETE FROM test_runs');
    await exec('DELETE FROM branches');
    await exec('DELETE FROM projects');

    await testBody({ branchWorkflow, createProject });
  } finally {
    vi.resetModules();
  }
};

const coverageSummaryJson = (pct = 100) =>
  JSON.stringify({
    total: {
      lines: { pct },
      statements: { pct },
      functions: { pct },
      branches: { pct }
    }
  });

const coverageSummaryJsonTotals = ({ lines = 100, statements = 100, functions = 100, branches = 100 } = {}) =>
  JSON.stringify({
    total: {
      lines: { pct: lines },
      statements: { pct: statements },
      functions: { pct: functions },
      branches: { pct: branches }
    }
  });

const coverageSummaryJsonWithFiles = ({
  total = { lines: 100, statements: 100, functions: 100, branches: 100 },
  files = {}
} = {}) => {
  const perFile = Object.fromEntries(
    Object.entries(files).map(([filePath, pct]) => [
      filePath,
      {
        lines: { pct },
        statements: { pct },
        functions: { pct },
        branches: { pct }
      }
    ])
  );

  return JSON.stringify({
    total: {
      lines: { pct: total.lines },
      statements: { pct: total.statements },
      functions: { pct: total.functions },
      branches: { pct: total.branches }
    },
    ...perFile
  });
};

const coverageSummaryJsonMissingMetric = ({ omit = [] } = {}) => {
  const totals = {
    lines: { pct: 100 },
    statements: { pct: 100 },
    functions: { pct: 100 },
    branches: { pct: 100 }
  };

  for (const key of omit) {
    delete totals[key];
  }

  return JSON.stringify({ total: totals });
};

describe('branchWorkflow.js coverage (runTestsForBranch workspace collection)', () => {
  it('runs real workspace collection (node + python) and passes the coverage gate', async () => {
    const projectRoot = `C:/tmp/branchworkflow-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const backendReq = `${projectRoot}/backend/requirements.txt`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const pythonCoverage = `${projectRoot}/backend/coverage.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg, backendReq],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJson(100),
        [pythonCoverage]: JSON.stringify({ raw: true })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Coverage ${Date.now()}`,
          description: 'Covers collectWorkspaceResults',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          onJobStarted: () => {
            throw new Error('boom');
          },
          onJobCompleted: () => {
            throw new Error('boom');
          }
        });

        expect(result.status).toBe('passed');
        expect(result.success).toBe(true);
        expect(Array.isArray(result.workspaceRuns)).toBe(true);
        expect(result.workspaceRuns.length).toBe(2);

        const frontendRun = result.workspaceRuns.find((run) => run.workspace === 'frontend');
        expect(frontendRun).toBeTruthy();
        expect(frontendRun.status).toBe(jobRunnerMock.JOB_STATUS.SUCCEEDED);
        expect(frontendRun.coverage).toMatchObject({ lines: 100, statements: 100, functions: 100, branches: 100 });

        const backendRun = result.workspaceRuns.find((run) => run.workspace === 'backend');
        expect(backendRun).toBeTruthy();
        expect(backendRun.coverage).toMatchObject({ raw: { raw: true } });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('includes uncovered line details for changed files when coverage-final.json is available', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-lines-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const coveredFilePath = `${projectRoot}/frontend/src/foo.js`;
    const coverageFinal = {
      // Non-object entry should be ignored when building the byFile map.
      'src/ignore-me.js': null,
      [coveredFilePath]: {
        path: coveredFilePath,
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
        l: {
          1: 1,
          2: 0,
          3: 1,
          4: 0
        }
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered Lines ${Date.now()}`,
          description: 'Captures uncovered lines from coverage-final.json',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.uncoveredLines).toEqual([
          { workspace: 'frontend', file: 'src/foo.js', lines: [2, 4] }
        ]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('returns null uncoveredLines when coverage-final entry has no line/statement maps', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-empty-entry-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const coverageFinal = {
      'src/foo.js': {
        fnMap: {},
        branchMap: {},
        f: {},
        b: {}
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered EmptyEntry ${Date.now()}`,
          description: 'Covers extractUncoveredLines early return for missing maps',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.uncoveredLines).toBe(null);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('captures uncovered lines for all files when includeCoverageLineRefs is true', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-all-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;
    const filePath = `${projectRoot}/frontend/src/foo.js`;

    const coverageFinal = {
      [filePath]: {
        l: { 5: 0 }
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered All ${Date.now()}`,
          description: 'Collects uncovered lines for all files when requested',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          includeCoverageLineRefs: true,
          changedFiles: [],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.uncoveredLines).toEqual([
          { workspace: 'frontend', file: 'src/foo.js', lines: [5] }
        ]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('extracts uncovered lines from statementMap when line map is missing', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-statement-map-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const filePath = `${projectRoot}/frontend/src/foo.js`;
    const coverageFinal = {
      [filePath]: {
        path: filePath,
        statementMap: {
          0: { start: { line: 10, column: 0 }, end: { line: 12, column: 0 } },
          1: { start: { line: 20, column: 0 }, end: { line: 20, column: 5 } },
          2: { start: { line: 30, column: 0 }, end: { line: 31, column: 0 } },
          3: { start: { column: 0 }, end: { line: 35, column: 0 } },
          4: { start: { line: 40, column: 0 }, end: { column: 0 } }
        },
        s: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 },
        fnMap: {},
        branchMap: {},
        f: {},
        b: {}
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered StatementMap ${Date.now()}`,
          description: 'Uses statementMap fallback when l is missing',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.summary?.coverage?.uncoveredLines).toEqual([
          { workspace: 'frontend', file: 'src/foo.js', lines: [10, 11, 12, 20, 40] }
        ]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('resolves coverage-final entries by exact relative path match when available', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-direct-key-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const coverageFinal = {
      'src/foo.js': {
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
        l: { 2: 0 }
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered DirectKey ${Date.now()}`,
          description: 'Covers direct byFile.has match path',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.summary?.coverage?.uncoveredLines).toEqual([
          { workspace: 'frontend', file: 'src/foo.js', lines: [2] }
        ]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('resolves coverage-final entries by suffix match when direct match is missing', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-suffix-key-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const coverageFinal = {
      'packages/app/src/foo.js': {
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
        l: { 2: 0 }
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered SuffixKey ${Date.now()}`,
          description: 'Covers resolveCoverageEntry endsWith fallback for coverage-final.json',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.summary?.coverage?.uncoveredLines).toEqual([
          { workspace: 'frontend', file: 'src/foo.js', lines: [2] }
        ]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('returns null uncoveredLines when coverage-final.json has no entry for changed files', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-missing-entry-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify({})
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered MissingEntry ${Date.now()}`,
          description: 'Covers resolveCoverageEntry miss branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.summary?.coverage?.uncoveredLines).toBe(null);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('returns null uncoveredLines when coverage-final.json has entries but none match changed files', async () => {
    const projectRoot = `C:/tmp/branchworkflow-uncovered-nonmatching-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const frontendFinal = `${projectRoot}/frontend/coverage/coverage-final.json`;

    const coverageFinal = {
      'packages/app/src/other.js': {
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
        l: { 1: 1 }
      }
    };

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 90, statements: 90, functions: 90, branches: 90 },
          files: { 'src/foo.js': 90 }
        }),
        [frontendFinal]: JSON.stringify(coverageFinal)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Uncovered NonMatching ${Date.now()}`,
          description: 'Covers resolveCoverageEntry endsWith false branch for coverage-final.json',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/foo.js'],
          coverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 },
          changedFileCoverageThresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.uncoveredLines).toBe(null);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('uses git diff changed paths when explicit changedFiles is not provided', async () => {
    const projectRoot = `C:/tmp/branchworkflow-git-diff-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/changed.js': 95
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();
    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--name-only' && typeof args[2] === 'string') {
        if (args[2].includes('main..feature/changed')) {
          return { stdout: 'frontend/src/changed.js\n', stderr: '', code: 0 };
        }
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await runScenario({
      fsMock,
      jobRunnerMock,
      gitMock: {
        runGitCommand,
        ensureGitRepository: vi.fn(async () => ({})),
        getCurrentBranch: vi.fn(async () => 'main'),
        stashWorkingTree: vi.fn(async () => null),
        popBranchStash: vi.fn(async () => null),
        commitAllChanges: vi.fn(async () => true),
        removeBranchStashes: vi.fn(async () => null)
      },
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Git Diff ${Date.now()}`,
          description: 'Covers resolveChangedPaths git diff success path',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        // Create a non-main branch so main..branch yields a diff.
        await branchWorkflow.__testing.runSql('UPDATE branches SET is_current = 0 WHERE project_id = ?', [project.id]);
        await branchWorkflow.__testing.runSql(
          `INSERT INTO branches (project_id, name, description, type, status, is_current, ahead_commits, behind_commits, staged_files)
           VALUES (?, ?, ?, ?, 'active', 1, 1, 0, '[]')`,
          [project.id, 'feature/changed', 'Git diff branch', 'feature']
        );

        const result = await branchWorkflow.runTestsForBranch(project.id, 'feature/changed', {
          real: true,
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95
        });

        const diffCallFound = runGitCommand.mock.calls.some(([, args]) => (
          Array.isArray(args)
          && args[0] === 'diff'
          && args[1] === '--name-only'
          && String(args[2] || '').includes('main..feature/changed')
        ));
        expect(diffCallFound).toBe(true);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('falls back to staged_files when git is not ready', async () => {
    const projectRoot = `C:/tmp/branchworkflow-staged-fallback-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/staged.js': 92
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Staged Fallback ${Date.now()}`,
          description: 'Covers resolveChangedPaths staged_files fallback',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        // When running tests without a git override in test mode, gitReady is false.
        await branchWorkflow.__testing.runSql('UPDATE branches SET is_current = 0 WHERE project_id = ?', [project.id]);
        await branchWorkflow.__testing.runSql(
          `INSERT INTO branches (project_id, name, description, type, status, is_current, ahead_commits, behind_commits, staged_files)
           VALUES (?, ?, ?, ?, 'active', 1, 1, 0, ?)`,
          [
            project.id,
            'feature/staged',
            'Staged fallback branch',
            'feature',
            // Include a few junk entries to cover the `entry?.path || ''` sanitization branch.
            JSON.stringify([{ path: '  src/staged.js  ' }, {}, null])
          ]
        );

        const result = await branchWorkflow.runTestsForBranch(project.id, 'feature/staged', {
          real: true,
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 92,
          statements: 92,
          functions: 92,
          branches: 92
        });
      }
    });
  });

  it('accepts changedPaths alias and sanitizes entries (covers falsy values + .cjs)', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changedpaths-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/file.cjs': 94
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow ChangedPaths ${Date.now()}`,
          description: 'Covers options.changedPaths, falsy values, and .cjs relevance',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedPaths: [null, '', '  frontend\\src\\file.cjs  '],
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 94,
          statements: 94,
          functions: 94,
          branches: 94
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('resolves per-file coverage entries by suffix and ignores non-object file entries', async () => {
    const projectRoot = `C:/tmp/branchworkflow-suffix-coverage-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const summary = JSON.stringify({
      total: {
        lines: { pct: 100 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      },
      // Non-object entry should be ignored (covers `entry && typeof entry === 'object'` branch).
      'src/ignore-me.js': null,
      // This should match `src/suffix.js` via the endsWith `/${normalized}` fallback.
      'packages/app/src/suffix.js': {
        lines: { pct: 93 },
        statements: { pct: 93 },
        functions: { pct: 93 },
        branches: { pct: 93 }
      }
    });

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: summary
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Suffix Coverage ${Date.now()}`,
          description: 'Covers resolveCoverageEntry endsWith fallback + non-object file entries',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/suffix.js'],
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 93,
          statements: 93,
          functions: 93,
          branches: 93
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('skips changed-file coverage when enforceChangedFileCoverage is false', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-disabled-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/whatever.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Coverage Disabled ${Date.now()}`,
          description: 'Covers enforceChangedFileCoverage=false branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          enforceChangedFileCoverage: false
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.workspaces?.[0]).toMatchObject({
          skipped: true,
          reason: 'disabled'
        });
      }
    });
  });

  it('applies coverageThresholds overrides when provided', async () => {
    const projectRoot = `C:/tmp/branchworkflow-thresholds-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJson(100)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Threshold Overrides ${Date.now()}`,
          description: 'Covers coverageThresholds spread branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          coverageThresholds: { lines: 90, statements: 95, functions: 80, branches: 85 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.thresholds).toMatchObject({
          lines: 90,
          statements: 95,
          functions: 80,
          branches: 85
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the changed-file coverage gate when a changed file is below changedFileCoverageThresholds', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/changed.js': 80,
            'src/unchanged.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files ${Date.now()}`,
          description: 'Covers changed-file coverage enforcement',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/changed.js'],
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(false);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual([]);
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 80,
          statements: 80,
          functions: 80,
          branches: 80
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('passes the changed-file coverage gate when changed files meet thresholds', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-pass-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/changed.js': 95
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Pass ${Date.now()}`,
          description: 'Covers passing changed-file coverage enforcement',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/changed.js'],
          changedFileCoverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(true);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual([]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('supports changed files without workspace prefix when only one node workspace exists', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-noprefix-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/changed.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files No Prefix ${Date.now()}`,
          description: 'Covers changed-file handling when paths are relative to workspace',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['src/changed.js']
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(true);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual([]);
        expect(result.summary?.coverage?.changedFiles?.totals).toMatchObject({
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('filters changed files per workspace when multiple node workspaces exist', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-multi-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const backendPkg = `${projectRoot}/backend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;
    const backendSummary = `${projectRoot}/backend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg, backendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [backendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/front.js': 100
          }
        }),
        [backendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/back.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Multi ${Date.now()}`,
          description: 'Covers workspace-prefix filtering when both frontend and backend are node workspaces',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/front.js', 'backend/src/back.js']
        });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(true);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual([]);

        const perWorkspace = result.summary?.coverage?.changedFiles?.workspaces;
        expect(Array.isArray(perWorkspace)).toBe(true);
        expect(perWorkspace.find((gate) => gate?.workspace === 'frontend')?.passed).toBe(true);
        expect(perWorkspace.find((gate) => gate?.workspace === 'backend')?.passed).toBe(true);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('skips changed-file gate when per-file coverage entries are unavailable (total-only summary)', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-total-only-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: JSON.stringify({
          total: {
            lines: { pct: 100 },
            statements: { pct: 100 },
            functions: { pct: 100 },
            branches: { pct: 100 }
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Total Only ${Date.now()}`,
          description: 'Covers per_file_coverage_unavailable branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/changed.js']
        });

        expect(result.status).toBe('passed');

        const gate = result.summary?.coverage?.changedFiles?.workspaces?.find((value) => value?.workspace === 'frontend');
        expect(gate).toBeTruthy();
        expect(gate.skipped).toBe(true);
        expect(gate.reason).toBe('per_file_coverage_unavailable');

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('returns gate early when changed paths exist but none are relevant source files', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-irrelevant-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/covered.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Irrelevant ${Date.now()}`,
          description: 'Covers early return when changedForWorkspace is empty',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/README.md', 'frontend/styles.css']
        });

        expect(result.status).toBe('passed');

        const gate = result.summary?.coverage?.changedFiles?.workspaces?.find((value) => value?.workspace === 'frontend');
        expect(gate).toBeTruthy();
        expect(gate.skipped).toBe(false);
        expect(gate.passed).toBe(true);
        expect(gate.totals).toBe(null);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('marks changed files as missing when per-file coverage entry is not present', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-missing-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonWithFiles({
          total: { lines: 100, statements: 100, functions: 100, branches: 100 },
          files: {
            'src/other.js': 100
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Missing ${Date.now()}`,
          description: 'Covers missing per-file entry branch in changed-file gate',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/missing.js']
        });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(false);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual(['frontend/src/missing.js']);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('marks changed files as missing when per-file pct values are non-finite', async () => {
    const projectRoot = `C:/tmp/branchworkflow-changed-files-nonfinite-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: JSON.stringify({
          total: {
            lines: { pct: 100 },
            statements: { pct: 100 },
            functions: { pct: 100 },
            branches: { pct: 100 }
          },
          'frontend/src/bad.js': {
            lines: { pct: 'NaN' },
            statements: { pct: 100 },
            functions: { pct: 100 },
            branches: { pct: 100 }
          }
        })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Changed Files Non-finite ${Date.now()}`,
          description: 'Covers non-finite per-file pct branch in changed-file gate',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, {
          real: true,
          changedFiles: ['frontend/src/bad.js']
        });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.changedFiles?.passed).toBe(false);
        expect(result.summary?.coverage?.changedFiles?.missing).toEqual(['frontend/src/bad.js']);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('treats empty changed-path diffs as not css-only (covers listBranchChangedPaths early return)', async () => {
    const fsMock = makeFsMock({});
    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow }) => {
        const result = await branchWorkflow.__testing.isCssOnlyBranchDiff({ gitReady: true }, '');
        expect(result).toBe(false);
      }
    });
  });

  it('marks root workspace missing coverage when only root package.json exists', async () => {
    const projectRoot = `C:/tmp/branchworkflow-root-missing-${Date.now()}`;
    const rootPkg = `${projectRoot}/package.json`;

    const fsMock = makeFsMock({
      accessible: [rootPkg],
      files: {
        [rootPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Root Missing Coverage ${Date.now()}`,
          description: 'Covers ranNode root branch in coverage gate',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        expect(result.summary?.coverage?.missing).toEqual(expect.arrayContaining(['root']));

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('marks backend workspace missing coverage when backend package.json exists (no frontend)', async () => {
    const projectRoot = `C:/tmp/branchworkflow-backend-missing-${Date.now()}`;
    const backendPkg = `${projectRoot}/backend/package.json`;

    const fsMock = makeFsMock({
      accessible: [backendPkg],
      files: {
        [backendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Backend Missing Coverage ${Date.now()}`,
          description: 'Covers ranNode backend branch in coverage gate',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        expect(result.summary?.coverage?.missing).toEqual(expect.arrayContaining(['backend']));
        expect(result.workspaceRuns).toHaveLength(1);
        expect(result.workspaceRuns[0].workspace).toBe('backend');

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the coverage gate when node coverage output is missing', async () => {
    const projectRoot = `C:/tmp/branchworkflow-missing-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } })
        // coverage summary intentionally missing
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Missing Coverage ${Date.now()}`,
          description: 'Covers coverageGate missing path',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('failed');
        expect(result.success).toBe(false);
        expect(result.summary?.coverage?.passed).toBe(false);
        expect(result.summary?.coverage?.missing).toEqual(expect.arrayContaining(['frontend']));
        expect(result.error).toMatch(/Branch main has failing tests/i);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('treats non-array details objects without tests as empty tests', async () => {
    const projectRoot = `C:/tmp/branchworkflow-details-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJson(100)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Details Shape ${Date.now()}`,
          description: 'Covers serializeTestRun details/tests fallback branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        // Create a test run via the normal path.
        await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        const latestRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM test_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1',
          [project.id]
        );

        await branchWorkflow.__testing.runSql(
          'UPDATE test_runs SET details = ? WHERE id = ?',
          [JSON.stringify({ workspaceRuns: [] }), latestRow.id]
        );

        const latest = await branchWorkflow.getLatestTestRun(project.id);
        expect(Array.isArray(latest.tests)).toBe(true);
        expect(latest.tests).toEqual([]);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the coverage gate when coverage totals are below thresholds', async () => {
    const projectRoot = `C:/tmp/branchworkflow-threshold-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJson(99)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Threshold ${Date.now()}`,
          description: 'Covers failed threshold comparisons',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        expect(result.summary?.coverage?.missing).toEqual([]);
        expect(result.summary?.coverage?.totals).toMatchObject({
          lines: 99,
          statements: 99,
          functions: 99,
          branches: 99
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the coverage gate when statements miss threshold but lines pass', async () => {
    const projectRoot = `C:/tmp/branchworkflow-threshold-statements-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 99, functions: 100, branches: 100 })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Threshold Statements ${Date.now()}`,
          description: 'Exercises short-circuit when statements miss threshold',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.totals).toMatchObject({ lines: 100, statements: 99, functions: 100, branches: 100 });
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the coverage gate when functions miss threshold but lines/statements pass', async () => {
    const projectRoot = `C:/tmp/branchworkflow-threshold-functions-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 100, functions: 99, branches: 100 })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Threshold Functions ${Date.now()}`,
          description: 'Exercises short-circuit when functions miss threshold',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.totals).toMatchObject({ lines: 100, statements: 100, functions: 99, branches: 100 });
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('fails the coverage gate when branches miss threshold but lines/statements/functions pass', async () => {
    const projectRoot = `C:/tmp/branchworkflow-threshold-branches-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 100, functions: 100, branches: 99 })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Threshold Branches ${Date.now()}`,
          description: 'Exercises final threshold comparison when branches miss threshold',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.totals).toMatchObject({ lines: 100, statements: 100, functions: 100, branches: 99 });
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers optional chaining when coverage totals omit lines', async () => {
    const projectRoot = `C:/tmp/branchworkflow-missing-lines-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonMissingMetric({ omit: ['lines'] })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Missing Lines ${Date.now()}`,
          description: 'Covers missing totals.lines optional chain',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers optional chaining when coverage totals omit statements', async () => {
    const projectRoot = `C:/tmp/branchworkflow-missing-statements-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonMissingMetric({ omit: ['statements'] })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Missing Statements ${Date.now()}`,
          description: 'Covers missing totals.statements optional chain',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers optional chaining when coverage totals omit functions', async () => {
    const projectRoot = `C:/tmp/branchworkflow-missing-functions-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonMissingMetric({ omit: ['functions'] })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Missing Functions ${Date.now()}`,
          description: 'Covers missing totals.functions optional chain',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers optional chaining when coverage totals omit branches', async () => {
    const projectRoot = `C:/tmp/branchworkflow-missing-branches-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonMissingMetric({ omit: ['branches'] })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Missing Branches ${Date.now()}`,
          description: 'Covers missing totals.branches optional chain',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.passed).toBe(false);
        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers optional chaining when job completion payload is undefined', async () => {
    const projectRoot = `C:/tmp/branchworkflow-undefined-job-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 100, functions: 100, branches: 100 })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();
    jobRunnerMock.waitForJobCompletion.mockResolvedValueOnce(undefined);

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Undefined Job ${Date.now()}`,
          description: 'Covers coverageJob optional chaining branches',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('failed');
        expect(result.summary?.coverage?.totals).toBeTruthy();

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('falls back to root workspace and uses npm test -- --coverage when no test:coverage script exists', async () => {
    const projectRoot = `C:/tmp/branchworkflow-root-${Date.now()}`;
    const rootPkg = `${projectRoot}/package.json`;
    const rootSummary = `${projectRoot}/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [rootPkg],
      files: {
        [rootPkg]: JSON.stringify({ scripts: { test: 'vitest' } }),
        [rootSummary]: coverageSummaryJson(100)
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Root ${Date.now()}`,
          description: 'Covers root workspace fallback',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('passed');

        const startedArgs = jobRunnerMock.startJob.mock.calls[0]?.[0]?.args;
        expect(Array.isArray(startedArgs)).toBe(true);
        expect(startedArgs).toEqual(['test', '--', '--coverage']);

        expect(result.workspaceRuns[0]?.workspace).toBe('root');

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('treats non-object scripts in package.json as missing test:coverage', async () => {
    const projectRoot = `C:/tmp/branchworkflow-scripts-nonobject-${Date.now()}`;
    const rootPkg = `${projectRoot}/package.json`;
    const rootSummary = `${projectRoot}/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [rootPkg],
      files: {
        [rootPkg]: JSON.stringify({ scripts: 'not-an-object' }),
        [rootSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 100, functions: 100, branches: 100 })
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Scripts Non-Object ${Date.now()}`,
          description: 'Covers scripts ternary fallback when scripts is not an object',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });
        expect(result.status).toBe('passed');

        const startedArgs = jobRunnerMock.startJob.mock.calls[0]?.[0]?.args;
        expect(startedArgs).toEqual(['test', '--', '--coverage']);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('covers python workspace branch when coverage.json is missing', async () => {
    const projectRoot = `C:/tmp/branchworkflow-python-missing-coverage-${Date.now()}`;
    const frontendPkg = `${projectRoot}/frontend/package.json`;
    const backendReq = `${projectRoot}/backend/requirements.txt`;
    const frontendSummary = `${projectRoot}/frontend/coverage/coverage-summary.json`;

    const fsMock = makeFsMock({
      accessible: [frontendPkg, backendReq],
      files: {
        [frontendPkg]: JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } }),
        [frontendSummary]: coverageSummaryJsonTotals({ lines: 100, statements: 100, functions: 100, branches: 100 })
        // backend/coverage.json intentionally missing
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Python Missing Coverage ${Date.now()}`,
          description: 'Covers python parsed==null branch',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        const backendRun = result.workspaceRuns.find((run) => run.workspace === 'backend');
        expect(backendRun).toBeTruthy();
        expect(backendRun.coverage).toBe(null);

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('does not fail coverage gate for python-only workspaces (node gate is not applicable)', async () => {
    const projectRoot = `C:/tmp/branchworkflow-python-only-${Date.now()}`;
    const backendReq = `${projectRoot}/backend/requirements.txt`;

    const fsMock = makeFsMock({
      accessible: [backendReq],
      files: {
        [backendReq]: 'pytest\npytest-cov\n'
        // backend/coverage.json intentionally missing
      }
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow Python Only ${Date.now()}`,
          description: 'Covers ranNode=false branch when only python workspace exists',
          language: 'python',
          framework: 'flask',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);
        const result = await branchWorkflow.runTestsForBranch(project.id, null, { real: true });

        expect(result.status).toBe('passed');
        expect(result.summary?.coverage?.passed).toBe(true);
        expect(result.workspaceRuns).toHaveLength(1);
        expect(result.workspaceRuns[0]).toMatchObject({ workspace: 'backend', kind: 'python' });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('throws 400 when no conventional workspaces exist', async () => {
    const projectRoot = `C:/tmp/branchworkflow-none-${Date.now()}`;

    const fsMock = makeFsMock({
      accessible: [],
      files: {}
    });

    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow None ${Date.now()}`,
          description: 'Covers missing workspace error',
          language: 'javascript',
          framework: 'react',
          path: projectRoot
        });

        branchWorkflow.__testing.setGitContextOverride(project.id, projectRoot);

        await expect(
          branchWorkflow.runTestsForBranch(project.id, null, { real: true })
        ).rejects.toMatchObject({ statusCode: 400 });

        branchWorkflow.__testing.setGitContextOverride(project.id, null);
      }
    });
  });

  it('throws 400 when project context has no projectPath', async () => {
    const fsMock = makeFsMock({ accessible: [], files: {} });
    const jobRunnerMock = makeJobRunnerMock();

    await runScenario({
      fsMock,
      jobRunnerMock,
      testBody: async ({ branchWorkflow, createProject }) => {
        const project = await createProject({
          name: `BranchWorkflow No Path ${Date.now()}`,
          description: 'Covers missing projectPath error',
          language: 'javascript',
          framework: 'react',
          path: null
        });

        await expect(
          branchWorkflow.runTestsForBranch(project.id, null, { real: true })
        ).rejects.toMatchObject({ statusCode: 400 });
      }
    });
  });
});
