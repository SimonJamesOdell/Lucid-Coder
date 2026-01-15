import { describe, test, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/branchWorkflow.js', () => ({
  getBranchOverview: vi.fn(),
  createWorkingBranch: vi.fn(),
  runTestsForBranch: vi.fn(),
  recordJobProofForBranch: vi.fn(),
  mergeBranch: vi.fn(),
  stageWorkspaceChange: vi.fn(),
  clearStagedChanges: vi.fn(),
  checkoutBranch: vi.fn(),
  deleteBranchByName: vi.fn(),
  commitBranchChanges: vi.fn(),
  getBranchCommitContext: vi.fn()
}));

import branchRoutes from '../routes/branches.js';
import {
  getBranchOverview,
  createWorkingBranch,
  stageWorkspaceChange,
  clearStagedChanges,
  commitBranchChanges,
  getBranchCommitContext,
  runTestsForBranch,
  recordJobProofForBranch,
  mergeBranch,
  checkoutBranch,
  deleteBranchByName
} from '../services/branchWorkflow.js';

const createTestApp = (useJson = true) => {
  const instance = express();
  if (useJson) {
    instance.use(express.json());
  }
  instance.use('/api/projects/:projectId/branches', branchRoutes);
  return instance;
};

const app = createTestApp();

describe('branch route error handling', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('rejects invalid project ids before hitting services', async () => {
    const response = await request(app).get('/api/projects/not-a-number/branches');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid project id');
    expect(getBranchOverview).not.toHaveBeenCalled();
  });

  test('GET /branches uses fallback message when overview lookup fails', async () => {
    getBranchOverview.mockRejectedValueOnce(new Error('database offline'));

    const response = await request(app).get('/api/projects/1/branches');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to fetch branches');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[BranchRoutes]', 'database offline');
  });

  test('POST /branches surfaces creation failures', async () => {
    createWorkingBranch.mockRejectedValueOnce(new Error('cannot create branch'));

    const response = await request(app)
      .post('/api/projects/1/branches')
      .send({ name: 'feature/missing' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to create branch');
  });

  test('POST /branches/stage surfaces staging failures', async () => {
    stageWorkspaceChange.mockRejectedValueOnce(new Error('stage crashed'));

    const response = await request(app)
      .post('/api/projects/1/branches/stage')
      .send({ filePath: 'src/app.jsx' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to stage file change');
  });

  test('DELETE /branches/stage reports clearing errors', async () => {
    clearStagedChanges.mockRejectedValueOnce(new Error('unable to clear stage'));

    const response = await request(app)
      .delete('/api/projects/1/branches/stage')
      .send({ filePath: 'src/app.jsx' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to clear staged changes');
  });

  test('GET /branches/:branch/commit-context handles context errors', async () => {
    getBranchCommitContext.mockRejectedValueOnce(new Error('context missing'));

    const response = await request(app)
      .get('/api/projects/1/branches/feature-broken/commit-context');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to describe staged changes');
  });

  test('POST /branches/:branch/tests surfaces runner errors', async () => {
    runTestsForBranch.mockRejectedValueOnce(new Error('runner crashed'));

    const response = await request(app)
      .post('/api/projects/1/branches/feature-broken/tests')
      .send({});

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to run tests');
  });

  test('POST /branches/:branch/tests/proof surfaces proof errors', async () => {
    recordJobProofForBranch.mockRejectedValueOnce(new Error('proof missing jobs'));

    const response = await request(app)
      .post('/api/projects/1/branches/feature-broken/tests/proof')
      .send({ jobIds: [] });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to record test proof');
  });

  test('POST /branches/:branch/tests/proof returns overview when successful', async () => {
    const testRun = { id: 7, status: 'passed' };
    const overview = { current: 'feature-proof', branches: [], workingBranches: [] };
    recordJobProofForBranch.mockResolvedValueOnce(testRun);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post('/api/projects/1/branches/feature-proof/tests/proof')
      .send({ jobIds: ['proof-job'] });

    expect(response.status).toBe(200);
    expect(recordJobProofForBranch).toHaveBeenCalledWith(1, 'feature-proof', { jobIds: ['proof-job'] });
    expect(response.body).toEqual({ success: true, testRun, overview });
  });

  test('POST /branches/:branch/tests/proof falls back to empty payload when body is missing', async () => {
    const rawApp = createTestApp(false);
    const testRun = { id: 8, status: 'stored' };
    const overview = { current: 'feature-proof', branches: [], workingBranches: [] };
    recordJobProofForBranch.mockResolvedValueOnce(testRun);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(rawApp).post('/api/projects/1/branches/feature-proof/tests/proof');

    expect(response.status).toBe(200);
    expect(recordJobProofForBranch).toHaveBeenCalledWith(1, 'feature-proof', {});
    expect(response.body).toEqual({ success: true, testRun, overview });
  });

  test('POST /branches/:branch/checkout surfaces checkout errors', async () => {
    checkoutBranch.mockRejectedValueOnce(new Error('checkout blocked'));

    const response = await request(app)
      .post('/api/projects/1/branches/feature-broken/checkout')
      .send();

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to switch branch');
  });

  test('DELETE /branches/:branch surfaces deletion errors', async () => {
    deleteBranchByName.mockRejectedValueOnce(new Error('cannot delete branch'));

    const response = await request(app)
      .delete('/api/projects/1/branches/feature-broken')
      .set('x-confirm-destructive', 'true')
      .send();

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to delete branch');
  });

  test('GET /branches returns overview details when successful', async () => {
    const overview = { current: 'main', branches: [{ name: 'main' }], workingBranches: [] };
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app).get('/api/projects/1/branches');

    expect(response.status).toBe(200);
    expect(getBranchOverview).toHaveBeenCalledWith(1);
    expect(response.body).toEqual({ success: true, ...overview });
  });

  test('POST /branches responds with branch and overview payload', async () => {
    const branch = { name: 'feature/api', stagedFiles: [] };
    const overview = { current: 'feature/api', branches: [], workingBranches: [] };
    createWorkingBranch.mockResolvedValueOnce(branch);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post('/api/projects/1/branches')
      .send({ description: 'API work' });

    expect(response.status).toBe(201);
    expect(createWorkingBranch).toHaveBeenCalledWith(1, { description: 'API work' });
    expect(response.body).toEqual({ success: true, branch, overview });
  });

  test('POST /branches falls back to empty payload when body is missing', async () => {
    const rawApp = createTestApp(false);
    const branch = { name: 'feature/empty' };
    const overview = { current: 'feature/empty', branches: [], workingBranches: [] };
    createWorkingBranch.mockResolvedValueOnce(branch);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(rawApp).post('/api/projects/1/branches');

    expect(response.status).toBe(201);
    expect(createWorkingBranch).toHaveBeenCalledWith(1, {});
    expect(response.body).toEqual({ success: true, branch, overview });
  });

  test('POST /branches/stage returns staged payload and overview', async () => {
    const payload = {
      branch: { name: 'feature/files', stagedFiles: [{ path: 'src/file.js' }] },
      stagedFiles: [{ path: 'src/file.js' }]
    };
    const overview = { current: 'feature/files', branches: [], workingBranches: [] };
    stageWorkspaceChange.mockResolvedValueOnce(payload);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post('/api/projects/1/branches/stage')
      .send({ filePath: 'src/file.js' });

    expect(response.status).toBe(201);
    expect(stageWorkspaceChange).toHaveBeenCalledWith(1, { filePath: 'src/file.js' });
    expect(response.body).toEqual({ success: true, ...payload, overview });
  });

  test('POST /branches/stage falls back to empty payload when body is missing', async () => {
    const rawApp = createTestApp(false);
    const payload = { branch: { name: 'feature/files' }, stagedFiles: [] };
    const overview = { current: 'feature/files', branches: [], workingBranches: [] };
    stageWorkspaceChange.mockResolvedValueOnce(payload);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(rawApp).post('/api/projects/1/branches/stage');

    expect(response.status).toBe(201);
    expect(stageWorkspaceChange).toHaveBeenCalledWith(1, {});
    expect(response.body).toEqual({ success: true, ...payload, overview });
  });

  test('DELETE /branches/stage returns branch and overview when successful', async () => {
    const branch = { name: 'feature/files', stagedFiles: [] };
    const overview = { current: 'feature/files', branches: [], workingBranches: [] };
    clearStagedChanges.mockResolvedValueOnce(branch);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .delete('/api/projects/1/branches/stage')
      .send({ branchName: 'feature/files' });

    expect(response.status).toBe(200);
    expect(clearStagedChanges).toHaveBeenCalledWith(1, { branchName: 'feature/files' });
    expect(response.body).toEqual({ success: true, branch, overview });
  });

  test('DELETE /branches/stage falls back to empty payload when body is missing', async () => {
    const rawApp = createTestApp(false);
    const branch = { name: 'feature/files', stagedFiles: [] };
    const overview = { current: 'feature/files', branches: [], workingBranches: [] };
    clearStagedChanges.mockResolvedValueOnce(branch);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(rawApp).delete('/api/projects/1/branches/stage');

    expect(response.status).toBe(200);
    expect(clearStagedChanges).toHaveBeenCalledWith(1, {});
    expect(response.body).toEqual({ success: true, branch, overview });
  });

  test('GET /branches/:branch/commit-context returns commit context', async () => {
    const context = { branch: 'feature/context', files: [{ path: 'src/a.js' }] };
    getBranchCommitContext.mockResolvedValueOnce(context);

    const response = await request(app)
      .get('/api/projects/1/branches/feature-context/commit-context');

    expect(response.status).toBe(200);
    expect(getBranchCommitContext).toHaveBeenCalledWith(1, 'feature-context');
    expect(response.body).toEqual({ success: true, context });
  });

  test('POST /branches/:branch/tests returns test run results', async () => {
    const testRun = { id: 'run-1', status: 'passed' };
    runTestsForBranch.mockResolvedValueOnce(testRun);

    const response = await request(app)
      .post('/api/projects/1/branches/feature-tests/tests')
      .send({ force: true });

    expect(response.status).toBe(200);
    expect(runTestsForBranch).toHaveBeenCalledWith(1, 'feature-tests', { force: true });
    expect(response.body).toEqual({ success: true, testRun });
  });

  test('POST /branches/:branch/tests uses empty options when body missing', async () => {
    const rawApp = createTestApp(false);
    const testRun = { id: 'run-2', status: 'passed' };
    runTestsForBranch.mockResolvedValueOnce(testRun);

    const response = await request(rawApp).post('/api/projects/1/branches/feature-tests/tests');

    expect(response.status).toBe(200);
    expect(runTestsForBranch).toHaveBeenCalledWith(1, 'feature-tests', {});
    expect(response.body).toEqual({ success: true, testRun });
  });

  test('POST /branches/:branch/commit returns commit result and overview', async () => {
    const branchName = 'feature-commit';
    const result = {
      branch: { name: branchName, stagedFiles: [] },
      commit: { id: 'c1', message: 'feat: commit' }
    };
    const overview = { current: branchName, branches: [], workingBranches: [] };
    commitBranchChanges.mockResolvedValueOnce(result);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post(`/api/projects/1/branches/${branchName}/commit`)
      .send({ message: 'feat: commit' });

    expect(response.status).toBe(200);
    expect(commitBranchChanges).toHaveBeenCalledWith(1, branchName, { message: 'feat: commit' });
    expect(response.body).toEqual({ success: true, ...result, overview });
  });

  test('POST /branches/:branch/commit uses empty payload when body missing', async () => {
    const rawApp = createTestApp(false);
    const branchName = 'feature-commit';
    const result = {
      branch: { name: branchName, stagedFiles: [] },
      commit: { id: 'c2', message: 'feat: commit' }
    };
    const overview = { current: branchName, branches: [], workingBranches: [] };
    commitBranchChanges.mockResolvedValueOnce(result);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(rawApp).post(`/api/projects/1/branches/${branchName}/commit`);

    expect(response.status).toBe(200);
    expect(commitBranchChanges).toHaveBeenCalledWith(1, branchName, {});
    expect(response.body).toEqual({ success: true, ...result, overview });
  });

  test('POST /branches/:branch/commit surfaces commit failures', async () => {
    commitBranchChanges.mockRejectedValueOnce(new Error('commit blocked'));

    const response = await request(app)
      .post('/api/projects/1/branches/feature-commit/commit')
      .send({ message: 'feat: commit' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to commit changes');
  });

  test('POST /branches/:branch/merge returns merge result and overview', async () => {
    const branchName = 'feature-merge';
    const result = { mergedBranch: branchName };
    const overview = { current: 'main', branches: [], workingBranches: [] };
    mergeBranch.mockResolvedValueOnce(result);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post(`/api/projects/1/branches/${branchName}/merge`)
      .send();

    expect(response.status).toBe(200);
    expect(mergeBranch).toHaveBeenCalledWith(1, branchName);
    expect(response.body).toEqual({ success: true, ...result, overview });
  });

  test('POST /branches/:branch/merge surfaces merge failures', async () => {
    mergeBranch.mockRejectedValueOnce(new Error('merge blocked'));

    const response = await request(app)
      .post('/api/projects/1/branches/feature-merge/merge')
      .send();

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to merge branch');
  });

  test('POST /branches/:branch/checkout returns branch and overview on success', async () => {
    const branch = { name: 'feature-checkout' };
    const overview = { current: 'feature-checkout', branches: [], workingBranches: [] };
    checkoutBranch.mockResolvedValueOnce(branch);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .post('/api/projects/1/branches/feature-checkout/checkout')
      .send();

    expect(response.status).toBe(200);
    expect(checkoutBranch).toHaveBeenCalledWith(1, 'feature-checkout');
    expect(response.body).toEqual({ success: true, branch, overview });
  });

  test('DELETE /branches/:branch returns deletion result and overview', async () => {
    const branchName = 'feature-delete';
    const result = { deletedBranch: branchName };
    const overview = { current: 'main', branches: [], workingBranches: [] };
    deleteBranchByName.mockResolvedValueOnce(result);
    getBranchOverview.mockResolvedValueOnce(overview);

    const response = await request(app)
      .delete(`/api/projects/1/branches/${branchName}`)
      .set('x-confirm-destructive', 'true')
      .send();

    expect(response.status).toBe(200);
    expect(deleteBranchByName).toHaveBeenCalledWith(1, branchName);
    expect(response.body).toEqual({ success: true, ...result, overview });
  });
});
