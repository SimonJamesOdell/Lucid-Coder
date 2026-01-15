import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import projectRoutes, { __projectRoutesInternals } from '../routes/projects.js';
import db, { initializeDatabase, closeDatabase, createProject } from '../database.js';

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn(),
  scaffoldProject: vi.fn(),
  installDependencies: vi.fn(),
  startProject: vi.fn()
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
});
