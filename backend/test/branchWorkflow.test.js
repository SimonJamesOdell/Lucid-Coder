import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import db, { initializeDatabase, createProject, saveProjectGitSettings, saveGitSettings, deleteProjectGitSettings } from '../database.js';
import * as databaseModule from '../database.js';
import * as branchWorkflow from '../services/branchWorkflow.js';
import * as cleanup from '../routes/projects/cleanup.js';
import * as git from '../utils/git.js';
import * as jobRunner from '../services/jobRunner.js';

const exec = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, (err) => {
    if (err) {
      reject(err);
    } else {
      resolve();
    }
  });
});

const execBatch = (sql) => new Promise((resolve, reject) => {
  db.exec(sql, (err) => {
    if (err) {
      reject(err);
    } else {
      resolve();
    }
  });
});

const countTestRuns = () => new Promise((resolve, reject) => {
  db.get('SELECT COUNT(*) as count FROM test_runs', (err, row) => {
    if (err) {
      reject(err);
    } else {
      resolve(row?.count || 0);
    }
  });
});

const getBranchRow = (projectId, branchName) => new Promise((resolve, reject) => {
  db.get(
    'SELECT * FROM branches WHERE project_id = ? AND name = ? LIMIT 1',
    [projectId, branchName],
    (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    }
  );
});

const getGoalRow = (projectId, branchName) => new Promise((resolve, reject) => {
  db.get(
    'SELECT * FROM agent_goals WHERE project_id = ? AND branch_name = ? ORDER BY id DESC LIMIT 1',
    [projectId, branchName],
    (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    }
  );
});

const cleanupProjectRecords = async (projectId) => {
  await execBatch('BEGIN;DELETE FROM branches WHERE project_id = ' + Number(projectId) + ';COMMIT;');
  await deleteProjectGitSettings(projectId).catch(() => {});
  await execBatch('BEGIN;DELETE FROM projects WHERE id = ' + Number(projectId) + ';COMMIT;');
};

describe('branchWorkflow staging automation', () => {
  let projectId;
  const projectBase = {
    description: 'Test project',
    language: 'javascript',
    framework: 'react'
  };

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    await execBatch('BEGIN;DELETE FROM test_runs;DELETE FROM branches;DELETE FROM projects;COMMIT;');
    const project = await createProject({
      ...projectBase,
      name: `Staging Project ${Date.now()}`
    });
    projectId = project.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requires filePath when staging workspace changes', async () => {
    await expect(branchWorkflow.stageWorkspaceChange(projectId, {})).rejects.toThrow(/filePath is required/i);
  });

  it('stages file changes and auto-creates working branch', async () => {
    const result = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/App.jsx',
      source: 'editor',
      autoRun: false
    });

    expect(result.branch.name).toMatch(/feature\//);
    expect(result.branch.stagedFiles).toHaveLength(1);
    expect(result.branch.stagedFiles[0]).toMatchObject({
      path: 'src/App.jsx',
      source: 'editor'
    });

    const overview = await branchWorkflow.getBranchOverview(projectId);
    expect(overview.workingBranches).toHaveLength(1);
    expect(overview.workingBranches[0].stagedFiles).toHaveLength(1);
  });

  it('invalidates last passing tests when new staged changes are added', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/App.jsx',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    let overview = await branchWorkflow.getBranchOverview(projectId);
    let working = overview.workingBranches.find((entry) => entry.name === staged.branch.name);
    expect(working?.lastTestStatus).toBe('passed');

    await branchWorkflow.stageWorkspaceChange(projectId, {
      branchName: staged.branch.name,
      filePath: 'src/App.js',
      autoRun: false
    });

    overview = await branchWorkflow.getBranchOverview(projectId);
    working = overview.workingBranches.find((entry) => entry.name === staged.branch.name);
    expect(working?.lastTestStatus).toBeNull();
  });

  it('retains AI-sourced staging metadata without coercion', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/ai/suggestion.js',
      source: 'ai',
      autoRun: false
    });

    expect(staged.stagedFiles[0]).toMatchObject({
      path: 'src/ai/suggestion.js',
      source: 'ai'
    });
  });

  it('clears staged files for active branch', async () => {
    await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/util.ts',
      autoRun: false
    });

    const cleared = await branchWorkflow.clearStagedChanges(projectId);
    expect(cleared.stagedFiles).toHaveLength(0);
    expect(cleared.ahead).toBe(0);
  });

  it('rolls back staged changes for a named branch', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/rollback/me.js',
      autoRun: false
    });

    const result = await branchWorkflow.rollbackBranchChanges(projectId, staged.branch.name);

    expect(result).toMatchObject({
      rolledBack: true,
      branch: expect.objectContaining({
        name: staged.branch.name,
        status: 'active'
      })
    });

    expect(result.branch.stagedFiles).toHaveLength(0);
    expect(result.branch.ahead).toBe(0);
  });

  it('rolls back staged changes and checks out the branch in git when ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/rollback/git.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-rollback');

    const executed = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      executed.push(args);
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.rollbackBranchChanges(projectId, staged.branch.name);

    expect(result.branch.stagedFiles).toHaveLength(0);
    expect(executed.some((args) => args[0] === 'checkout' && args[1] === staged.branch.name)).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('requires a branch name when rolling back branch changes', async () => {
    await expect(branchWorkflow.rollbackBranchChanges(projectId, '   ')).rejects.toMatchObject({
      message: expect.stringMatching(/Branch name is required to roll back changes/i),
      statusCode: 400
    });
  });

  it('rejects non-string branch names when rolling back branch changes', async () => {
    await expect(branchWorkflow.rollbackBranchChanges(projectId, 123)).rejects.toMatchObject({
      message: expect.stringMatching(/Branch name is required to roll back changes/i),
      statusCode: 400
    });
  });

  it('rolls back staged changes and updates branch status when provided', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/rollback/status.js',
      autoRun: false
    });

    const result = await branchWorkflow.rollbackBranchChanges(projectId, staged.branch.name, {
      status: '  paused  '
    });

    expect(result).toMatchObject({
      rolledBack: true,
      branch: expect.objectContaining({
        name: staged.branch.name,
        status: 'paused'
      })
    });
  });

  it('rejects rollback attempts targeting the main branch', async () => {
    await expect(branchWorkflow.rollbackBranchChanges(projectId, 'main')).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot roll back the main branch/i),
      statusCode: 400
    });
  });

  it('clears a single staged file when filePath provided', async () => {
    await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/util.ts',
      autoRun: false
    });
    await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/app.tsx',
      autoRun: false
    });

    const updated = await branchWorkflow.clearStagedChanges(projectId, {
      filePath: 'src/util.ts'
    });

    expect(updated.stagedFiles).toHaveLength(1);
    expect(updated.stagedFiles[0].path).toBe('src/app.tsx');
    expect(updated.ahead).toBe(1);
  });

  it('clears staged files and resets git state when repository is ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/reset-me.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-clear');

    const executed = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      executed.push(args);
      return Promise.resolve({ stdout: '' });
    });

    const cleared = await branchWorkflow.clearStagedChanges(projectId, {
      branchName: staged.branch.name
    });

    expect(cleared.stagedFiles).toHaveLength(0);
    expect(executed.some((args) => args[0] === 'reset')).toBe(true);
    expect(executed.some((args) => args[0] === 'checkout')).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues clearing staged files even when git reset or checkout fails', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/reset-failure.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-reset-failure');

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'reset' || args[0] === 'checkout') {
        return Promise.reject(new Error('git reset failed'));
      }
      return Promise.resolve({ stdout: '' });
    });

    const cleared = await branchWorkflow.clearStagedChanges(projectId, {
      branchName: staged.branch.name
    });

    expect(cleared.stagedFiles).toHaveLength(0);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues clearing staged files when staged status map lookup fails', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/status-map-failure.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-status-map-failure');

    const executed = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      executed.push(args);

      if (args[0] === 'diff' && args.includes('--name-status')) {
        throw new Error('git diff name-status exploded');
      }

      return Promise.resolve({ stdout: '' });
    });

    const cleared = await branchWorkflow.clearStagedChanges(projectId, {
      branchName: staged.branch.name
    });

    expect(cleared.stagedFiles).toHaveLength(0);
    expect(executed.some((args) => args[0] === 'reset')).toBe(true);
    expect(executed.some((args) => args[0] === 'checkout')).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('debounces auto test runs after staging', async () => {
    const timerCallbacks = new Map();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      const handle = Symbol('timer');
      timerCallbacks.set(handle, fn);
      return handle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      timerCallbacks.delete(handle);
    });

    const beforeCount = await countTestRuns();

    const firstStage = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/App.jsx',
      autoRun: true,
      autoRunDelayMs: 5
    });

    await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/App.jsx',
      autoRun: true,
      autoRunDelayMs: 5
    });

    const scheduled = branchWorkflow.__testing.getScheduledAutoTests();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toContain(firstStage.branch.name);

    const activeHandle = branchWorkflow.__testing.getAutoTestHandle(projectId, firstStage.branch.name);
    const callback = activeHandle ? timerCallbacks.get(activeHandle) : null;
    expect(typeof callback).toBe('function');
    await callback();

    const afterCount = await countTestRuns();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('skips scheduling auto tests when no branch is provided', () => {
    branchWorkflow.__testing.scheduleAutoTests(projectId, '', 5);
    expect(branchWorkflow.__testing.getScheduledAutoTests()).toHaveLength(0);
  });

  it('logs failures when scheduled auto tests cannot determine a branch', async () => {
    const timerCallbacks = new Map();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      const handle = Symbol('timer');
      timerCallbacks.set(handle, fn);
      return handle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      timerCallbacks.delete(handle);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    branchWorkflow.__testing.scheduleAutoTests(projectId, 'missing-auto-branch', 5);

    const activeHandle = branchWorkflow.__testing.getAutoTestHandle(projectId, 'missing-auto-branch');
    const callback = activeHandle ? timerCallbacks.get(activeHandle) : null;
    expect(typeof callback).toBe('function');
    await callback();

    expect(warnSpy).toHaveBeenCalledWith(
      '[BranchWorkflow] Auto test run failed',
      expect.stringMatching(/Branch "missing-auto-branch" not found/i)
    );
  });

  it('returns null auto test handles when timers do not exist', () => {
    const orphanHandle = branchWorkflow.__testing.getAutoTestHandle(projectId, 'ghost-branch');
    expect(orphanHandle).toBeNull();
  });

  it('runs pending auto tests immediately via the helper hook', async () => {
    const timerCallbacks = new Map();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      const handle = Symbol('timer');
      timerCallbacks.set(handle, fn);
      return handle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      timerCallbacks.delete(handle);
    });

    const beforeCount = await countTestRuns();

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/run-now.js',
      autoRun: true,
      autoRunDelayMs: 5
    });

    expect(branchWorkflow.__testing.getScheduledAutoTests()).toContain(`${projectId}:${staged.branch.name}`);

    await branchWorkflow.__testing.runScheduledAutoTestsNow();

    expect(branchWorkflow.__testing.getScheduledAutoTests()).toHaveLength(0);

    const afterCount = await countTestRuns();
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('runs scheduled auto tests for non-numeric project identifiers', async () => {
    const timerCallbacks = new Map();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      const handle = Symbol('timer');
      timerCallbacks.set(handle, fn);
      return handle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      timerCallbacks.delete(handle);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    branchWorkflow.__testing.scheduleAutoTests('custom-project', 'virtual-branch', 10);
    expect(branchWorkflow.__testing.getScheduledAutoTests()).toContain('custom-project:virtual-branch');

    await branchWorkflow.__testing.runScheduledAutoTestsNow();

    expect(warnSpy).toHaveBeenCalledWith('[BranchWorkflow] Auto test run failed', expect.stringMatching(/Project not found/i));

    branchWorkflow.__testing.cancelScheduledAutoTests('custom-project', 'virtual-branch');
  });

  it('falls back to the default debounce delay when an invalid value is provided', () => {
    const observedDelays = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, delay) => {
      observedDelays.push(delay);
      return Symbol('timer');
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    branchWorkflow.__testing.scheduleAutoTests(projectId, 'delay-check', Number.POSITIVE_INFINITY);

    expect(observedDelays[observedDelays.length - 1]).toBe(750);

    branchWorkflow.__testing.cancelScheduledAutoTests(projectId, 'delay-check');
  });

  it('initializes git repositories when not running in test mode', async () => {
    const projectPath = `C:/tmp/context-${Date.now()}`;
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);

    branchWorkflow.__testing.setTestModeOverride(false);
    const ensureSpy = vi.spyOn(git, 'ensureGitRepository').mockResolvedValue();
    const runSpy = vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    try {
      const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
        filePath: 'src/context-init.js',
        autoRun: false
      });

      expect(staged.branch.stagedFiles).toHaveLength(1);
      expect(ensureSpy).toHaveBeenCalledWith(projectPath, { defaultBranch: 'main' });
      expect(runSpy).toHaveBeenCalledWith(projectPath, ['add', '-A', '--', 'src/context-init.js'], undefined);
    } finally {
      branchWorkflow.__testing.setTestModeOverride(null);
    }
  });

  it('logs git availability failures when repository initialization fails', async () => {
    const projectPath = `C:/tmp/context-failure-${Date.now()}`;
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);

    branchWorkflow.__testing.setTestModeOverride(false);
    vi.spyOn(git, 'ensureGitRepository').mockRejectedValue(new Error('init broke'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await branchWorkflow.stageWorkspaceChange(projectId, {
        filePath: 'src/context-init.js',
        autoRun: false
      });
    } finally {
      branchWorkflow.__testing.setTestModeOverride(null);
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Git unavailable for project/)
    );
  });

  it('no-ops git commands when project context is not git ready', async () => {
    const runSpy = vi.spyOn(git, 'runGitCommand');
    const result = await branchWorkflow.__testing.runProjectGit(
      { gitReady: false, projectPath: 'C:/tmp/nope' },
      ['status']
    );
    expect(result).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('skips ensuring git branches when git is unavailable', async () => {
    const runSpy = vi.spyOn(git, 'runGitCommand');
    await branchWorkflow.__testing.ensureGitBranchExists({ gitReady: false, projectPath: 'C:/tmp/nope' }, 'feature/skip');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('creates git branches when refs are missing', async () => {
    const calls = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((cwd, args) => {
      calls.push(args);
      if (args[0] === 'show-ref') {
        const error = new Error('missing');
        error.code = 1;
        return Promise.reject(error);
      }
      return Promise.resolve({ stdout: '' });
    });

    await branchWorkflow.__testing.ensureGitBranchExists({ gitReady: true, projectPath: 'C:/tmp/git-ensure' }, 'feature/new', 'main');

    expect(calls.some((args) => args[0] === 'checkout' && args[1] === 'main')).toBe(true);
    expect(calls.some((args) => args[0] === 'checkout' && args[1] === '-b' && args[2] === 'feature/new')).toBe(true);
  });

  it('rethrows git errors when branch verification fails unexpectedly', async () => {
    const fatal = new Error('');
    fatal.message = '';
    vi.spyOn(git, 'runGitCommand').mockRejectedValue(fatal);

    await expect(
      branchWorkflow.__testing.ensureGitBranchExists({ gitReady: true, projectPath: 'C:/tmp/git-error' }, 'feature/error')
    ).rejects.toThrow(fatal);
  });

  it('creates git branches when refs fail with textual errors instead of codes', async () => {
    const calls = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((cwd, args = []) => {
      calls.push(args);
      if (args[0] === 'show-ref') {
        const error = new Error('fatal: Not a valid ref');
        error.code = 128;
        return Promise.reject(error);
      }
      return Promise.resolve({ stdout: '' });
    });

    await branchWorkflow.__testing.ensureGitBranchExists(
      { gitReady: true, projectPath: 'C:/tmp/git-text-ref' },
      'feature/text-ref',
      'develop'
    );

    expect(calls.some((args) => args[0] === 'checkout' && args[1] === 'develop')).toBe(true);
    expect(calls.some((args) => args[0] === 'checkout' && args[1] === '-b' && args[2] === 'feature/text-ref')).toBe(true);
  });

  it('skips checkout helpers when git context is unavailable', async () => {
    const runSpy = vi.spyOn(git, 'runGitCommand');
    await branchWorkflow.__testing.checkoutGitBranch({ gitReady: false, projectPath: 'C:/tmp/no-checkout' }, 'feature/skip');
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('stages workspace changes onto an explicitly requested branch', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-explicit',
      description: 'Manual routing'
    });

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/components/Explicit.jsx',
      branchName: working.name,
      autoRun: false
    });

    expect(staged.branch.name).toBe(working.name);
    expect(staged.stagedFiles[0]).toMatchObject({ path: 'src/components/Explicit.jsx' });
  });

  it('creates named working branches and prevents duplicates', async () => {
    const created = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-api',
      description: 'API improvements'
    });

    expect(created.name).toBe('feature-api');
    await expect(
      branchWorkflow.createWorkingBranch(projectId, { name: 'feature-api' })
    ).rejects.toThrow(/already exists/i);
  });

  it('logs git errors when branch creation fails', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-branch-create-error');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'checkout' && args[1] === '-b') {
        return Promise.reject(new Error('checkout -b broke'));
      }
      return Promise.resolve({ stdout: '' });
    });

    const created = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-git-create'
    });

    expect(created.name).toBe('feature-git-create');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to create git branch feature-git-create/i)
    );

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('checkoutBranch switches the current branch flag', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-switch'
    });

    const mainBranch = await branchWorkflow.checkoutBranch(projectId, 'main');

    expect(mainBranch.isCurrent).toBe(true);
    const featureRow = await getBranchRow(projectId, working.name);
    expect(featureRow?.is_current).toBe(0);
  });

  it('performs git checkout workflow when a git context is available', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-git-checkout'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-checkout-success');

    const gitCalls = [];
    vi.spyOn(git, 'runGitCommand').mockImplementation((cwd, args = []) => {
      gitCalls.push(args);
      return Promise.resolve({ stdout: '' });
    });
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();

    await branchWorkflow.checkoutBranch(projectId, working.name);

    expect(gitCalls.some((args) => args[0] === 'checkout' && args[1] === working.name)).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('logs git failures when checkout attempts fail', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-git-checkout-fail'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-checkout-fail');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'checkout' && args[1] === working.name) {
        return Promise.reject(new Error('checkout blew up'));
      }
      return Promise.resolve({ stdout: '' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await branchWorkflow.checkoutBranch(projectId, working.name);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to checkout git branch feature-git-checkout-fail/i)
    );

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('skips stashing when the current git branch cannot be determined', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-no-current');

    const getCurrentSpy = vi.spyOn(git, 'getCurrentBranch').mockResolvedValue(null);
    const stashSpy = vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    const popSpy = vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    await branchWorkflow.__testing.checkoutGitBranch(
      { gitReady: true, projectPath: 'C:/tmp/git-no-current' },
      'feature/checkout-missing-current'
    );

    expect(getCurrentSpy).toHaveBeenCalled();
    expect(stashSpy).not.toHaveBeenCalled();
    expect(popSpy).toHaveBeenCalledTimes(1);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('ignores pop stash failures when already on the requested branch', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-pop-fail');
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('feature/existing');
    vi.spyOn(git, 'popBranchStash').mockRejectedValue(new Error('pop fail'));

    const context = await branchWorkflow.__testing.getProjectContext(projectId);
    context.gitReady = true;

    await expect(branchWorkflow.__testing.checkoutGitBranch(context, 'feature/existing')).resolves.toBeUndefined();

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('swallows stash failures when switching away from the current branch', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-stash-fail');
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockRejectedValue(new Error('stash fail'));
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    const context = await branchWorkflow.__testing.getProjectContext(projectId);
    context.gitReady = true;

    await expect(branchWorkflow.__testing.checkoutGitBranch(context, 'feature/new-work')).resolves.toBeUndefined();

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues checkout when current branch lookup fails and pop stash rejects', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-pop-after');
    vi.spyOn(git, 'getCurrentBranch').mockRejectedValue(new Error('lookup fail'));
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    const popSpy = vi.spyOn(git, 'popBranchStash').mockRejectedValue(new Error('pop after checkout'));
    const runSpy = vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    const context = await branchWorkflow.__testing.getProjectContext(projectId);
    context.gitReady = true;

    await expect(branchWorkflow.__testing.checkoutGitBranch(context, 'feature/git-pop-after')).resolves.toBeUndefined();

    expect(runSpy).toHaveBeenCalled();
    expect(popSpy).toHaveBeenCalled();

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('warns when project path is outside the managed root', async () => {
    const projectPath = 'C:/tmp/outside-managed-root';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ensureRepoSpy = vi.spyOn(git, 'ensureGitRepository').mockResolvedValue();
    const rootSpy = vi.spyOn(cleanup, 'isWithinManagedProjectsRoot').mockReturnValue(false);

    try {
      branchWorkflow.__testing.setTestModeOverride(false);

      const context = await branchWorkflow.__testing.getProjectContext(projectId);
      expect(context.projectPath).toBe(projectPath);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('outside managed root')
      );
      expect(ensureRepoSpy).toHaveBeenCalled();
    } finally {
      rootSpy.mockRestore();
      branchWorkflow.__testing.setTestModeOverride(null);
    }
  });

  it('runTestsForBranch defaults to the active branch when omitted', async () => {
    const result = await branchWorkflow.runTestsForBranch(projectId);

    expect(result.branch).toBe('main');
    expect(result.success).toBe(true);
  });

  it('skips running tests when the branch diff and staged files are CSS-only', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/skip.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-css-only-tests-skip';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const gitRunSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/styles/skip.css\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const startJobSpy = vi.spyOn(jobRunner, 'startJob');

    const result = await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    expect(result.status).toBe('skipped');
    expect(result.success).toBe(true);
    expect(startJobSpy).not.toHaveBeenCalled();

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    expect(branchRow.status).toBe('ready-for-merge');
    expect(branchRow.last_test_run_id).toBe(result.id);

    gitRunSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('describes css-only status for a branch without running tests', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/status.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-css-only-status';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const gitRunSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/styles/status.css\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const status = await branchWorkflow.describeBranchCssOnlyStatus(projectId, staged.branch.name);

    expect(status.branch).toBe(staged.branch.name);
    expect(status.isCssOnly).toBe(true);
    expect(['git-diff', 'staged']).toContain(status.indicator);

    gitRunSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('falls back to the main branch when none are marked current', async () => {
    await branchWorkflow.runTestsForBranch(projectId);
    await exec('UPDATE branches SET is_current = 0 WHERE project_id = ?', [projectId]);

    const result = await branchWorkflow.runTestsForBranch(projectId, undefined, { forceFail: true });

    expect(result.branch).toBe('main');
    expect(result.success).toBe(false);

    const mainRow = await getBranchRow(projectId, 'main');
    expect(mainRow.status).toBe('needs-fix');
    expect(mainRow.ahead_commits).toBeGreaterThan(0);
  });

  it('serializes latest test runs with fallback metrics when database columns are null', async () => {
    const result = await branchWorkflow.runTestsForBranch(projectId);

    await exec(
      `UPDATE test_runs SET summary = NULL, details = NULL, total_tests = NULL, passed_tests = NULL,
        failed_tests = NULL, skipped_tests = NULL, duration = NULL, branch_id = NULL WHERE id = ?`,
      [result.id]
    );

    const latest = await branchWorkflow.getLatestTestRun(projectId);

    expect(latest.branch).toBeNull();
    expect(latest.summary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 });
    expect(latest.tests).toEqual([]);
  });

  it('defaults the overview current branch label to main when none are flagged current', async () => {
    await branchWorkflow.getBranchOverview(projectId);
    await exec('UPDATE branches SET is_current = 0 WHERE project_id = ?', [projectId]);

    const overview = await branchWorkflow.getBranchOverview(projectId);

    expect(overview.current).toBe('main');
  });

  it('suppresses merge block messaging when tests are not required', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-ready'
    });

    await exec(
      `UPDATE branches SET status = 'ready-for-merge', staged_files = '[]' WHERE id = ?`,
      [branch.id]
    );

    const overview = await branchWorkflow.getBranchOverview(projectId);
    const readyBranch = overview.workingBranches.find((entry) => entry.name === branch.name);

    expect(readyBranch).toMatchObject({ testsRequired: false, mergeBlockedReason: null });
  });

  it('reports failing test merge blockers when the last run failed', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/merge-block.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name, { forceFail: true });

    const overview = await branchWorkflow.getBranchOverview(projectId);
    const failingBranch = overview.workingBranches.find((entry) => entry.name === staged.branch.name);

    expect(failingBranch.mergeBlockedReason).toBe('Resolve failing tests before merging');
    expect(failingBranch.testsRequired).toBe(true);
  });

  it('prompts to run tests before merge when no test run exists', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/no-tests-yet.js',
      autoRun: false
    });

    const overview = await branchWorkflow.getBranchOverview(projectId);
    const branch = overview.workingBranches.find((entry) => entry.name === staged.branch.name);

    expect(branch.testsRequired).toBe(true);
    expect(branch.lastTestStatus).toBeNull();
    expect(branch.mergeBlockedReason).toBe('Run tests before merging');
  });

  it('deleteBranchByName forbids main and restores main as current branch', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-prune'
    });

    await expect(branchWorkflow.deleteBranchByName(projectId, 'main')).rejects.toThrow(/cannot delete/i);

    const result = await branchWorkflow.deleteBranchByName(projectId, branch.name);
    expect(result).toEqual({ deletedBranch: branch.name });

    const removedRow = await getBranchRow(projectId, branch.name);
    expect(removedRow).toBeNull();
    const mainRow = await getBranchRow(projectId, 'main');
    expect(mainRow?.is_current).toBe(1);
  });

  it('reassigns main as the current branch when no branches remain active after deletion', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-no-current'
    });

    await exec('UPDATE branches SET is_current = 0 WHERE project_id = ?', [projectId]);

    await branchWorkflow.deleteBranchByName(projectId, branch.name);

    const mainRow = await getBranchRow(projectId, 'main');
    expect(mainRow?.is_current).toBe(1);
  });

  it('leaves current branch assignments untouched when another branch remains current', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-retain-current'
    });

    await branchWorkflow.checkoutBranch(projectId, 'main');

    await branchWorkflow.deleteBranchByName(projectId, branch.name);

    const mainRow = await getBranchRow(projectId, 'main');
    expect(mainRow?.is_current).toBe(1);
  });

  it('removes git branch artifacts when deleting a branch in git-ready projects', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-prune-git'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-delete');

    const currentSpy = vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });
    const removeSpy = vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();

    await branchWorkflow.deleteBranchByName(projectId, branch.name);

    expect(currentSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith('C:/tmp/git-delete', branch.name);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('ignores missing git branches when deletion reports not found', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-missing-git'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-delete-missing');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    const runSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        return Promise.reject(new Error('branch not found'));
      }
      return Promise.resolve({ stdout: '' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await branchWorkflow.deleteBranchByName(projectId, branch.name);

    expect(result).toEqual({ deletedBranch: branch.name });
    expect(runSpy).toHaveBeenCalled();
    const gitWarnings = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((message) => /Failed to delete git branch/.test(message));
    expect(gitWarnings).toHaveLength(0);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues deleting branches when current git branch lookup fails', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-delete-lookup'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-delete-lookup');

    vi.spyOn(git, 'getCurrentBranch').mockRejectedValue(new Error('status broke'));
    const runSpy = vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();

    const result = await branchWorkflow.deleteBranchByName(projectId, branch.name);

    expect(result).toEqual({ deletedBranch: branch.name });
    expect(runSpy).toHaveBeenCalledWith('C:/tmp/git-delete-lookup', ['branch', '-D', branch.name], undefined);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('logs git errors when branch deletion fails for other reasons', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-bad-delete'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-delete-error');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue(branch.name);
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    const runSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        return Promise.reject(new Error('permission denied'));
      }
      return Promise.resolve({ stdout: '' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await branchWorkflow.deleteBranchByName(projectId, branch.name);

    expect(result).toEqual({ deletedBranch: branch.name });
    expect(runSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to delete git branch feature-bad-delete/i)
    );

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('logs git deletion failures even when the error lacks a message', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-empty-error'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-empty-error');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue(branch.name);
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        const error = new Error('');
        error.message = '';
        return Promise.reject(error);
      }
      return Promise.resolve({ stdout: '' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await branchWorkflow.deleteBranchByName(projectId, branch.name);

    expect(result).toEqual({ deletedBranch: branch.name });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to delete git branch feature-empty-error: $/)
    );

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('requires a branch name when committing changes', async () => {
    await expect(branchWorkflow.commitBranchChanges(projectId)).rejects.toThrow(/Branch name is required/i);
  });

  it('requires staged changes before committing', async () => {
    const branch = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-empty'
    });

    await expect(branchWorkflow.commitBranchChanges(projectId, branch.name)).rejects.toThrow(/No staged changes/i);
  });

  it('prevents committing directly to the main branch', async () => {
    await expect(branchWorkflow.commitBranchChanges(projectId, 'main')).rejects.toMatchObject({
      message: expect.stringMatching(/Cannot commit directly to the main branch/i),
      statusCode: 400
    });
  });

  it('throws when clearing staged changes without a working branch', async () => {
    await expect(branchWorkflow.clearStagedChanges(projectId)).rejects.toThrow(/No working branch to clear/i);
  });

  it('commits staged files with explicit messages and clears staging state', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/branchTab/App.jsx',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const commitResult = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: wire up branch tab'
    });

    expect(commitResult.commit).toMatchObject({
      branch: staged.branch.name,
      message: 'feat: wire up branch tab'
    });
    expect(commitResult.branch.stagedFiles).toHaveLength(0);

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    expect(branchRow.ahead_commits).toBeGreaterThan(0);
  });

  it('uses fallback ahead commit counts when branches drift negative', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/ahead-reset.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET ahead_commits = ? WHERE id = ?', [-5, branchRow.id]);

    const commitResult = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: normalize ahead'
    });

    expect(commitResult.branch.ahead).toBeGreaterThan(0);
  });

  it('recomputes ahead commit counts when stored values are nullish', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/ahead-null.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET ahead_commits = 0 WHERE id = ?', [branchRow.id]);

    const commitResult = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: revive ahead tracking'
    });

    expect(commitResult.branch.ahead).toBeGreaterThan(0);
  });

  it('generates default commit messages when none supplied', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/utils/git.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const commitResult = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name);

    expect(commitResult.commit.message).toMatch(/^chore\(/i);
    expect(commitResult.branch.stagedFiles).toHaveLength(0);
  });

  it('wraps git commit errors with status codes when git is ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/branchTab/App.jsx',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-ready');

    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    const commitError = new Error('commit exploded');
    vi.spyOn(git, 'commitAllChanges').mockRejectedValue(commitError);

    await expect(branchWorkflow.commitBranchChanges(projectId, staged.branch.name)).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to commit changes/i),
      statusCode: 500
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('includes commit sha + shortSha when git is ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/branchTab/App.jsx',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const gitPath = 'C:/tmp/git-ready-sha';
    branchWorkflow.__testing.setGitContextOverride(projectId, gitPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation(async (projectPath, args = []) => {
      if (projectPath === gitPath && Array.isArray(args) && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'abc123def456\n' };
      }
      return { stdout: '' };
    });
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue(true);

    const result = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: include sha'
    });

    expect(result.commit).toMatchObject({
      sha: 'abc123def456',
      shortSha: 'abc123d',
      message: 'feat: include sha'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('normalizes missing sha output to null when git returns non-string stdout', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/branchTab/missing-sha.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    const gitPath = 'C:/tmp/git-ready-missing-sha';
    branchWorkflow.__testing.setGitContextOverride(projectId, gitPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation(async (projectPath, args = []) => {
      if (projectPath === gitPath && Array.isArray(args) && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: undefined };
      }
      return { stdout: '' };
    });
    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue(true);

    const result = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: missing sha'
    });

    expect(result.commit).toMatchObject({
      sha: null,
      shortSha: null,
      message: 'feat: missing sha'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('describes staged files via commit context even without git', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/context/AppStateContext.jsx',
      autoRun: false
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.branch).toBe(staged.branch.name);
    expect(context.totalFiles).toBe(1);
    expect(context.files[0]).toMatchObject({ path: 'src/context/AppStateContext.jsx' });
    expect(context.isGitAvailable).toBe(false);
  });

  it('builds commit context via the non-git path when test mode forces offline behavior', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/context/offline.js',
      autoRun: false
    });

    branchWorkflow.__testing.setTestModeOverride(true);
    try {
      const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);
      expect(context.isGitAvailable).toBe(false);
      expect(context.files[0].diff).toBe('');
    } finally {
      branchWorkflow.__testing.setTestModeOverride(null);
    }
  });

  it('returns base commit context when an active branch has no staged files', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, {
      name: 'feature-empty-context'
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId);

    expect(context.branch).toBe(working.name);
    expect(context.totalFiles).toBe(0);
    expect(context.summaryText).toBe('');
  });

  it('treats literal null staged file payloads as empty collections', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/state/nullish.js',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET staged_files = ? WHERE id = ?', ['null', branchRow.id]);

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);
    expect(context.totalFiles).toBe(0);
    expect(context.files).toHaveLength(0);
  });

  it('throws when requesting commit context without a working branch', async () => {
    const working = await branchWorkflow.createWorkingBranch(projectId, { name: 'feature-gone' });
    await branchWorkflow.deleteBranchByName(projectId, working.name);

    await expect(branchWorkflow.getBranchCommitContext(projectId)).rejects.toThrow(/Working branch not found/i);
  });

  it('handles git staging failures gracefully', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-stage');

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'add') {
        return Promise.reject(new Error('git add exploded'));
      }
      return Promise.resolve({ stdout: '' });
    });

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/problem.js',
      autoRun: false
    });

    expect(staged.stagedFiles).toHaveLength(1);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('collects git diff details for staged files when git is ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/details.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-diff');

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '3\t1\tsrc/git/details.js' });
      }
      if (args.includes('--unified=5')) {
        return Promise.resolve({ stdout: 'diff --git a/src/git/details.js b/src/git/details.js\n@@' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.isGitAvailable).toBe(true);
    expect(context.files[0]).toMatchObject({
      additions: 3,
      deletions: 1
    });
    expect(context.files[0].diff).toContain('diff --git');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('fills default metadata when git-ready staged entries omit source or timestamp', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/defaults-git.js',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET staged_files = ? WHERE id = ?', [
      JSON.stringify([{ path: 'src/git/defaults-git.js' }]),
      branchRow.id
    ]);

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-defaults');

    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.files[0]).toMatchObject({
      source: 'editor',
      timestamp: null,
      diff: ''
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('skips git diff collection when staged entries do not include a file path', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/pathless.js',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET staged_files = ? WHERE id = ?', [JSON.stringify([{ source: 'ai' }]), branchRow.id]);

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-pathless');

    const runSpy = vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(runSpy).not.toHaveBeenCalled();
    expect(context.files[0].path).toBeUndefined();
    expect(context.files[0].diff).toBe('');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('falls back gracefully when git diff commands fail', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/failure.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-diff-failure');

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('--numstat')) {
        return Promise.reject(new Error('numstat failed'));
      }
      if (args.includes('--unified=5')) {
        return Promise.reject(new Error('diff missing'));
      }
      return Promise.resolve({ stdout: '' });
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.files[0].additions).toBeNull();
    expect(context.files[0].diff).toBe('');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('fills default metadata when git is unavailable and staged entries omit fields', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/defaults-non-git.js',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET staged_files = ? WHERE id = ?', [
      JSON.stringify([{ path: 'src/git/defaults-non-git.js' }]),
      branchRow.id
    ]);

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.files[0]).toMatchObject({
      source: 'editor',
      timestamp: null,
      diff: ''
    });
  });

  it('ignores malformed git numstat rows while building commit context', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/malformed.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-numstat-bad');

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: 'bad-row-without-tabs' });
      }
      if (args.includes('--unified=5')) {
        return Promise.resolve({ stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.files[0].additions).toBeNull();
    expect(context.files[0].deletions).toBeNull();
    expect(context.files[0].diff).toBe('');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('truncates oversized git diffs to keep payloads bounded', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/huge.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-diff-huge');

    const longDiff = `${'diff --git a/src/git/huge.js b/src/git/huge.js\n@@\n'}${'x'.repeat(2500)}`;

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '10\t2\tsrc/git/huge.js' });
      }
      if (args.includes('--unified=5')) {
        return Promise.resolve({ stdout: longDiff });
      }
      return Promise.resolve({ stdout: '' });
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.files[0].truncated).toBe(true);
    expect(context.files[0].diff).toContain('…diff truncated…');
    expect(context.files[0].diff.length).toBeLessThan(2050);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('truncates aggregate diffs when combined output exceeds limits', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/git/aggregate.js',
      autoRun: false
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-aggregate');

    const hugeDiff = `diff --git a/src/git/aggregate.js b/src/git/aggregate.js\n@@\n${'x'.repeat(13000)}`;

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '5\t1\tsrc/git/aggregate.js' });
      }
      if (args.includes('--unified=5')) {
        return Promise.resolve({ stdout: hugeDiff });
      }
      return Promise.resolve({ stdout: '' });
    });

    const context = await branchWorkflow.getBranchCommitContext(projectId, staged.branch.name);

    expect(context.aggregateDiff).toContain('…diff truncated…');
    expect(context.truncated).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('summarizes staged file stats into readable text', () => {
    const emptySummary = branchWorkflow.__testing.coerceReasonableSummary();
    expect(emptySummary).toBe('');

    const summary = branchWorkflow.__testing.coerceReasonableSummary([
      { path: 'src/git/details.js', additions: 5, deletions: 3 },
      { path: 'src/git/empty.js' }
    ]);

    expect(summary).toContain('1. src/git/details.js (+5 / -3)');
    expect(summary).toContain('2. src/git/empty.js');
  });

  it('labels missing summary paths as unknown files', () => {
    const summary = branchWorkflow.__testing.coerceReasonableSummary([
      { additions: 2, deletions: 1 }
    ]);

    expect(summary).toContain('unknown file');
  });

  it('parses git numstat placeholders as null change counts', () => {
    const parsed = branchWorkflow.__testing.parseNumstatLine('-\t-\tsrc/assets.bin');

    expect(parsed).toEqual({
      additions: null,
      deletions: null,
      path: 'src/assets.bin'
    });
  });

  it('requires a commitSha when git access is available for commit details', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-history-main');

    await expect(branchWorkflow.getCommitDetails(projectId)).rejects.toThrow(/commitSha is required/i);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('returns commit metadata when git details can be loaded', async () => {
    const projectPath = 'C:/tmp/git-commit-details';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const gitSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show') {
        return Promise.resolve({
          stdout: 'abc123\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fInitial commit\x1fparent1 parent2\x1fFull body'
        });
      }
      if (args[0] === 'diff-tree') {
        return Promise.resolve({ stdout: 'A\tREADME.md\nM\tsrc/app.js' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const details = await branchWorkflow.getCommitDetails(projectId, 'abc123');

    expect(details).toMatchObject({
      sha: 'abc123',
      shortSha: 'abc123'.slice(0, 7),
      author: {
        name: 'Alice',
        email: 'alice@example.com'
      },
      parentShas: ['parent1', 'parent2'],
      files: [
        { path: 'README.md', status: 'A' },
        { path: 'src/app.js', status: 'M' }
      ]
    });

    gitSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('falls back to default commit metadata when git output omits fields', async () => {
    const projectPath = 'C:/tmp/git-commit-fallback';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const nativeTrim = String.prototype.trim;
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function mockTrim() {
      if (typeof this === 'string' && this.startsWith('PRESERVE:')) {
        return this.replace('PRESERVE:', '');
      }
      return nativeTrim.call(this);
    });

    const gitSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show') {
        return Promise.resolve({ stdout: '' });
      }
      if (args[0] === 'diff-tree') {
        return Promise.resolve({ stdout: 'PRESERVE:\tREADME.md' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const details = await branchWorkflow.getCommitDetails(projectId, 'deadbeef');

    expect(details).toMatchObject({
      sha: '',
      shortSha: '',
      message: '',
      body: '',
      author: {
        name: 'Unknown',
        email: ''
      },
      parentShas: [],
      canRevert: false,
      isInitialCommit: true,
      files: [
        { path: 'README.md', status: 'M' }
      ]
    });

    gitSpy.mockRestore();
    trimSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('parses git history entries with missing fields using default values', async () => {
    const projectPath = 'C:/tmp/git-history-fallback';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const gitSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'log') {
        return Promise.resolve({ stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const history = await branchWorkflow.getCommitHistory(projectId, { limit: -5 });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sha: '',
      shortSha: '',
      message: '',
      author: { name: 'Unknown', email: '' },
      authoredAt: null
    });

    gitSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('labels commit diffs as Empty when the commit has no parent', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-initial';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show' && args.includes('--pretty=format:%P')) {
        return Promise.resolve({ stdout: '' });
      }

      if (args[0] === 'show' && typeof args[1] === 'string' && args[1].includes(':src/App.jsx')) {
        return Promise.resolve({ stdout: 'new file contents' });
      }

      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', 'src/App.jsx');

    expect(result).toMatchObject({
      path: 'src/App.jsx',
      original: '',
      modified: 'new file contents',
      originalLabel: 'Empty',
      modifiedLabel: 'abcdef1'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('requires commitSha when loading commit file diffs', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-requires-sha';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await expect(branchWorkflow.getCommitFileDiffContent(projectId, '   ', 'src/App.jsx')).rejects.toMatchObject({
      message: expect.stringMatching(/commitSha is required/i),
      statusCode: 400
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('requires filePath when loading commit file diffs', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-requires-path';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await expect(branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', '   ')).rejects.toMatchObject({
      message: expect.stringMatching(/filePath is required/i),
      statusCode: 400
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('coerces non-string git show output to a string for diffs', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-coerce';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show' && args.includes('--pretty=format:%P')) {
        return Promise.resolve({ stdout: '' });
      }

      if (args[0] === 'show' && typeof args[1] === 'string' && args[1].includes(':src/number.txt')) {
        return Promise.resolve({ stdout: 123 });
      }

      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', 'src/number.txt');
    expect(result.modified).toBe('123');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('returns empty diff content when git show fails', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-safe-show-failure';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show' && args.includes('--pretty=format:%P')) {
        return Promise.resolve({ stdout: '' });
      }

      if (args[0] === 'show' && typeof args[1] === 'string' && args[1].includes(':src/broken.txt')) {
        throw new Error('git show failed');
      }

      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', 'src/broken.txt');
    expect(result.modified).toBe('');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('rejects commit file diff requests when git is not ready', async () => {
    branchWorkflow.__testing.setGitContextOverride(projectId);

    await expect(branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', 'src/App.jsx')).rejects.toMatchObject({
      message: expect.stringMatching(/Git repository unavailable/i),
      statusCode: 400
    });
  });

  it('falls back to Empty when parent sha lookup fails', async () => {
    const projectPath = 'C:/tmp/git-commit-diff-parent-failure';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'show' && args.includes('--pretty=format:%P')) {
        throw new Error('parent lookup failed');
      }

      if (args[0] === 'show' && typeof args[1] === 'string' && args[1].includes(':src/App.jsx')) {
        return Promise.resolve({ stdout: 'file contents' });
      }

      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.getCommitFileDiffContent(projectId, 'abcdef1', 'src/App.jsx');
    expect(result).toMatchObject({ originalLabel: 'Empty', modified: 'file contents' });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('auto-marks css-only branches ready-for-merge in branch overview when git diff is css-only', async () => {
    const projectPath = 'C:/tmp/git-css-only-overview-ready';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/overview-only.css',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ?, staged_files = ? WHERE id = ?', ['active', '[]', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only' && typeof args[2] === 'string') {
        return Promise.resolve({ stdout: 'src/styles/overview-only.css\n' });
      }

      return Promise.resolve({ stdout: '' });
    });

    const overview = await branchWorkflow.getBranchOverview(projectId);
    const working = overview.workingBranches.find((branch) => branch.name === staged.branch.name);
    expect(working).toMatchObject({
      status: 'ready-for-merge',
      testsRequired: false,
      mergeBlockedReason: null
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('auto-marks css-only commits ready-for-merge when git diff is css-only', async () => {
    const projectPath = 'C:/tmp/git-css-only-commit-ready';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/only.css',
      autoRun: false
    });

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/styles/only.css\n' });
      }
      return Promise.resolve({ stdout: '' });
    });
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    const result = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'chore: css-only'
    });

    expect(result.branch.status).toBe('ready-for-merge');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('does not auto-mark css-only commits ready when css-only diff check fails', async () => {
    const projectPath = 'C:/tmp/git-css-only-commit-fail';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/fails.css',
      autoRun: false
    });

    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ? WHERE id = ?', ['active', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        throw new Error('diff failed');
      }
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'chore: css-only'
    });

    expect(result.branch.status).toBe('active');

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('allows css-only merges when no test run exists', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/merge.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-css-only-merge';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await branchWorkflow.clearStagedChanges(projectId, staged.branch.name);
    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ?, staged_files = ? WHERE id = ?', ['ready-for-merge', '[]', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/styles/merge.css\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('allows css-only merges even when the latest test run did not pass', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/merge-with-failing-run.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-css-only-merge-with-failing-run';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    // Force a failing run by presenting a non-CSS diff before the branch becomes CSS-only.
    const failingDiffSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/App.jsx\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const failingRun = await branchWorkflow.runTestsForBranch(projectId, staged.branch.name, { forceFail: true });
    expect(failingRun.status).toBe('failed');

    failingDiffSpy.mockRestore();

    await branchWorkflow.clearStagedChanges(projectId, staged.branch.name);
    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ?, staged_files = ? WHERE id = ?', ['ready-for-merge', '[]', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/styles/merge-with-failing-run.css\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('rejects css-only merge fallback when the diff is not css-only', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/not-css-only.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-non-css-only-merge';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await branchWorkflow.clearStagedChanges(projectId, staged.branch.name);
    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ?, staged_files = ? WHERE id = ?', ['ready-for-merge', '[]', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return Promise.resolve({ stdout: 'src/App.jsx\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    await expect(branchWorkflow.mergeBranch(projectId, staged.branch.name)).rejects.toMatchObject({
      message: expect.stringMatching(/Latest test run must pass/i),
      statusCode: 400
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('falls back to rejecting merge when css-only diff check fails', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/styles/css-only-check-error.css',
      autoRun: false
    });

    const projectPath = 'C:/tmp/git-css-only-merge-error';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    await branchWorkflow.clearStagedChanges(projectId, staged.branch.name);
    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ?, staged_files = ? WHERE id = ?', ['ready-for-merge', '[]', branchRow.id]);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        throw new Error('git diff failed');
      }
      return Promise.resolve({ stdout: '' });
    });

    await expect(branchWorkflow.mergeBranch(projectId, staged.branch.name)).rejects.toMatchObject({
      message: expect.stringMatching(/Latest test run must pass/i),
      statusCode: 400
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('merges a branch only after tests pass and staged files are clean', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/index.js',
      autoRun: false
    });

    await exec(
      `INSERT INTO agent_goals (project_id, prompt, status, lifecycle_state, branch_name, metadata)
       VALUES (?, ?, ?, ?, ?, ?)` ,
      [projectId, 'Merge should complete the goal', 'verifying', 'verifying', staged.branch.name, 'null']
    );

    const testRun = await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    expect(testRun.status).toBe('passed');

    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: bootstrap server'
    });

    const mergeResult = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(mergeResult).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    const mergedGoal = await getGoalRow(projectId, staged.branch.name);
    expect(mergedGoal).toMatchObject({
      status: 'ready',
      lifecycle_state: 'merged'
    });

    const overview = await branchWorkflow.getBranchOverview(projectId);
    expect(overview.workingBranches.find((branch) => branch.name === staged.branch.name)).toBeUndefined();
  });

  it('pushes main to origin when cloud workflow is configured', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/auto-push.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: auto push'
    });

    await saveProjectGitSettings(projectId, {
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/example/auto-push.git',
      defaultBranch: 'main'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-auto-push');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    const runSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    const pushCall = runSpy.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === 'push');
    expect(pushCall).toBeTruthy();
    expect(pushCall[1]).toEqual(['push', 'origin', 'main']);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues merging when auto push fails', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/auto-push-fail.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: auto push fail'
    });

    await saveProjectGitSettings(projectId, {
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/example/auto-push.git',
      defaultBranch: 'main'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-auto-push-fail');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'push') {
        throw new Error('push failed');
      }
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('skips auto push when remoteUrl is blank', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/auto-push-empty-remote.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: auto push empty remote'
    });

    await saveProjectGitSettings(projectId, {
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: '',
      defaultBranch: 'main'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-auto-push-empty');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    const runSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    const pushCall = runSpy.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === 'push');
    expect(pushCall).toBeUndefined();

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues merging when git settings lookup fails', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/auto-push-settings-fail.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: auto push settings fail'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-auto-push-settings-fail');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    const settingsSpy = vi.spyOn(databaseModule, 'getGitSettings')
      .mockRejectedValueOnce(new Error('settings failed'));
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    settingsSpy.mockRestore();
    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('skips auto push when workflow is local', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/server/auto-push-local.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: auto push local'
    });

    await saveProjectGitSettings(projectId, {
      workflow: 'local',
      provider: 'github',
      remoteUrl: 'https://github.com/example/auto-push.git',
      defaultBranch: 'main'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-auto-push-local');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();

    const runSpy = vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      return Promise.resolve({ stdout: '' });
    });

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    const pushCall = runSpy.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === 'push');
    expect(pushCall).toBeUndefined();

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('rejects merge attempts when latest tests fail', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/routes/branches.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: pending merge'
    });

    const failingRun = await branchWorkflow.runTestsForBranch(projectId, staged.branch.name, { forceFail: true });
    expect(failingRun.status).toBe('failed');

    await expect(branchWorkflow.mergeBranch(projectId, staged.branch.name)).rejects.toThrow(/pass tests/i);
  });

  it('requires the latest test run to pass even if the branch is marked ready', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/routes/tests.js',
      autoRun: false
    });

    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);
    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: pretend ready'
    });

    await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/routes/tests-fail.js',
      autoRun: false,
      branch: staged.branch.name
    });
    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name, { forceFail: true });
    await branchWorkflow.clearStagedChanges(projectId, staged.branch.name);
    const branchRow = await getBranchRow(projectId, staged.branch.name);
    await exec('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);

    await expect(branchWorkflow.mergeBranch(projectId, staged.branch.name)).rejects.toThrow(/Latest test run must pass/i);
  });

  it('rejects merge attempts targeting the main branch', async () => {
    await expect(branchWorkflow.mergeBranch(projectId, 'main')).rejects.toMatchObject({
      message: expect.stringMatching(/Main branch cannot be merged/i),
      statusCode: 400
    });
  });

  it('syncs staged git tokens when git is ready', async () => {
    const projectPath = 'C:/tmp/git-staged-token-sync';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
        return Promise.resolve({
          stdout: 'src/deleted.txt\nsrc/empty.txt\nsrc/badline.txt\nsrc/good.txt\n'
        });
      }

      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-status') {
        return Promise.resolve({
          stdout: 'D\tsrc/deleted.txt\nM\nM\tsrc/empty.txt\nM\tsrc/badline.txt\nM\tsrc/good.txt\n'
        });
      }

      if (args[0] === 'ls-files' && args.includes('--stage')) {
        const filePath = args[args.length - 1] || '';
        if (filePath === 'src/empty.txt') {
          return Promise.resolve({ stdout: '' });
        }
        if (filePath === 'src/badline.txt') {
          return Promise.resolve({ stdout: '100644\n' });
        }
        if (filePath === 'src/good.txt') {
          return Promise.resolve({ stdout: '100644 abcd123 0\tsrc/good.txt\n' });
        }
        return Promise.resolve({ stdout: '' });
      }

      return Promise.resolve({ stdout: '' });
    });

    await branchWorkflow.getBranchOverview(projectId);

    const mainRow = await getBranchRow(projectId, 'main');
    const stagedFiles = Array.isArray(mainRow?.staged_files)
      ? mainRow.staged_files
      : JSON.parse(mainRow?.staged_files || '[]');

    expect(stagedFiles.some((entry) => entry.path === 'src/deleted.txt' && entry.gitToken === 'D')).toBe(true);
    expect(stagedFiles.some((entry) => entry.path === 'src/good.txt' && entry.gitToken === 'abcd123')).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('tracks rename/copy statuses when syncing staged files', async () => {
    const projectPath = 'C:/tmp/git-staged-token-rename';
    await exec('UPDATE projects SET path = ? WHERE id = ?', [projectPath, projectId]);
    branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
        return Promise.resolve({ stdout: 'src/new-name.txt\n' });
      }

      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-status') {
        return Promise.resolve({ stdout: 'R100\tsrc/old-name.txt\tsrc/new-name.txt\n' });
      }

      if (args[0] === 'ls-files' && args.includes('--stage')) {
        return Promise.resolve({ stdout: '100644 deadbeef 0\tsrc/new-name.txt\n' });
      }

      return Promise.resolve({ stdout: '' });
    });

    await branchWorkflow.getBranchOverview(projectId);

    const mainRow = await getBranchRow(projectId, 'main');
    const stagedFiles = JSON.parse(mainRow?.staged_files || '[]');
    expect(stagedFiles.some((entry) => entry.path === 'src/new-name.txt' && entry.gitToken === 'deadbeef')).toBe(true);

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('continues merging when the autosave commit fails in git', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/routes/continue.js',
      autoRun: false
    });
    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: ready to merge'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-autosave');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });
    vi.spyOn(git, 'commitAllChanges').mockRejectedValue(new Error('autosave failed'));

    const result = await branchWorkflow.mergeBranch(projectId, staged.branch.name);
    expect(result).toEqual({ mergedBranch: staged.branch.name, current: 'main' });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });

  it('surfaces git merge failures with helpful errors', async () => {
    const staged = await branchWorkflow.stageWorkspaceChange(projectId, {
      filePath: 'src/routes/api.js',
      autoRun: false
    });
    await branchWorkflow.runTestsForBranch(projectId, staged.branch.name);

    await branchWorkflow.commitBranchChanges(projectId, staged.branch.name, {
      message: 'feat: prep merge'
    });

    branchWorkflow.__testing.setGitContextOverride(projectId, 'C:/tmp/git-merge');

    vi.spyOn(git, 'getCurrentBranch').mockResolvedValue('main');
    vi.spyOn(git, 'stashWorkingTree').mockResolvedValue();
    vi.spyOn(git, 'popBranchStash').mockResolvedValue();
    vi.spyOn(git, 'commitAllChanges').mockResolvedValue();
    vi.spyOn(git, 'removeBranchStashes').mockResolvedValue();
    vi.spyOn(git, 'runGitCommand').mockImplementation((_, args = []) => {
      if (args.includes('merge')) {
        const error = new Error('merge failed');
        error.message = 'merge failed';
        throw error;
      }
      return Promise.resolve({ stdout: '' });
    });

    await expect(branchWorkflow.mergeBranch(projectId, staged.branch.name)).rejects.toMatchObject({
      message: expect.stringMatching(/Git merge failed/i),
      statusCode: 500
    });

    branchWorkflow.__testing.setGitContextOverride(projectId);
  });
});

describe('commit history helpers', () => {
  it('includes --root when building commit diff args', () => {
    const args = branchWorkflow.__testing.buildCommitFilesArgs('abc123');
    expect(args).toEqual([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      'abc123'
    ]);
  });

  it('ignores falsy ids when overriding git context for tests', () => {
    expect(() => branchWorkflow.__testing.setGitContextOverride(null, 'any')).not.toThrow();
  });
});

describe('internal helper coverage', () => {
  const helperProjectBase = {
    description: 'Helper project',
    language: 'javascript',
    framework: 'react'
  };

  it('propagates database run errors through the helper wrapper', async () => {
    const failure = new Error('run failure');
    const runSpy = vi.spyOn(db, 'run').mockImplementation((sql, params, callback) => {
      callback.call({ lastID: 0, changes: 0 }, failure);
      return db;
    });

    await expect(branchWorkflow.__testing.runSql('UPDATE broken SET value = 1')).rejects.toBe(failure);

    runSpy.mockRestore();
  });

  it('propagates database get errors through the helper wrapper', async () => {
    const failure = new Error('get failure');
    const getSpy = vi.spyOn(db, 'get').mockImplementation((sql, params, callback) => {
      callback(failure);
      return db;
    });

    await expect(branchWorkflow.__testing.getSql('SELECT * FROM broken WHERE id = 1')).rejects.toBe(failure);

    getSpy.mockRestore();
  });

  it('propagates database all errors through the helper wrapper', async () => {
    const failure = new Error('all failure');
    const allSpy = vi.spyOn(db, 'all').mockImplementation((sql, params, callback) => {
      callback(failure);
      return db;
    });

    await expect(branchWorkflow.__testing.allSql('SELECT * FROM broken')).rejects.toBe(failure);

    allSpy.mockRestore();
  });

  it('coerces falsy row collections into empty arrays when using allSql', async () => {
    const allSpy = vi.spyOn(db, 'all').mockImplementation((sql, params, callback) => {
      callback(null, null);
      return db;
    });

    const rows = await branchWorkflow.__testing.allSql('SELECT 1');

    expect(rows).toEqual([]);

    allSpy.mockRestore();
  });

  it('returns fallback values when parsing invalid JSON columns', () => {
    const fallback = [{ path: 'fallback' }];
    const parsed = branchWorkflow.__testing.parseJsonColumn('not-json', fallback);
    expect(parsed).toBe(fallback);
  });

  it('treats non-git-ready contexts as non css-only diffs', async () => {
    const result = await branchWorkflow.__testing.isCssOnlyBranchDiff({ gitReady: false }, 'feature/x');
    expect(result).toBe(false);
  });

  it('returns false when branch diff has no changed paths', async () => {
    const runGitSpy = vi.spyOn(git, 'runGitCommand').mockResolvedValue({ stdout: '' });

    const result = await branchWorkflow.__testing.isCssOnlyBranchDiff(
      { gitReady: true, projectPath: 'C:/tmp/css-only-empty' },
      'feature/empty'
    );

    expect(result).toBe(false);
    expect(runGitSpy).toHaveBeenCalled();

    runGitSpy.mockRestore();
  });

  it('throws when ensuring a project that does not exist', async () => {
    await expect(branchWorkflow.__testing.ensureProjectExists(-999)).rejects.toMatchObject({
      message: expect.stringMatching(/Project not found/i),
      statusCode: 404
    });
  });

  it('prefers project git settings over global defaults when available', async () => {
    const project = await createProject({
      ...helperProjectBase,
      name: `Helper Project ${Date.now()}`
    });

    await saveProjectGitSettings(project.id, {
      defaultBranch: 'develop',
      useCommitTemplate: true,
      commitTemplate: 'feat {summary}'
    });

    try {
      const resolved = await branchWorkflow.__testing.resolveProjectGitSettings(project.id);
      expect(resolved.defaultBranch).toBe('develop');
      expect(resolved.useCommitTemplate).toBe(true);
      expect(resolved.commitTemplate).toBe('feat {summary}');
    } finally {
      await cleanupProjectRecords(project.id);
    }
  });

  it('falls back to global git settings when project lookup fails', async () => {
    const project = await createProject({
      ...helperProjectBase,
      name: `Helper Failure ${Date.now()}`
    });

    const globalSettings = {
      workflow: 'local',
      provider: 'github',
      remoteUrl: 'git@example.com/fallback.git',
      username: 'fallback',
      defaultBranch: 'fallback',
      autoPush: false,
      useCommitTemplate: false,
      commitTemplate: ''
    };

    const projectSpy = vi.spyOn(databaseModule, 'getProjectGitSettings').mockRejectedValueOnce(new Error('unreachable'));
    const globalSpy = vi.spyOn(databaseModule, 'getGitSettings').mockResolvedValueOnce(globalSettings);

    try {
      const resolved = await branchWorkflow.__testing.resolveProjectGitSettings(project.id);
      expect(projectSpy).toHaveBeenCalled();
      expect(globalSpy).toHaveBeenCalled();
      expect(resolved).toBe(globalSettings);
    } finally {
      projectSpy.mockRestore();
      globalSpy.mockRestore();
      await cleanupProjectRecords(project.id);
    }
  });

  it('falls back to global git settings when project overrides are missing', async () => {
    const project = await createProject({
      ...helperProjectBase,
      name: `Helper Global ${Date.now()}`
    });

    await saveGitSettings({
      workflow: 'local',
      provider: 'github',
      remoteUrl: 'git@example.com/global.git',
      username: 'tester',
      defaultBranch: 'release',
      autoPush: true,
      useCommitTemplate: true,
      commitTemplate: 'release {summary}'
    });

    try {
      const resolved = await branchWorkflow.__testing.resolveProjectGitSettings(project.id);
      expect(resolved.defaultBranch).toBe('release');
      expect(resolved.useCommitTemplate).toBe(true);
      expect(resolved.commitTemplate).toBe('release {summary}');
    } finally {
      await cleanupProjectRecords(project.id);
      await saveGitSettings({
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        username: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      });
    }
  });

  it('summarizes staged changes for zero, single, and multiple files', () => {
    expect(branchWorkflow.__testing.summarizeStagedChanges()).toBe('staged changes');
    expect(branchWorkflow.__testing.summarizeStagedChanges([{ path: 'src/index.js' }])).toBe('src/index.js');
    expect(
      branchWorkflow.__testing.summarizeStagedChanges([
        { path: 'src/App.jsx' },
        { path: 'src/utils/helpers.js' }
      ])
    ).toBe('2 files');
    expect(branchWorkflow.__testing.summarizeStagedChanges([{ path: '' }])).toBe('staged changes');
  });

  it('trims diffs and handles empty values', () => {
    expect(branchWorkflow.__testing.trimDiff('', 5)).toBe('');
    expect(branchWorkflow.__testing.trimDiff('short', 10)).toBe('short');
    const trimmed = branchWorkflow.__testing.trimDiff('x'.repeat(15), 5);
    expect(trimmed).toContain('…diff truncated…');
    expect(trimmed.startsWith('xxxxx')).toBe(true);
  });

  it('interpolates commit templates with supported tokens', () => {
    const result = branchWorkflow.__testing.interpolateCommitTemplate(
      'feat {Summary} -> {branch} / {branchName} / {fileCount} / {unknown}',
      {
        summary: 'Add login',
        branch: 'feature/login-ui',
        fileCount: '3'
      }
    );
    expect(result).toBe('feat Add login -> feature/login-ui / feature/login-ui / 3 / {unknown}');
  });

  it('treats missing template values as empty strings', () => {
    const combined = branchWorkflow.__testing.interpolateCommitTemplate('{summary}{branch}{branchname}{filecount}');
    expect(combined).toBe('');

    const fallback = branchWorkflow.__testing.interpolateCommitTemplate(null, { summary: 'ignored' });
    expect(fallback).toBe('');
  });

  it('builds commit messages using configured templates when enabled', () => {
    const message = branchWorkflow.__testing.buildCommitMessage({
      gitSettings: {
        useCommitTemplate: true,
        commitTemplate: 'feat {summary} ({branch})'
      },
      branchName: 'feature/template',
      stagedFiles: [{ path: 'src/app.js' }]
    });

    expect(message).toBe('feat src/app.js (feature/template)');
  });

  it('falls back to summary text when a commit template renders an empty string', () => {
    const message = branchWorkflow.__testing.buildCommitMessage({
      gitSettings: {
        useCommitTemplate: true,
        commitTemplate: '{branch}'
      },
      branchName: '',
      stagedFiles: undefined
    });

    expect(message).toBe('staged changes');
  });

  it('defaults commit messages to the workspace branch label when none is provided', () => {
    const message = branchWorkflow.__testing.buildCommitMessage({
      stagedFiles: [{ path: 'src/app.js' }]
    });

    expect(message).toBe('chore(workspace): update src/app.js');
  });
});
