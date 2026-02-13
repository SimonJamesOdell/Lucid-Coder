import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import jobsRoutes, { __testables } from '../routes/jobs.js';
import { getProject, getTestingSettings, getProjectTestingSettings } from '../database.js';
import { startJob, listJobsForProject, getJob, cancelJob } from '../services/jobRunner.js';
import { describeBranchCssOnlyStatus } from '../services/branchWorkflow.js';

vi.mock('../database.js', () => ({
  getProject: vi.fn(),
  getTestingSettings: vi.fn(),
  getProjectTestingSettings: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  startJob: vi.fn(),
  listJobsForProject: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn()
}));

vi.mock('../services/branchWorkflow.js', () => ({
  describeBranchCssOnlyStatus: vi.fn()
}));

const fsAccessMock = vi.fn();
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  const patched = {
    ...actual,
    access: (...args) => fsAccessMock(...args)
  };
  return {
    __esModule: true,
    ...actual,
    access: patched.access,
    default: patched
  };
});

const app = express();
app.use(express.json({ strict: false }));
app.use('/api/projects/:projectId/jobs', jobsRoutes);

const PROJECT_ROOT = path.join(process.cwd(), 'virtual-project');
const FRONTEND_DIR = path.join(PROJECT_ROOT, 'frontend');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const FRONTEND_PACKAGE = path.join(FRONTEND_DIR, 'package.json');
const BACKEND_PACKAGE = path.join(BACKEND_DIR, 'package.json');
const BACKEND_REQUIREMENTS = path.join(BACKEND_DIR, 'requirements.txt');

const normalizePath = (target) => target.replace(/\\/g, '/');
const existingPaths = new Set();

const configureFsState = ({
  projectRoot = true,
  frontendDir = false,
  frontendPackage = false,
  backendDir = false,
  backendPackage = false,
  backendRequirements = false,
  extra = []
} = {}) => {
  existingPaths.clear();
  const entries = [];
  if (projectRoot) entries.push(PROJECT_ROOT);
  if (frontendDir) entries.push(FRONTEND_DIR);
  if (frontendPackage) entries.push(FRONTEND_PACKAGE);
  if (backendDir) entries.push(BACKEND_DIR);
  if (backendPackage) entries.push(BACKEND_PACKAGE);
  if (backendRequirements) entries.push(BACKEND_REQUIREMENTS);
  if (extra.length) entries.push(...extra);
  entries.forEach((entry) => existingPaths.add(normalizePath(entry)));
};

fsAccessMock.mockImplementation(async (targetPath) => {
  const normalized = normalizePath(targetPath);
  if (!existingPaths.has(normalized)) {
    const error = new Error(`ENOENT: ${targetPath}`);
    error.code = 'ENOENT';
    throw error;
  }
});

let jobCounter = 0;

describe('Jobs Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobCounter = 0;
    configureFsState();
    getProject.mockResolvedValue({ id: 42, path: PROJECT_ROOT });
    getTestingSettings.mockResolvedValue({ coverageTarget: 100 });
    getProjectTestingSettings.mockResolvedValue({
      frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    });
    listJobsForProject.mockReturnValue([]);
    getJob.mockReturnValue(null);
    cancelJob.mockImplementation(() => null);
    startJob.mockImplementation((job) => ({ id: `job-${++jobCounter}`, ...job }));
    describeBranchCssOnlyStatus.mockReset();
    describeBranchCssOnlyStatus.mockResolvedValue({ isCssOnly: false });
  });

  it('treats missing target paths as non-existent', async () => {
    await expect(__testables.pathExists(null)).resolves.toBe(false);
  });

  it('leaves install args untouched for unsupported actions', () => {
    expect(__testables.buildInstallArgs('react', { action: 'prune' })).toEqual(['prune', 'react']);
  });

  it('requires a job type when creating jobs', async () => {
    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/job type/i);
    expect(getProject).not.toHaveBeenCalled();
  });

  it('treats null request bodies as missing job definitions', async () => {
    const response = await request(app)
      .post('/api/projects/42/jobs')
      .set('Content-Type', 'application/json')
      .send('null');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/job type/i);
  });

  it('returns 404 when project is missing during job creation', async () => {
    getProject.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:status' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Project not found');
    expect(startJob).not.toHaveBeenCalled();
  });

  it('rejects projects without stored paths', async () => {
    getProject.mockResolvedValueOnce({ id: 42, path: '' });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:status' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/project path not found/i);
  });

  it('falls back to python backend installs when only requirements exist', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendRequirements: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:install' });

    expect(response.status).toBe(202);
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 42,
      type: 'backend:install',
      command: 'python',
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      cwd: BACKEND_DIR
    }));
    expect(response.body.job.command).toBe('python');
  });

  it('adds frontend packages with normalized versions and dev flags', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({
        type: 'frontend:add-package',
        payload: { packageName: '  lodash  ', version: '  @beta  ', devDependency: true }
      })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm',
      args: ['install', 'lodash@beta', '--save-dev'],
      cwd: FRONTEND_DIR
    }));
  });

  it('requires package names when adding frontend packages', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:add-package', payload: { packageName: '   ' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/packageName is required/i);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('coerces non-object payloads before validating package names', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:add-package', payload: null });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/packageName is required/i);
  });

  it('installs frontend dependencies when workspace exists', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:install' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Install frontend dependencies',
      command: 'npm',
      args: ['install'],
      cwd: FRONTEND_DIR
    }));
  });

  it('requires frontend package.json before installing dependencies', async () => {
    configureFsState({ projectRoot: true, frontendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:install' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend package\.json not found/i);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('runs frontend lint inside workspace', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:lint' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Frontend lint',
      args: ['run', 'lint'],
      cwd: FRONTEND_DIR
    }));
  });

  it('requires frontend package.json before running lint', async () => {
    configureFsState({ projectRoot: true, frontendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:lint' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend package\.json not found/i);
  });

  it('runs frontend tests when package scripts exist', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Frontend tests',
      args: ['run', 'test:coverage'],
      cwd: FRONTEND_DIR
    }));
  });

  it('falls back to default coverage threshold when global setting is non-integer and project settings are missing', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 'not-a-number' });
    getProjectTestingSettings.mockResolvedValueOnce(null);

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }
    }));
  });

  it('falls back to default coverage threshold when global setting is out of range', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 120 });
    getProjectTestingSettings.mockResolvedValueOnce(null);

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }
    }));
  });

  it('falls back to default coverage threshold when global testing settings lookup fails', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });
    getTestingSettings.mockRejectedValueOnce(new Error('settings unavailable'));

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }
    }));
  });

  it('falls back to global coverage threshold when project testing settings lookup fails', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 80 });
    getProjectTestingSettings.mockRejectedValueOnce(new Error('project settings unavailable'));

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      coverageThresholds: { lines: 80, statements: 80, functions: 80, branches: 80 }
    }));
  });

  it('falls back to global threshold when custom project thresholds are invalid', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 90 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'custom', coverageTarget: 95, effectiveCoverageTarget: 45 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 90 }
    });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      coverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
    }));
  });

  it('requires frontend package.json before running tests', async () => {
    configureFsState({ projectRoot: true, frontendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend package\.json not found/i);
  });

  it('rejects frontend package jobs when package.json is missing', async () => {
    configureFsState({ projectRoot: true, frontendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:add-package', payload: { packageName: 'react' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend package\.json not found/i);
  });

  it('removes frontend packages via npm uninstall', async () => {
    configureFsState({ projectRoot: true, frontendDir: true, frontendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:remove-package', payload: { packageName: 'react', dev: true } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      args: ['uninstall', 'react', '--save-dev'],
      cwd: FRONTEND_DIR
    }));
  });

  it('rejects frontend remove-package jobs when package.json is missing', async () => {
    configureFsState({ projectRoot: true, frontendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:remove-package', payload: { packageName: 'react' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend package\.json not found/i);
  });

  it('removes backend packages using npm uninstall flow', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:remove-package', payload: { packageName: 'express' } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      args: ['uninstall', 'express', '--save']
    }));
  });

  it('adds backend packages when node manifests exist', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:add-package', payload: { packageName: 'axios', version: 'latest', dev: true } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      type: 'backend:add-package',
      args: ['install', 'axios', '--save-dev'],
      cwd: BACKEND_DIR
    }));
  });

  it('preserves numeric version tags when adding backend packages', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:add-package', payload: { packageName: 'axios', version: ' 1.2.3 ' } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      args: ['install', 'axios@1.2.3', '--save']
    }));
  });

  it('rejects backend package management when package.json is missing', async () => {
    configureFsState({ projectRoot: true, backendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:add-package', payload: { packageName: 'lodash' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/backend package\.json not found/i);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('rejects backend remove-package jobs when package.json is missing', async () => {
    configureFsState({ projectRoot: true, backendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:remove-package', payload: { packageName: 'lodash' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/backend package\.json not found/i);
  });

  it('surfaced workspace errors when package json exists but directory is missing', async () => {
    configureFsState({ projectRoot: true, frontendPackage: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:install' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/frontend workspace not found/i);
  });

  it('returns helpful message for unknown job types', async () => {
    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'invalid:task' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/unknown job type/i);
  });

  it('skips test jobs when css-only branches are detected', async () => {
    const payload = { branchName: 'feature/css-only' };
    describeBranchCssOnlyStatus.mockResolvedValueOnce({ isCssOnly: true });

    const firstResponse = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'frontend:test', payload });

    expect(firstResponse.status).toBe(202);
    expect(firstResponse.body).toMatchObject({
      success: true,
      skipped: true,
      reason: 'css-only-branch',
      branch: null,
      indicator: null
    });
    expect(startJob).not.toHaveBeenCalled();

    describeBranchCssOnlyStatus.mockResolvedValueOnce({
      isCssOnly: true,
      branch: 'feature/css-only',
      indicator: 'git-diff'
    });

    const secondResponse = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test', payload });

    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body).toMatchObject({
      success: true,
      skipped: true,
      branch: 'feature/css-only',
      indicator: 'git-diff'
    });
    expect(startJob).not.toHaveBeenCalled();
    expect(describeBranchCssOnlyStatus).toHaveBeenCalledTimes(2);
  });

  it('continues starting test jobs when css-only detection fails', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    describeBranchCssOnlyStatus.mockImplementationOnce(() => {
      throw new Error('css check failed');
    });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test', payload: { branchName: 'feature/bugfix' } });

    expect(response.status).toBe(202);
    expect(startJob).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[JobsRoute] Failed to evaluate css-only status before starting tests',
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });

  it('falls back to 500 when starting a job fails unexpectedly', async () => {
    startJob.mockImplementationOnce(() => {
      throw new Error('runner offline');
    });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:status' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('runner offline');
  });

  it('uses a generic error message when start-job exceptions omit details', async () => {
    const error = new Error('');
    error.message = '';
    startJob.mockImplementationOnce(() => {
      throw error;
    });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:status' });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to start job');
  });

  it('runs git status jobs inside the project workspace', async () => {
    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:status' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'git',
      args: ['status', '--short', '--branch'],
      cwd: PROJECT_ROOT
    }));
  });

  it('runs git pull jobs with fast-forward flag', async () => {
    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'git:pull' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      args: ['pull', '--ff-only'],
      cwd: PROJECT_ROOT
    }));
  });

  it('returns 404 when listing jobs for a missing project', async () => {
    getProject.mockResolvedValueOnce(null);

    const response = await request(app).get('/api/projects/42/jobs');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Project not found');
  });

  it('lists jobs for a project', async () => {
    const createdAt = new Date().toISOString();
    listJobsForProject.mockReturnValueOnce([
      {
        id: 'job-a',
        projectId: 42,
        type: 'git:status',
        displayName: 'Status',
        status: 'running',
        command: 'git',
        args: ['status'],
        cwd: PROJECT_ROOT,
        createdAt,
        logs: ['ok']
      }
    ]);

    const response = await request(app).get('/api/projects/42/jobs');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0]).toMatchObject({
      id: 'job-a',
      type: 'git:status',
      displayName: 'Status',
      status: 'running',
      command: 'git',
      args: ['status'],
      cwd: PROJECT_ROOT,
      createdAt,
      logs: ['ok']
    });
  });

  it('filters null jobs coming from the job runner', async () => {
    listJobsForProject.mockReturnValueOnce([null]);

    const response = await request(app).get('/api/projects/42/jobs');

    expect(response.status).toBe(200);
    expect(response.body.jobs).toEqual([null]);
  });

  it('returns 500 when listing jobs fails unexpectedly', async () => {
    listJobsForProject.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const response = await request(app).get('/api/projects/42/jobs');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to list jobs');
  });

  it('returns 404 if requested job belongs to another project', async () => {
    getJob.mockReturnValueOnce({ id: 'job-7', projectId: 7 });

    const response = await request(app).get('/api/projects/42/jobs/job-7');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Job not found');
  });

  it('returns 404 when requested job does not exist', async () => {
    getJob.mockReturnValueOnce(null);

    const response = await request(app).get('/api/projects/42/jobs/missing');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Job not found');
  });

  it('returns job details when job exists for project', async () => {
    getJob.mockReturnValueOnce({
      id: 'job-12',
      projectId: 42,
      type: 'git:status',
      displayName: 'Status',
      status: 'running',
      command: 'git',
      args: ['status'],
      cwd: PROJECT_ROOT,
      createdAt: 'now',
      summary: { ok: true }
    });

    const response = await request(app).get('/api/projects/42/jobs/job-12');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.job).toMatchObject({ id: 'job-12', type: 'git:status' });
    expect(response.body.job.summary).toEqual({ ok: true });
  });

  it('returns 404 when fetching job for a missing project', async () => {
    getProject.mockResolvedValueOnce(null);

    const response = await request(app).get('/api/projects/42/jobs/job-12');

    expect(response.status).toBe(404);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('falls back to 500 when fetching job fails unexpectedly', async () => {
    getJob.mockImplementationOnce(() => {
      throw new Error('db unavailable');
    });

    const response = await request(app).get('/api/projects/42/jobs/job-12');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to fetch job');
  });

  it('cancels a job and returns serialized payload', async () => {
    const job = {
      id: 'job-9',
      projectId: 42,
      type: 'git:pull',
      displayName: 'Pull',
      status: 'succeeded',
      command: 'git',
      args: ['pull'],
      cwd: PROJECT_ROOT,
      createdAt: '2024-01-01T00:00:00.000Z',
      startedAt: '2024-01-01T00:01:00.000Z',
      completedAt: '2024-01-01T00:02:00.000Z',
      exitCode: 0,
      signal: null,
      logs: ['done']
    };
    getJob.mockReturnValueOnce(job);
    cancelJob.mockReturnValueOnce(job);

    const response = await request(app).post('/api/projects/42/jobs/job-9/cancel');

    expect(response.status).toBe(200);
    const { projectId, ...expectedJob } = job;
    expect(response.body.job).toEqual(expectedJob);
  });

  it('returns 404 when attempting to cancel an unknown job', async () => {
    getJob.mockReturnValueOnce(null);

    const response = await request(app).post('/api/projects/42/jobs/missing/cancel');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Job not found');
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('returns 404 when cancelling a job for a missing project', async () => {
    getProject.mockResolvedValueOnce(null);

    const response = await request(app).post('/api/projects/42/jobs/job-9/cancel');

    expect(response.status).toBe(404);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('falls back to 500 when cancelling a job fails unexpectedly', async () => {
    const job = { id: 'job-10', projectId: 42 };
    getJob.mockReturnValueOnce(job);
    cancelJob.mockImplementationOnce(() => {
      throw new Error('cancel failed');
    });

    const response = await request(app).post('/api/projects/42/jobs/job-10/cancel');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to cancel job');
  });

  it('installs backend dependencies via npm when package.json exists', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:install' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm',
      args: ['install'],
      cwd: BACKEND_DIR
    }));
  });

  it('requires backend manifests before installing dependencies', async () => {
    configureFsState({ projectRoot: true, backendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:install' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/backend dependencies manifest not found/i);
  });

  it('runs backend lint via npm when package.json exists', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:lint' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm',
      args: ['run', 'lint'],
      cwd: BACKEND_DIR
    }));
  });

  it('runs backend lint via python when node manifest is missing', async () => {
    configureFsState({ projectRoot: true, backendDir: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:lint' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'python',
      args: ['-m', 'flake8'],
      cwd: BACKEND_DIR
    }));
  });

  it('runs backend tests via npm when package.json exists', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: BACKEND_DIR
    }));
  });

  it('uses payload coverage target override for backend tests when useGlobal is false', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 100 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test', payload: { useGlobal: false, coverageTarget: 50 } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      env: { LUCIDCODER_COVERAGE_TARGET: '50' },
      coverageThresholds: { lines: 50, statements: 50, functions: 50, branches: 50 }
    }));
  });

  it('ignores payload coverage target override when useGlobal is true', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test', payload: { useGlobal: true, coverageTarget: 50 } })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      env: { LUCIDCODER_COVERAGE_TARGET: '100' },
      coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 }
    }));
  });

  it('treats non-object payloads as no coverage override for backend tests', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendPackage: true });
    getTestingSettings.mockResolvedValue({ coverageTarget: 90 });
    getProjectTestingSettings.mockResolvedValue(null);

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test', payload: 'not-an-object' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      env: { LUCIDCODER_COVERAGE_TARGET: '90' },
      coverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 }
    }));
  });

  it('runs backend tests via python when requirements exist', async () => {
    configureFsState({ projectRoot: true, backendDir: true, backendRequirements: true });

    await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test' })
      .expect(202);

    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({
      command: 'python',
      args: ['-m', 'pytest'],
      cwd: BACKEND_DIR
    }));
  });

  it('rejects backend tests when no manifest exists', async () => {
    configureFsState({ projectRoot: true, backendDir: true });

    const response = await request(app)
      .post('/api/projects/42/jobs')
      .send({ type: 'backend:test' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/test runner not configured/i);
  });
});
