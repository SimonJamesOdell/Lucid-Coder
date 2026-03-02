import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn((_file, _args, _options, callback) => {
    if (typeof callback === 'function') {
      callback(null, '', '');
    }
  })
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    execFile: execFileMock
  };
});

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
  let fsMock;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    execFileMock.mockClear();

    const { getProject } = await import('../database.js');
    getProject.mockResolvedValue(project);

    const internals = await import('../routes/projects/internals.js');

    fsMock = {
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

  it('skips llm bundle rebuild when bundle script stat resolves as non-file', async () => {
    fsMock.stat.mockImplementation(async (targetPath) => {
      if (String(targetPath).includes('build_llm_bundle.cjs')) {
        return { isFile: () => false };
      }
      return { isFile: () => true };
    });

    await request(app)
      .put('/api/projects/123/files/llm_src/styles/style_Global.json')
      .send({ content: '{"css":"body{}"}' })
      .expect(200);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('skips llm bundle rebuild when bundle script stat throws', async () => {
    fsMock.stat.mockImplementation(async (targetPath) => {
      if (String(targetPath).includes('build_llm_bundle.cjs')) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => true };
    });

    await request(app)
      .put('/api/projects/123/files/llm_src/styles/style_Global.json')
      .send({ content: '{"css":"body{}"}' })
      .expect(200);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('continues request when llm bundle rebuild command fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      if (typeof callback === 'function') {
        callback(new Error('bundle failed'));
      }
    });

    await request(app)
      .put('/api/projects/123/files/llm_src/styles/style_Global.json')
      .send({ content: '{"css":"body{}"}' })
      .expect(200);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs raw rebuild failure value when llm bundle rebuild throws without a message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      if (typeof callback === 'function') {
        callback('bundle failed without message field');
      }
    });

    await request(app)
      .put('/api/projects/123/files/llm_src/styles/style_Global.json')
      .send({ content: '{"css":"body{}"}' })
      .expect(200);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to rebuild llm bundle after file edit:',
      'bundle failed without message field'
    );
    warnSpy.mockRestore();
  });
});
