import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import { enqueueInstallJobs } from '../routes/projects/installJobs.js';

const buildClassicLayout = (projectPath) => ({
  frontendWorkspacePath: path.join(projectPath, 'frontend'),
  frontendWorkspaceManifestPath: path.join(projectPath, 'frontend', 'package.json'),
  backendWorkspacePath: path.join(projectPath, 'backend')
});

describe('enqueueInstallJobs', () => {
  test('returns empty when project id or path is missing', async () => {
    await expect(enqueueInstallJobs({ projectId: null, projectPath: 'x' })).resolves.toEqual([]);
    await expect(enqueueInstallJobs({ projectId: 1, projectPath: '' })).resolves.toEqual([]);
  });

  test('enqueues frontend and npm backend installs when manifests exist', async () => {
    const started = [];
    const startJobFn = vi.fn((job) => {
      started.push(job);
      return { id: started.length, ...job };
    });
    const dirExistsFn = vi.fn(async (targetPath) => targetPath.endsWith(`${path.sep}frontend`) || targetPath.endsWith(`${path.sep}backend`));
    const fileExistsFn = vi.fn(async (targetPath) => {
      if (targetPath.endsWith(`${path.sep}frontend${path.sep}package.json`)) return true;
      if (targetPath.endsWith(`${path.sep}backend${path.sep}package.json`)) return true;
      return false;
    });

    const jobs = await enqueueInstallJobs(
      { projectId: 7, projectPath: '/repo/proj' },
      {
        startJobFn,
        dirExistsFn,
        fileExistsFn,
        resolveLayoutFn: async (projectPath) => buildClassicLayout(projectPath)
      }
    );

    expect(jobs).toHaveLength(2);
    expect(started[0]).toEqual(expect.objectContaining({ type: 'frontend:install', command: 'npm' }));
    expect(started[1]).toEqual(expect.objectContaining({ type: 'backend:install', command: 'npm' }));
  });

  test('prefers python requirements backend install when npm manifest is absent', async () => {
    const startJobFn = vi.fn((job) => job);
    const dirExistsFn = vi.fn(async () => true);
    const fileExistsFn = vi.fn(async (targetPath) => targetPath.endsWith(`${path.sep}backend${path.sep}requirements.txt`));

    const jobs = await enqueueInstallJobs(
      { projectId: 7, projectPath: '/repo/proj' },
      {
        startJobFn,
        dirExistsFn,
        fileExistsFn,
        resolveLayoutFn: async (projectPath) => buildClassicLayout(projectPath)
      }
    );

    expect(jobs.at(-1)).toEqual(expect.objectContaining({
      type: 'backend:install',
      command: 'python',
      args: ['-m', 'pip', 'install', '-r', 'requirements.txt']
    }));
  });

  test('continues when starting one job throws', async () => {
    const startJobFn = vi.fn((job) => {
      if (job.type === 'frontend:install') {
        throw new Error('boom');
      }
      return job;
    });
    const dirExistsFn = vi.fn(async () => true);
    const fileExistsFn = vi.fn(async (targetPath) => targetPath.endsWith(`${path.sep}backend${path.sep}package.json`) || targetPath.endsWith(`${path.sep}frontend${path.sep}package.json`));

    const jobs = await enqueueInstallJobs(
      { projectId: 7, projectPath: '/repo/proj' },
      {
        startJobFn,
        dirExistsFn,
        fileExistsFn,
        resolveLayoutFn: async (projectPath) => buildClassicLayout(projectPath)
      }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ type: 'backend:install' }));
  });

  test('does not enqueue duplicate npm installs when frontend and backend resolve to root workspace', async () => {
    const startJobFn = vi.fn((job) => job);
    const dirExistsFn = vi.fn(async () => true);
    const fileExistsFn = vi.fn(async (targetPath) => targetPath.endsWith(`${path.sep}package.json`));

    const jobs = await enqueueInstallJobs(
      { projectId: 7, projectPath: '/repo/proj' },
      {
        startJobFn,
        dirExistsFn,
        fileExistsFn,
        resolveLayoutFn: async (projectPath) => ({
          frontendWorkspacePath: projectPath,
          frontendWorkspaceManifestPath: path.join(projectPath, 'package.json'),
          backendWorkspacePath: projectPath
        })
      }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ type: 'frontend:install', cwd: '/repo/proj' }));
  });

  test('falls back to frontend package.json when workspace manifest path is not provided', async () => {
    const startJobFn = vi.fn((job) => job);
    const jobs = await enqueueInstallJobs(
      { projectId: 9, projectPath: '/repo/focus' },
      {
        startJobFn,
        dirExistsFn: async () => true,
        fileExistsFn: async (targetPath) => targetPath.endsWith(`${path.sep}frontend${path.sep}package.json`),
        resolveLayoutFn: async (projectPath) => ({
          frontendWorkspacePath: path.join(projectPath, 'frontend'),
          frontendWorkspaceManifestPath: '',
          backendWorkspacePath: path.join(projectPath, 'backend')
        })
      }
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      type: 'frontend:install',
      cwd: path.join('/repo/focus', 'frontend')
    }));
  });
});
