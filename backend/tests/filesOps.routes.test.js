import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import projectRoutes from '../routes/projects.js';
import { initializeDatabase, closeDatabase, createProject } from '../database.js';

const app = express();
app.use(express.json());
app.use('/api/projects', projectRoutes);

describe('Projects files-ops routes', () => {
  let project;
  let projectPath;
  let originalProjectsDir;
  let managedProjectsDir;

  const rmDirWithRetries = async (dirPath, { retries = 25, delayMs = 50 } = {}) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };

  beforeAll(async () => {
    originalProjectsDir = process.env.PROJECTS_DIR;
    managedProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-managed-projects-'));
    process.env.PROJECTS_DIR = managedProjectsDir;
    await initializeDatabase();
  });

  afterAll(async () => {
    await closeDatabase();

    process.env.PROJECTS_DIR = originalProjectsDir;
    if (managedProjectsDir) {
      await fs.rm(managedProjectsDir, { recursive: true, force: true });
      managedProjectsDir = undefined;
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-test-project-files-ops-'));

    project = await createProject({
      name: `files-ops-${Date.now()}`,
      description: 'Files ops route test',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
  });

  afterEach(async () => {
    try {
      await rmDirWithRetries(projectPath);
    } catch (error) {
      // best effort cleanup
    }
  });

  test('mkdir creates folder and a tracking .gitkeep by default', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/mkdir`)
      .send({ folderPath: 'src/new-folder' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.folderPath).toBe('src/new-folder');
    expect(response.body.trackingPath).toBe('src/new-folder/.gitkeep');

    await expect(fs.stat(path.join(projectPath, 'src', 'new-folder'))).resolves.toBeDefined();
    await expect(fs.readFile(path.join(projectPath, 'src', 'new-folder', '.gitkeep'), 'utf-8')).resolves.toBe('');
  });

  test('mkdir rejects path traversal', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/mkdir`)
      .send({ folderPath: '../oops' })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  test('create-file creates a file (and parent dirs) with provided content', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/create-file`)
      .send({ filePath: 'src/new-file.txt', content: 'hello' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.filePath).toBe('src/new-file.txt');

    await expect(fs.readFile(path.join(projectPath, 'src', 'new-file.txt'), 'utf-8')).resolves.toBe('hello');
  });

  test('create-file rejects path traversal', async () => {
    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/create-file`)
      .send({ filePath: '../oops.txt', content: 'nope' })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  test('create-file returns 409 when file already exists and does not overwrite', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'exists.txt'), 'original');

    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/create-file`)
      .send({ filePath: 'src/exists.txt', content: 'new' })
      .expect(409);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/already exists/i);
    await expect(fs.readFile(path.join(projectPath, 'src', 'exists.txt'), 'utf-8')).resolves.toBe('original');
  });

  test('rename moves a file without overwriting', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'a.txt'), 'hello');

    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/rename`)
      .send({ fromPath: 'src/a.txt', toPath: 'src/b.txt' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.fromPath).toBe('src/a.txt');
    expect(response.body.toPath).toBe('src/b.txt');

    await expect(fs.stat(path.join(projectPath, 'src', 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(projectPath, 'src', 'b.txt'), 'utf-8')).resolves.toBe('hello');
  });

  test('duplicate copies a file and refuses to overwrite existing destinations', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'a.txt'), 'hello');

    const response = await request(app)
      .post(`/api/projects/${project.id}/files-ops/duplicate`)
      .send({ sourcePath: 'src/a.txt', destinationPath: 'src/a.copy.txt' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.destinationPath).toBe('src/a.copy.txt');

    await expect(fs.readFile(path.join(projectPath, 'src', 'a.copy.txt'), 'utf-8')).resolves.toBe('hello');

    const overwriteAttempt = await request(app)
      .post(`/api/projects/${project.id}/files-ops/duplicate`)
      .send({ sourcePath: 'src/a.txt', destinationPath: 'src/a.copy.txt' })
      .expect(400);

    expect(overwriteAttempt.body.success).toBe(false);
    expect(overwriteAttempt.body.error).toMatch(/already exists/i);
  });

  test('delete removes files and requires recursive:true for folders', async () => {
    await fs.mkdir(path.join(projectPath, 'src', 'tmp'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'tmp', 'a.txt'), 'hello');

    const folderReject = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .send({ targetPath: 'src/tmp' })
      .expect(400);

    expect(folderReject.body.success).toBe(false);
    expect(folderReject.body.error).toMatch(/recursive/i);

    const folderOk = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .set('x-confirm-destructive', 'true')
      .send({ targetPath: 'src/tmp', recursive: true })
      .expect(200);

    expect(folderOk.body.success).toBe(true);

    await expect(fs.stat(path.join(projectPath, 'src', 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(path.join(projectPath, 'README.md'), 'ok');

    const fileOk = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .set('x-confirm-destructive', 'true')
      .send({ targetPath: 'README.md' })
      .expect(200);

    expect(fileOk.body.success).toBe(true);
    await expect(fs.stat(path.join(projectPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('delete requires destructive confirmation', async () => {
    await fs.writeFile(path.join(projectPath, 'confirm-me.txt'), 'hello');

    const blocked = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .send({ targetPath: 'confirm-me.txt' })
      .expect(409);

    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error).toMatch(/confirmation required/i);
    await expect(fs.readFile(path.join(projectPath, 'confirm-me.txt'), 'utf-8')).resolves.toBe('hello');

    const allowed = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .set('x-confirm-destructive', 'true')
      .send({ targetPath: 'confirm-me.txt' })
      .expect(200);

    expect(allowed.body.success).toBe(true);
    await expect(fs.stat(path.join(projectPath, 'confirm-me.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
