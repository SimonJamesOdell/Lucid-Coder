import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../database.js', () => ({
  getProject: vi.fn()
}));

vi.mock('../services/agentUiCommands.js', () => ({
  sendAgentUiCommand: vi.fn()
}));

vi.mock('../services/branchWorkflow.js', () => ({
  stageWorkspaceChange: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../routes/projects/cleanup.js', () => ({
  isWithinManagedProjectsRoot: vi.fn(() => true)
}));

vi.mock('../routes/projects/internals.js', () => ({
  buildFileTree: vi.fn(),
  assertNoSymlinkSegments: vi.fn().mockResolvedValue(),
  extractFileContentFromRequest: vi.fn((body) => body?.content),
  getFsModule: vi.fn(),
  isSensitiveRepoPath: vi.fn(() => false),
  normalizeRepoPath: vi.fn((value) => value),
  resolveProjectRelativePath: vi.fn(),
  requireDestructiveConfirmation: vi.fn()
}));

describe('Project file routes emit OPEN_FILE commands', () => {
  const project = {
    id: 123,
    path: 'C:/tmp/test-project'
  };

  const mockIo = { emit: vi.fn() };

  let app;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { getProject } = await import('../database.js');
    getProject.mockResolvedValue(project);

    const internals = await import('../routes/projects/internals.js');

    const fsMock = {
      stat: vi.fn().mockResolvedValue({ isFile: () => true }),
      writeFile: vi.fn().mockResolvedValue(),
      mkdir: vi.fn().mockResolvedValue()
    };

    internals.getFsModule.mockResolvedValue(fsMock);

    internals.resolveProjectRelativePath.mockImplementation((_projectPath, filePath) => {
      const normalized = String(filePath).replace(/^\/+/, '');
      return {
        normalized,
        fullPath: `C:/tmp/test-project/${normalized}`,
        resolvedPath: `C:/tmp/test-project/${normalized}`,
        projectResolved: 'C:/tmp/test-project'
      };
    });

    const routes = await import('../routes/projects/routes.files.js');

    app = express();
    app.use(express.json());
    app.set('io', mockIo);

    const router = express.Router();
    routes.registerProjectFileRoutes(router);
    app.use('/api/projects', router);
  });

  it('PUT /api/projects/:id/files/* sends OPEN_FILE when io is present', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    await request(app)
      .put('/api/projects/123/files/src/hello.js')
      .send({ content: 'console.log("hi")' })
      .expect(200);

    expect(sendAgentUiCommand).toHaveBeenCalledWith({
      io: mockIo,
      projectId: '123',
      command: { type: 'OPEN_FILE', payload: { filePath: 'src/hello.js' } }
    });
  });

  it('POST /api/projects/:id/files-ops/create-file sends OPEN_FILE when io is present', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');
    const { stageWorkspaceChange } = await import('../services/branchWorkflow.js');

    await request(app)
      .post('/api/projects/123/files-ops/create-file')
      .send({ filePath: 'src/newFile.js', content: 'export const x = 1;' })
      .expect(200);

    expect(sendAgentUiCommand).toHaveBeenCalledWith({
      io: mockIo,
      projectId: '123',
      command: { type: 'OPEN_FILE', payload: { filePath: 'src/newFile.js' } }
    });
    expect(stageWorkspaceChange).not.toHaveBeenCalled();
  });
});
