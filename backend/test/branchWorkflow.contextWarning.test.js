import { describe, it, expect, vi } from 'vitest';

const runScenario = async ({ isWithinManagedProjectsRootResult }) => {
  vi.resetModules();

  vi.doMock('../routes/projects/cleanup.js', () => ({
    isWithinManagedProjectsRoot: vi.fn(() => isWithinManagedProjectsRootResult)
  }));

  const ensureGitRepository = vi.fn().mockResolvedValue();
  vi.doMock('../utils/git.js', () => ({
    ensureGitRepository,
    runGitCommand: vi.fn()
  }));

  const database = await import('../database.js');
  const { initializeDatabase, createProject } = database;

  await initializeDatabase();

  const project = await createProject({
    name: 'Context warning project',
    description: 'Covers managed root warning',
    language: 'javascript',
    framework: 'react',
    path: 'C:/tmp/outside-managed-root'
  });

  const contextModule = await import('../services/branchWorkflow/context.js');
  contextModule.setTestModeOverride(false);

  try {
    const context = await contextModule.getProjectContext(project.id);
    return { context, contextModule, ensureGitRepository };
  } finally {
    contextModule.setTestModeOverride(null);
  }
};

describe('branchWorkflow context warnings', () => {
  it('logs a warning when project path is outside the managed root', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { context, ensureGitRepository } = await runScenario({ isWithinManagedProjectsRootResult: false });

      expect(context.projectPath).toBe('C:/tmp/outside-managed-root');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('outside managed root')
      );
      expect(ensureGitRepository).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns via branchWorkflow when project path is outside the managed root', async () => {
    vi.resetModules();
    const database = await import('../database.js');
    const branchWorkflow = await import('../services/branchWorkflow.js');
    const cleanup = await import('../routes/projects/cleanup.js');
    const git = await import('../utils/git.js');

    await database.initializeDatabase();
    const project = await database.createProject({
      name: 'Context warning project (branchWorkflow)',
      description: 'Covers managed root warning',
      language: 'javascript',
      framework: 'react',
      path: 'C:/tmp/outside-managed-root'
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootSpy = vi.spyOn(cleanup, 'isWithinManagedProjectsRoot').mockReturnValue(false);
    const ensureRepoSpy = vi.spyOn(git, 'ensureGitRepository').mockResolvedValue();

    try {
      branchWorkflow.__testing.setTestModeOverride(false);

      const context = await branchWorkflow.__testing.getProjectContext(project.id);
      expect(context.projectPath).toBe('C:/tmp/outside-managed-root');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('outside managed root')
      );
      expect(ensureRepoSpy).toHaveBeenCalled();
    } finally {
      rootSpy.mockRestore();
      branchWorkflow.__testing.setTestModeOverride(null);
      warnSpy.mockRestore();
    }
  });

  it('warns when managed root check is forced false via spy', async () => {
    vi.resetModules();

    const database = await import('../database.js');
    const cleanup = await import('../routes/projects/cleanup.js');
    const git = await import('../utils/git.js');
    const contextModule = await import('../services/branchWorkflow/context.js');

    await database.initializeDatabase();
    const project = await database.createProject({
      name: 'Context warning project (spy)',
      description: 'Covers managed root warning',
      language: 'javascript',
      framework: 'react',
      path: 'C:/tmp/outside-managed-root'
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rootSpy = vi.spyOn(cleanup, 'isWithinManagedProjectsRoot').mockReturnValue(false);
    const ensureRepoSpy = vi.spyOn(git, 'ensureGitRepository').mockResolvedValue();

    try {
      contextModule.setTestModeOverride(false);

      const context = await contextModule.getProjectContext(project.id);
      expect(context.projectPath).toBe('C:/tmp/outside-managed-root');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('outside managed root')
      );
      expect(ensureRepoSpy).toHaveBeenCalled();
    } finally {
      rootSpy.mockRestore();
      contextModule.setTestModeOverride(null);
      warnSpy.mockRestore();
    }
  });
});
