import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  deleteProjectGitSettings: vi.fn(),
  getGitSettings: vi.fn(),
  getProject: vi.fn(),
  getProjectGitSettings: vi.fn(),
  getGitSettingsToken: vi.fn(),
  saveProjectGitSettings: vi.fn()
}));

vi.mock('../database.js', () => ({
  __esModule: true,
  ...dbMocks
}));

const gitUtils = vi.hoisted(() => ({
  ensureGitRepository: vi.fn(),
  fetchRemote: vi.fn(),
  getAheadBehind: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRemoteUrl: vi.fn(),
  hasWorkingTreeChanges: vi.fn(),
  runGitCommand: vi.fn()
}));

vi.mock('../utils/git.js', () => ({
  __esModule: true,
  ...gitUtils
}));

const loadApp = async () => {
  const { registerProjectGitRoutes } = await import('../routes/projects/routes.git.js');
  const router = express.Router();
  registerProjectGitRoutes(router);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  return app;
};

describe('routes.git settings recovery coverage', () => {
  let app;

  beforeEach(async () => {
    Object.values(dbMocks).forEach((mockFn) => mockFn.mockReset?.());
    Object.values(gitUtils).forEach((mockFn) => mockFn.mockReset?.());
    gitUtils.ensureGitRepository.mockResolvedValue(undefined);
    gitUtils.getRemoteUrl.mockResolvedValue('https://github.com/octo/recovered.git');
    app = await loadApp();
  });

  it('recovers remote and persists default provider/branch', async () => {
    const projectId = '123';
    const projectPath = '/tmp/project';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({
      workflow: 'cloud',
      provider: '',
      defaultBranch: ''
    });
    dbMocks.saveProjectGitSettings.mockResolvedValue({
      workflow: 'cloud',
      provider: 'github',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/octo/recovered.git'
    });

    const response = await request(app)
      .get(`/api/projects/${projectId}/git-settings`)
      .expect(200);

    expect(response.body.inheritsFromGlobal).toBe(false);
    expect(response.body.projectSettings).toMatchObject({
      workflow: 'cloud',
      provider: 'github',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/octo/recovered.git'
    });

    expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(projectPath, { defaultBranch: 'main' });
    expect(dbMocks.saveProjectGitSettings).toHaveBeenCalledWith(projectId, expect.objectContaining({
      provider: 'github',
      defaultBranch: 'main'
    }));
  });
});