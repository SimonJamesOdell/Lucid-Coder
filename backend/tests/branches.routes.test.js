import { describe, test, beforeEach, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { initializeDatabase, closeDatabase, createProject } from '../database.js';
import branchRoutes from '../routes/branches.js';
import testsRoutes from '../routes/tests.js';
import db from '../database.js';
import { describeBranchCssOnlyStatus } from '../services/branchWorkflow.js';

const app = express();
app.use(express.json());
app.use('/api/projects/:projectId/branches', branchRoutes);
app.use('/api/projects/:projectId/tests', testsRoutes);

const exec = (sql) => new Promise((resolve, reject) => {
  db.run(sql, (err) => {
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

let project;

describe('Branch workflow routes', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetTables();
    project = await createProject({
      name: `branch-workflow-${Date.now()}`,
      description: 'Workflow project',
      language: 'javascript',
      framework: 'react',
      path: '/tmp/project'
    });
  });

  afterAll(async () => {
    await resetTables();
    await closeDatabase();
  });

  test('GET /branches bootstraps main branch state', async () => {
    const response = await request(app).get(`/api/projects/${project.id}/branches`);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.current).toBe('main');
    expect(response.body.branches).toHaveLength(1);
    expect(response.body.branches[0].name).toBe('main');
    expect(response.body.workingBranches).toHaveLength(0);
  });

  test('POST /branches creates a working branch and updates overview', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ description: 'Implement dashboard' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.branch.name).toMatch(/feature-/);
    expect(response.body.overview.current).toBe(response.body.branch.name);
    expect(response.body.overview.workingBranches).toHaveLength(1);
  });

  test('merge is blocked until tests pass', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-audit', description: 'Audit logging' });

    const mergeAttempt = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-audit/merge`);

    expect(mergeAttempt.status).toBe(400);
    expect(mergeAttempt.body.error).toMatch(/pass tests/i);
  });

  test('run tests then merge succeeds', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-search', description: 'Search UI' });

    const testRun = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-search/tests`)
      .send();

    expect(testRun.status).toBe(200);
    expect(testRun.body.testRun.status).toBe('passed');

    const mergeResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-search/merge`)
      .send();

    expect(mergeResponse.status).toBe(200);
    expect(mergeResponse.body.mergedBranch).toBe('feature-search');
    expect(mergeResponse.body.overview.current).toBe('main');
    expect(mergeResponse.body.overview.workingBranches).toHaveLength(0);
  });

  test('failed tests keep merge blocked', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-reports', description: 'Reporting UI' });

    const failedRun = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-reports/tests`)
      .send({ forceFail: true });

    expect(failedRun.status).toBe(200);
    expect(failedRun.body.testRun.status).toBe('failed');

    const mergeAttempt = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-reports/merge`);

    expect(mergeAttempt.status).toBe(400);
    expect(mergeAttempt.body.error).toMatch(/pass tests/i);
  });

  test('merge endpoint rejects unknown branches', async () => {
    const mergeAttempt = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-ghost/merge`);

    expect(mergeAttempt.status).toBe(404);
    expect(mergeAttempt.body.success).toBe(false);
    expect(mergeAttempt.body.error).toMatch(/not found/i);
  });

  test('main branch cannot be merged', async () => {
    const mergeAttempt = await request(app)
      .post(`/api/projects/${project.id}/branches/main/merge`);

    expect(mergeAttempt.status).toBe(400);
    expect(mergeAttempt.body.success).toBe(false);
    expect(mergeAttempt.body.error).toMatch(/main branch cannot be merged/i);
  });

  test('/tests/run defaults to current branch and exposes overview', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-default', description: 'Default branch' });

    const runResponse = await request(app)
      .post(`/api/projects/${project.id}/tests/run`)
      .send({});

    expect(runResponse.status).toBe(200);
    expect(runResponse.body.testRun).toBeDefined();
    expect(runResponse.body.testRun.branch).toBe('feature-default');
    expect(runResponse.body.overview.current).toBe('feature-default');
  });

  test('GET /tests/latest returns most recent test run', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/tests/run`)
      .send({ branchName: 'main' });

    const latest = await request(app)
      .get(`/api/projects/${project.id}/tests/latest`)
      .send();

    expect(latest.status).toBe(200);
    expect(latest.body.testRun).toBeDefined();
    expect(latest.body.testRun.branch).toBe('main');
    expect(latest.body.testRun.summary.total).toBeGreaterThan(0);
  });

  test('checkout sets current branch', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-switch', description: 'Switchable branch' });

    const checkout = await request(app)
      .post(`/api/projects/${project.id}/branches/feature-switch/checkout`)
      .send();

    expect(checkout.status).toBe(200);
    expect(checkout.body.success).toBe(true);
    expect(checkout.body.branch.name).toBe('feature-switch');
    expect(checkout.body.overview.current).toBe('feature-switch');
  });

  test('delete branch removes it from overview', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-delete', description: 'Temp branch' });

    const response = await request(app)
      .delete(`/api/projects/${project.id}/branches/feature-delete`)
      .set('x-confirm-destructive', 'true')
      .send();

    expect(response.status).toBe(200);
    expect(response.body.deletedBranch).toBe('feature-delete');
    expect(response.body.overview.branches.find((b) => b.name === 'feature-delete')).toBeUndefined();
  });

  test('delete branch requires destructive confirmation', async () => {
    await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-confirm', description: 'Confirm deletion' });

    const blocked = await request(app)
      .delete(`/api/projects/${project.id}/branches/feature-confirm`)
      .send();

    expect(blocked.status).toBe(409);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error).toMatch(/confirmation required/i);

    const overview = await request(app).get(`/api/projects/${project.id}/branches`);
    expect(overview.status).toBe(200);
    expect(overview.body.branches.find((b) => b.name === 'feature-confirm')).toBeDefined();
  });

  test('POST /branches/stage auto-creates a working branch and tracks staged files', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/components/BranchList.tsx', description: 'Initial UI work' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.branch.name).not.toBe('main');
    expect(response.body.branch.stagedFiles).toHaveLength(1);
    expect(response.body.branch.stagedFiles[0].path).toBe('src/components/BranchList.tsx');
    expect(response.body.stagedFiles).toHaveLength(1);
    expect(response.body.overview.current).toBe(response.body.branch.name);
  });

  test('POST /branches/stage requires a filePath', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ description: 'Missing file' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/filePath is required/i);
  });

  test('commit context lists staged files for the working branch', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/hooks/useBranches.ts', description: 'Hook logic' });

    const branchName = stageResponse.body.branch.name;

    const contextResponse = await request(app)
      .get(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/commit-context`)
      .send();

    expect(contextResponse.status).toBe(200);
    expect(contextResponse.body.success).toBe(true);
    expect(contextResponse.body.context.branch).toBe(branchName);
    expect(contextResponse.body.context.totalFiles).toBe(1);
    expect(contextResponse.body.context.files[0].path).toBe('src/hooks/useBranches.ts');
  });

  test('DELETE /branches/stage removes a staged file entry', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/utils/git.ts', description: 'Git helper' });

    const branchName = stageResponse.body.branch.name;

    const clearResponse = await request(app)
      .delete(`/api/projects/${project.id}/branches/stage`)
      .send({ branchName, filePath: 'src/utils/git.ts' });

    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body.success).toBe(true);
    expect(clearResponse.body.branch.stagedFiles).toHaveLength(0);
    expect(clearResponse.body.overview.current).toBe(branchName);
  });

  test('POST /branches/:branch/commit consumes staged files and returns metadata', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/server/index.js', description: 'Server bootstrap' });

    const branchName = stageResponse.body.branch.name;

    const testResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/tests`)
      .send({});

    expect(testResponse.status).toBe(200);
    expect(testResponse.body.success).toBe(true);
    expect(testResponse.body.testRun.status).toBe('passed');

    const commitResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/commit`)
      .send({ message: 'feat: bootstrap server' });

    expect(commitResponse.status).toBe(200);
    expect(commitResponse.body.success).toBe(true);
    expect(commitResponse.body.commit.message).toBe('feat: bootstrap server');
    expect(commitResponse.body.branch.stagedFiles).toHaveLength(0);
    expect(commitResponse.body.branch.ahead).toBeGreaterThan(0);
    expect(commitResponse.body.overview.current).toBe(branchName);
  });

  test('POST /branches/:branch/commit requires passing tests before committing', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/server/policy.js', description: 'Policy check' });

    const branchName = stageResponse.body.branch.name;

    const commitResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/commit`)
      .send({ message: 'feat: enforce policy' });

    expect(commitResponse.status).toBe(400);
    expect(commitResponse.body.success).toBe(false);
    expect(commitResponse.body.error).toMatch(/Run tests to prove this branch before committing\./i);
  });

  test('GET /branches/:branch/css-only reports CSS-only status payloads', async () => {
    const response = await request(app)
      .get(`/api/projects/${project.id}/branches/${encodeURIComponent('main')}/css-only`)
      .send();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      branch: 'main',
      isCssOnly: false,
      indicator: null
    });
  });

  test('GET /branches/:branch/css-only rejects invalid project id input', async () => {
    const response = await request(app)
      .get('/api/projects/not-a-number/branches/main/css-only')
      .send();

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, error: 'Invalid project id' });
  });

  test('describeBranchCssOnlyStatus defaults to the active branch when branchName is omitted', async () => {
    const status = await describeBranchCssOnlyStatus(project.id);

    expect(status).toMatchObject({ branch: 'main', isCssOnly: false, indicator: null });
  });

  test('POST /branches/:branch/commit allows committing CSS-only staged changes without passing tests', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'frontend/src/App.css', description: 'CSS tweak' });

    const branchName = stageResponse.body.branch.name;

    const commitResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/commit`)
      .send({ message: 'style: tweak css' });

    expect(commitResponse.status).toBe(200);
    expect(commitResponse.body.success).toBe(true);
    expect(commitResponse.body.commit.message).toBe('style: tweak css');
    expect(commitResponse.body.branch.stagedFiles).toHaveLength(0);
    expect(commitResponse.body.overview.current).toBe(branchName);
  });

  test('POST /branches/:branch/commit requires fixing failing tests before committing', async () => {
    const stageResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/stage`)
      .send({ filePath: 'src/server/policy-fail.js', description: 'Policy failure check' });

    const branchName = stageResponse.body.branch.name;

    const testResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/tests`)
      .send({ forceFail: true });

    expect(testResponse.status).toBe(200);
    expect(testResponse.body.success).toBe(true);
    expect(testResponse.body.testRun.status).toBe('failed');

    const commitResponse = await request(app)
      .post(`/api/projects/${project.id}/branches/${encodeURIComponent(branchName)}/commit`)
      .send({ message: 'feat: should not commit' });

    expect(commitResponse.status).toBe(400);
    expect(commitResponse.body.success).toBe(false);
    expect(commitResponse.body.error).toMatch(/Resolve failing tests and run tests again before committing\./i);
  });

  test('commit endpoint guards against invalid branches and empty staging', async () => {
    const branchResponse = await request(app)
      .post(`/api/projects/${project.id}/branches`)
      .send({ name: 'feature-empty', description: 'No staged files yet' });

    const emptyCommit = await request(app)
      .post(`/api/projects/${project.id}/branches/${branchResponse.body.branch.name}/commit`)
      .send({ message: 'should fail' });

    expect(emptyCommit.status).toBe(400);
    expect(emptyCommit.body.error).toMatch(/No staged changes/i);

    const mainCommit = await request(app)
      .post(`/api/projects/${project.id}/branches/main/commit`)
      .send({ message: 'forbidden' });

    expect(mainCommit.status).toBe(400);
    expect(mainCommit.body.error).toMatch(/main branch/i);
  });
});
