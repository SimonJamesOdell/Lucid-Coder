import { describe, expect, test, vi } from 'vitest';
import {
  normalizeImportMethod,
  normalizeImportMode,
  safeTrim,
  extractRepoName,
  resolveImportProjectName,
  resolveImportPayloadConfig,
  ensureLocalImportGitRepository,
  importProjectFromGit,
  importProjectFromLocal,
  applyImportPostProcessing,
  isCloneTargetNotEmptyError,
  resolveImportGitSettings,
  normalizeProjectDates,
  serializeJob
} from '../routes/projects/helpers.js';

describe('projects route helpers', () => {
  test('normalizes import method and mode', () => {
    expect(normalizeImportMethod('git')).toBe('git');
    expect(normalizeImportMethod('other')).toBe('local');
    expect(normalizeImportMode('link')).toBe('link');
    expect(normalizeImportMode('copy')).toBe('copy');
    expect(normalizeImportMode('other')).toBe('copy');
  });

  test('extractRepoName handles ssh and https git URLs', () => {
    expect(extractRepoName('https://github.com/org/repo.git')).toBe('repo');
    expect(extractRepoName('git@github.com:org/repo.git')).toBe('repo');
    expect(extractRepoName('')).toBe('');
  });

  test('resolveImportProjectName prefers explicit name and falls back by method', () => {
    expect(resolveImportProjectName({
      importMethod: 'git',
      payload: { name: '  custom-name  ', gitUrl: 'https://github.com/org/repo.git' }
    })).toBe('custom-name');

    expect(resolveImportProjectName({
      importMethod: 'git',
      payload: { gitUrl: 'git@github.com:org/repo.git' }
    })).toBe('repo');

    expect(resolveImportProjectName({
      importMethod: 'local',
      payload: { localPath: 'C:/workspaces/demo-app' }
    })).toBe('demo-app');
  });

  test('resolveImportPayloadConfig applies defaults and trims explicit values', () => {
    expect(resolveImportPayloadConfig({})).toEqual({
      frontendConfig: { language: 'javascript', framework: 'react' },
      backendConfig: { language: 'javascript', framework: 'express' },
      description: '',
      gitProvider: 'github'
    });

    expect(resolveImportPayloadConfig({
      description: '  demo  ',
      gitProvider: '  gitlab  ',
      frontend: { language: ' typescript ', framework: ' vue ' },
      backend: { language: ' python ', framework: ' flask ' }
    })).toEqual({
      frontendConfig: { language: 'typescript', framework: 'vue' },
      backendConfig: { language: 'python', framework: 'flask' },
      description: 'demo',
      gitProvider: 'gitlab'
    });
  });

  test('ensureLocalImportGitRepository initializes only for local imports without git dir', async () => {
    const dirExistsFn = vi.fn(async () => false);
    const ensureGitRepositoryFn = vi.fn(async () => {});
    const configureGitUserFn = vi.fn(async () => {});
    const ensureInitialCommitFn = vi.fn(async () => {});

    await ensureLocalImportGitRepository({
      importMethod: 'local',
      projectPath: '/repo/project',
      payload: { gitDefaultBranch: ' develop ' },
      globalGitSettings: { username: 'u', email: 'e@example.com' },
      dirExistsFn,
      ensureGitRepositoryFn,
      configureGitUserFn,
      ensureInitialCommitFn
    });

    expect(ensureGitRepositoryFn).toHaveBeenCalledWith('/repo/project', { defaultBranch: 'develop' });
    expect(configureGitUserFn).toHaveBeenCalledWith('/repo/project', { name: 'u', email: 'e@example.com' });
    expect(ensureInitialCommitFn).toHaveBeenCalledWith('/repo/project', 'Initial commit');

    const dirExistsTrueFn = vi.fn(async () => true);
    const skippedInitFn = vi.fn(async () => {});
    await ensureLocalImportGitRepository({
      importMethod: 'git',
      projectPath: '/repo/project',
      payload: {},
      globalGitSettings: {},
      dirExistsFn: dirExistsTrueFn,
      ensureGitRepositoryFn: skippedInitFn,
      configureGitUserFn: vi.fn(async () => {}),
      ensureInitialCommitFn: vi.fn(async () => {})
    });
    expect(skippedInitFn).not.toHaveBeenCalled();
  });

  test('importProjectFromGit validates URL and returns cloned state', async () => {
    await expect(importProjectFromGit({
      payload: {},
      projectName: 'p',
      gitProvider: 'github',
      resolveProjectPathFn: vi.fn(),
      prepareTargetPathFn: vi.fn(),
      buildCloneUrlFn: vi.fn(),
      getProjectsDirFn: vi.fn(),
      mkdirFn: vi.fn(),
      runGitCommandFn: vi.fn(),
      getCurrentBranchFn: vi.fn()
    })).rejects.toMatchObject({ statusCode: 400, message: 'Git repository URL is required' });

    const runGitCommandFn = vi.fn(async () => ({ code: 0, stdout: '' }));
    const result = await importProjectFromGit({
      payload: { gitUrl: 'https://example.com/repo.git', gitAuthMethod: 'ssh' },
      projectName: 'proj',
      gitProvider: 'github',
      resolveProjectPathFn: vi.fn(() => '/projects/proj'),
      prepareTargetPathFn: vi.fn(async () => true),
      buildCloneUrlFn: vi.fn(() => ({ cloneUrl: 'git@example.com:repo.git', safeUrl: 'https://example.com/repo.git' })),
      getProjectsDirFn: vi.fn(() => '/projects'),
      mkdirFn: vi.fn(async () => {}),
      runGitCommandFn,
      getCurrentBranchFn: vi.fn(async () => 'main')
    });

    expect(result).toEqual({
      projectPath: '/projects/proj',
      createdProjectPath: '/projects/proj',
      gitRemoteUrl: 'https://example.com/repo.git',
      gitDefaultBranch: 'main'
    });
  });

  test('importProjectFromLocal validates path and handles link/copy flows', async () => {
    const common = {
      assertDirectoryExistsFn: vi.fn(async () => {}),
      isWithinManagedProjectsRootFn: vi.fn(() => false),
      resolveProjectPathFn: vi.fn(() => '/projects/name'),
      prepareTargetPathFn: vi.fn(async () => true),
      copyProjectFilesWithFallbackFn: vi.fn(async () => {})
    };

    await expect(importProjectFromLocal({
      payload: {},
      importMode: 'copy',
      projectName: 'name',
      ...common
    })).rejects.toMatchObject({ statusCode: 400, message: 'Project path is required' });

    await expect(importProjectFromLocal({
      payload: { localPath: '/outside' },
      importMode: 'link',
      projectName: 'name',
      ...common
    })).rejects.toMatchObject({ statusCode: 400 });

    const assertDirectoryExistsFn = vi.fn(async () => {});
    const isWithinManagedProjectsRootFn = vi.fn(() => true);
    const resolveProjectPathFn = vi.fn(() => '/projects/name');
    const prepareTargetPathFn = vi.fn(async () => true);
    const copyProjectFilesWithFallbackFn = vi.fn(async () => {});

    const linkResult = await importProjectFromLocal({
      payload: { localPath: '/projects/name' },
      importMode: 'link',
      projectName: 'name',
      assertDirectoryExistsFn,
      isWithinManagedProjectsRootFn,
      resolveProjectPathFn,
      prepareTargetPathFn,
      copyProjectFilesWithFallbackFn
    });
    const copyResult = await importProjectFromLocal({
      payload: { localPath: '/source/name' },
      importMode: 'copy',
      projectName: 'name',
      assertDirectoryExistsFn,
      isWithinManagedProjectsRootFn,
      resolveProjectPathFn,
      prepareTargetPathFn,
      copyProjectFilesWithFallbackFn
    });

    expect(linkResult).toEqual({ projectPath: '/projects/name', createdProjectPath: null });
    expect(copyResult).toEqual({ projectPath: '/projects/name', createdProjectPath: '/projects/name' });
    expect(copyProjectFilesWithFallbackFn).toHaveBeenCalledWith('/source/name', '/projects/name');
  });

  test('applyImportPostProcessing applies flags and maps failures to 400', async () => {
    await expect(applyImportPostProcessing({
      projectPath: '/repo/p',
      applyStructureFix: false,
      applyCompatibilityChanges: false,
      applyProjectStructureFn: vi.fn(async () => ({})),
      applyCompatibilityFn: vi.fn(async () => ({}))
    })).resolves.toEqual({ structureResult: null, compatibilityResult: null });

    await expect(applyImportPostProcessing({
      projectPath: '/repo/p',
      applyStructureFix: true,
      applyCompatibilityChanges: false,
      applyProjectStructureFn: vi.fn(async () => {
        throw new Error('structure failed');
      }),
      applyCompatibilityFn: vi.fn(async () => ({}))
    })).rejects.toMatchObject({ statusCode: 400, message: 'structure failed' });

    await expect(applyImportPostProcessing({
      projectPath: '/repo/p',
      applyStructureFix: false,
      applyCompatibilityChanges: true,
      applyProjectStructureFn: vi.fn(async () => ({})),
      applyCompatibilityFn: vi.fn(async () => {
        throw new Error();
      })
    })).rejects.toMatchObject({ statusCode: 400, message: 'Failed to apply compatibility changes' });
  });

  test('resolveImportGitSettings honors local/global/custom modes', () => {
    const local = resolveImportGitSettings({
      payload: { gitConnectionMode: 'local', gitProvider: 'github' },
      globalSettings: { provider: 'gitlab', username: 'global-user', defaultBranch: 'main' },
      gitRemoteUrl: 'https://github.com/org/repo.git',
      gitDefaultBranch: 'develop',
      fallbackProvider: 'github'
    });
    expect(local.workflow).toBe('local');
    expect(local.remoteUrl).toBe('');

    const global = resolveImportGitSettings({
      payload: { gitConnectionMode: 'global' },
      globalSettings: { provider: 'gitlab', username: 'global-user', defaultBranch: 'main' },
      gitRemoteUrl: 'https://example.com/repo.git',
      gitDefaultBranch: '',
      fallbackProvider: 'github'
    });
    expect(global.workflow).toBe('cloud');
    expect(global.provider).toBe('gitlab');
    expect(global.username).toBe('global-user');

    const custom = resolveImportGitSettings({
      payload: {
        gitConnectionMode: 'custom',
        gitConnectionProvider: 'github',
        gitUsername: 'custom-user',
        gitRemoteUrl: 'https://example.com/custom.git',
        gitDefaultBranch: 'release'
      },
      globalSettings: { provider: 'gitlab', username: 'global-user', defaultBranch: 'main' },
      gitRemoteUrl: '',
      gitDefaultBranch: '',
      fallbackProvider: 'github'
    });
    expect(custom.provider).toBe('github');
    expect(custom.username).toBe('custom-user');
    expect(custom.defaultBranch).toBe('release');
  });

  test('utility helpers preserve compatibility behavior', () => {
    expect(safeTrim('  hi  ')).toBe('hi');
    expect(safeTrim(null)).toBe('');

    expect(isCloneTargetNotEmptyError({ message: 'already exists and is not an empty directory' })).toBe(true);
    expect(isCloneTargetNotEmptyError({ message: 'different error' })).toBe(false);

    expect(normalizeProjectDates({ created_at: 'a' })).toEqual(expect.objectContaining({ createdAt: 'a', updatedAt: 'a' }));

    expect(serializeJob({ id: 1, project_id: 2, type: 'x', displayName: 'X' })).toEqual(
      expect.objectContaining({ id: 1, projectId: 2, type: 'x', displayName: 'X' })
    );
    expect(serializeJob(null)).toBeNull();
  });
});
