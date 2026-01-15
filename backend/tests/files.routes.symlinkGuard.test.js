import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import projectRoutes from '../routes/projects.js';
import { initializeDatabase, closeDatabase, createProject } from '../database.js';
import { resetFsModuleOverride, setFsModuleOverride } from '../routes/projects/internals.js';
import { assertNoSymlinkSegments, isPathWithinRoot, isSensitiveRepoPath } from '../routes/projects/internals.js';

const app = express();
app.use(express.json());
app.use('/api/projects', projectRoutes);

describe('Projects /files routes symlink guard', () => {
  let originalProjectsDir;
  let managedProjectsDir;
  let projectPath;
  let project;

  beforeAll(async () => {
    originalProjectsDir = process.env.PROJECTS_DIR;
    managedProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-managed-projects-files-'));
    process.env.PROJECTS_DIR = managedProjectsDir;
    await initializeDatabase();
  });

  afterAll(async () => {
    resetFsModuleOverride();
    await closeDatabase();
    process.env.PROJECTS_DIR = originalProjectsDir;
    if (managedProjectsDir) {
      await fs.rm(managedProjectsDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    resetFsModuleOverride();
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-project-files-'));
    project = await createProject({
      name: `files-${Date.now()}`,
      description: 'Files routes test',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
  });

  afterEach(async () => {
    resetFsModuleOverride();
    if (projectPath) {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('GET /files returns file contents for an in-scope file', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'hello.txt'), 'hi', 'utf-8');

    const response = await request(app)
      .get(`/api/projects/${project.id}/files/src/hello.txt`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/hello.txt');
    expect(response.body.content).toBe('hi');
  });

  test('PUT /files updates file contents for an in-scope file', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src', 'hello.txt'), 'old', 'utf-8');

    await request(app)
      .put(`/api/projects/${project.id}/files/src/hello.txt`)
      .send({ content: 'new' })
      .expect(200);

    await expect(fs.readFile(path.join(projectPath, 'src', 'hello.txt'), 'utf-8')).resolves.toBe('new');
  });

  test('GET /files rejects when any existing segment is a symlink', async () => {
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const readFile = vi.fn(async () => 'should-not-read');
    const lstat = vi.fn(async (p) => {
      const asString = String(p);
      if (asString.endsWith(`${path.sep}src`)) {
        return { isSymbolicLink: () => true };
      }
      return { isSymbolicLink: () => false };
    });

    setFsModuleOverride({
      lstat,
      stat,
      readFile
    });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files/src/hello.txt`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
    expect(readFile).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  test('PUT /files rejects when any existing segment is a symlink', async () => {
    const stat = vi.fn(async () => ({ isFile: () => true }));
    const writeFile = vi.fn(async () => undefined);
    const lstat = vi.fn(async (p) => {
      const asString = String(p);
      if (asString.endsWith(`${path.sep}src`)) {
        return { isSymbolicLink: () => true };
      }
      return { isSymbolicLink: () => false };
    });

    setFsModuleOverride({
      lstat,
      stat,
      writeFile
    });

    const response = await request(app)
      .put(`/api/projects/${project.id}/files/src/hello.txt`)
      .send({ content: 'nope' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('GET /files returns 500 when lstat throws unexpected errors', async () => {
    const lstat = vi.fn(async () => {
      const error = new Error('no access');
      error.code = 'EACCES';
      throw error;
    });
    const stat = vi.fn();
    const readFile = vi.fn();

    setFsModuleOverride({ lstat, stat, readFile });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files/src/hello.txt`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to read file');
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  test('PUT /files returns 500 when lstat throws unexpected errors', async () => {
    const lstat = vi.fn(async () => {
      const error = new Error('no access');
      error.code = 'EACCES';
      throw error;
    });
    const stat = vi.fn();
    const writeFile = vi.fn();

    setFsModuleOverride({ lstat, stat, writeFile });

    const response = await request(app)
      .put(`/api/projects/${project.id}/files/src/hello.txt`)
      .send({ content: 'nope' })
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to save file');
    expect(stat).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('internals symlink/path guards', () => {
  test('isPathWithinRoot accepts root and children, rejects outside', () => {
    const root = path.resolve('root');
    expect(isPathWithinRoot(root, root)).toBe(true);
    expect(isPathWithinRoot(root, path.join(root, 'child', 'file.txt'))).toBe(true);
    expect(isPathWithinRoot(root, path.resolve(root, '..', 'other'))).toBe(false);
  });

  test('assertNoSymlinkSegments rejects when resolved path is outside root', async () => {
    const fsStub = { lstat: vi.fn() };
    await expect(
      assertNoSymlinkSegments(fsStub, path.resolve('root'), path.resolve('outside'), { errorMessage: 'Invalid path' })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fsStub.lstat).not.toHaveBeenCalled();
  });

  test('assertNoSymlinkSegments returns immediately when target is the root', async () => {
    const fsStub = { lstat: vi.fn() };
    const root = path.resolve('root');
    await expect(assertNoSymlinkSegments(fsStub, root, root)).resolves.toBeUndefined();
    expect(fsStub.lstat).not.toHaveBeenCalled();
  });

  test('assertNoSymlinkSegments rejects when a segment is a symlink', async () => {
    const root = path.resolve('root');
    const target = path.join(root, 'src', 'file.txt');
    const fsStub = {
      lstat: vi.fn(async (p) => {
        const asString = String(p);
        if (asString.endsWith(`${path.sep}src`)) {
          return { isSymbolicLink: () => true };
        }
        return { isSymbolicLink: () => false };
      })
    };

    await expect(assertNoSymlinkSegments(fsStub, root, target)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('assertNoSymlinkSegments allows missing paths (ENOENT) for create scenarios', async () => {
    const root = path.resolve('root');
    const target = path.join(root, 'missing', 'file.txt');
    const fsStub = {
      lstat: vi.fn(async () => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      })
    };

    await expect(assertNoSymlinkSegments(fsStub, root, target)).resolves.toBeUndefined();
  });

  test('isSensitiveRepoPath flags common credential paths', () => {
    expect(isSensitiveRepoPath('.env')).toBe(true);
    expect(isSensitiveRepoPath('.env.local')).toBe(true);
    expect(isSensitiveRepoPath('.npmrc')).toBe(true);
    expect(isSensitiveRepoPath('.pypirc')).toBe(true);
    expect(isSensitiveRepoPath('.ssh/id_rsa')).toBe(true);
    expect(isSensitiveRepoPath('.ssh/id_ed25519')).toBe(true);
    expect(isSensitiveRepoPath('.aws/credentials')).toBe(true);

    expect(isSensitiveRepoPath('/')).toBe(false);

    expect(isSensitiveRepoPath('src/App.jsx')).toBe(false);
    expect(isSensitiveRepoPath('README.md')).toBe(false);
    expect(isSensitiveRepoPath('')).toBe(false);
  });
});
