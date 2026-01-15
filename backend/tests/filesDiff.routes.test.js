import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runGitCommand: vi.fn()
  };
});

import projectRoutes from '../routes/projects.js';
import { initializeDatabase, closeDatabase, createProject } from '../database.js';
import { runGitCommand } from '../utils/git.js';

const app = express();
app.use(express.json());
app.use('/api/projects', projectRoutes);

let originalProjectsDir;
let managedProjectsDir;

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

describe('Projects files-diff route', () => {
  let project;
  let projectPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-test-project-diff-'));

    project = await createProject({
      name: `diff-project-${Date.now()}`,
      description: 'Diff route test',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
  });

  afterEach(async () => {
    if (projectPath) {
      await fs.rm(projectPath, { recursive: true, force: true });
      projectPath = null;
    }
  });

  test('returns staged diff text when git diff succeeds', async () => {
    runGitCommand.mockResolvedValue({ stdout: 'diff --git a/a b/a\n@@', stderr: '', code: 0 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff/src/App.jsx`)
      .expect(200);

    expect(runGitCommand).toHaveBeenCalledWith(
      projectPath,
      ['diff', '--cached', '--', 'src/App.jsx'],
      { allowFailure: true }
    );

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.diff).toContain('diff --git');
  });

  test('returns 404 when project is not found', async () => {
    const response = await request(app)
      .get('/api/projects/999999/files-diff/src/App.jsx')
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  test('returns 400 when project exists but has no path', async () => {
    const projectWithoutPath = await createProject({
      name: `diff-project-nopath-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      description: 'Diff route test (no path)',
      language: 'javascript',
      framework: 'react',
      path: null
    });

    const response = await request(app)
      .get(`/api/projects/${projectWithoutPath.id}/files-diff/src/App.jsx`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('Project path not found');
  });

  test('returns success=false when git diff fails and produces no stdout', async () => {
    runGitCommand.mockResolvedValue({ stdout: '', stderr: 'fatal: not a git repository', code: 128 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('fatal');
    expect(response.body.diff).toBe('');
  });

  test('returns success=false with default copy when git diff fails without stderr', async () => {
    runGitCommand.mockResolvedValue({ stdout: '', stderr: '', code: 1 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Git diff unavailable');
    expect(response.body.diff).toBe('');
  });

  test('rejects empty file path', async () => {
    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff/`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
  });

  test('returns 500 when git diff throws unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runGitCommand.mockRejectedValue(new Error('git died'));

    try {
      const response = await request(app)
        .get(`/api/projects/${project.id}/files-diff/src/App.jsx`)
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Failed to fetch staged diff');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('rejects path traversal attempts', async () => {
    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff/../secrets.txt`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
  });
});

describe('Projects files-diff-content route', () => {
  let project;
  let projectPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-test-project-diff-content-'));

    project = await createProject({
      name: `diff-content-project-${Date.now()}`,
      description: 'Diff content route test',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });
  });

  afterEach(async () => {
    if (projectPath) {
      await fs.rm(projectPath, { recursive: true, force: true });
      projectPath = null;
    }
  });

  test('returns head vs staged content when git show succeeds', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: 'HEAD content\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'staged content\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: '', code: 0 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(runGitCommand).toHaveBeenNthCalledWith(
      1,
      projectPath,
      ['show', 'HEAD:src/App.jsx'],
      { allowFailure: true }
    );
    expect(runGitCommand).toHaveBeenNthCalledWith(
      2,
      projectPath,
      ['show', ':src/App.jsx'],
      { allowFailure: true }
    );

    expect(runGitCommand).toHaveBeenNthCalledWith(
      3,
      projectPath,
      ['rev-parse', 'HEAD:src/App.jsx'],
      { allowFailure: true }
    );
    expect(runGitCommand).toHaveBeenNthCalledWith(
      4,
      projectPath,
      ['rev-parse', ':src/App.jsx'],
      { allowFailure: true }
    );

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.original).toBe('HEAD content\n');
    expect(response.body.modified).toBe('staged content\n');
    expect(response.body.headBlobOid).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(response.body.indexBlobOid).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(response.body.originalLabel).toBe('HEAD');
    expect(response.body.modifiedLabel).toBe('Staged');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  test('returns content even when rev-parse fails (blob oids fall back to null)', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: 'HEAD content\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'staged content\n', stderr: '', code: 0 })
      .mockRejectedValueOnce(new Error('rev-parse failed'))
      .mockRejectedValueOnce(new Error('rev-parse failed'));

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.original).toBe('HEAD content\n');
    expect(response.body.modified).toBe('staged content\n');
    expect(response.body.headBlobOid).toBe(null);
    expect(response.body.indexBlobOid).toBe(null);
  });

  test('returns content when rev-parse yields non-object results (safeGit falls back)', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: 'HEAD content\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'staged content\n', stderr: '', code: 0 })
      .mockResolvedValueOnce('not-an-object')
      .mockResolvedValueOnce(null);

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.original).toBe('HEAD content\n');
    expect(response.body.modified).toBe('staged content\n');
    expect(response.body.headBlobOid).toBe(null);
    expect(response.body.indexBlobOid).toBe(null);
  });

  test('handles empty stdout for successful git show and rev-parse', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.original).toBe('');
    expect(response.body.modified).toBe('');
    expect(response.body.headBlobOid).toBe('');
    expect(response.body.indexBlobOid).toBe('');
  });

  test('returns 404 when project is not found', async () => {
    const response = await request(app)
      .get('/api/projects/999999/files-diff-content/src/App.jsx')
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  test('returns 400 when project exists but has no path', async () => {
    const projectWithoutPath = await createProject({
      name: `diff-content-nopath-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      description: 'Diff content route test (no path)',
      language: 'javascript',
      framework: 'react',
      path: null
    });

    const response = await request(app)
      .get(`/api/projects/${projectWithoutPath.id}/files-diff-content/src/App.jsx`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('Project path not found');
  });

  test('returns success=false when both git show commands fail', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: bad revision', code: 128 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: path does not exist', code: 128 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('fatal');
    expect(response.body.original).toBe('');
    expect(response.body.modified).toBe('');
  });

  test('falls back to default error copy when both git show commands fail without stderr', async () => {
    runGitCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
      .expect(200);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Git diff unavailable');
    expect(response.body.path).toBe('src/App.jsx');
    expect(response.body.original).toBe('');
    expect(response.body.modified).toBe('');
  });

  test('rejects empty file path', async () => {
    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
  });

  test('returns 500 when git helper throws unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runGitCommand.mockRejectedValue(new Error('git died'));

    try {
      const response = await request(app)
        .get(`/api/projects/${project.id}/files-diff-content/src/App.jsx`)
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Failed to fetch staged diff');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('rejects path traversal attempts', async () => {
    const response = await request(app)
      .get(`/api/projects/${project.id}/files-diff-content/../secrets.txt`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
  });
});
