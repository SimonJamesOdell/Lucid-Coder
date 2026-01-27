import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import db, { initializeDatabase, createProject } from '../database.js';
import * as branchWorkflow from '../services/branchWorkflow.js';
import * as context from '../services/branchWorkflow/context.js';

const execBatch = (sql) => new Promise((resolve, reject) => {
  db.exec(sql, (err) => {
    if (err) {
      reject(err);
    } else {
      resolve();
    }
  });
});

describe('branchWorkflow getBranchChangedFiles', () => {
  let project;

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await execBatch('BEGIN;DELETE FROM test_runs;DELETE FROM branches;DELETE FROM projects;COMMIT;');

    project = await createProject({
      name: `Changed Files Project ${Date.now()}`,
      description: 'Covers getBranchChangedFiles behaviors',
      language: 'javascript',
      framework: 'react',
      // Keep path null so git is not ready by default in test mode.
      path: null
    });

    branchWorkflow.__testing.setGitContextOverride(project.id, null);
  });

  afterEach(() => {
    branchWorkflow.__testing.setGitContextOverride(project?.id, null);
    vi.restoreAllMocks();
  });

  it('requires a branch name', async () => {
    await expect(branchWorkflow.getBranchChangedFiles(project.id, '   ')).rejects.toMatchObject({
      message: expect.stringMatching(/Branch name is required/i),
      statusCode: 400
    });
  });

  it('rejects non-string branch names', async () => {
    await expect(branchWorkflow.getBranchChangedFiles(project.id, 123)).rejects.toMatchObject({
      message: expect.stringMatching(/Branch name is required/i),
      statusCode: 400
    });
  });

  it('returns empty files when git context is not ready', async () => {
    const result = await branchWorkflow.getBranchChangedFiles(project.id, 'feature-no-git');

    expect(result).toEqual({
      branch: 'feature-no-git',
      files: []
    });
  });

  it('coerces non-array git output to an empty list', async () => {
    branchWorkflow.__testing.setGitContextOverride(project.id, 'C:/tmp/forced-git');

    const spy = vi.spyOn(context, 'listBranchChangedPaths').mockResolvedValueOnce('nope');

    const result = await branchWorkflow.getBranchChangedFiles(project.id, 'feature-coerce');

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({
      branch: 'feature-coerce',
      files: []
    });
  });

  it('returns changed file paths when git returns a list', async () => {
    branchWorkflow.__testing.setGitContextOverride(project.id, 'C:/tmp/forced-git');

    const spy = vi.spyOn(context, 'listBranchChangedPaths').mockResolvedValueOnce([
      'src/app.jsx',
      'src/styles.css'
    ]);

    const result = await branchWorkflow.getBranchChangedFiles(project.id, 'feature-ok');

    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({
      branch: 'feature-ok',
      files: ['src/app.jsx', 'src/styles.css']
    });
  });

  it('returns empty files when git diff listing fails', async () => {
    branchWorkflow.__testing.setGitContextOverride(project.id, 'C:/tmp/forced-git');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('boom');
    const spy = vi.spyOn(context, 'listBranchChangedPaths').mockRejectedValueOnce(error);

    const result = await branchWorkflow.getBranchChangedFiles(project.id, 'feature-error');

    expect(spy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(result).toEqual({
      branch: 'feature-error',
      files: []
    });
  });
});
