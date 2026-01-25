import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const createGitSpies = (gitModule, overrides = {}) => {
  const spy = (method, fallback) => {
    const impl = overrides[method] || fallback;
    return vi.spyOn(gitModule, method).mockImplementation(impl);
  };

  return {
    runGitCommand: spy('runGitCommand', async () => ({ stdout: '' })),
    ensureGitRepository: spy('ensureGitRepository', async () => ({})),
    getCurrentBranch: spy('getCurrentBranch', async () => 'main'),
    stashWorkingTree: spy('stashWorkingTree', async () => null),
    popBranchStash: spy('popBranchStash', async () => null),
    commitAllChanges: spy('commitAllChanges', async () => true),
    removeBranchStashes: spy('removeBranchStashes', async () => null)
  };
};

const runGitScenario = async (testBody, options = {}) => {
  vi.resetModules();

  if (options.pathOverrides) {
    const overrides = options.pathOverrides;
    vi.doMock('path', async () => {
      const actual = await vi.importActual('path');
      const baseDefault = actual?.default && typeof actual.default === 'object'
        ? actual.default
        : actual;
      return {
        ...actual,
        ...overrides,
        default: {
          ...baseDefault,
          ...overrides
        }
      };
    });
  }

  if (options.fsOverrides) {
    const overrides = options.fsOverrides;
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual('fs/promises');
      const baseDefault = actual?.default && typeof actual.default === 'object'
        ? actual.default
        : actual;
      return {
        ...actual,
        ...overrides,
        'default': {
          ...baseDefault,
          ...overrides
        }
      };
    });
  }

  let branchWorkflow;
  let gitSpies;
  const forcedProjects = new Set();

  try {
    branchWorkflow = await import('../services/branchWorkflow.js');
    branchWorkflow.__testing.setTestModeOverride(false);

    const gitModule = await import('../utils/git.js');
    gitSpies = createGitSpies(gitModule, options.gitOverrides);

    const databaseModule = await import('../database.js');
    const { default: dbInstance, initializeDatabase, createProject } = databaseModule;

    const exec = (sql, params = []) => new Promise((resolve, reject) => {
      dbInstance.run(sql, params, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    await initializeDatabase();
    await exec('DELETE FROM test_runs');
    await exec('DELETE FROM branches');
    await exec('DELETE FROM projects');

    const forceGitContext = (projectId, projectPath) => {
      if (!branchWorkflow?.__testing) {
        return;
      }
      branchWorkflow.__testing.setGitContextOverride(projectId, projectPath);
      if (projectPath) {
        forcedProjects.add(projectId);
      } else {
        forcedProjects.delete(projectId);
      }
    };

    await testBody({ branchWorkflow, createProject, forceGitContext, gitSpies });
  } finally {
    if (gitSpies) {
      Object.values(gitSpies).forEach((spy) => spy.mockRestore());
    }
    if (branchWorkflow?.__testing) {
      forcedProjects.forEach((projectId) => {
        branchWorkflow.__testing.setGitContextOverride(projectId, null);
      });
      branchWorkflow.__testing.setTestModeOverride(null);
    }
    vi.resetModules();
  }
};

describe('branchWorkflow git-ready operations', () => {
  const expectGitCommand = (gitSpies, matcher) => {
    const matchFound = gitSpies.runGitCommand.mock.calls.some(matcher);
    expect(matchFound).toBe(true);
  };

  const createProjectPayload = (pathSuffix = '') => ({
    name: `Git Ready Project ${Date.now()}${pathSuffix}`,
    description: 'Covers git-ready flows',
    language: 'javascript',
    framework: 'react',
    path: `C:/tmp/lucidcoder-${Date.now()}${pathSuffix}`
  });

  it('stages workspace changes inside git when repository is ready', async () => {
    const targetPath = `C:/tmp/git-stage-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      const project = await createProject({
        ...createProjectPayload('-stage'),
        path: targetPath
      });

      expect(project.path).toBe(targetPath);
      expect(typeof project.id).toBe('number');
      forceGitContext(project.id, targetPath);

      await branchWorkflow.stageWorkspaceChange(project.id, {
        filePath: 'src/index.js',
        source: 'editor',
        autoRun: false
      });

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'add'
        && args.includes('src/index.js')
      ));
    });
  });

  it('clearing a newly created staged file deletes it from disk', async () => {
    const targetPath = `C:/tmp/git-clear-new-${Date.now()}`;
    const stagedPath = 'src/newfile.txt';
    const stagedSet = new Set();

    const rmSpy = vi.fn(async () => undefined);

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
        const project = await createProject({
          ...createProjectPayload('-clear-new'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: stagedPath,
          source: 'editor',
          autoRun: false
        });

        await branchWorkflow.clearStagedChanges(project.id, { filePath: stagedPath });

        // Verifies we attempted to remove the untracked file from disk.
        const expectedSuffix = `${targetPath}/src/newfile.txt`.replace(/\\/g, '/');
        expect(rmSpy).toHaveBeenCalled();
        const rmArg = String(rmSpy.mock.calls[0]?.[0] || '').replace(/\\/g, '/');
        expect(rmArg.endsWith(expectedSuffix)).toBe(true);

        // Also verifies the git index was cleared for that file.
        const resetCallFound = gitSpies.runGitCommand.mock.calls.some((call) => {
          const [, args] = call;
          return Array.isArray(args)
            && args[0] === 'reset'
            && args.includes('--')
            && args.includes(stagedPath);
        });
        expect(resetCallFound).toBe(true);
      },
      {
        fsOverrides: { rm: rmSpy },
        gitOverrides: {
          runGitCommand: async (cwd, args, opts) => {
            if (cwd !== targetPath) {
              return { stdout: '', stderr: '', code: 0 };
            }

            // Simulate staging/un-staging state for diff --cached.
            if (Array.isArray(args) && args[0] === 'add') {
              const last = args[args.length - 1];
              if (typeof last === 'string') {
                stagedSet.add(last);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
              return { stdout: Array.from(stagedSet).join('\n'), stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-status') {
              const lines = Array.from(stagedSet).map((p) => `A\t${p}`);
              return { stdout: lines.join('\n'), stderr: '', code: 0 };
            }

            // HEAD does not contain the file (new file).
            if (Array.isArray(args) && args[0] === 'cat-file' && args[1] === '-e') {
              const ref = args[2] || '';
              if (typeof ref === 'string' && ref === `HEAD:${stagedPath}`) {
                return { stdout: '', stderr: 'missing', code: 1 };
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'reset') {
              const relative = args[args.length - 1];
              if (typeof relative === 'string') {
                stagedSet.delete(relative);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'checkout') {
              return { stdout: '', stderr: '', code: 0 };
            }

            // Default stubbed success.
            return { stdout: '', stderr: '', code: 0 };
          }
        }
      }
    );
  });

  it('clearing staged changes with an absolute filePath skips deletion heuristics', async () => {
    const targetPath = `C:/tmp/git-clear-abs-${Date.now()}`;
    const stagedPath = 'src/newfile.txt';

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
        const project = await createProject({
          ...createProjectPayload('-clear-abs'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        // Ensure we have a working branch and at least one staged file entry.
        await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: stagedPath,
          source: 'editor',
          autoRun: false
        });

        // Pass an absolute file path so the internal relative-path guard fails.
        const absolutePath = `${targetPath}/${stagedPath}`;

        await branchWorkflow.clearStagedChanges(project.id, { filePath: absolutePath });

        // Still resets/checkout in git even with the absolute path.
        const resetCallFound = gitSpies.runGitCommand.mock.calls.some((call) => {
          const [, args] = call;
          return Array.isArray(args) && args[0] === 'reset' && args.includes('--') && args.includes(absolutePath);
        });
        expect(resetCallFound).toBe(true);
      },
      {
        gitOverrides: {
          runGitCommand: async () => ({ stdout: '', stderr: '', code: 0 })
        }
      }
    );
  });

  it('ignores fs.rm failures when clearing newly created staged files', async () => {
    const targetPath = `C:/tmp/git-clear-new-rm-fail-${Date.now()}`;
    const stagedPath = 'src/newfile.txt';
    const stagedSet = new Set();

    const rmSpy = vi.fn(async () => {
      throw new Error('rm failed');
    });

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-clear-new-rm-fail'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: stagedPath,
          source: 'editor',
          autoRun: false
        });

        await branchWorkflow.clearStagedChanges(project.id, { filePath: stagedPath });

        // The removal attempt happens even if the underlying rm fails.
        expect(rmSpy).toHaveBeenCalled();
      },
      {
        fsOverrides: { rm: rmSpy },
        gitOverrides: {
          runGitCommand: async (cwd, args) => {
            if (cwd !== targetPath) {
              return { stdout: '', stderr: '', code: 0 };
            }

            // Simulate staging/un-staging state for diff --cached.
            if (Array.isArray(args) && args[0] === 'add') {
              const last = args[args.length - 1];
              if (typeof last === 'string') {
                stagedSet.add(last);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
              return { stdout: Array.from(stagedSet).join('\n'), stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-status') {
              const lines = Array.from(stagedSet).map((p) => `A\t${p}`);
              return { stdout: lines.join('\n'), stderr: '', code: 0 };
            }

            // HEAD does not contain the file (new file).
            if (Array.isArray(args) && args[0] === 'cat-file' && args[1] === '-e') {
              const ref = args[2] || '';
              if (typeof ref === 'string' && ref === `HEAD:${stagedPath}`) {
                return { stdout: '', stderr: 'missing', code: 1 };
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'reset') {
              const relative = args[args.length - 1];
              if (typeof relative === 'string') {
                stagedSet.delete(relative);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'checkout') {
              return { stdout: '', stderr: '', code: 0 };
            }

            return { stdout: '', stderr: '', code: 0 };
          }
        }
      }
    );
  });

  it('does not delete from disk when resolved path does not stay within project root', async () => {
    const targetPath = `C:/tmp/git-clear-escape-${Date.now()}`;
    const stagedPath = 'src/newfile.txt';
    const stagedSet = new Set();

    const rmSpy = vi.fn(async () => undefined);

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-clear-escape'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: stagedPath,
          source: 'editor',
          autoRun: false
        });

        await branchWorkflow.clearStagedChanges(project.id, { filePath: stagedPath });

        // Guard should prevent deletion when resolved path is outside project root.
        expect(rmSpy).not.toHaveBeenCalled();
      },
      {
        fsOverrides: { rm: rmSpy },
        // Force path.resolve(fullPath) to return something that fails startsWith(projectResolved).
        pathOverrides: {
          resolve: (...parts) => {
            const joined = parts.filter(Boolean).join('');
            // path.resolve(context.projectPath) is called with just the project path.
            if (parts.length === 1 && typeof parts[0] === 'string' && parts[0] === targetPath) {
              return targetPath.replace(/\//g, '\\');
            }
            // path.resolve(fullPath) should look like it escaped.
            if (typeof joined === 'string' && joined.includes('newfile.txt')) {
              return 'D:\\outside\\newfile.txt';
            }
            return targetPath.replace(/\//g, '\\');
          }
        },
        gitOverrides: {
          runGitCommand: async (cwd, args) => {
            if (cwd !== targetPath) {
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'add') {
              const last = args[args.length - 1];
              if (typeof last === 'string') {
                stagedSet.add(last);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
              return { stdout: Array.from(stagedSet).join('\n'), stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-status') {
              const lines = Array.from(stagedSet).map((p) => `A\t${p}`);
              return { stdout: lines.join('\n'), stderr: '', code: 0 };
            }

            // Ensure shouldDeleteFromDisk becomes true.
            if (Array.isArray(args) && args[0] === 'cat-file' && args[1] === '-e') {
              const ref = args[2] || '';
              if (typeof ref === 'string' && ref === `HEAD:${stagedPath}`) {
                return { stdout: '', stderr: 'missing', code: 1 };
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'reset') {
              const relative = args[args.length - 1];
              if (typeof relative === 'string') {
                stagedSet.delete(relative);
              }
              return { stdout: '', stderr: '', code: 0 };
            }

            if (Array.isArray(args) && args[0] === 'checkout') {
              return { stdout: '', stderr: '', code: 0 };
            }

            return { stdout: '', stderr: '', code: 0 };
          }
        }
      }
    );
  });

  it('treats staging verification failures as not-staged without surfacing an error', async () => {
    const targetPath = `C:/tmp/git-stage-verify-fail-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
          && args.includes('--')
          && args.includes('src/index.js')
        ) {
          throw new Error('git diff failed');
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-stage-verify-fail'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      const result = await branchWorkflow.stageWorkspaceChange(project.id, {
        filePath: 'src/index.js',
        source: 'editor',
        autoRun: false
      });

      expect(result.git.ready).toBe(true);
      expect(result.git.staged).toBe(false);
      expect(result.git.error).toBe(null);

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'add'
        && args.includes('src/index.js')
      ));

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'diff'
        && args.includes('--cached')
        && args.includes('--name-only')
        && args.includes('src/index.js')
      ));
    });
  });

  it('falls back to a default git staging error when the thrown value has no message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const targetPath = `C:/tmp/git-stage-no-message-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'add'
          && args.includes('--')
          && args.includes('src/index.js')
        ) {
          throw Object.create(null);
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-stage-no-message'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      const result = await branchWorkflow.stageWorkspaceChange(project.id, {
        filePath: 'src/index.js',
        source: 'editor',
        autoRun: false
      });

      expect(result.git.ready).toBe(true);
      expect(result.git.staged).toBe(false);
      expect(result.git.error).toBe('Failed to stage file in git');
    });

    warnSpy.mockRestore();
  });

  it('syncs externally staged git files into the branch overview', async () => {
    const targetPath = `C:/tmp/git-sync-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/autostage');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
        ) {
          return { stdout: 'frontend/src/App.css\n' };
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-sync'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/autostage' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ?, staged_files = ? WHERE project_id = ? AND name = ?',
        ['ready-for-merge', '[]', project.id, 'feature/autostage']
      );

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/autostage');

      expect(working).toBeTruthy();
      expect(working.stagedFiles).toHaveLength(1);
      expect(working.stagedFiles[0].path).toBe('frontend/src/App.css');
      expect(working.status).toBe('active');

      const updated = await branchWorkflow.__testing.getSql(
        'SELECT staged_files, status FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/autostage']
      );

      expect(updated.status).toBe('active');
      const stagedFiles = JSON.parse(updated.staged_files);
      expect(stagedFiles).toHaveLength(1);
      expect(stagedFiles[0]).toMatchObject({
        path: 'frontend/src/App.css',
        source: 'editor',
        timestamp: null
      });

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'diff'
        && args.includes('--cached')
        && args.includes('--name-only')
      ));
    });
  });

  it('getBranchOverview nulls last test fields when last_test_run_id points to a missing test run row', async () => {
    const targetPath = `C:/tmp/git-overview-missing-test-run-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/missing-test-run');

      const project = await createProject({
        ...createProjectPayload('-overview-missing-test-run'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/missing-test-run' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET last_test_run_id = ? WHERE project_id = ? AND name = ?',
        [999999, project.id, 'feature/missing-test-run']
      );

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/missing-test-run');

      expect(working).toBeTruthy();
      expect(working.lastTestStatus).toBe(null);
      expect(working.lastTestCompletedAt).toBe(null);
    });
  });

  it('createWorkingBranch tolerates git checkout failures when git is ready', async () => {
    const targetPath = `C:/tmp/git-create-branch-fail-${Date.now()}`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'checkout'
          && args[1] === '-b'
        ) {
          throw new Error('checkout failed');
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-create-branch-fail'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      const created = await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/create-fail' });
      expect(created).toBeTruthy();
      expect(created.name).toBe('feature/create-fail');
    });

    warnSpy.mockRestore();
  });

  it('syncs rename/copy staged status entries into branch overview', async () => {
    const targetPath = `C:/tmp/git-sync-rename-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/rename');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: 'old.txt\nnew.txt\n' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-status')) {
          return { stdout: 'R100\told.txt\tnew.txt\n' };
        }

        if (args[0] === 'ls-files' && args.includes('--stage')) {
          const filePath = args[args.length - 1];
          const blob = filePath === 'old.txt' ? 'abcdef' : '123456';
          return { stdout: `100644 ${blob} 0\t${filePath}\n` };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-sync-rename'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/rename' });

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/rename');

      expect(working).toBeTruthy();
      expect(working.stagedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'old.txt', source: 'editor' }),
          expect.objectContaining({ path: 'new.txt', source: 'editor' })
        ])
      );

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'diff'
        && args.includes('--cached')
        && args.includes('--name-status')
      ));
    });
  });

  it('listGitStagedStatusMap includes both sides of rename/copy status lines', async () => {
    const targetPath = `C:/tmp/git-status-map-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-status')) {
          return { stdout: 'R100\told.txt\tnew.txt\nM\n' };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-status-map'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      const context = await branchWorkflow.__testing.getProjectContext(project.id);
      expect(context.gitReady).toBe(true);

      const map = await branchWorkflow.__testing.listGitStagedStatusMap(context);
      expect(map.get('old.txt')).toBe('R');
      expect(map.get('new.txt')).toBe('R');
    });
  });

  it('parseGitLsFilesStageBlob returns null for empty or malformed outputs', async () => {
    await runGitScenario(async ({ branchWorkflow }) => {
      expect(branchWorkflow.__testing.parseGitLsFilesStageBlob('')).toBe(null);
      expect(branchWorkflow.__testing.parseGitLsFilesStageBlob('100644\n')).toBe(null);
      expect(branchWorkflow.__testing.parseGitLsFilesStageBlob('100644 abcdef 0\tfile.txt\n')).toBe('abcdef');
    });
  });

  it('listGitStagedStatusMap swallows git errors via catch callback', async () => {
    const targetPath = `C:/tmp/git-status-map-catch-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-status')) {
          throw new Error('diff failed');
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-status-map-catch'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      const context = await branchWorkflow.__testing.getProjectContext(project.id);

      const map = await branchWorkflow.__testing.listGitStagedStatusMap(context);
      expect(map.size).toBe(0);
    });
  });

  it('listGitStagedEntries tolerates ls-files failures via catch callback', async () => {
    const targetPath = `C:/tmp/git-staged-entries-catch-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: 'file.txt\n' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-status')) {
          return { stdout: 'M\tfile.txt\n' };
        }

        if (args[0] === 'ls-files' && args.includes('--stage')) {
          throw new Error('ls-files failed');
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-staged-entries-catch'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      const context = await branchWorkflow.__testing.getProjectContext(project.id);

      const entries = await branchWorkflow.__testing.listGitStagedEntries(context);
      expect(entries).toEqual([{ path: 'file.txt', gitToken: '' }]);
    });
  });

  it('ensureGitBranchExists is a no-op when git is not ready or branch is missing', async () => {
    await runGitScenario(async ({ branchWorkflow, gitSpies }) => {
      await branchWorkflow.__testing.ensureGitBranchExists({ gitReady: false, projectPath: 'C:/tmp/nope' }, 'feature/x');
      await branchWorkflow.__testing.ensureGitBranchExists({ gitReady: true, projectPath: 'C:/tmp/nope' }, '');

      expect(gitSpies.runGitCommand).not.toHaveBeenCalled();
    });
  });

  it('ensureGitBranchExists creates branch when show-ref verification fails', async () => {
    const targetPath = `C:/tmp/git-ensure-branch-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'show-ref') {
          const err = new Error('no ref');
          err.code = 1;
          throw err;
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-ensure-branch'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      const context = await branchWorkflow.__testing.getProjectContext(project.id);

      await branchWorkflow.__testing.ensureGitBranchExists(context, 'feature/new', 'main');

      expect(gitSpies.runGitCommand).toHaveBeenCalledTimes(3);
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        1,
        targetPath,
        ['show-ref', '--verify', 'refs/heads/feature/new'],
        undefined
      );
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        2,
        targetPath,
        ['checkout', 'main'],
        undefined
      );
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        3,
        targetPath,
        ['checkout', '-b', 'feature/new'],
        undefined
      );
    });
  });

  it('getBranchOverview clears staged_files without invalidating test run when nothing remains staged', async () => {
    const targetPath = `C:/tmp/git-branch-overview-clear-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext }) => {
      const project = await createProject({
        ...createProjectPayload('-overview-clear'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      // First call ensures the main branch row exists.
      await branchWorkflow.getBranchOverview(project.id);

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ? WHERE project_id = ? AND name = ?',
        [
          JSON.stringify([{ path: 'src/was-staged.js', source: 'editor', timestamp: null, gitToken: 'abc' }]),
          project.id,
          'main'
        ]
      );

      // With git reporting no staged changes, sync should clear staged_files.
      await branchWorkflow.getBranchOverview(project.id);

      const mainBranch = await branchWorkflow.__testing.getSql(
        'SELECT staged_files FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'main']
      );
      expect(mainBranch.staged_files).toBe('[]');
    });
  });

  it('ensureGitBranchExists creates branch when show-ref error indicates invalid ref', async () => {
    const targetPath = `C:/tmp/git-ensure-branch-regex-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'show-ref') {
          const err = new Error('not a valid ref');
          err.code = 2;
          throw err;
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-ensure-branch-regex'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      const context = await branchWorkflow.__testing.getProjectContext(project.id);

      await branchWorkflow.__testing.ensureGitBranchExists(context, 'feature/new', 'main');

      expect(gitSpies.runGitCommand).toHaveBeenCalledTimes(3);
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        1,
        targetPath,
        ['show-ref', '--verify', 'refs/heads/feature/new'],
        undefined
      );
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        2,
        targetPath,
        ['checkout', 'main'],
        undefined
      );
      expect(gitSpies.runGitCommand).toHaveBeenNthCalledWith(
        3,
        targetPath,
        ['checkout', '-b', 'feature/new'],
        undefined
      );
    });
  });

  it('commitBranchChanges returns needs-fix guidance when tests have failed', async () => {
    const targetPath = `C:/tmp/git-commit-needs-fix-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext }) => {
      const project = await createProject({
        ...createProjectPayload('-commit-needs-fix'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/needs-fix' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ?, staged_files = ? WHERE project_id = ? AND name = ?',
        [
          'needs-fix',
          JSON.stringify([{ path: 'src/index.js', source: 'editor', timestamp: null, gitToken: '' }]),
          project.id,
          'feature/needs-fix'
        ]
      );

      await expect(branchWorkflow.commitBranchChanges(project.id, 'feature/needs-fix', { message: 'test' }))
        .rejects.toMatchObject({ statusCode: 400 });

      await expect(branchWorkflow.commitBranchChanges(project.id, 'feature/needs-fix', { message: 'test' }))
        .rejects.toThrow(/Resolve failing tests and run tests again before committing/i);
    });
  });

  it('commitBranchChanges requires a passing test run when not css-only', async () => {
    const targetPath = `C:/tmp/git-commit-requires-tests-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext }) => {
      const project = await createProject({
        ...createProjectPayload('-commit-requires-tests'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/needs-tests' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ?, staged_files = ? WHERE project_id = ? AND name = ?',
        [
          'active',
          JSON.stringify([{ path: 'src/index.js', source: 'editor', timestamp: null, gitToken: '' }]),
          project.id,
          'feature/needs-tests'
        ]
      );

      await expect(branchWorkflow.commitBranchChanges(project.id, 'feature/needs-tests', { message: 'test' }))
        .rejects.toThrow(/Run tests to prove this branch before committing/i);
    });
  });

  it('commitBranchChanges treats non-string staged paths as non-css-only', async () => {
    const targetPath = `C:/tmp/git-commit-nonstring-path-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject }) => {
      const project = await createProject({
        ...createProjectPayload('-commit-nonstring-path'),
        path: targetPath
      });

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/nonstring' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ?, staged_files = ? WHERE project_id = ? AND name = ?',
        [
          'active',
          JSON.stringify([{ path: null, source: 'editor', timestamp: null, gitToken: '' }]),
          project.id,
          'feature/nonstring'
        ]
      );

      await expect(branchWorkflow.commitBranchChanges(project.id, 'feature/nonstring', { message: 'test' }))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('getCommitFileDiffContent rejects when git is unavailable', async () => {
    await runGitScenario(async ({ branchWorkflow, createProject }) => {
      const project = await createProject({
        ...createProjectPayload('-commit-diff-git-unavailable'),
        path: `C:/tmp/git-unavailable-${Date.now()}`
      });

      branchWorkflow.__testing.setTestModeOverride(true);

      await expect(branchWorkflow.getCommitFileDiffContent(project.id, 'abc', 'file.txt'))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('getCommitFileDiffContent handles parent sha and safeShow failures', async () => {
    const targetPath = `C:/tmp/git-commit-diff-${Date.now()}`;
    const commitSha = 'abcdef0123456789';

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (
          args[0] === 'show'
          && args[1] === commitSha
          && args.includes('--pretty=format:%P')
        ) {
          return { stdout: 'parent1234567890' };
        }

        if (args[0] === 'show' && args[1] === 'parent1234567890:src/index.js') {
          return { stdout: 123 };
        }

        if (args[0] === 'show' && args[1] === `${commitSha}:src/index.js`) {
          throw new Error('missing blob');
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-commit-diff'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      await expect(branchWorkflow.getCommitFileDiffContent(project.id, '', 'src/index.js'))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(branchWorkflow.getCommitFileDiffContent(project.id, commitSha, ''))
        .rejects.toMatchObject({ statusCode: 400 });

      const diff = await branchWorkflow.getCommitFileDiffContent(project.id, commitSha, 'src/index.js');
      expect(diff.path).toBe('src/index.js');
      expect(diff.original).toBe('123');
      expect(diff.modified).toBe('');
      expect(diff.originalLabel).toBe('parent1');
      expect(diff.modifiedLabel).toBe('abcdef0');
    });
  });

  it('getCommitFileDiffContent validates non-string commitSha and filePath when git is ready', async () => {
    const targetPath = `C:/tmp/git-commit-diff-coerce-${Date.now()}`;
    const commitSha = 'abcdef0123456789';

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (
          args[0] === 'show'
          && args[1] === commitSha
          && args.includes('--pretty=format:%P')
        ) {
          return { stdout: '' };
        }

        if (args[0] === 'show' && args[1] === `${commitSha}:src/index.js`) {
          return { stdout: 'modified content' };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-commit-diff-coerce'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      await expect(branchWorkflow.getCommitFileDiffContent(project.id, 123, 'src/index.js'))
        .rejects.toThrow(/commitSha is required/i);

      await expect(branchWorkflow.getCommitFileDiffContent(project.id, commitSha, 456))
        .rejects.toThrow(/filePath is required/i);

      const diff = await branchWorkflow.getCommitFileDiffContent(project.id, commitSha, 'src/index.js');
      expect(diff.modified).toBe('modified content');
      expect(diff.original).toBe('');
      expect(diff.originalLabel).toBe('Empty');
    });
  });

  it('getCommitFileDiffContent treats falsy non-string stdout as empty content', async () => {
    const targetPath = `C:/tmp/git-commit-diff-falsy-stdout-${Date.now()}`;
    const commitSha = 'fedcba9876543210';

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (
          args[0] === 'show'
          && args[1] === commitSha
          && args.includes('--pretty=format:%P')
        ) {
          return { stdout: '' };
        }

        if (args[0] === 'show' && args[1] === `${commitSha}:src/index.js`) {
          return { stdout: 0 };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-commit-diff-falsy-stdout'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);

      const diff = await branchWorkflow.getCommitFileDiffContent(project.id, commitSha, 'src/index.js');
      expect(diff.modified).toBe('');
      expect(diff.originalLabel).toBe('Empty');
    });
  });

  it('listBranchChangedPaths returns empty list for invalid contexts and refs', async () => {
    await runGitScenario(async ({ branchWorkflow }) => {
      await expect(branchWorkflow.__testing.listBranchChangedPaths(null, { baseRef: 'main', branchRef: 'feature/x' }))
        .resolves.toEqual([]);

      const context = { gitReady: true, projectPath: 'C:/tmp/branch-changes-noop' };

      await expect(branchWorkflow.__testing.listBranchChangedPaths(context, { baseRef: 123, branchRef: 'feature/x' }))
        .resolves.toEqual([]);

      await expect(branchWorkflow.__testing.listBranchChangedPaths(context, { baseRef: 'main', branchRef: { nope: true } }))
        .resolves.toEqual([]);
    });
  });

  it('does not invalidate ready-for-merge when staged files match the stored snapshot', async () => {
    const targetPath = `C:/tmp/git-ready-preserve-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/ready');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
        ) {
          return { stdout: 'frontend/src/App.css\n' };
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-ready-preserve'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/ready' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ?, staged_files = ? WHERE project_id = ? AND name = ?',
        [
          'ready-for-merge',
          JSON.stringify([{ path: 'frontend/src/App.css', source: 'editor', timestamp: null }]),
          project.id,
          'feature/ready'
        ]
      );

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/ready');

      expect(working).toBeTruthy();
      expect(working.stagedFiles).toHaveLength(1);
      expect(working.stagedFiles[0].path).toBe('frontend/src/App.css');
      expect(working.status).toBe('ready-for-merge');

      const updated = await branchWorkflow.__testing.getSql(
        'SELECT status FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/ready']
      );

      expect(updated.status).toBe('ready-for-merge');
    });
  });

  it('skips git staged-file syncing when git context is not ready', async () => {
    const targetPath = `C:/tmp/git-sync-skip-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject }) => {
      const project = await createProject({
        ...createProjectPayload('-skip'),
        path: targetPath
      });

      branchWorkflow.__testing.setTestModeOverride(true);
      const overview = await branchWorkflow.getBranchOverview(project.id);
      expect(overview).toBeTruthy();
    });
  });

  it('skips git staged-file syncing when current git branch cannot be resolved', async () => {
    const targetPath = `C:/tmp/git-sync-nobranch-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockRejectedValueOnce(new Error('git branch lookup failed'));

      const project = await createProject({
        ...createProjectPayload('-nobranch'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      const overview = await branchWorkflow.getBranchOverview(project.id);
      expect(overview).toBeTruthy();
    });
  });

  it('handles git diff failures when syncing staged file paths', async () => {
    const targetPath = `C:/tmp/git-sync-diff-fail-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/autostage');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
        ) {
          return Promise.reject(new Error('diff exploded'));
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-diff-fail'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/autostage' });

      const overview = await branchWorkflow.getBranchOverview(project.id);
      expect(overview).toBeTruthy();
    });
  });

  it('throws when git still reports a file staged after clearStagedChanges', async () => {
    const targetPath = `C:/tmp/git-clear-staged-stuck-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: 'src/App.jsx\n' };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-stuck'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/stuck' });
      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ? WHERE project_id = ? AND name = ?',
        [JSON.stringify([{ path: 'src/App.jsx', source: 'editor', timestamp: null }]), project.id, 'feature/stuck']
      );

      await expect(
        branchWorkflow.clearStagedChanges(project.id, {
          branchName: 'feature/stuck',
          filePath: 'src/App.jsx'
        })
      ).rejects.toMatchObject({ statusCode: 500 });

      expect(gitSpies.runGitCommand).toHaveBeenCalled();
    });
  });

  it('normalizes filePath inputs when clearing staged changes via git', async () => {
    const targetPath = `C:/tmp/git-clear-staged-normalize-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: '' };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-normalize'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/normalize' });
      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ? WHERE project_id = ? AND name = ?',
        [JSON.stringify([{ path: 'src/App.jsx', source: 'editor', timestamp: null }]), project.id, 'feature/normalize']
      );

      await branchWorkflow.clearStagedChanges(project.id, {
        branchName: 'feature/normalize',
        filePath: 'src\\App.jsx'
      });

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'reset'
        && args[args.length - 1] === 'src/App.jsx'
      ));
    });
  });

  it('clears git-staged files even when the stored staged_files snapshot is empty', async () => {
    const targetPath = `C:/tmp/git-clear-staged-external-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      let cleared = false;

      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'reset' || args[0] === 'checkout') {
          cleared = true;
          return { stdout: '' };
        }

        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--name-only')) {
          return { stdout: cleared ? '' : 'frontend/src/App.css\n' };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-external-clear'),
        path: targetPath
      });

      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/external-clear' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ? WHERE project_id = ? AND name = ?',
        ['[]', project.id, 'feature/external-clear']
      );

      await branchWorkflow.clearStagedChanges(project.id, {
        branchName: 'feature/external-clear',
        filePath: 'frontend/src/App.css'
      });

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'reset'
        && args[args.length - 1] === 'frontend/src/App.css'
      ));
    });
  });

  it('skips git staged-file syncing when the current git branch is not tracked in the DB', async () => {
    const targetPath = `C:/tmp/git-sync-missing-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/unknown');

      const project = await createProject({
        ...createProjectPayload('-missing'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      const overview = await branchWorkflow.getBranchOverview(project.id);
      expect(overview).toBeTruthy();
    });
  });

  it('handles malformed staged_files rows when syncing staged files from git', async () => {
    const targetPath = `C:/tmp/git-sync-malformed-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/autostage');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
        ) {
          return { stdout: 'frontend/src/App.css\n' };
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-malformed'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/autostage' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ?, status = ? WHERE project_id = ? AND name = ?',
        [JSON.stringify([{ source: 'ai' }]), 'active', project.id, 'feature/autostage']
      );

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/autostage');

      expect(working).toBeTruthy();
      expect(working.stagedFiles).toHaveLength(1);
      expect(working.stagedFiles[0]).toMatchObject({
        path: 'frontend/src/App.css',
        source: 'editor',
        timestamp: null
      });
    });
  });

  it('does not rewrite staged_files when git staged paths already match the stored snapshot', async () => {
    const targetPath = `C:/tmp/git-sync-noop-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch.mockResolvedValue('feature/autostage');
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'diff'
          && args.includes('--cached')
          && args.includes('--name-only')
        ) {
          return { stdout: 'frontend/src/App.css\n' };
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-noop'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/autostage' });

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET staged_files = ?, status = ? WHERE project_id = ? AND name = ?',
        [
          JSON.stringify([{ path: 'frontend/src/App.css', source: 'ai', timestamp: '2024-01-01T00:00:00.000Z' }]),
          'active',
          project.id,
          'feature/autostage'
        ]
      );

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const working = overview.workingBranches.find((branch) => branch.name === 'feature/autostage');

      expect(working).toBeTruthy();
      expect(working.stagedFiles).toHaveLength(1);
      expect(working.stagedFiles[0]).toMatchObject({
        path: 'frontend/src/App.css',
        source: 'ai',
        timestamp: '2024-01-01T00:00:00.000Z'
      });
    });
  });

  it('commits staged files through git helpers when committing branches', async () => {
    const targetPath = `C:/tmp/git-commit-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      const project = await createProject({
        ...createProjectPayload('-commit'),
        path: targetPath
      });

      expect(project.path).toBe(targetPath);
      expect(typeof project.id).toBe('number');
      forceGitContext(project.id, targetPath);

      const staged = await branchWorkflow.stageWorkspaceChange(project.id, {
        filePath: 'src/App.jsx',
        autoRun: false
      });

      const branchRow = await branchWorkflow.__testing.getSql(
        'SELECT id FROM branches WHERE project_id = ? AND name = ?',
        [project.id, staged.branch.name]
      );
      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ? WHERE id = ?',
        ['ready-for-merge', branchRow.id]
      );

      await branchWorkflow.commitBranchChanges(project.id, staged.branch.name, {
        message: 'feat: cover git commit'
      });

      expect(gitSpies.commitAllChanges).toHaveBeenCalledWith(targetPath, 'feat: cover git commit');
    });
  });

  it('includes commit sha + shortSha when committing through git', async () => {
    const targetPath = `C:/tmp/git-commit-sha-${Date.now()}`;
    const commitSha = 'abc123def4567890abc123def4567890abc123de';

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-commit-sha'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        const staged = await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: 'src/App.jsx',
          autoRun: false
        });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, staged.branch.name]
        );
        await branchWorkflow.__testing.runSql(
          'UPDATE branches SET status = ? WHERE id = ?',
          ['ready-for-merge', branchRow.id]
        );

        const result = await branchWorkflow.commitBranchChanges(project.id, staged.branch.name, {
          message: 'feat: include sha'
        });

        expect(result.commit).toMatchObject({
          sha: commitSha,
          shortSha: commitSha.slice(0, 7),
          message: 'feat: include sha'
        });
      },
      {
        gitOverrides: {
          runGitCommand: async (projectPath, args = []) => {
            if (projectPath === targetPath && Array.isArray(args) && args[0] === 'rev-parse' && args[1] === 'HEAD') {
              return { stdout: `${commitSha}\n` };
            }
            return { stdout: '' };
          }
        }
      }
    );
  });

  it('normalizes missing commit sha to null when git cannot resolve HEAD', async () => {
    const targetPath = `C:/tmp/git-commit-sha-null-${Date.now()}`;

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-commit-sha-null'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        const staged = await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: 'src/App.jsx',
          autoRun: false
        });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, staged.branch.name]
        );
        await branchWorkflow.__testing.runSql(
          'UPDATE branches SET status = ? WHERE id = ?',
          ['ready-for-merge', branchRow.id]
        );

        const result = await branchWorkflow.commitBranchChanges(project.id, staged.branch.name, {
          message: 'feat: sha missing'
        });

        expect(result.commit).toMatchObject({
          sha: null,
          shortSha: null,
          message: 'feat: sha missing'
        });
      },
      {
        gitOverrides: {
          runGitCommand: async (projectPath, args = []) => {
            if (projectPath === targetPath && Array.isArray(args) && args[0] === 'rev-parse') {
              const err = new Error('rev-parse failed');
              err.code = 1;
              throw err;
            }
            return { stdout: '' };
          }
        }
      }
    );
  });

  it('cleans up git branches and stashes when deleting the active working branch', async () => {
    const targetPath = `C:/tmp/git-delete-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.getCurrentBranch
        .mockResolvedValueOnce('feature/prune-me')
        .mockResolvedValueOnce('feature/prune-me')
        .mockResolvedValue('main');

      const project = await createProject({
        ...createProjectPayload('-delete'),
        path: targetPath
      });

      expect(project.path).toBe(targetPath);
      expect(typeof project.id).toBe('number');
      forceGitContext(project.id, targetPath);

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/prune-me' });
      await branchWorkflow.deleteBranchByName(project.id, 'feature/prune-me');

      expectGitCommand(gitSpies, ([cwd, args]) => (
        cwd === targetPath
        && Array.isArray(args)
        && args[0] === 'branch'
        && args[1] === '-D'
        && args[2] === 'feature/prune-me'
      ));
      expect(gitSpies.removeBranchStashes).toHaveBeenCalledWith(targetPath, 'feature/prune-me');
    });
  });

  it('reports diff metadata for staged files when git diffs are available', async () => {
    const diffText = 'diff --git a/src/App.jsx b/src/App.jsx\n@@ -1,3 +1,3 @@';
    const targetPath = `C:/tmp/git-diff-${Date.now()}`;

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
        gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
          if (args[0] === 'diff' && args.includes('--numstat')) {
            return { stdout: '12\t3\tsrc/App.jsx' };
          }
          if (args[0] === 'diff' && args.includes('--unified=5')) {
            return { stdout: diffText };
          }
          return { stdout: '' };
        });

        const project = await createProject({
          ...createProjectPayload('-diff'),
          path: targetPath
        });

        expect(project.path).toBe(targetPath);
        expect(typeof project.id).toBe('number');
        forceGitContext(project.id, targetPath);

        const staged = await branchWorkflow.stageWorkspaceChange(project.id, {
          filePath: 'src/App.jsx',
          autoRun: false
        });

        const context = await branchWorkflow.getBranchCommitContext(project.id, staged.branch.name);
        expect(context.isGitAvailable).toBe(true);
        expect(context.summaryText).toContain('(+12 / -3)');
        expect(context.files[0]).toMatchObject({
          path: 'src/App.jsx',
          additions: 12,
          deletions: 3,
          truncated: false
        });
        expect(context.aggregateDiff).toContain('diff --git');
      }
    );
  });

  it('loads commit metadata along with touched files when git history is available', async () => {
    const targetPath = `C:/tmp/git-details-${Date.now()}`;
    const commitSha = 'abc123def456';

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
        gitSpies.runGitCommand.mockImplementation(async (projectPath, args = []) => {
          if (args[0] === 'show') {
            return {
              stdout: `${commitSha}\x1fAlice\x1falice@example.com\x1f2024-01-01T00:00:00Z\x1fInitial commit\x1fparent1 parent2\x1fFull body`
            };
          }
          if (args[0] === 'diff-tree') {
            return { stdout: 'A\tREADME.md\nM\tsrc/app.js' };
          }
          return { stdout: '' };
        });

        const project = await createProject({
          ...createProjectPayload('-commit-details'),
          path: targetPath
        });

        forceGitContext(project.id, targetPath);

        const details = await branchWorkflow.getCommitDetails(project.id, commitSha);

        expect(details).toMatchObject({
          sha: commitSha,
          shortSha: commitSha.slice(0, 7),
          message: 'Initial commit',
          body: 'Full body',
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
      }
    );
  });

  it('blocks merges when the git working tree has uncommitted changes', async () => {
    const targetPath = `C:/tmp/git-merge-dirty-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'status'
          && args[1] === '--porcelain'
        ) {
          return { stdout: ' M src/App.jsx\n' };
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-merge-dirty'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/dirty-merge' });

      const branchRow = await branchWorkflow.__testing.getSql(
        'SELECT id FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/dirty-merge']
      );

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ? WHERE id = ?',
        ['ready-for-merge', branchRow.id]
      );

      await branchWorkflow.__testing.runSql(
        `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
         VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [project.id, branchRow.id]
      );

      const error = await branchWorkflow
        .mergeBranch(project.id, 'feature/dirty-merge')
        .then(() => null)
        .catch((err) => err);

      expect(error).toBeTruthy();
      expect(error).toMatchObject({ statusCode: 400 });
      expect(String(error.message || '')).toMatch(/working tree|uncommitted|clean/i);

      const attemptedMerge = gitSpies.runGitCommand.mock.calls.some((call) => {
        const [cwd, args] = call;
        return cwd === targetPath && Array.isArray(args) && args[0] === 'merge';
      });
      expect(attemptedMerge).toBe(false);
    });
  });

  it('fails merges when git status cannot be verified', async () => {
    const targetPath = `C:/tmp/git-merge-status-error-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (
          projectPath === targetPath
          && Array.isArray(args)
          && args[0] === 'status'
          && args[1] === '--porcelain'
        ) {
          throw new Error('git status exploded');
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-merge-status-error'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/status-error-merge' });

      const branchRow = await branchWorkflow.__testing.getSql(
        'SELECT id FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/status-error-merge']
      );

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ? WHERE id = ?',
        ['ready-for-merge', branchRow.id]
      );

      await branchWorkflow.__testing.runSql(
        `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
         VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [project.id, branchRow.id]
      );

      const error = await branchWorkflow
        .mergeBranch(project.id, 'feature/status-error-merge')
        .then(() => null)
        .catch((err) => err);

      expect(error).toBeTruthy();
      expect(error).toMatchObject({ statusCode: 500 });
      expect(String(error.message || '')).toMatch(/Unable to verify git working tree status/i);
    });
  });

  it('getBranchOverview tolerates css-only detection failures (covers catch fallback)', async () => {
    const targetPath = `C:/tmp/git-overview-css-only-failure-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath === targetPath && Array.isArray(args) && args[0] === 'diff' && args[1] === '--name-only') {
          // Causes listBranchChangedPaths() to throw when destructuring stdout.
          return null;
        }
        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-overview-css-only-failure'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/css-only-detect-failure' });

      const overview = await branchWorkflow.getBranchOverview(project.id);
      const feature = overview.branches.find((b) => b?.name === 'feature/css-only-detect-failure');

      expect(feature).toBeTruthy();
      expect(feature.status).not.toBe('ready-for-merge');
      expect(feature.__cssOnlyMergeAllowed).toBeUndefined();
    });
  });

  it('allows merges when git commands return non-string stdout values', async () => {
    const targetPath = `C:/tmp/git-merge-nonstring-stdout-${Date.now()}`;

    await runGitScenario(async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
      let revParseShouldThrow = false;

      gitSpies.runGitCommand.mockImplementation(async (projectPath, args) => {
        if (projectPath !== targetPath || !Array.isArray(args)) {
          return { stdout: '' };
        }

        if (args[0] === 'status' && args[1] === '--porcelain') {
          return { stdout: null };
        }

        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
          if (revParseShouldThrow) {
            throw new Error('rev-parse exploded');
          }
          return { stdout: null };
        }

        return { stdout: '' };
      });

      const project = await createProject({
        ...createProjectPayload('-merge-nonstring-stdout'),
        path: targetPath
      });
      forceGitContext(project.id, targetPath);

      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/nonstring-stdout-merge' });

      const branchRow = await branchWorkflow.__testing.getSql(
        'SELECT id FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/nonstring-stdout-merge']
      );

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ? WHERE id = ?',
        ['ready-for-merge', branchRow.id]
      );

      await branchWorkflow.__testing.runSql(
        `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
         VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [project.id, branchRow.id]
      );

      // Merge #1: rev-parse returns a non-string stdout (covers the ternary else branch).
      const result = await branchWorkflow.mergeBranch(project.id, 'feature/nonstring-stdout-merge');

      expect(result).toMatchObject({ mergedBranch: 'feature/nonstring-stdout-merge', current: 'main' });

      // Merge #2: rev-parse throws and resolveCurrentGitBranch() falls back to null via catch.
      revParseShouldThrow = true;
      await branchWorkflow.createWorkingBranch(project.id, { name: 'feature/revparse-throws-merge' });

      const branchRow2 = await branchWorkflow.__testing.getSql(
        'SELECT id FROM branches WHERE project_id = ? AND name = ?',
        [project.id, 'feature/revparse-throws-merge']
      );

      await branchWorkflow.__testing.runSql(
        'UPDATE branches SET status = ? WHERE id = ?',
        ['ready-for-merge', branchRow2.id]
      );

      await branchWorkflow.__testing.runSql(
        `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
         VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [project.id, branchRow2.id]
      );

      const result2 = await branchWorkflow.mergeBranch(project.id, 'feature/revparse-throws-merge');
      expect(result2).toMatchObject({ mergedBranch: 'feature/revparse-throws-merge', current: 'main' });

      const attemptedMerge = gitSpies.runGitCommand.mock.calls.some((call) => {
        const [cwd, callArgs] = call;
        return cwd === targetPath && Array.isArray(callArgs) && callArgs[0] === 'merge';
      });
      expect(attemptedMerge).toBe(true);
    });
  });

  it('bumps VERSION and rolls changelog entries after merging to main', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T12:00:00Z'));

    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-merge-bump-'));

    try {
      const changelogText = [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '- Add merge bump test coverage',
        '',
        '## 0.1.0 (2026-01-01)',
        '',
        '- Initial scaffold'
      ].join('\n');

      await fs.writeFile(path.join(targetPath, 'VERSION'), '0.1.0\n', 'utf8');
      await fs.writeFile(path.join(targetPath, 'CHANGELOG.md'), changelogText + '\n', 'utf8');

      await fs.mkdir(path.join(targetPath, 'frontend'), { recursive: true });
      await fs.mkdir(path.join(targetPath, 'backend'), { recursive: true });

      await fs.writeFile(
        path.join(targetPath, 'frontend', 'package.json'),
        JSON.stringify({ name: 'frontend', version: '0.1.0' }, null, 2) + '\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(targetPath, 'backend', 'package.json'),
        JSON.stringify({ name: 'backend', version: '0.1.0' }, null, 2) + '\n',
        'utf8'
      );

      let headSha = 'sha-main-0';
      const mergedBranches = new Set();

      await runGitScenario(
        async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
          const project = await createProject({
            ...createProjectPayload('-merge-bump'),
            path: targetPath
          });
          forceGitContext(project.id, targetPath);

          const branchName = 'feature/merge-bump';
          await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

          const branchRow = await branchWorkflow.__testing.getSql(
            'SELECT id FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );

          await branchWorkflow.__testing.runSql(
            'UPDATE branches SET status = ? WHERE id = ?',
            ['ready-for-merge', branchRow.id]
          );

          await branchWorkflow.__testing.runSql(
            `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
             VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [project.id, branchRow.id]
          );

          const result = await branchWorkflow.mergeBranch(project.id, branchName);
          expect(result).toMatchObject({ mergedBranch: branchName, current: 'main' });

          const mergedRow = await branchWorkflow.__testing.getSql(
            'SELECT status FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );
          expect(mergedRow?.status).toBe('merged');

          const versionAfter = (await fs.readFile(path.join(targetPath, 'VERSION'), 'utf8')).trim();
          expect(versionAfter).toBe('0.1.1');

          const changelogAfter = await fs.readFile(path.join(targetPath, 'CHANGELOG.md'), 'utf8');
          expect(changelogAfter).toMatch(/##\s+0\.1\.1\s+\(2026-01-24\)/);
          expect(changelogAfter).toMatch(/- Add merge bump test coverage/);

          const frontendPkg = JSON.parse(await fs.readFile(path.join(targetPath, 'frontend', 'package.json'), 'utf8'));
          const backendPkg = JSON.parse(await fs.readFile(path.join(targetPath, 'backend', 'package.json'), 'utf8'));
          expect(frontendPkg.version).toBe('0.1.1');
          expect(backendPkg.version).toBe('0.1.1');

          const bumpCommitCall = gitSpies.runGitCommand.mock.calls.find((call) => {
            const [, args] = call;
            return Array.isArray(args)
              && args[0] === 'commit'
              && args[1] === '-m'
              && String(args[2] || '').includes('chore: bump version to 0.1.1');
          });
          expect(bumpCommitCall).toBeTruthy();
        },
        {
          gitOverrides: {
            runGitCommand: async (cwd, args = []) => {
              if (cwd !== targetPath || !Array.isArray(args)) {
                return { stdout: '', stderr: '', code: 0 };
              }

              // Changelog enforcement
              if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
                return { stdout: changelogText + '\n', stderr: '', code: 0 };
              }

              if (args[0] === 'diff' && args[1] === '--name-only' && typeof args[2] === 'string') {
                // listBranchChangedPaths() uses: diff --name-only main..branch
                if (args[2].startsWith('main..')) {
                  return { stdout: 'CHANGELOG.md\n', stderr: '', code: 0 };
                }
              }

              // Merge workflow
              if (args[0] === 'status' && args[1] === '--porcelain') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
                return { stdout: 'main\n', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return { stdout: `${headSha}\n`, stderr: '', code: 0 };
              }

              if (args[0] === 'show-ref' && args[1] === '--verify') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'checkout' && args[1] === '-b') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'checkout') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'merge' && args[1] === '--no-ff' && typeof args[2] === 'string') {
                mergedBranches.add(args[2]);
                headSha = `sha-main-merged-${mergedBranches.size}`;
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'add') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'commit' && args[1] === '-m') {
                headSha = `sha-main-bump-${Date.now()}`;
                return { stdout: '', stderr: '', code: 0 };
              }

              return { stdout: '', stderr: '', code: 0 };
            }
          }
        }
      );
    } finally {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
      vi.useRealTimers();
    }
  });

  it('continues merge when pre-merge HEAD sha cannot be resolved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T12:00:00Z'));

    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-merge-nopre-'));

    try {
      const changelogText = [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '- Ensure pre-merge sha fallback is covered'
      ].join('\n');

      await fs.writeFile(path.join(targetPath, 'VERSION'), '0.1.0\n', 'utf8');
      await fs.writeFile(path.join(targetPath, 'CHANGELOG.md'), changelogText + '\n', 'utf8');

      let headSha = 'sha-main-0';
      let preMergeRevParseShouldThrow = true;

      await runGitScenario(
        async ({ branchWorkflow, createProject, forceGitContext }) => {
          const project = await createProject({
            ...createProjectPayload('-merge-nopre'),
            path: targetPath
          });
          forceGitContext(project.id, targetPath);

          const branchName = 'feature/premerge-sha-fails';
          await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

          const branchRow = await branchWorkflow.__testing.getSql(
            'SELECT id FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );

          await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
          await branchWorkflow.__testing.runSql(
            `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
             VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [project.id, branchRow.id]
          );

          const result = await branchWorkflow.mergeBranch(project.id, branchName);
          expect(result).toMatchObject({ mergedBranch: branchName, current: 'main' });

          const versionAfter = (await fs.readFile(path.join(targetPath, 'VERSION'), 'utf8')).trim();
          expect(versionAfter).toBe('0.1.1');
        },
        {
          gitOverrides: {
            runGitCommand: async (cwd, args = []) => {
              if (cwd !== targetPath || !Array.isArray(args)) {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
                return { stdout: changelogText + '\n', stderr: '', code: 0 };
              }

              if (args[0] === 'diff' && args[1] === '--name-only' && typeof args[2] === 'string' && args[2].startsWith('main..')) {
                return { stdout: 'CHANGELOG.md\n', stderr: '', code: 0 };
              }

              if (args[0] === 'status' && args[1] === '--porcelain') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
                return { stdout: 'main\n', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                if (preMergeRevParseShouldThrow) {
                  preMergeRevParseShouldThrow = false;
                  throw new Error('rev-parse HEAD failed');
                }
                return { stdout: `${headSha}\n`, stderr: '', code: 0 };
              }

              if (args[0] === 'show-ref' && args[1] === '--verify') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'checkout') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'merge') {
                headSha = `sha-main-merged-${Date.now()}`;
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'add') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'commit') {
                headSha = `sha-main-bump-${Date.now()}`;
                return { stdout: '', stderr: '', code: 0 };
              }

              return { stdout: '', stderr: '', code: 0 };
            }
          }
        }
      );
    } finally {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
      vi.useRealTimers();
    }
  });

  it('resets main to pre-merge sha when version bump commit fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T12:00:00Z'));

    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-merge-reset-'));

    try {
      const changelogText = [
        '# Changelog',
        '',
        '## Unreleased',
        '',
        '- Force bump failure to cover reset'
      ].join('\n');

      await fs.writeFile(path.join(targetPath, 'VERSION'), '0.1.0\n', 'utf8');
      await fs.writeFile(path.join(targetPath, 'CHANGELOG.md'), changelogText + '\n', 'utf8');

      const preMergeSha = 'sha-main-pre-merge';
      let sawReset = false;

      await runGitScenario(
        async ({ branchWorkflow, createProject, forceGitContext }) => {
          const project = await createProject({
            ...createProjectPayload('-merge-reset'),
            path: targetPath
          });
          forceGitContext(project.id, targetPath);

          const branchName = 'feature/bump-fails';
          await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

          const branchRow = await branchWorkflow.__testing.getSql(
            'SELECT id FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );

          await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
          await branchWorkflow.__testing.runSql(
            `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
             VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [project.id, branchRow.id]
          );

          const err = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
          expect(err).toBeTruthy();
          expect(err).toMatchObject({ statusCode: 500 });
          expect(String(err.message || '')).toMatch(/Failed to bump version after merge/i);
          expect(sawReset).toBe(true);
        },
        {
          gitOverrides: {
            runGitCommand: async (cwd, args = []) => {
              if (cwd !== targetPath || !Array.isArray(args)) {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
                return { stdout: changelogText + '\n', stderr: '', code: 0 };
              }

              if (args[0] === 'diff' && args[1] === '--name-only' && typeof args[2] === 'string' && args[2].startsWith('main..')) {
                return { stdout: 'CHANGELOG.md\n', stderr: '', code: 0 };
              }

              if (args[0] === 'status' && args[1] === '--porcelain') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
                return { stdout: 'main\n', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return { stdout: `${preMergeSha}\n`, stderr: '', code: 0 };
              }

              if (args[0] === 'show-ref' && args[1] === '--verify') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'checkout') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'merge') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'add') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'commit' && args[1] === '-m' && String(args[2] || '').startsWith('chore: bump version to')) {
                throw new Error('commit failed');
              }

              if (args[0] === 'reset' && args[1] === '--hard' && args[2] === preMergeSha) {
                sawReset = true;
                return { stdout: '', stderr: '', code: 0 };
              }

              return { stdout: '', stderr: '', code: 0 };
            }
          }
        }
      );
    } finally {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
      vi.useRealTimers();
    }
  });

  it('bumps version even if the on-disk changelog lacks an Unreleased heading (enforcement skipped)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T12:00:00Z'));

    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-merge-no-unreleased-'));

    try {
      const onDiskChangelog = [
        '# Changelog',
        '',
        '## 0.1.0 (2026-01-01)',
        '',
        '- Initial scaffold'
      ].join('\n');

      await fs.writeFile(path.join(targetPath, 'VERSION'), '0.1.0\n', 'utf8');
      await fs.writeFile(path.join(targetPath, 'CHANGELOG.md'), onDiskChangelog + '\n', 'utf8');

      // Git-probed changelog is empty -> enforcement returns early.
      const gitChangelogText = '';

      await runGitScenario(
        async ({ branchWorkflow, createProject, forceGitContext }) => {
          const project = await createProject({
            ...createProjectPayload('-merge-no-unreleased'),
            path: targetPath
          });
          forceGitContext(project.id, targetPath);

          const branchName = 'feature/no-unreleased';
          await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

          const branchRow = await branchWorkflow.__testing.getSql(
            'SELECT id FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );

          await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
          await branchWorkflow.__testing.runSql(
            `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
             VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [project.id, branchRow.id]
          );

          const result = await branchWorkflow.mergeBranch(project.id, branchName);
          expect(result).toMatchObject({ mergedBranch: branchName, current: 'main' });

          const versionAfter = (await fs.readFile(path.join(targetPath, 'VERSION'), 'utf8')).trim();
          expect(versionAfter).toBe('0.1.1');

          const changelogAfter = await fs.readFile(path.join(targetPath, 'CHANGELOG.md'), 'utf8');
          // No Unreleased section means we don't inject a new section; we just preserve content.
          expect(changelogAfter).toContain('## 0.1.0 (2026-01-01)');
        },
        {
          gitOverrides: {
            runGitCommand: async (cwd, args = []) => {
              if (cwd !== targetPath || !Array.isArray(args)) {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
                return { stdout: gitChangelogText, stderr: '', code: 0 };
              }

              if (args[0] === 'status' && args[1] === '--porcelain') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse') {
                return { stdout: 'sha\n', stderr: '', code: 0 };
              }

              if (args[0] === 'show-ref') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'checkout' || args[0] === 'merge' || args[0] === 'add' || args[0] === 'commit') {
                return { stdout: '', stderr: '', code: 0 };
              }

              return { stdout: '', stderr: '', code: 0 };
            }
          }
        }
      );
    } finally {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
      vi.useRealTimers();
    }
  });

  it('rejects merges when branch is not ready-for-merge and not css-only', async () => {
    const targetPath = `C:/tmp/git-merge-not-ready-${Date.now()}`;

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-merge-not-ready'),
          path: targetPath
        });
        forceGitContext(project.id, targetPath);

        const branchName = 'feature/not-ready';
        await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, branchName]
        );

        // Keep status as "active" (default from createWorkingBranch).
        await branchWorkflow.__testing.runSql(
          `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
           VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [project.id, branchRow.id]
        );

        const error = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
        expect(error).toBeTruthy();
        expect(error).toMatchObject({ statusCode: 400 });
        expect(String(error.message || '')).toMatch(/Branch must pass tests before merging/i);
      },
      {
        gitOverrides: {
          runGitCommand: async () => ({ stdout: '' })
        }
      }
    );
  });

  it('rejects merges when the latest test run is missing', async () => {
    const targetPath = `C:/tmp/git-merge-missing-test-${Date.now()}`;

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-merge-missing-test'),
          path: targetPath
        });
        forceGitContext(project.id, targetPath);

        const branchName = 'feature/missing-test';
        await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, branchName]
        );

        await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);

        // Intentionally do NOT insert a test_runs row.
        const error = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
        expect(error).toBeTruthy();
        expect(error).toMatchObject({ statusCode: 400 });
        expect(String(error.message || '')).toMatch(/Latest test run must pass/i);
      },
      {
        gitOverrides: {
          runGitCommand: async () => ({ stdout: '' })
        }
      }
    );
  });

  it('rejects merges when the latest test run failed', async () => {
    const targetPath = `C:/tmp/git-merge-failed-test-${Date.now()}`;

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-merge-failed-test'),
          path: targetPath
        });
        forceGitContext(project.id, targetPath);

        const branchName = 'feature/failed-test';
        await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, branchName]
        );

        await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
        await branchWorkflow.__testing.runSql(
          `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
           VALUES (?, ?, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [project.id, branchRow.id]
        );

        const error = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
        expect(error).toBeTruthy();
        expect(error).toMatchObject({ statusCode: 400 });
        expect(String(error.message || '')).toMatch(/Latest test run must pass/i);
      },
      {
        gitOverrides: {
          runGitCommand: async () => ({ stdout: '' })
        }
      }
    );
  });

  it('enforces Unreleased section presence when changelog exists in git', async () => {
    const targetPath = `C:/tmp/git-merge-changelog-no-unreleased-${Date.now()}`;
    const changelogWithoutUnreleased = ['# Changelog', '', '## 0.1.0', '', '- Initial'].join('\n') + '\n';

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-merge-changelog-no-unreleased'),
          path: targetPath
        });
        forceGitContext(project.id, targetPath);

        const branchName = 'feature/changelog-no-unreleased';
        await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, branchName]
        );

        await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
        await branchWorkflow.__testing.runSql(
          `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
           VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [project.id, branchRow.id]
        );

        const error = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
        expect(error).toBeTruthy();
        expect(error).toMatchObject({ statusCode: 400 });
        expect(String(error.message || '')).toMatch(/must include an\s+"Unreleased"\s+section/i);
      },
      {
        gitOverrides: {
          runGitCommand: async (cwd, args = []) => {
            if (cwd !== targetPath || !Array.isArray(args)) {
              return { stdout: '' };
            }

            if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
              return { stdout: changelogWithoutUnreleased };
            }

            if (args[0] === 'diff' && args[1] === '--name-only') {
              // Ensure CHANGELOG.md is considered touched so we reach Unreleased parsing.
              return { stdout: 'CHANGELOG.md\n' };
            }

            return { stdout: '' };
          }
        }
      }
    );
  });

  it('enforces at least one Unreleased entry when changelog exists in git', async () => {
    const targetPath = `C:/tmp/git-merge-changelog-empty-unreleased-${Date.now()}`;
    const changelogEmptyUnreleased = ['# Changelog', '', '## Unreleased', '', '## 0.1.0', '', '- Initial'].join('\n') + '\n';

    await runGitScenario(
      async ({ branchWorkflow, createProject, forceGitContext }) => {
        const project = await createProject({
          ...createProjectPayload('-merge-changelog-empty-unreleased'),
          path: targetPath
        });
        forceGitContext(project.id, targetPath);

        const branchName = 'feature/changelog-empty-unreleased';
        await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

        const branchRow = await branchWorkflow.__testing.getSql(
          'SELECT id FROM branches WHERE project_id = ? AND name = ?',
          [project.id, branchName]
        );

        await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
        await branchWorkflow.__testing.runSql(
          `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
           VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [project.id, branchRow.id]
        );

        const error = await branchWorkflow.mergeBranch(project.id, branchName).then(() => null).catch((e) => e);
        expect(error).toBeTruthy();
        expect(error).toMatchObject({ statusCode: 400 });
        expect(String(error.message || '')).toMatch(/at least one entry under Unreleased/i);
      },
      {
        gitOverrides: {
          runGitCommand: async (cwd, args = []) => {
            if (cwd !== targetPath || !Array.isArray(args)) {
              return { stdout: '' };
            }

            if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
              return { stdout: changelogEmptyUnreleased };
            }

            if (args[0] === 'diff' && args[1] === '--name-only') {
              return { stdout: 'CHANGELOG.md\n' };
            }

            return { stdout: '' };
          }
        }
      }
    );
  });

  it('skips post-merge bump when CHANGELOG.md is missing on disk (covers bumpVersionAfterMerge early return)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T12:00:00Z'));

    const targetPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-merge-missing-changelog-'));

    try {
      // Invalid semver in VERSION covers the parseSemver("no match") path; missing changelog forces early return.
      await fs.writeFile(path.join(targetPath, 'VERSION'), 'not-a-version\n', 'utf8');

      await runGitScenario(
        async ({ branchWorkflow, createProject, forceGitContext, gitSpies }) => {
          const project = await createProject({
            ...createProjectPayload('-merge-missing-changelog'),
            path: targetPath
          });
          forceGitContext(project.id, targetPath);

          const branchName = 'feature/missing-changelog';
          await branchWorkflow.createWorkingBranch(project.id, { name: branchName });

          const branchRow = await branchWorkflow.__testing.getSql(
            'SELECT id FROM branches WHERE project_id = ? AND name = ?',
            [project.id, branchName]
          );

          await branchWorkflow.__testing.runSql('UPDATE branches SET status = ? WHERE id = ?', ['ready-for-merge', branchRow.id]);
          await branchWorkflow.__testing.runSql(
            `INSERT INTO test_runs (project_id, branch_id, status, created_at, completed_at)
             VALUES (?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [project.id, branchRow.id]
          );

          const result = await branchWorkflow.mergeBranch(project.id, branchName);
          expect(result).toMatchObject({ mergedBranch: branchName, current: 'main' });

          const versionAfter = (await fs.readFile(path.join(targetPath, 'VERSION'), 'utf8')).trim();
          // Bump logic returns early before rewriting VERSION.
          expect(versionAfter).toBe('not-a-version');

          const bumpCommitAttempted = gitSpies.runGitCommand.mock.calls.some((call) => {
            const [, args] = call;
            return Array.isArray(args)
              && args[0] === 'commit'
              && args[1] === '-m'
              && String(args[2] || '').includes('chore: bump version to');
          });
          expect(bumpCommitAttempted).toBe(false);
        },
        {
          gitOverrides: {
            runGitCommand: async (cwd, args = []) => {
              if (cwd !== targetPath || !Array.isArray(args)) {
                return { stdout: '', stderr: '', code: 0 };
              }

              // Make enforcement a no-op.
              if (args[0] === 'show' && typeof args[1] === 'string' && /:CHANGELOG\.md$/.test(args[1])) {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'status' && args[1] === '--porcelain') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
                return { stdout: 'main\n', stderr: '', code: 0 };
              }

              if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
                return { stdout: 'sha-main\n', stderr: '', code: 0 };
              }

              if (args[0] === 'show-ref' || args[0] === 'checkout' || args[0] === 'merge') {
                return { stdout: '', stderr: '', code: 0 };
              }

              if (args[0] === 'add' || args[0] === 'commit' || args[0] === 'reset') {
                return { stdout: '', stderr: '', code: 0 };
              }

              return { stdout: '', stderr: '', code: 0 };
            }
          }
        }
      );
    } finally {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
      vi.useRealTimers();
    }
  });

  it('exposes scheduled auto test handles via the testing helpers', async () => {
    await runGitScenario(async ({ branchWorkflow, createProject }) => {
      const project = await createProject(createProjectPayload('-auto-handle'));

      const staged = await branchWorkflow.stageWorkspaceChange(project.id, {
        filePath: 'src/auto/trigger.js',
        autoRun: true,
        autoRunDelayMs: 25
      });

      const handle = branchWorkflow.__testing.getAutoTestHandle(project.id, staged.branch.name);
      expect(handle).toBeTruthy();

      branchWorkflow.__testing.cancelScheduledAutoTests(project.id, staged.branch.name);
    });
  });
});
