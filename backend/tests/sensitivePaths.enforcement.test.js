import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

describe('Sensitive path enforcement (denylist)', () => {
  let originalProjectsDir;
  let managedProjectsDir;
  let projectPath;
  let project;

  beforeAll(async () => {
    originalProjectsDir = process.env.PROJECTS_DIR;
    managedProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-managed-projects-sensitive-'));
    process.env.PROJECTS_DIR = managedProjectsDir;
    await initializeDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
    process.env.PROJECTS_DIR = originalProjectsDir;
    if (managedProjectsDir) {
      await fs.rm(managedProjectsDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-project-sensitive-'));
    project = await createProject({
      name: `sensitive-${Date.now()}`,
      description: 'Sensitive-path enforcement test',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
  });

  test('blocks /files read and write of .env', async () => {
    const read = await request(app)
      .get(`/api/projects/${project.id}/files/.env`)
      .expect(403);

    expect(read.body).toMatchObject({ success: false, error: 'Access denied' });

    const write = await request(app)
      .put(`/api/projects/${project.id}/files/.env`)
      .send({ content: 'nope' })
      .expect(403);

    expect(write.body).toMatchObject({ success: false, error: 'Access denied' });
  });

  test('blocks file-ops endpoints when paths are sensitive', async () => {
    const mkdir = await request(app)
      .post(`/api/projects/${project.id}/files-ops/mkdir`)
      .send({ folderPath: '.ssh' })
      .expect(403);
    expect(mkdir.body).toMatchObject({ success: false, error: 'Access denied' });

    const createFile = await request(app)
      .post(`/api/projects/${project.id}/files-ops/create-file`)
      .send({ filePath: '.env.local', content: 'nope' })
      .expect(403);
    expect(createFile.body).toMatchObject({ success: false, error: 'Access denied' });

    const rename = await request(app)
      .post(`/api/projects/${project.id}/files-ops/rename`)
      .send({ fromPath: 'src/a.txt', toPath: '.npmrc' })
      .expect(403);
    expect(rename.body).toMatchObject({ success: false, error: 'Access denied' });

    const del = await request(app)
      .post(`/api/projects/${project.id}/files-ops/delete`)
      .send({ targetPath: '.aws/credentials', recursive: true })
      .expect(403);
    expect(del.body).toMatchObject({ success: false, error: 'Access denied' });

    const duplicate = await request(app)
      .post(`/api/projects/${project.id}/files-ops/duplicate`)
      .send({ sourcePath: '.npmrc', destinationPath: 'src/a.copy' })
      .expect(403);
    expect(duplicate.body).toMatchObject({ success: false, error: 'Access denied' });
  });
});
