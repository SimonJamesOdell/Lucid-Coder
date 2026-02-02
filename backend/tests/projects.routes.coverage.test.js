import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import projectRoutes, {
  __projectRoutesInternals,
  buildCloneUrl,
  enqueueInstallJobs,
  stripGitCredentials,
  extractRepoName,
  assertProjectPathAvailable,
  pathExists,
  dirExists,
  fileExists,
  serializeJob,
  copyDirectoryRecursive
} from '../routes/projects.js';
import db, { initializeDatabase, closeDatabase, createProject } from '../database.js';
import { resolveProjectPath } from '../utils/projectPaths.js';
import * as cleanup from '../routes/projects/cleanup.js';

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn(),
  scaffoldProject: vi.fn(),
  installDependencies: vi.fn(),
  startProject: vi.fn()
}));

vi.mock('../utils/git.js', () => ({
  runGitCommand: vi.fn(),
  getCurrentBranch: vi.fn()
}));

vi.mock('../services/importCompatibility.js', () => ({
  applyCompatibility: vi.fn(),
  applyProjectStructure: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  startJob: vi.fn((job) => ({
    id: `job-${Date.now()}`,
    ...job
  }))
}));

vi.mock('../services/projectScaffolding/generate.js', () => ({
  generateBackendFiles: vi.fn()
}));

vi.mock('../services/remoteRepoService.js', () => {
  class RemoteRepoCreationError extends Error {
    constructor(message, { statusCode = 400, provider = 'github', details = null } = {}) {
      super(message);
      this.name = 'RemoteRepoCreationError';
      this.statusCode = statusCode;
      this.provider = provider;
      this.details = details;
    }
  }

  return {
    createRemoteRepository: vi.fn(),
    RemoteRepoCreationError
  };
});

const app = express();
app.use(express.json());
app.use('/api/projects', projectRoutes);

const cleanDatabase = async () => {
  const tables = [
    'project_git_settings',
    'git_settings',
    'port_settings',
    'branches',
    'test_runs',
    'agent_tasks',
    'agent_goals',
    'projects',
    'llm_config'
  ];

  const sql = ['BEGIN;']
    .concat(tables.map((table) => `DELETE FROM ${table};`))
    .concat(['COMMIT;'])
    .join('\n');

  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const ensureEmptyDir = async (dirPath) => {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
};

describe('Projects routes coverage (projects.js)', () => {
  const projectsRoot = process.env.PROJECTS_DIR
    ? path.resolve(process.env.PROJECTS_DIR)
    : path.resolve(process.cwd(), 'test-runtime-projects');

  beforeAll(async () => {
    await initializeDatabase();
    await fs.mkdir(projectsRoot, { recursive: true });
  });

  beforeEach(async () => {
    await cleanDatabase();
    __projectRoutesInternals.resetFsModuleOverride();
  });

  describe('clone URL helpers', () => {
    test('extractRepoName handles empty and scp style inputs', () => {
      expect(extractRepoName('/')).toBe('');
      expect(extractRepoName('git@github.com:acme')).toBe('acme');
      expect(extractRepoName('git@github.com:')).toBe('git@github.com:');
    });

    test('stripGitCredentials removes inline credentials', () => {
      const url = 'https://user:pass@github.com/acme/repo.git';
      expect(stripGitCredentials(url)).toBe('https://github.com/acme/repo.git');
    });

    test('stripGitCredentials returns empty string for blank input', () => {
      expect(stripGitCredentials('   ')).toBe('');
    });

    test('stripGitCredentials returns raw value when URL parsing fails', () => {
      expect(stripGitCredentials('not a url')).toBe('not a url');
    });

    test('buildCloneUrl uses custom PAT username when provided', () => {
      const result = buildCloneUrl({
        url: 'https://github.com/acme/repo.git',
        authMethod: 'pat',
        token: 'token123',
        username: 'custom-user',
        provider: 'github'
      });

      expect(result.cloneUrl).toContain('custom-user:token123@');
      expect(result.safeUrl).toBe('https://github.com/acme/repo.git');
    });

    test('buildCloneUrl returns raw URL when parsing fails', () => {
      const result = buildCloneUrl({
        url: 'not a url',
        authMethod: 'pat',
        token: 'token123',
        username: 'custom-user',
        provider: 'github'
      });

      expect(result).toEqual({
        cloneUrl: 'not a url',
        safeUrl: 'not a url'
      });
    });
  });

  describe('import path helpers', () => {
    test('assertProjectPathAvailable throws when path exists', async () => {
      const filePath = path.join(projectsRoot, `exists-${Date.now()}`);
      await fs.writeFile(filePath, 'data');

      await expect(assertProjectPathAvailable(filePath)).rejects.toMatchObject({ statusCode: 409 });
    });

    test('assertProjectPathAvailable resolves when path is missing', async () => {
      const missingPath = path.join(projectsRoot, `missing-${Date.now()}`);
      await expect(assertProjectPathAvailable(missingPath)).resolves.toBeUndefined();
    });

    test('assertProjectPathAvailable rethrows non-ENOENT errors', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(assertProjectPathAvailable('C:/forbidden')).rejects.toMatchObject({ code: 'EACCES' });
      statSpy.mockRestore();
    });

    test('pathExists rethrows non-ENOENT errors', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(pathExists('C:/forbidden')).rejects.toMatchObject({ code: 'EACCES' });
      statSpy.mockRestore();
    });

    test('dirExists rethrows non-ENOENT errors', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(dirExists('C:/forbidden')).rejects.toMatchObject({ code: 'EACCES' });
      statSpy.mockRestore();
    });

    test('fileExists rethrows non-ENOENT errors', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(fileExists('C:/forbidden')).rejects.toMatchObject({ code: 'EACCES' });
      statSpy.mockRestore();
    });

    test('serializeJob handles missing job and legacy project_id', () => {
      expect(serializeJob(null)).toBeNull();

      const primary = serializeJob({
        id: 'job-1',
        projectId: 'primary',
        type: 'test',
        displayName: 'Test',
        status: 'queued',
        command: 'node',
        args: [],
        cwd: '.',
        createdAt: 'now',
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        logs: ''
      });

      const legacy = serializeJob({
        id: 'job-2',
        project_id: 'legacy',
        type: 'test',
        displayName: 'Test',
        status: 'queued',
        command: 'node',
        args: [],
        cwd: '.',
        createdAt: 'now',
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        logs: ''
      });

      const missing = serializeJob({
        id: 'job-3',
        type: 'test',
        displayName: 'Test',
        status: 'queued',
        command: 'node',
        args: [],
        cwd: '.',
        createdAt: 'now',
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        logs: ''
      });

      expect(primary.projectId).toBe('primary');
      expect(legacy.projectId).toBe('legacy');
      expect(missing.projectId).toBeNull();
    });
  });

  describe('enqueueInstallJobs', () => {
    test('returns empty array when projectId or projectPath is missing', async () => {
      await expect(enqueueInstallJobs({ projectId: null, projectPath: null })).resolves.toEqual([]);
      await expect(enqueueInstallJobs({ projectId: '1', projectPath: '' })).resolves.toEqual([]);
    });

    test('skips frontend install when frontend package is missing', async () => {
      const projectPath = path.join(projectsRoot, `no-frontend-${Date.now()}`);
      await ensureEmptyDir(projectPath);

      const jobs = await enqueueInstallJobs({ projectId: 'no-frontend', projectPath });
      expect(jobs.find((job) => job.type === 'frontend:install')).toBeUndefined();
    });

    test('skips frontend install when frontend dir exists without package.json', async () => {
      const projectPath = path.join(projectsRoot, `frontend-empty-${Date.now()}`);
      const frontendPath = path.join(projectPath, 'frontend');
      await ensureEmptyDir(frontendPath);

      const jobs = await enqueueInstallJobs({ projectId: 'frontend-empty', projectPath });
      expect(jobs.find((job) => job.type === 'frontend:install')).toBeUndefined();
    });

    test('enqueues frontend install job when frontend package.json exists', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const projectPath = path.join(projectsRoot, `frontend-only-${Date.now()}`);
      const frontendPath = path.join(projectPath, 'frontend');
      await ensureEmptyDir(frontendPath);
      await fs.writeFile(path.join(frontendPath, 'package.json'), JSON.stringify({ name: 'frontend' }));

      const jobs = await enqueueInstallJobs({ projectId: 'frontend-1', projectPath });
      const frontendJob = jobs.find((job) => job.type === 'frontend:install');
      expect(frontendJob).toBeTruthy();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('continues when frontend install job throws', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const projectPath = path.join(projectsRoot, `frontend-fail-${Date.now()}`);
      const frontendPath = path.join(projectPath, 'frontend');
      await ensureEmptyDir(frontendPath);
      await fs.writeFile(path.join(frontendPath, 'package.json'), JSON.stringify({ name: 'frontend' }));

      const { startJob } = await import('../services/jobRunner.js');
      startJob.mockImplementationOnce(() => {
        throw new Error('frontend job failed');
      });

      const jobs = await enqueueInstallJobs({ projectId: 'frontend-2', projectPath });
      const frontendJob = jobs.find((job) => job.type === 'frontend:install');
      expect(frontendJob).toBeUndefined();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('logs warning when frontend install job throws without a message', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const projectPath = path.join(projectsRoot, `frontend-throw-${Date.now()}`);
      const frontendPath = path.join(projectPath, 'frontend');
      await ensureEmptyDir(frontendPath);
      await fs.writeFile(path.join(frontendPath, 'package.json'), JSON.stringify({ name: 'frontend' }));

      const { startJob } = await import('../services/jobRunner.js');
      startJob.mockImplementationOnce(() => {
        throw 'frontend job failed';
      });

      const jobs = await enqueueInstallJobs({ projectId: 'frontend-3', projectPath });
      expect(jobs.find((job) => job.type === 'frontend:install')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('uses gradle wrapper bat when present', async () => {
      const projectPath = path.join(projectsRoot, `gradle-bat-${Date.now()}`);
      await ensureEmptyDir(projectPath);
      await fs.writeFile(path.join(projectPath, 'build.gradle'), 'apply plugin');
      await fs.writeFile(path.join(projectPath, 'gradlew.bat'), 'echo bat');

      const jobs = await enqueueInstallJobs({ projectId: 'gradle-bat', projectPath });
      const backendJob = jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe(path.join(projectPath, 'gradlew.bat'));
    });

    test('uses gradle wrapper when bat is missing', async () => {
      const projectPath = path.join(projectsRoot, `gradle-sh-${Date.now()}`);
      await ensureEmptyDir(projectPath);
      await fs.writeFile(path.join(projectPath, 'build.gradle'), 'apply plugin');
      await fs.writeFile(path.join(projectPath, 'gradlew'), 'echo sh');

      const jobs = await enqueueInstallJobs({ projectId: 'gradle-sh', projectPath });
      const backendJob = jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe(path.join(projectPath, 'gradlew'));
    });

    test('falls back to system gradle when wrapper is missing', async () => {
      const projectPath = path.join(projectsRoot, `gradle-system-${Date.now()}`);
      await ensureEmptyDir(projectPath);
      await fs.writeFile(path.join(projectPath, 'build.gradle'), 'apply plugin');

      const jobs = await enqueueInstallJobs({ projectId: 'gradle-system', projectPath });
      const backendJob = jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe('gradle');
    });

    test('logs warning when backend install job throws without a message', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const projectPath = path.join(projectsRoot, `backend-throw-${Date.now()}`);
      await ensureEmptyDir(projectPath);
      await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'backend' }));

      const { startJob } = await import('../services/jobRunner.js');
      startJob.mockImplementationOnce(() => {
        throw { code: 'NOPE' };
      });

      const jobs = await enqueueInstallJobs({ projectId: 'backend-throw', projectPath });
      expect(jobs.find((job) => job.type === 'backend:install')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('copyDirectoryRecursive', () => {
    test('rethrows symlink errors without an onFileError handler', async () => {
      const sourceDir = path.join(projectsRoot, `symlink-src-${Date.now()}`);
      const targetDir = path.join(projectsRoot, `symlink-dest-${Date.now()}`);
      await fs.mkdir(sourceDir, { recursive: true });

      const readdirSpy = vi.spyOn(fs, 'readdir').mockResolvedValue([
        {
          name: 'link',
          isDirectory: () => false,
          isSymbolicLink: () => true
        }
      ]);
      const readlinkSpy = vi.spyOn(fs, 'readlink').mockResolvedValue('target');
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockRejectedValue(new Error('symlink failed'));

      await expect(copyDirectoryRecursive(sourceDir, targetDir)).rejects.toThrow('symlink failed');

      readdirSpy.mockRestore();
      readlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
    });

    test('rethrows copyFile errors without an onFileError handler', async () => {
      const sourceDir = path.join(projectsRoot, `copy-src-${Date.now()}`);
      const targetDir = path.join(projectsRoot, `copy-dest-${Date.now()}`);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, 'file.txt'), 'data');

      const copySpy = vi.spyOn(fs, 'copyFile').mockRejectedValue(new Error('copy failed'));

      await expect(copyDirectoryRecursive(sourceDir, targetDir)).rejects.toThrow('copy failed');

      copySpy.mockRestore();
    });
  });

  describe('GET /api/projects', () => {
    test('normalizes camelCase createdAt/updatedAt fields', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValueOnce([
        {
          id: 1,
          name: 'Camel Dates',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z'
        }
      ]);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body.projects[0]).toMatchObject({
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z'
      });
      getProjectsSpy.mockRestore();
    });

    test('normalizes snake_case created_at and updated_at fields', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValueOnce([
        {
          id: 2,
          name: 'Snake Dates',
          created_at: '2024-02-01T00:00:00.000Z',
          updated_at: '2024-02-03T00:00:00.000Z'
        }
      ]);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body.projects[0]).toMatchObject({
        createdAt: '2024-02-01T00:00:00.000Z',
        updatedAt: '2024-02-03T00:00:00.000Z'
      });
      getProjectsSpy.mockRestore();
    });

    test('falls back to createdAt when updated_at is missing', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValueOnce([
        {
          id: 3,
          name: 'Fallback Dates',
          created_at: '2024-03-01T00:00:00.000Z',
          updated_at: null
        }
      ]);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body.projects[0]).toMatchObject({
        createdAt: '2024-03-01T00:00:00.000Z',
        updatedAt: '2024-03-01T00:00:00.000Z'
      });
      getProjectsSpy.mockRestore();
    });

    test('defaults date fields to null when missing', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValueOnce([
        {
          id: 4,
          name: 'No Dates'
        }
      ]);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body.projects[0]).toMatchObject({
        createdAt: null,
        updatedAt: null
      });
      getProjectsSpy.mockRestore();
    });

    test('returns empty list when database returns null', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValue(null);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body).toMatchObject({ success: true, projects: [] });
      getProjectsSpy.mockRestore();
    });

    test('returns empty list when database returns undefined', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockResolvedValue(undefined);

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body).toMatchObject({ success: true, projects: [] });
      getProjectsSpy.mockRestore();
    });

    test('returns projects from the database', async () => {
      const project = await createProject({
        name: `list-${Date.now()}`,
        description: 'list coverage',
        language: 'javascript,javascript',
        framework: 'react,express',
        path: path.join(projectsRoot, `list-${Date.now()}`),
        frontendPort: null,
        backendPort: null
      });

      const response = await request(app)
        .get('/api/projects')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.projects.some((entry) => entry.id === project.id)).toBe(true);
    });

    test('returns 500 when database throws', async () => {
      const dbModule = await import('../database.js');
      const getProjectsSpy = vi.spyOn(dbModule, 'getAllProjects').mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .get('/api/projects')
        .expect(500);

      expect(response.body).toMatchObject({ success: false, error: 'Failed to fetch projects' });
      getProjectsSpy.mockRestore();
    });
  });

  describe('POST /api/projects/import (local)', () => {
    test('rejects imports without a project name', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project name is required' });
    });

    test('rejects empty import payloads (coverage)', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project name is required' });
    });

    test('rejects import requests without a body', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project name is required' });
    });

    test('rejects imports when body parser is missing', async () => {
      const localApp = express();
      localApp.use('/api/projects', projectRoutes);

      const response = await request(localApp)
        .post('/api/projects/import')
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project name is required' });
    });

    test('imports a local folder with copy mode', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `source-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `local-${Date.now()}`
        })
        .expect(201);

      expect(response.body).toMatchObject({ success: true });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('cleans existing target path before copy import', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const projectName = `cleanup-${Date.now()}`;
      const localPath = path.join(projectsRoot, `source-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));
      await fs.writeFile(path.join(localPath, 'index.js'), 'console.log("ok");');

      const targetPath = resolveProjectPath(projectName);
      await ensureEmptyDir(targetPath);
      await fs.writeFile(path.join(targetPath, 'stale.txt'), 'stale');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(201);

      expect(response.body).toMatchObject({ success: true });
      const staleExists = await fs
        .access(path.join(targetPath, 'stale.txt'))
        .then(() => true)
        .catch(() => false);
      const copiedExists = await fs
        .access(path.join(targetPath, 'index.js'))
        .then(() => true)
        .catch(() => false);

      expect(staleExists).toBe(false);
      expect(copiedExists).toBe(true);

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('requires a project name when local path does not provide one', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath: '',
          name: ''
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project name is required' });
    });

    test('enqueues backend install jobs when backend directory exists', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `backend-only-${Date.now()}`);
      const backendDir = path.join(localPath, 'backend');
      await ensureEmptyDir(backendDir);
      await fs.writeFile(path.join(backendDir, 'package.json'), JSON.stringify({ name: 'backend' }));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `backend-only-${Date.now()}`
        })
        .expect(201);

      const backendJob = response.body.jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.cwd).toContain(path.join(response.body.project.path, 'backend'));

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test.each([
      {
        label: 'requirements.txt',
        fileName: 'requirements.txt',
        contents: 'flask==2.0.0',
        command: 'python',
        args: ['-m', 'pip', 'install', '-r', 'requirements.txt']
      },
      {
        label: 'pyproject.toml',
        fileName: 'pyproject.toml',
        contents: '[project]\nname = "backend"',
        command: 'python',
        args: ['-m', 'pip', 'install', '-e', '.']
      },
      {
        label: 'go.mod',
        fileName: 'go.mod',
        contents: 'module example\nrequire example.com/other v1.0.0',
        command: 'go',
        args: ['mod', 'download']
      },
      {
        label: 'Cargo.toml',
        fileName: 'Cargo.toml',
        contents: '[dependencies]\nserde = "1"',
        command: 'cargo',
        args: ['fetch']
      },
      {
        label: 'composer.json',
        fileName: 'composer.json',
        contents: '{"require":{"monolog/monolog":"^3.0"}}',
        command: 'composer',
        args: ['install']
      },
      {
        label: 'Gemfile',
        fileName: 'Gemfile',
        contents: 'gem "rake"',
        command: 'bundle',
        args: ['install']
      },
      {
        label: 'Package.swift',
        fileName: 'Package.swift',
        contents: 'import Foundation',
        command: 'swift',
        args: ['package', 'resolve']
      }
    ])('enqueues backend install jobs for $label', async ({ fileName, contents, command, args }) => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `backend-marker-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, fileName), contents);

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `backend-marker-${Date.now()}`
        })
        .expect(201);

      const backendJob = response.body.jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe(command);
      expect(backendJob?.args).toEqual(args);

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('enqueues Maven install job when pom.xml exists', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `backend-maven-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'pom.xml'), '<project></project>');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `backend-maven-${Date.now()}`
        })
        .expect(201);

      const backendJob = response.body.jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe('mvn');
      expect(backendJob?.args).toEqual(['-q', '-DskipTests', 'package']);

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('enqueues Gradle wrapper job when gradlew.bat exists', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `backend-gradle-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'build.gradle'), 'plugins {}');
      await fs.writeFile(path.join(localPath, 'gradlew.bat'), '@echo off');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `backend-gradle-${Date.now()}`
        })
        .expect(201);

      const backendJob = response.body.jobs.find((job) => job.type === 'backend:install');
      expect(backendJob?.command).toBe(path.join(response.body.project.path, 'gradlew.bat'));
      expect(backendJob?.args).toEqual(['build', '-x', 'test']);

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('continues when backend install job throws', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `backend-job-fail-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'go.mod'), 'module example\nrequire example.com/other v1.0.0');

      const { startJob } = await import('../services/jobRunner.js');
      startJob.mockImplementationOnce(() => {
        throw new Error('job failed');
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `backend-job-fail-${Date.now()}`
        })
        .expect(201);

      const backendJob = response.body.jobs.find((job) => job.type === 'backend:install');
      expect(backendJob).toBeUndefined();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('falls back to recursive copy for symlink entries', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `symlink-source-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const projectName = `symlink-copy-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);

      const cpSpy = vi.spyOn(fs, 'cp').mockRejectedValueOnce(new Error('cp failed'));
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (candidate, options) => {
        if (path.resolve(candidate) === path.resolve(localPath)) {
          return [
            {
              name: 'linked.txt',
              isDirectory: () => false,
              isSymbolicLink: () => true
            }
          ];
        }
        return originalReaddir(candidate, options);
      });
      const readlinkSpy = vi.spyOn(fs, 'readlink').mockResolvedValue('target.txt');
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockResolvedValue();

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/Failed to copy project files/);
      expect(readlinkSpy).toHaveBeenCalledWith(path.join(localPath, 'linked.txt'));
      expect(symlinkSpy).toHaveBeenCalledWith('target.txt', path.join(targetPath, 'linked.txt'));

      cpSpy.mockRestore();
      readdirSpy.mockRestore();
      readlinkSpy.mockRestore();
      symlinkSpy.mockRestore();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('skips ignored directories and recurses into nested folders', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `recursive-copy-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const projectName = `recursive-copy-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);

      const cpSpy = vi.spyOn(fs, 'cp').mockRejectedValueOnce(new Error('cp failed'));
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (candidate, options) => {
        const resolved = path.resolve(candidate);
        if (resolved === path.resolve(localPath)) {
          return [
            { name: 'node_modules', isDirectory: () => true, isSymbolicLink: () => false },
            { name: 'nested', isDirectory: () => true, isSymbolicLink: () => false },
            { name: 'root.txt', isDirectory: () => false, isSymbolicLink: () => false }
          ];
        }
        if (resolved === path.resolve(localPath, 'nested')) {
          return [
            { name: 'child.txt', isDirectory: () => false, isSymbolicLink: () => false }
          ];
        }
        return originalReaddir(candidate, options);
      });
      const copyFileSpy = vi.spyOn(fs, 'copyFile').mockResolvedValue();

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/Failed to copy project files/);
      expect(copyFileSpy).toHaveBeenCalledWith(
        path.join(localPath, 'root.txt'),
        path.join(targetPath, 'root.txt')
      );
      expect(copyFileSpy).toHaveBeenCalledWith(
        path.join(localPath, 'nested', 'child.txt'),
        path.join(targetPath, 'nested', 'child.txt')
      );
      const nodeModulesCalls = copyFileSpy.mock.calls.filter(([src]) => String(src).includes('node_modules'));
      expect(nodeModulesCalls).toHaveLength(0);

      cpSpy.mockRestore();
      readdirSpy.mockRestore();
      copyFileSpy.mockRestore();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('returns failed path when symlink copy fails', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `symlink-error-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const projectName = `symlink-error-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);

      const cpSpy = vi.spyOn(fs, 'cp').mockRejectedValueOnce(new Error('cp failed'));
      const originalReaddir = fs.readdir;
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (candidate, options) => {
        if (path.resolve(candidate) === path.resolve(localPath)) {
          return [
            {
              name: 'linked.txt',
              isDirectory: () => false,
              isSymbolicLink: () => true
            }
          ];
        }
        return originalReaddir(candidate, options);
      });
      const readlinkSpy = vi.spyOn(fs, 'readlink').mockResolvedValue('target.txt');
      const symlinkSpy = vi.spyOn(fs, 'symlink').mockRejectedValueOnce(new Error('link failed'));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain(path.join(localPath, 'linked.txt'));
      expect(readlinkSpy).toHaveBeenCalledWith(path.join(localPath, 'linked.txt'));
      expect(symlinkSpy).toHaveBeenCalledWith('target.txt', path.join(targetPath, 'linked.txt'));

      cpSpy.mockRestore();
      readdirSpy.mockRestore();
      readlinkSpy.mockRestore();
      symlinkSpy.mockRestore();

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('rejects link imports outside the managed root', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const outsideRoot = path.join(path.dirname(projectsRoot), `outside-${Date.now()}`);
      await ensureEmptyDir(outsideRoot);

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'link',
          localPath: outsideRoot,
          name: `outside-${Date.now()}`
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
      });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('rejects link imports outside the managed root (coverage)', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const outsideRoot = path.join(path.dirname(projectsRoot), `outside-coverage-${Date.now()}`);
      await ensureEmptyDir(outsideRoot);

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'link',
          localPath: outsideRoot,
          name: `outside-coverage-${Date.now()}`
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
      });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('imports a local folder with link mode inside the managed root', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `linked-${Date.now()}`);
      await ensureEmptyDir(localPath);

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'link',
          localPath,
          name: `linked-${Date.now()}`
        })
        .expect(201);

      expect(response.body).toMatchObject({ success: true });
      expect(response.body.project?.path).toBe(localPath);

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('rejects local import when path is not a directory', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const filePath = path.join(projectsRoot, `file-${Date.now()}.txt`);
      await fs.writeFile(filePath, 'not a directory');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath: filePath,
          name: `file-${Date.now()}`
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path must be a directory'
      });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('rejects when project name already exists', async () => {
      await createProject({
        name: 'Duplicate Project',
        description: 'Existing',
        language: 'javascript,javascript',
        framework: 'react,express',
        path: path.join(projectsRoot, 'dup-existing'),
        frontendPort: null,
        backendPort: null
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          name: 'Duplicate Project'
        })
        .expect(409);

      expect(response.body).toMatchObject({
        success: false,
        error: 'A project with the name "Duplicate Project" already exists. Please choose a different name.'
      });
    });

    test('rejects local import when project path is missing', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          name: 'Missing Path'
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Project path is required' });
    });

    test('returns 409 when cleanupExistingImportTarget fails', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `cleanup-target-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const projectName = `cleanup-target-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);
      await ensureEmptyDir(targetPath);

      const originalRm = fs.rm;
      const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (candidate, options) => {
        if (path.resolve(candidate) === path.resolve(targetPath)) {
          throw new Error('rm failed');
        }
        return originalRm(candidate, options);
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(409);

      expect(response.body).toMatchObject({ success: false, error: 'Project path already exists' });

      rmSpy.mockRestore();
      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('returns 409 when cleanup target is outside managed root', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `cleanup-outside-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const projectName = `cleanup-outside-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);
      await ensureEmptyDir(targetPath);

      const withinSpy = vi.spyOn(cleanup, 'isWithinManagedProjectsRoot').mockReturnValue(false);

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: projectName
        })
        .expect(409);

      expect(response.body).toMatchObject({ success: false, error: 'Project path already exists' });

      withinSpy.mockRestore();
      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });
  });

  afterAll(async () => {
    __projectRoutesInternals.resetFsModuleOverride();
    await closeDatabase();
  });

  test('buildCleanupTargets includes managed slug extras for managed project name', () => {
    const slug = 'coverage-managed-project';
    const targets = __projectRoutesInternals.buildCleanupTargets({ name: slug, path: null });

    const managedSlugPath = path.resolve(projectsRoot, slug);
    expect(targets).toContain(managedSlugPath);
    expect(targets).toContain(path.resolve(managedSlugPath, 'frontend'));
    expect(targets).toContain(path.resolve(managedSlugPath, 'backend'));
    expect(targets).toContain(path.resolve(managedSlugPath, 'frontend', 'node_modules'));
    expect(targets).toContain(path.resolve(managedSlugPath, 'backend', 'node_modules'));
    expect(targets).toContain(path.resolve(managedSlugPath, '.gitignore'));
  });

  test('killProcessesOnPort terminates eligible pids', async () => {
    const terminatePid = vi.fn().mockResolvedValue();
    const listPids = vi.fn().mockResolvedValue([54321]);

    await __projectRoutesInternals.killProcessesOnPort(12345, { listPids, terminatePid });

    expect(listPids).toHaveBeenCalledWith(12345);
    expect(terminatePid).toHaveBeenCalledWith(54321, { forceDelay: 250 });
  });

  describe('resolveProjectRelativePath validation', () => {
    test('throws 400 for empty relative path', () => {
      const projectRoot = path.join(projectsRoot, `resolve-empty-${Date.now()}`);

      try {
        __projectRoutesInternals.resolveProjectRelativePath(projectRoot, '');
        throw new Error('Expected resolveProjectRelativePath to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Invalid path');
      }
    });

    test('throws 400 when resolved path escapes project root', () => {
      const projectRoot = path.join(projectsRoot, `resolve-escape-${Date.now()}`);
      const relative = 'safe.txt';
      const fullPath = path.join(projectRoot, relative);

      const originalResolve = path.resolve;
      const resolveSpy = vi.spyOn(path, 'resolve').mockImplementation((value) => {
        if (value === projectRoot) {
          return originalResolve(value);
        }
        if (value === fullPath) {
          return originalResolve(path.join(projectsRoot, 'outside', 'safe.txt'));
        }
        return originalResolve(value);
      });

      try {
        __projectRoutesInternals.resolveProjectRelativePath(projectRoot, relative);
        throw new Error('Expected resolveProjectRelativePath to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Invalid path');
      } finally {
        resolveSpy.mockRestore();
      }
    });

    test('throws 400 when resolved path contains unsafe command characters', () => {
      const projectRoot = path.join(projectsRoot, `resolve-unsafe-chars-${Date.now()}`);
      const relative = 'src/\"bad\".txt';

      try {
        __projectRoutesInternals.resolveProjectRelativePath(projectRoot, relative);
        throw new Error('Expected resolveProjectRelativePath to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Invalid path');
      }
    });
  });

  describe('POST /api/projects/:id/files-ops/delete', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post('/api/projects/999999/files-ops/delete')
        .send({ targetPath: 'src/whatever.txt', recursive: true });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
    });

    test('returns 400 when project has no path', async () => {
      const projectRecord = await createProject({
        name: `delete-nopath-${Date.now()}`,
        description: 'delete missing path coverage',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: 'src/whatever.txt', recursive: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path not found. Please re-import or recreate the project.'
      });
    });

    test('returns 400 when targetPath is missing', async () => {
      const projectName = `delete-missing-target-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete missing targetPath coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ recursive: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'targetPath is required' });
    });

    test('returns 400 when attempting to delete the project root', async () => {
      const projectName = `delete-root-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete root protection coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: '.', recursive: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Refusing to delete project root' });
    });

    test('returns 404 when deleting a missing path (ENOENT)', async () => {
      const projectName = `delete-missing-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete missing coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: 'src/missing.txt', recursive: true });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Path not found' });
    });

    test('returns 400 when deleting a folder without recursive', async () => {
      const projectName = `delete-folder-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);
      await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete folder coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: 'src', recursive: false });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'recursive must be true to delete folders'
      });
    });

    test('deletes a folder when recursive is true', async () => {
      const projectName = `delete-folder-rec-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const folderPath = path.join(projectPath, 'src', 'nested');
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(path.join(folderPath, 'file.txt'), 'hello');

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete folder recursive coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .set('x-confirm-destructive', 'true')
        .send({ targetPath: 'src', recursive: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, targetPath: 'src' });
      await expect(fs.stat(path.join(projectPath, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('deletes a file when target is a file', async () => {
      const projectName = `delete-file-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const filePath = path.join(projectPath, 'src', 'toDelete.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'bye');

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete file coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .set('x-confirm-destructive', 'true')
        .send({ targetPath: 'src/toDelete.txt', recursive: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ success: true, targetPath: 'src/toDelete.txt' });
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('returns 400 when targetPath is an invalid relative path', async () => {
      const projectName = `delete-invalid-path-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete invalid path coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: '../evil.txt', recursive: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid path' });
    });

    test('returns 500 when fs.stat fails with a non-ENOENT error', async () => {
      const projectName = `delete-staterr-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const filePath = path.join(projectPath, 'src', 'protected.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'nope');

      const projectRecord = await createProject({
        name: projectName,
        description: 'delete stat error coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        stat: async () => {
          const err = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/delete`)
        .send({ targetPath: 'src/protected.txt', recursive: true });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to delete path' });

      __projectRoutesInternals.resetFsModuleOverride();
    });
  });

  describe('POST /api/projects/import (git)', () => {
    test('builds clone URL with PAT and applies compatibility/structure flags', async () => {
      const { runGitCommand, getCurrentBranch } = await import('../utils/git.js');
      const { applyCompatibility, applyProjectStructure } = await import('../services/importCompatibility.js');

      runGitCommand.mockResolvedValue(undefined);
      getCurrentBranch.mockResolvedValue('main');
      applyCompatibility.mockResolvedValue({ applied: true, plan: { needsChanges: true } });
      applyProjectStructure.mockResolvedValue({ applied: true, plan: { needsMove: true } });

      const repoSuffix = Date.now();
      const gitUrl = `https://gitlab.com/acme/repo-${repoSuffix}.git`;

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          name: '',
          importMethod: 'git',
          gitUrl,
          gitAuthMethod: 'pat',
          gitToken: 'token123',
          gitProvider: 'gitlab',
          applyCompatibility: true,
          applyStructureFix: true
        })
        .expect(201);

      const cloneCall = runGitCommand.mock.calls.find((call) => call[1]?.[0] === 'clone');
      expect(cloneCall).toBeTruthy();
      expect(cloneCall[1][1]).toContain('oauth2:token123@');

      expect(runGitCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['remote', 'set-url', 'origin', gitUrl]),
        expect.any(Object)
      );
      expect(applyCompatibility).toHaveBeenCalled();
      expect(applyProjectStructure).toHaveBeenCalled();
      expect(response.body).toMatchObject({ success: true });
      expect(response.body.project.name).toBe(`repo-${repoSuffix}`);
    });

    test('uses raw git URL for ssh auth and strips credentials for remote', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const { runGitCommand, getCurrentBranch } = await import('../utils/git.js');
      runGitCommand.mockReset();
      getCurrentBranch.mockReset();
      runGitCommand.mockResolvedValue(undefined);
      getCurrentBranch.mockResolvedValue('main');

      const gitUrl = `https://user:pass@github.com/acme/repo-${Date.now()}.git`;
      const safeUrl = gitUrl.replace('user:pass@', '');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitAuthMethod: 'ssh',
          gitToken: 'ignored-token',
          gitUrl
        })
        .expect(201);

      const cloneCall = runGitCommand.mock.calls.find((call) => call[1]?.[0] === 'clone');
      expect(cloneCall[1][1]).toBe(gitUrl);
      expect(runGitCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['remote', 'set-url', 'origin', safeUrl]),
        expect.any(Object)
      );
      expect(response.body).toMatchObject({ success: true });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('cleans existing git target paths before cloning', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const { runGitCommand, getCurrentBranch } = await import('../utils/git.js');
      runGitCommand.mockResolvedValue(undefined);
      getCurrentBranch.mockResolvedValue('main');

      const projectName = `git-clean-${Date.now()}`;
      const targetPath = resolveProjectPath(projectName);
      await ensureEmptyDir(targetPath);
      await fs.writeFile(path.join(targetPath, 'stale.txt'), 'stale');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/${projectName}.git`,
          name: projectName
        })
        .expect(201);

      const staleExists = await fs
        .access(path.join(targetPath, 'stale.txt'))
        .then(() => true)
        .catch(() => false);

      expect(staleExists).toBe(false);
      expect(response.body).toMatchObject({ success: true });

      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });
  });

  describe('POST /api/projects/import error branches', () => {
    test('returns 400 when local copy fails after fallback copy', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `copy-fail-${Date.now()}`);
      await ensureEmptyDir(localPath);
      const badFile = path.join(localPath, 'bad.txt');
      await fs.writeFile(badFile, 'fail');

      const cpSpy = vi.spyOn(fs, 'cp').mockRejectedValueOnce(Object.assign(new Error('cp failed'), { code: 'EIO' }));
      const copyFileSpy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(async () => {
        const err = new Error('copy failed');
        err.code = 'EACCES';
        throw err;
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `copy-fail-${Date.now()}`
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false });
      expect(response.body.error).toContain('Failed to copy project files');
      expect(response.body.error).toContain('EACCES');

      cpSpy.mockRestore();
      copyFileSpy.mockRestore();
      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('returns 400 when git URL is missing', async () => {
      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          name: `missing-git-${Date.now()}`
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'Git repository URL is required' });
    });

    test('continues when cleanup fails after import error', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `cleanup-fail-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const dbModule = await import('../database.js');
      const createSpy = vi.spyOn(dbModule, 'createProject').mockRejectedValue(new Error('create failed'));

      const originalRm = fs.rm;
      const rmSpy = vi.spyOn(fs, 'rm').mockImplementationOnce(async (candidate, options) => {
        if (String(candidate).includes('cleanup-fail-')) {
          throw new Error('rm failed');
        }
        return originalRm(candidate, options);
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          importMode: 'copy',
          localPath,
          name: `cleanup-fail-${Date.now()}`
        })
        .expect(500);

      expect(response.body).toMatchObject({ success: false, error: 'create failed' });

      createSpy.mockRestore();
      rmSpy.mockRestore();
      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });
  });

  describe('POST /api/projects/:id/files-ops/rename', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post('/api/projects/999999/files-ops/rename')
        .send({ fromPath: 'src/from.txt', toPath: 'src/to.txt' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
    });

    test('returns 400 when project has no path', async () => {
      const projectRecord = await createProject({
        name: `rename-nopath-${Date.now()}`,
        description: 'rename missing path coverage',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: 'src/to.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path not found. Please re-import or recreate the project.'
      });
    });

    test('returns 400 when fromPath or toPath is missing', async () => {
      const projectName = `rename-missing-paths-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename missing from/to coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'fromPath and toPath are required' });
    });

    test('returns 400 when destination already exists', async () => {
      const projectName = `rename-dest-exists-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const fromFile = path.join(projectPath, 'src', 'from.txt');
      const toFile = path.join(projectPath, 'src', 'to.txt');
      await fs.mkdir(path.dirname(fromFile), { recursive: true });
      await fs.writeFile(fromFile, 'from');
      await fs.writeFile(toFile, 'to');

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename destination exists coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: 'src/to.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Destination already exists' });
    });

    test('returns 400 when fromPath is absolute (path.isAbsolute)', async () => {
      const projectName = `rename-absolute-src-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename absolute source coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'C:/windows/system32/drivers/etc/hosts', toPath: 'src/to.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid path' });
    });

    test('returns 400 when resolved path escapes the project root', async () => {
      const projectName = `rename-escape-root-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename resolvedPath startsWith coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      // This path is not absolute itself, but will resolve outside the project
      // once joined + resolved.
      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: '../outside.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid path' });
    });

    test('returns 400 with error message when path validation throws', async () => {
      const projectName = `rename-invalid-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename invalid path coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: '../evil.txt', toPath: 'src/good.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid path' });
    });

    test('returns 500 when fs.rename throws', async () => {
      const projectName = `rename-fail-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const fromFile = path.join(projectPath, 'src', 'from.txt');
      await fs.mkdir(path.dirname(fromFile), { recursive: true });
      await fs.writeFile(fromFile, 'content');

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename failure coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        rename: async () => {
          const err = new Error('rename failed');
          err.code = 'EACCES';
          throw err;
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: 'src/to.txt' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to rename path' });

      __projectRoutesInternals.resetFsModuleOverride();
    });

    test('returns 400 when renaming from the project root', async () => {
      const projectName = `rename-root-src-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename invalid source root coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: '.', toPath: 'src/to.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid source path' });
    });

    test('returns 400 when renaming to the project root', async () => {
      const projectName = `rename-root-dest-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename invalid destination root coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: '.' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid destination path' });
    });

    test('returns 500 when destination stat fails with non-ENOENT', async () => {
      const projectName = `rename-staterr-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const fromFile = path.join(projectPath, 'src', 'from.txt');
      await fs.mkdir(path.dirname(fromFile), { recursive: true });
      await fs.writeFile(fromFile, 'content');

      const projectRecord = await createProject({
        name: projectName,
        description: 'rename stat error coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        stat: async () => {
          const err = new Error('no access');
          err.code = 'EACCES';
          throw err;
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/rename`)
        .send({ fromPath: 'src/from.txt', toPath: 'src/to.txt' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to rename path' });

      __projectRoutesInternals.resetFsModuleOverride();
    });
  });

  describe('POST /api/projects/:id/files-ops/mkdir', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post('/api/projects/999999/files-ops/mkdir')
        .send({ folderPath: 'src/new-folder', track: true });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
    });

    test('returns 400 when project has no path', async () => {
      const projectRecord = await createProject({
        name: `mkdir-nopath-${Date.now()}`,
        description: 'mkdir missing path coverage',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: 'src/new-folder', track: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path not found. Please re-import or recreate the project.'
      });
    });

    test('returns 400 when folderPath is missing', async () => {
      const projectName = `mkdir-missing-folder-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir missing folderPath coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ track: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'folderPath is required' });
    });

    test('returns 400 when folderPath is the project root', async () => {
      const projectName = `mkdir-root-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir invalid root coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: '.', track: true });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid folder path' });
    });

    test('returns 500 when tracking file creation fails with non-EEXIST error', async () => {
      const projectName = `mkdir-track-fail-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir tracking error coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        writeFile: async () => {
          const err = new Error('write denied');
          err.code = 'EACCES';
          throw err;
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: 'src/new-folder', track: true });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to create folder' });

      __projectRoutesInternals.resetFsModuleOverride();
    });

    test('creates a folder and tracking file when track is true', async () => {
      const projectName = `mkdir-track-true-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir track true coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: 'src/new-folder', track: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        folderPath: 'src/new-folder',
        trackingPath: 'src/new-folder/.gitkeep'
      });

      await expect(fs.stat(path.join(projectPath, 'src', 'new-folder', '.gitkeep'))).resolves.toBeTruthy();
    });

    test('ignores EEXIST when tracking file already exists', async () => {
      const projectName = `mkdir-track-exists-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const folder = path.join(projectPath, 'src', 'new-folder');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, '.gitkeep'), '');

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir tracking exists coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: 'src/new-folder', track: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        folderPath: 'src/new-folder',
        trackingPath: 'src/new-folder/.gitkeep'
      });
    });

    test('creates a folder without tracking when track is false', async () => {
      const projectName = `mkdir-track-false-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'mkdir track false coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/mkdir`)
        .send({ folderPath: 'src/new-folder', track: false });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        folderPath: 'src/new-folder',
        trackingPath: null
      });

      await expect(fs.stat(path.join(projectPath, 'src', 'new-folder', '.gitkeep'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('POST /api/projects/:id/files-ops/create-file', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post('/api/projects/999999/files-ops/create-file')
        .send({ filePath: 'src/new-file.txt' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
    });

    test('returns 400 when project has no path', async () => {
      const projectRecord = await createProject({
        name: `create-file-nopath-${Date.now()}`,
        description: 'create-file missing path coverage',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/create-file`)
        .send({ filePath: 'src/new-file.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path not found. Please re-import or recreate the project.'
      });
    });

    test('returns 400 when filePath is missing', async () => {
      const projectName = `create-file-missing-path-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'create-file missing filePath coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/create-file`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'filePath is required' });
    });

    test('returns 400 when filePath resolves to project root', async () => {
      const projectName = `create-file-root-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'create-file root path coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/create-file`)
        .send({ filePath: '.' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid file path' });
    });

    test('returns 500 when file creation fails with non-EEXIST error', async () => {
      const projectName = `create-file-write-fail-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'create-file write error coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        writeFile: async () => {
          const err = new Error('write denied');
          err.code = 'EACCES';
          throw err;
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/create-file`)
        .send({ filePath: 'src/new-file.txt', content: 'hello' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to create file' });

      __projectRoutesInternals.resetFsModuleOverride();
    });
  });

  describe('POST /api/projects/:id/files-ops/duplicate', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post('/api/projects/999999/files-ops/duplicate')
        .send({ sourcePath: 'src/source.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
    });

    test('returns 400 when project has no path', async () => {
      const projectRecord = await createProject({
        name: `dup-nopath-${Date.now()}`,
        description: 'duplicate missing path coverage',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: 'src/source.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'Project path not found. Please re-import or recreate the project.'
      });
    });

    test('returns 400 when sourcePath or destinationPath is missing', async () => {
      const projectName = `dup-missing-paths-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate missing source/destination coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        error: 'sourcePath and destinationPath are required'
      });
    });

    test('returns 400 when source is a directory', async () => {
      const projectName = `dup-dir-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);
      await fs.mkdir(path.join(projectPath, 'src', 'folder'), { recursive: true });

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate directory coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: 'src/folder', destinationPath: 'src/folder-copy' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Only file duplication is supported' });
    });

    test('returns 400 when destination already exists', async () => {
      const projectName = `dup-exists-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const src = path.join(projectPath, 'src', 'source.txt');
      const dest = path.join(projectPath, 'src', 'dest.txt');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'source');
      await fs.writeFile(dest, 'dest already');

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate destination exists coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: 'src/source.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Destination already exists' });
    });

    test('duplicates a file successfully', async () => {
      const projectName = `dup-ok-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const src = path.join(projectPath, 'src', 'source.txt');
      const dest = path.join(projectPath, 'src', 'dest.txt');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'source-content');

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate success coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: 'src/source.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        sourcePath: 'src/source.txt',
        destinationPath: 'src/dest.txt'
      });

      const copied = await fs.readFile(dest, 'utf8');
      expect(copied).toBe('source-content');
    });

    test('returns 500 when destination stat fails with non-ENOENT error', async () => {
      const projectName = `dup-staterr-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const src = path.join(projectPath, 'src', 'source.txt');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'source-content');

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate stat error coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const realFs = await import('fs/promises');
      const destinationFullPath = path.join(projectPath, 'src', 'dest.txt');

      __projectRoutesInternals.setFsModuleOverride({
        ...realFs,
        stat: async (candidatePath) => {
          if (path.resolve(candidatePath) === path.resolve(destinationFullPath)) {
            const err = new Error('no access');
            err.code = 'EACCES';
            throw err;
          }
          return realFs.stat(candidatePath);
        }
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: 'src/source.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ success: false, error: 'Failed to duplicate file' });

      __projectRoutesInternals.resetFsModuleOverride();
    });

    test('returns 400 when sourcePath is an invalid relative path', async () => {
      const projectName = `dup-invalid-path-${Date.now()}`;
      const projectPath = path.join(projectsRoot, projectName);
      await ensureEmptyDir(projectPath);

      const projectRecord = await createProject({
        name: projectName,
        description: 'duplicate invalid path coverage',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .post(`/api/projects/${projectRecord.id}/files-ops/duplicate`)
        .send({ sourcePath: '../evil.txt', destinationPath: 'src/dest.txt' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ success: false, error: 'Invalid path' });
    });
  });

  test('buildFileTree skips ignored and hidden entries but keeps .gitignore', async () => {
    const dirName = `tree-${Date.now()}`;
    const treeRoot = path.join(projectsRoot, dirName);
    await ensureEmptyDir(treeRoot);

    await fs.writeFile(path.join(treeRoot, '.secret'), 'nope');
    await fs.writeFile(path.join(treeRoot, '.gitignore'), 'node_modules\n');
    await fs.writeFile(path.join(treeRoot, 'Thumbs.db'), 'nope');
    await fs.writeFile(path.join(treeRoot, 'visible.js'), 'console.log("ok");');

    await fs.mkdir(path.join(treeRoot, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(treeRoot, 'node_modules', 'pkg', 'index.js'), 'console.log("pkg");');

    const tree = await __projectRoutesInternals.buildFileTree(treeRoot);
    const names = tree.map((node) => node.name);

    expect(names).toContain('.gitignore');
    expect(names).toContain('visible.js');
    expect(names).not.toContain('.secret');
    expect(names).not.toContain('Thumbs.db');
    expect(names).not.toContain('node_modules');
  });

  describe('POST /api/projects/import error coverage', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalProjectsDir = process.env.PROJECTS_DIR;

    beforeEach(async () => {
      const { runGitCommand, getCurrentBranch } = await import('../utils/git.js');
      const { applyCompatibility, applyProjectStructure } = await import('../services/importCompatibility.js');
      runGitCommand.mockReset();
      getCurrentBranch.mockReset();
      applyCompatibility.mockReset();
      applyProjectStructure.mockReset();
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalProjectsDir === undefined) {
        delete process.env.PROJECTS_DIR;
      } else {
        process.env.PROJECTS_DIR = originalProjectsDir;
      }
    });

    test('returns 409 when cleanupExistingImportTarget fails for git import', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const repoName = `cleanup-fail-${Date.now()}`;
      const targetPath = path.join(projectsRoot, repoName);
      await ensureEmptyDir(targetPath);

      const originalRm = fs.rm;
      const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (candidate, options) => {
        if (path.resolve(candidate) === path.resolve(targetPath)) {
          throw new Error('cannot remove');
        }
        return originalRm(candidate, options);
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/${repoName}.git`
        })
        .expect(409);

      expect(response.body).toMatchObject({ success: false, error: 'Project path already exists' });
      rmSpy.mockRestore();
    });

    test('continues when getCurrentBranch fails', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const { runGitCommand, getCurrentBranch } = await import('../utils/git.js');

      runGitCommand.mockResolvedValue(undefined);
      getCurrentBranch.mockRejectedValue(new Error('branch error'));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/branch-${Date.now()}.git`
        })
        .expect(201);

      expect(response.body).toMatchObject({ success: true });
    });

    test('returns 400 when applyProjectStructure fails', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const { runGitCommand } = await import('../utils/git.js');
      const { applyProjectStructure } = await import('../services/importCompatibility.js');

      runGitCommand.mockResolvedValue(undefined);
      applyProjectStructure.mockRejectedValue(new Error('structure failed'));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/structure-${Date.now()}.git`,
          applyStructureFix: true
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'structure failed' });
    });

    test('returns 400 when applyProjectStructure fails without a message', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const { runGitCommand } = await import('../utils/git.js');
      const { applyProjectStructure } = await import('../services/importCompatibility.js');

      runGitCommand.mockResolvedValue(undefined);
      applyProjectStructure.mockRejectedValue({ code: 'STRUCTURE_FAIL' });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/structure-${Date.now()}.git`,
          applyStructureFix: true
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'Failed to apply project structure updates'
      });
    });

    test('returns 400 when applyCompatibility fails', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const { runGitCommand } = await import('../utils/git.js');
      const { applyCompatibility } = await import('../services/importCompatibility.js');

      runGitCommand.mockResolvedValue(undefined);
      applyCompatibility.mockRejectedValue(new Error('compat failed'));

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/compat-${Date.now()}.git`,
          applyCompatibility: true
        })
        .expect(400);

      expect(response.body).toMatchObject({ success: false, error: 'compat failed' });
    });

    test('returns 400 when applyCompatibility fails without a message', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const { runGitCommand } = await import('../utils/git.js');
      const { applyCompatibility } = await import('../services/importCompatibility.js');

      runGitCommand.mockResolvedValue(undefined);
      applyCompatibility.mockRejectedValue({ code: 'COMPAT_FAIL' });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'git',
          gitUrl: `https://github.com/acme/compat-${Date.now()}.git`,
          applyCompatibility: true
        })
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'Failed to apply compatibility changes'
      });
    });

    test('returns 201 when enqueueInstallJobs fails', async () => {
      process.env.PROJECTS_DIR = projectsRoot;
      const localPath = path.join(projectsRoot, `local-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const originalStat = fs.stat;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
        if (String(candidate).endsWith(path.join('package.json'))) {
          throw { code: 'STAT_FAIL' };
        }
        return originalStat(candidate);
      });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          localPath,
          importMode: 'copy',
          name: `local-${Date.now()}`
        })
        .expect(201);

      expect(response.body).toMatchObject({ success: true, jobs: [] });
      statSpy.mockRestore();
    });

    test('maps UNIQUE constraint failures to 409 and includes dev details', async () => {
      process.env.NODE_ENV = 'development';
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `local-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const dbModule = await import('../database.js');
      const createSpy = vi.spyOn(dbModule, 'createProject').mockRejectedValue(new Error('UNIQUE constraint failed'));
      const rmSpy = vi.spyOn(fs, 'rm');

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          localPath,
          importMode: 'copy',
          name: `local-${Date.now()}`
        })
        .expect(409);

      expect(response.body).toMatchObject({ success: false });
      expect(response.body.details).toBeTruthy();
      expect(rmSpy).toHaveBeenCalled();

      createSpy.mockRestore();
      rmSpy.mockRestore();
    });

    test('returns 500 fallback message when error message is not a string', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      process.env.PROJECTS_DIR = projectsRoot;

      const localPath = path.join(projectsRoot, `local-${Date.now()}`);
      await ensureEmptyDir(localPath);
      await fs.writeFile(path.join(localPath, 'package.json'), JSON.stringify({ name: 'local' }));

      const dbModule = await import('../database.js');
      const err = { message: 123, name: '' };
      const createSpy = vi.spyOn(dbModule, 'createProject').mockRejectedValue(err);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce({ code: 'RM_FAIL' });

      const response = await request(app)
        .post('/api/projects/import')
        .send({
          importMethod: 'local',
          localPath,
          importMode: 'copy',
          name: `local-${Date.now()}`
        })
        .expect(500);

      expect(response.body).toMatchObject({ success: false, error: 'Failed to import project' });
      expect(response.body.details?.name).toBeNull();

      createSpy.mockRestore();
      warnSpy.mockRestore();
      rmSpy.mockRestore();
      process.env.NODE_ENV = originalNodeEnv;
    });
  });

  describe('POST /api/projects/:id/backend/create', () => {
    test('uses backend language/framework and warns when install job fails', async () => {
      const { generateBackendFiles } = await import('../services/projectScaffolding/generate.js');
      const { startJob } = await import('../services/jobRunner.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const projectPath = path.join(projectsRoot, `backend-create-${Date.now()}`);
      await ensureEmptyDir(projectPath);

      const project = await createProject({
        name: `backend-create-${Date.now()}`,
        description: 'backend create coverage',
        language: 'javascript,python',
        framework: 'react,flask',
        path: projectPath,
        frontendPort: null,
        backendPort: null
      });

      generateBackendFiles.mockImplementationOnce(async (backendPath) => {
        await fs.writeFile(path.join(backendPath, 'package.json'), JSON.stringify({ name: 'backend' }));
      });
      startJob.mockImplementationOnce(() => {
        throw new Error('job failed');
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/backend/create`)
        .expect(200);

      const backendPath = path.join(projectPath, 'backend');
      expect(generateBackendFiles).toHaveBeenCalledWith(
        backendPath,
        expect.objectContaining({ language: 'python', framework: 'flask' })
      );
      expect(response.body).toMatchObject({ success: true });
      expect(warnSpy).toHaveBeenCalledWith('Failed to start backend install job:', 'job failed');

      warnSpy.mockRestore();
    });
  });

  describe('POST /api/projects/:id/restart', () => {
    test('returns 400 with details when restart fails for missing frontend entrypoint', async () => {
      const { startProject } = await import('../services/projectScaffolding.js');
      startProject.mockRejectedValueOnce(new Error('No frontend package.json found in frontend/ or project root'));

      const project = await createProject({
        name: `restart-missing-${Date.now()}`,
        description: 'restart missing frontend',
        language: 'javascript,javascript',
        framework: 'react,express',
        path: path.join(projectsRoot, `restart-missing-${Date.now()}`)
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`)
        .expect(400);

      expect(response.body).toMatchObject({
        success: false,
        error: 'No frontend package.json found in frontend/ or project root'
      });
      expect(response.body.details).toBeTruthy();
    });

    test('returns 500 with details when restart fails unexpectedly', async () => {
      const { startProject } = await import('../services/projectScaffolding.js');
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      const error = new Error('boom');
      error.name = 'RestartError';
      startProject.mockRejectedValueOnce(error);

      const project = await createProject({
        name: `restart-fail-${Date.now()}`,
        description: 'restart unexpected failure',
        language: 'javascript,javascript',
        framework: 'react,express',
        path: path.join(projectsRoot, `restart-fail-${Date.now()}`)
      });

      try {
        const response = await request(app)
          .post(`/api/projects/${project.id}/restart`)
          .expect(500);

        expect(response.body).toMatchObject({
          success: false,
          error: 'Failed to restart project'
        });
        expect(response.body.details?.message).toBe('boom');
        expect(response.body.details?.name).toBe('RestartError');
        expect(response.body.details?.stack).toContain('RestartError');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});
