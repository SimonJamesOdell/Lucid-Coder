import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createBranchWorkflowTests } from '../services/branchWorkflow/testsApi.js';
import { resolveCoveragePolicy } from '../constants/coveragePolicy.js';

const withStatusCode = (error, statusCode) => {
  error.statusCode = statusCode;
  return error;
};

const writeFrontendWorkspace = async (projectRoot) => {
  const frontendDir = path.join(projectRoot, 'frontend');
  const coverageDir = path.join(frontendDir, 'coverage');
  await fs.mkdir(coverageDir, { recursive: true });
  await fs.writeFile(
    path.join(frontendDir, 'package.json'),
    JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } })
  );
  await fs.writeFile(
    path.join(coverageDir, 'coverage-summary.json'),
    JSON.stringify({
      total: {
        lines: { pct: 100 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    })
  );
};

const buildApi = ({ projectRoot, getTestingSettings, getProjectTestingSettings }) => {
  let nextRunId = 1;
  const branch = { id: 1, name: 'feature/thresholds', ahead_commits: 1, staged_files: '[]' };
  const runRows = new Map();
  let nextJobId = 1;

  const run = async (sql, params = []) => {
    if (String(sql).includes('INSERT INTO test_runs')) {
      const id = nextRunId++;
      runRows.set(id, {
        id,
        project_id: params[0],
        branch_id: params[1],
        branch_name: branch.name,
        status: 'running',
        summary: null,
        details: null,
        total_tests: 0,
        passed_tests: 0,
        failed_tests: 0,
        skipped_tests: 0,
        duration: 0,
        error: null,
        created_at: new Date().toISOString(),
        completed_at: null
      });
      return { lastID: id };
    }

    if (String(sql).includes('UPDATE test_runs')) {
      const id = params[params.length - 1];
      const existing = runRows.get(id) || { id, branch_name: branch.name };
      runRows.set(id, {
        ...existing,
        status: params[0],
        summary: params[1],
        details: params[2],
        total_tests: params[3],
        passed_tests: params[4],
        failed_tests: params[5],
        skipped_tests: params[6],
        duration: params[7],
        error: params[8],
        completed_at: new Date().toISOString()
      });
      return { changes: 1 };
    }

    return { changes: 1 };
  };

  const get = async (sql, params = []) => {
    if (String(sql).includes('SELECT * FROM branches WHERE project_id = ? AND is_current = 1')) {
      return branch;
    }

    if (String(sql).includes('SELECT tr.*, b.name as branch_name')) {
      const id = params[0];
      const row = runRows.get(id);
      return row || null;
    }

    return null;
  };

  const api = createBranchWorkflowTests({
    AUTO_TEST_DEBOUNCE_MS: 0,
    autoTestTimers: new Map(),
    autoTestKey: (projectId, branchName) => `${projectId}:${branchName}`,
    isTestMode: () => false,
    ensureProjectExists: async () => true,
    ensureMainBranch: async () => ({ id: 999, name: 'main' }),
    getBranchByName: async () => branch,
    getProjectContext: async () => ({ projectPath: projectRoot, gitReady: false }),
    listBranchChangedPaths: async () => [],
    parseStagedFiles: () => [],
    resolveCoveragePolicy,
    getTestingSettings,
    getProjectTestingSettings,
    runProjectGit: async () => ({ stdout: '', stderr: '' }),
    run,
    get,
    getJob: () => null,
    serializeTestRun: (row) => {
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        summary: row.summary ? JSON.parse(row.summary) : null,
        details: row.details ? JSON.parse(row.details) : null,
        workspaceRuns: row.details ? (JSON.parse(row.details).workspaceRuns || []) : []
      };
    },
    buildTestResultPayload: () => ({ status: 'passed', summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 }, tests: [] }),
    withStatusCode,
    startJob: () => ({ id: `job-${nextJobId++}` }),
    waitForJobCompletion: async () => ({ status: 'succeeded', exitCode: 0, logs: [] }),
    JOB_STATUS: {
      PENDING: 'pending',
      RUNNING: 'running',
      SUCCEEDED: 'succeeded',
      FAILED: 'failed',
      CANCELLED: 'cancelled'
    },
    fs,
    path
  });

  return api;
};

describe('branchWorkflow testsApi thresholds normalization', () => {
  it('falls back when settings loaders reject', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-testsapi-reject-'));
    try {
      await writeFrontendWorkspace(projectRoot);
      const api = buildApi({
        projectRoot,
        getTestingSettings: async () => {
          throw new Error('global settings unavailable');
        },
        getProjectTestingSettings: async () => {
          throw new Error('project settings unavailable');
        }
      });

      const result = await api.runTestsForBranch(1, 'feature/thresholds', { real: true });
      expect(result.status).toBe('passed');
      expect(result.summary.coverage.workspaceThresholds.frontend).toEqual({
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to global thresholds when custom workspace values are invalid', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-testsapi-invalid-'));
    try {
      await writeFrontendWorkspace(projectRoot);
      const api = buildApi({
        projectRoot,
        getTestingSettings: async () => ({ coverageTarget: 90 }),
        getProjectTestingSettings: async () => ({
          frontend: { mode: 'custom', coverageTarget: 120, effectiveCoverageTarget: 95 },
          backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 90 }
        })
      });

      const result = await api.runTestsForBranch(1, 'feature/thresholds', { real: true });
      expect(result.status).toBe('passed');
      expect(result.summary.coverage.workspaceThresholds.frontend).toEqual({
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('evaluates dependency-install trigger paths for root and workspace-scoped changes', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-testsapi-install-trigger-'));
    try {
      await writeFrontendWorkspace(projectRoot);
      await fs.writeFile(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ scripts: { 'test:coverage': 'echo ok' } })
      );

      const api = buildApi({
        projectRoot,
        getTestingSettings: async () => ({ coverageTarget: 100 }),
        getProjectTestingSettings: async () => null
      });

      expect(api.__testHooks.shouldInstallNodeDependencies({
        workspaceName: 'frontend',
        changedPaths: ['package-lock.json']
      })).toBe(true);

      expect(api.__testHooks.shouldInstallNodeDependencies({
        workspaceName: 'root',
        changedPaths: ['package.json']
      })).toBe(true);

      expect(api.__testHooks.shouldInstallNodeDependencies({
        workspaceName: 'frontend',
        changedPaths: ['backend/package.json']
      })).toBe(false);

      expect(api.__testHooks.shouldInstallNodeDependencies({
        workspaceName: '',
        changedPaths: ['package.json']
      })).toBe(true);

      expect(api.__testHooks.shouldInstallNodeDependencies({
        workspaceName: 'frontend',
        changedPaths: ['   ']
      })).toBe(false);
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
