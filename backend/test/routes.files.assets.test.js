import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';

const { sharpMock } = vi.hoisted(() => ({
  sharpMock: vi.fn()
}));

vi.mock('sharp', () => ({
  default: sharpMock
}));

vi.mock('../database.js', () => ({
  getProject: vi.fn()
}));

vi.mock('../services/agentUiCommands.js', () => ({
  sendAgentUiCommand: vi.fn()
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

const createEnoentError = () => {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
};

describe('Project file routes assets coverage', () => {
  const project = {
    id: 321,
    path: 'C:/tmp/test-project'
  };

  const mockIo = { emit: vi.fn() };

  let app;
  let fsMock;
  let statMap;
  let metadataMap;
  let optimizeMetadata;
  let optimizeTransformer;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { getProject } = await import('../database.js');
    getProject.mockResolvedValue(project);

    statMap = new Map();
    metadataMap = new Map();
    optimizeMetadata = { width: 1536, height: 1024, hasAlpha: false };

    optimizeTransformer = {
      resize: vi.fn(),
      jpeg: vi.fn(),
      webp: vi.fn(),
      avif: vi.fn(),
      png: vi.fn(),
      toBuffer: vi.fn().mockResolvedValue({
        data: Buffer.from('optimized-binary'),
        info: { width: 1024, height: 683 }
      })
    };
    optimizeTransformer.resize.mockReturnValue(optimizeTransformer);
    optimizeTransformer.jpeg.mockReturnValue(optimizeTransformer);
    optimizeTransformer.webp.mockReturnValue(optimizeTransformer);
    optimizeTransformer.avif.mockReturnValue(optimizeTransformer);
    optimizeTransformer.png.mockReturnValue(optimizeTransformer);

    sharpMock.mockImplementation((fullPath, options) => {
      if (options?.animated === false) {
        return optimizeTransformer;
      }

      return {
        metadata: vi.fn().mockResolvedValue(metadataMap.get(fullPath) || optimizeMetadata)
      };
    });

    fsMock = {
      stat: vi.fn(async (fullPath) => {
        if (fullPath === 'C:/tmp/test-project/uploads') {
          return { isDirectory: () => true };
        }

        const entry = statMap.get(fullPath);
        if (!entry) {
          throw createEnoentError();
        }

        return {
          size: entry.size,
          isFile: () => entry.isFile !== false,
          isDirectory: () => entry.isDirectory === true
        };
      }),
      access: vi.fn(async () => {
        throw createEnoentError();
      }),
      writeFile: vi.fn().mockResolvedValue(),
      unlink: vi.fn().mockResolvedValue(),
      mkdir: vi.fn().mockResolvedValue()
    };

    const internals = await import('../routes/projects/internals.js');
    internals.getFsModule.mockResolvedValue(fsMock);
    internals.buildFileTree.mockResolvedValue([]);
    internals.resolveProjectRelativePath.mockImplementation((_projectPath, filePath) => {
      const normalized = String(filePath || '').replace(/^\/+/, '');
      return {
        normalized,
        fullPath: normalized
          ? `C:/tmp/test-project/${normalized}`
          : 'C:/tmp/test-project',
        resolvedPath: normalized
          ? `C:/tmp/test-project/${normalized}`
          : 'C:/tmp/test-project',
        projectResolved: 'C:/tmp/test-project'
      };
    });

    const routes = await import('../routes/projects/routes.files.js');

    app = express();
    app.use(express.json({ limit: '20mb' }));
    app.set('io', mockIo);
    const router = express.Router();
    routes.registerProjectFileRoutes(router);
    app.use('/api/projects', router);
  });

  it('GET /api/projects/:id/assets returns empty list when uploads folder is missing', async () => {
    fsMock.stat.mockImplementationOnce(async () => {
      throw createEnoentError();
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body).toEqual({ success: true, assets: [] });
  });

  it('GET /api/projects/:id/assets returns 404 when project is missing', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce(null);

    const response = await request(app)
      .get('/api/projects/999/assets')
      .expect(404);

    expect(response.body).toEqual({ success: false, error: 'Project not found' });
  });

  it('GET /api/projects/:id/assets returns 400 when project path is unavailable', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 321, path: '' });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'Project path not found. Please re-import or recreate the project.'
    });
  });

  it('GET /api/projects/:id/assets returns 400 when project path is out of scope', async () => {
    const cleanup = await import('../routes/projects/cleanup.js');
    cleanup.isWithinManagedProjectsRoot.mockReturnValueOnce(false);

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
  });

  it('GET /api/projects/:id/assets returns 400 when symlink validation rejects uploads root', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce({ statusCode: 400 });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('GET /api/projects/:id/assets returns 500 when symlink validation throws unexpected error', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce(new Error('symlink explode'));

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to load assets' });
  });

  it('GET /api/projects/:id/assets returns [] when uploads path is not a directory', async () => {
    fsMock.stat.mockResolvedValueOnce({ isDirectory: () => false });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body).toEqual({ success: true, assets: [] });
  });

  it('GET /api/projects/:id/assets returns 500 when uploads stat throws unexpected error', async () => {
    fsMock.stat.mockRejectedValueOnce(new Error('stat explode'));

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to load assets' });
  });

  it('GET /api/projects/:id/assets returns metadata and optimization labels', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValue([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'large.png', path: 'uploads/large.png' },
          { type: 'file', name: 'small.jpg', path: 'uploads/small.jpg' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/large.png', { size: 2_900_000 });
    statMap.set('C:/tmp/test-project/uploads/small.jpg', { size: 95_000 });

    metadataMap.set('C:/tmp/test-project/uploads/large.png', {
      width: 1536,
      height: 1024,
      hasAlpha: true
    });
    metadataMap.set('C:/tmp/test-project/uploads/small.jpg', {
      width: 1200,
      height: 800,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.assets).toHaveLength(2);
    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/large.png',
      optimizedForTransmission: false,
      optimizationReason: 'png_density_high',
      pixelWidth: 1536,
      pixelHeight: 1024
    });
    expect(response.body.assets[1]).toMatchObject({
      path: 'uploads/small.jpg',
      optimizedForTransmission: true,
      optimizationReason: 'lossy_density_ok',
      pixelWidth: 1200,
      pixelHeight: 800
    });
  });

  it('GET /api/projects/:id/assets tolerates metadata extraction failures', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValue([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'broken.png', path: 'uploads/broken.png' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/broken.png', { size: 45_000 });
    sharpMock.mockImplementationOnce(() => ({
      metadata: vi.fn().mockRejectedValue(new Error('metadata failed'))
    }));

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/broken.png',
      pixelWidth: null,
      pixelHeight: null,
      hasAlpha: null
    });
  });

  it('GET /api/projects/:id/assets returns [] when buildFileTree returns a non-array', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce(null);

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body).toEqual({ success: true, assets: [] });
  });

  it('GET /api/projects/:id/assets ignores invalid tree nodes during flattening', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      null,
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'valid.png', path: 'uploads/valid.png' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/valid.png', { size: 64_000 });
    metadataMap.set('C:/tmp/test-project/uploads/valid.png', {
      width: 640,
      height: 360,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets).toHaveLength(1);
    expect(response.body.assets[0].path).toBe('uploads/valid.png');
  });

  it('GET /api/projects/:id/assets handles directory nodes without children and non-image files', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'directory', name: 'misc', path: 'uploads/misc' },
          { type: 'file', name: 'note.txt', path: 'uploads/note.txt' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/note.txt', { size: 120 });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets).toHaveLength(1);
    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/note.txt',
      pixelWidth: null,
      pixelHeight: null,
      optimizationReason: 'insufficient_metadata'
    });
  });

  it('GET /api/projects/:id/assets classifies gif files via gif_size heuristics', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValue([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'animated.gif', path: 'uploads/animated.gif' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/animated.gif', { size: 90_000 });
    metadataMap.set('C:/tmp/test-project/uploads/animated.gif', {
      width: 640,
      height: 360,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets).toHaveLength(1);
    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/animated.gif',
      optimizedForTransmission: true,
      optimizationReason: 'gif_size_ok'
    });
  });

  it('GET /api/projects/:id/assets marks large jpg as lossy_density_high', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'heavy.jpg', path: 'uploads/heavy.jpg' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/heavy.jpg', { size: 2_400_000 });
    metadataMap.set('C:/tmp/test-project/uploads/heavy.jpg', {
      width: 1200,
      height: 800,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/heavy.jpg',
      optimizedForTransmission: false,
      optimizationReason: 'lossy_density_high'
    });
  });

  it('GET /api/projects/:id/assets marks large gif as gif_size_high', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'big.gif', path: 'uploads/big.gif' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/big.gif', { size: 1_300_000 });
    metadataMap.set('C:/tmp/test-project/uploads/big.gif', {
      width: 800,
      height: 600,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/big.gif',
      optimizedForTransmission: false,
      optimizationReason: 'gif_size_high'
    });
  });

  it('GET /api/projects/:id/assets returns unsupported_format for image extension not mapped to a density rule', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValue([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'odd.bmp', path: 'uploads/odd.bmp' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/odd.bmp', { size: 180_000 });
    metadataMap.set('C:/tmp/test-project/uploads/odd.bmp', {
      width: 1200,
      height: 800,
      hasAlpha: false
    });

    const originalHas = Set.prototype.has;
    const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function patchedHas(value) {
      if (
        value === 'bmp'
        && this.size === 6
        && originalHas.call(this, 'png')
        && originalHas.call(this, 'gif')
      ) {
        return true;
      }
      return originalHas.call(this, value);
    });

    try {
      const response = await request(app)
        .get('/api/projects/321/assets')
        .expect(200);

      expect(response.body.assets).toHaveLength(1);
      expect(response.body.assets[0]).toMatchObject({
        path: 'uploads/odd.bmp',
        optimizedForTransmission: false,
        optimizationReason: 'unsupported_format'
      });
    } finally {
      hasSpy.mockRestore();
    }
  });

  it('GET /api/projects/:id/assets returns format_allowlisted for synthetic svg image extension outside density rules', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'vector.svg', path: 'uploads/vector.svg' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/vector.svg', { size: 30_000 });
    metadataMap.set('C:/tmp/test-project/uploads/vector.svg', {
      width: 1200,
      height: 800,
      hasAlpha: false
    });

    const originalHas = Set.prototype.has;
    const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function patchedHas(value) {
      if (
        value === 'svg'
        && this.size === 6
        && originalHas.call(this, 'png')
        && originalHas.call(this, 'gif')
      ) {
        return true;
      }
      return originalHas.call(this, value);
    });

    try {
      const response = await request(app)
        .get('/api/projects/321/assets')
        .expect(200);

      expect(response.body.assets[0]).toMatchObject({
        path: 'uploads/vector.svg',
        optimizedForTransmission: true,
        optimizationReason: 'format_allowlisted'
      });
    } finally {
      hasSpy.mockRestore();
    }
  });

  it('POST /api/projects/:id/files-ops/create-file handles base64 content and openInEditor=false', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    await request(app)
      .post('/api/projects/321/files-ops/create-file')
      .send({
        filePath: 'uploads/test.bin',
        encoding: 'base64',
        contentBase64: Buffer.from('hello-world').toString('base64'),
        openInEditor: false
      })
      .expect(200);

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const writeArgs = fsMock.writeFile.mock.calls[0];
    expect(Buffer.isBuffer(writeArgs[1])).toBe(true);
    expect(writeArgs[2]).toEqual({ flag: 'wx' });
    expect(sendAgentUiCommand).not.toHaveBeenCalled();
  });

  it('POST /api/projects/:id/files-ops/create-file writes utf-8 content when encoding is omitted', async () => {
    await request(app)
      .post('/api/projects/321/files-ops/create-file')
      .send({
        filePath: 'uploads/plain.txt',
        content: 'hello utf8'
      })
      .expect(200);

    expect(fsMock.writeFile).toHaveBeenCalledWith(
      'C:/tmp/test-project/uploads/plain.txt',
      'hello utf8',
      { encoding: 'utf-8', flag: 'wx' }
    );
  });

  it('POST /api/projects/:id/files-ops/create-file base64 mode accepts empty payload fallback', async () => {
    await request(app)
      .post('/api/projects/321/files-ops/create-file')
      .send({
        filePath: 'uploads/empty.bin',
        encoding: 'base64'
      })
      .expect(200);

    expect(fsMock.writeFile).toHaveBeenCalledWith(
      'C:/tmp/test-project/uploads/empty.bin',
      Buffer.from('', 'base64'),
      { flag: 'wx' }
    );
  });

  it('POST /api/projects/:id/files-ops/create-file rejects unsupported encoding', async () => {
    const response = await request(app)
      .post('/api/projects/321/files-ops/create-file')
      .send({ filePath: 'uploads/test.txt', encoding: 'binary' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Unsupported encoding' });
  });

  it('POST /api/projects/:id/assets/optimize rejects missing or out-of-scope asset paths', async () => {
    await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({})
      .expect(400);

    const nonUploads = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'src/logo.png' })
      .expect(400);

    expect(nonUploads.body.error).toBe('Only uploaded assets can be optimized');
  });

  it('POST /api/projects/:id/assets/optimize returns 404 when project is missing', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce(null);

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/pic.png' })
      .expect(404);

    expect(response.body).toEqual({ success: false, error: 'Project not found' });
  });

  it('POST /api/projects/:id/assets/optimize returns 400 when project path is unavailable', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 321, path: '' });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/pic.png' })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'Project path not found. Please re-import or recreate the project.'
    });
  });

  it('POST /api/projects/:id/assets/optimize returns 400 when project path is out of scope', async () => {
    const cleanup = await import('../routes/projects/cleanup.js');
    cleanup.isWithinManagedProjectsRoot.mockReturnValueOnce(false);

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/pic.png' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
  });

  it('POST /api/projects/:id/assets/optimize returns 403 for sensitive paths', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.isSensitiveRepoPath.mockReturnValueOnce(true);

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/.env' })
      .expect(403);

    expect(response.body).toEqual({ success: false, error: 'Access denied' });
  });

  it('POST /api/projects/:id/assets/optimize handles resolveProjectRelativePath status errors', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => {
      throw { statusCode: 400 };
    });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/blocked.png' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('POST /api/projects/:id/assets/optimize returns 500 for unexpected resolve errors', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => {
      throw new Error('resolve explode');
    });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/blocked.png' })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to optimize asset' });
  });

  it('POST /api/projects/:id/assets/optimize returns 400 when symlink validation rejects path', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce({ statusCode: 400 });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/blocked.png' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('POST /api/projects/:id/assets/optimize returns 500 when symlink validation throws unexpected error', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce(new Error('symlink panic'));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/file.png' })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to optimize asset' });
  });

  it('POST /api/projects/:id/assets/optimize returns 404 when file does not exist', async () => {
    fsMock.stat.mockImplementationOnce(async () => {
      throw createEnoentError();
    });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/missing.png' })
      .expect(404);

    expect(response.body).toEqual({ success: false, error: 'File not found' });
  });

  it('POST /api/projects/:id/assets/optimize returns 400 when target is not a file', async () => {
    statMap.set('C:/tmp/test-project/uploads/not-file.png', {
      size: 0,
      isFile: false,
      isDirectory: true
    });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/not-file.png' })
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Path is not a file' });
  });

  it('POST /api/projects/:id/assets/optimize returns 500 when fs stat throws unexpected error', async () => {
    fsMock.stat.mockRejectedValueOnce(new Error('stat panic'));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/stat-crash.png' })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to optimize asset' });
  });

  it('POST /api/projects/:id/assets/optimize returns 400 when metadata is missing', async () => {
    statMap.set('C:/tmp/test-project/uploads/not-image.bin', { size: 100, isFile: true });
    optimizeMetadata = { width: null, height: null, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/not-image.bin', mode: 'manual', options: { format: 'webp' } })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'Optimization is currently supported for image files only'
    });
  });

  it('POST /api/projects/:id/assets/optimize manual mode supports webp and avif branches', async () => {
    statMap.set('C:/tmp/test-project/uploads/photo.jpg', { size: 240_000, isFile: true });
    optimizeMetadata = { width: 1400, height: 900, hasAlpha: false };

    await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/photo.jpg',
        mode: 'manual',
        options: { format: 'webp', quality: 70, scalePercent: 80 }
      })
      .expect(200);

    expect(optimizeTransformer.webp).toHaveBeenCalled();

    await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/photo.jpg',
        mode: 'manual',
        options: { format: 'avif', quality: 52, scalePercent: 95 }
      })
      .expect(200);

    expect(optimizeTransformer.avif).toHaveBeenCalled();
  });

  it('POST /api/projects/:id/assets/optimize manual mode normalizes jpg alias and clamps invalid numbers to fallbacks', async () => {
    statMap.set('C:/tmp/test-project/uploads/alias.png', { size: 240_000, isFile: true });
    optimizeMetadata = { width: 1400, height: 900, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/alias.png',
        mode: 'manual',
        options: { format: 'jpg', quality: 'oops', scalePercent: 'oops' }
      })
      .expect(200);

    expect(response.body.applied).toMatchObject({
      format: 'jpeg',
      quality: 76,
      scalePercent: 100
    });
  });

  it('POST /api/projects/:id/assets/optimize manual mode falls back unknown format to auto default', async () => {
    statMap.set('C:/tmp/test-project/uploads/fallback.png', { size: 240_000, isFile: true });
    optimizeMetadata = { width: 1200, height: 800, hasAlpha: true };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/fallback.png',
        mode: 'manual',
        options: { format: 'bmp', quality: 72, scalePercent: 95 }
      })
      .expect(200);

    expect(response.body.applied.format).toBe('webp');
  });

  it('POST /api/projects/:id/assets/optimize manual mode with format=auto uses derived default format', async () => {
    statMap.set('C:/tmp/test-project/uploads/manual-auto.png', { size: 420_000, isFile: true });
    optimizeMetadata = { width: 1400, height: 900, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/manual-auto.png',
        mode: 'manual',
        options: { format: 'auto', quality: 80, scalePercent: 100 }
      })
      .expect(200);

    expect(response.body.applied.format).toBe('jpeg');
  });

  it('POST /api/projects/:id/assets/optimize auto mode uses 60% scale above 2600px', async () => {
    statMap.set('C:/tmp/test-project/uploads/auto60.png', { size: 1_300_000, isFile: true });
    optimizeMetadata = { width: 2800, height: 1800, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/auto60.png', mode: 'auto' })
      .expect(200);

    expect(response.body.applied.scalePercent).toBe(60);
  });

  it('POST /api/projects/:id/assets/optimize auto mode uses 70% scale above 2000px', async () => {
    statMap.set('C:/tmp/test-project/uploads/auto70.png', { size: 1_000_000, isFile: true });
    optimizeMetadata = { width: 2200, height: 1400, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/auto70.png', mode: 'auto' })
      .expect(200);

    expect(response.body.applied.scalePercent).toBe(70);
  });

  it('POST /api/projects/:id/assets/optimize auto mode uses 78% scale above 1600px', async () => {
    statMap.set('C:/tmp/test-project/uploads/auto78.png', { size: 900_000, isFile: true });
    optimizeMetadata = { width: 1700, height: 1000, hasAlpha: false };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/auto78.png', mode: 'auto' })
      .expect(200);

    expect(response.body.applied.scalePercent).toBe(78);
  });

  it('GET /api/projects/:id/assets handles invalid pixel multiplication in optimization analysis', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'huge.png', path: 'uploads/huge.png' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/huge.png', { size: 128_000 });
    metadataMap.set('C:/tmp/test-project/uploads/huge.png', {
      width: Number.MAX_VALUE,
      height: 2,
      hasAlpha: false
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets).toHaveLength(1);
    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/huge.png',
      optimizationReason: 'format_allowlisted'
    });
  });

  it('GET /api/projects/:id/assets returns invalid_dimensions for synthetic bmp image extension', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'giant.bmp', path: 'uploads/giant.bmp' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/giant.bmp', { size: 100_000 });
    metadataMap.set('C:/tmp/test-project/uploads/giant.bmp', {
      width: Number.MAX_VALUE,
      height: Number.MAX_VALUE,
      hasAlpha: false
    });

    const originalHas = Set.prototype.has;
    const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function patchedHas(value) {
      if (
        value === 'bmp'
        && this.size === 6
        && originalHas.call(this, 'png')
        && originalHas.call(this, 'gif')
      ) {
        return true;
      }
      return originalHas.call(this, value);
    });

    try {
      const response = await request(app)
        .get('/api/projects/321/assets')
        .expect(200);

      expect(response.body.assets[0]).toMatchObject({
        path: 'uploads/giant.bmp',
        optimizedForTransmission: false,
        optimizationReason: 'invalid_dimensions'
      });
    } finally {
      hasSpy.mockRestore();
    }
  });

  it('GET /api/projects/:id/assets normalizes non-finite metadata and size values to null/0', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.buildFileTree.mockResolvedValueOnce([
      {
        type: 'directory',
        path: 'uploads',
        children: [
          { type: 'file', name: 'strange.png', path: 'uploads/strange.png' }
        ]
      }
    ]);

    statMap.set('C:/tmp/test-project/uploads/strange.png', { size: Number.NaN });
    metadataMap.set('C:/tmp/test-project/uploads/strange.png', {
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
      hasAlpha: 'yes'
    });

    const response = await request(app)
      .get('/api/projects/321/assets')
      .expect(200);

    expect(response.body.assets[0]).toMatchObject({
      path: 'uploads/strange.png',
      sizeBytes: 0,
      pixelWidth: null,
      pixelHeight: null,
      hasAlpha: null,
      optimizationReason: 'format_allowlisted'
    });
  });

  it('POST /api/projects/:id/assets/optimize auto mode converts to jpeg and replaces original path', async () => {
    statMap.set('C:/tmp/test-project/uploads/large.png', { size: 2_900_000, isFile: true });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/large.png', mode: 'auto' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('uploads/large.jpg');
    expect(response.body.replacedPath).toBe('uploads/large.png');
    expect(response.body.applied).toMatchObject({
      mode: 'auto',
      format: 'jpeg'
    });
    expect(optimizeTransformer.resize).toHaveBeenCalled();
    expect(optimizeTransformer.jpeg).toHaveBeenCalled();
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      'C:/tmp/test-project/uploads/large.jpg',
      expect.any(Buffer)
    );
    expect(fsMock.unlink).toHaveBeenCalledWith('C:/tmp/test-project/uploads/large.png');
  });

  it('POST /api/projects/:id/assets/optimize continues when replacing original file and unlink fails', async () => {
    statMap.set('C:/tmp/test-project/uploads/replace-fail.png', { size: 2_900_000, isFile: true });
    fsMock.unlink.mockRejectedValueOnce(new Error('unlink failed'));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/replace-fail.png', mode: 'auto' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toBe('uploads/replace-fail.jpg');
    expect(response.body.replacedPath).toBe('uploads/replace-fail.png');
    expect(fsMock.unlink).toHaveBeenCalledWith('C:/tmp/test-project/uploads/replace-fail.png');
  });

  it('POST /api/projects/:id/assets/optimize manual mode keeps same file when output format matches extension', async () => {
    statMap.set('C:/tmp/test-project/uploads/small.png', { size: 520_000, isFile: true });
    optimizeMetadata = { width: 900, height: 600, hasAlpha: true };

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({
        assetPath: 'uploads/small.png',
        mode: 'manual',
        options: {
          format: 'png',
          quality: 63,
          scalePercent: 100
        }
      })
      .expect(200);

    expect(response.body.path).toBe('uploads/small.png');
    expect(response.body.replacedPath).toBeNull();
    expect(response.body.applied).toMatchObject({
      mode: 'manual',
      format: 'png',
      quality: 63,
      scalePercent: 100
    });
    expect(optimizeTransformer.png).toHaveBeenCalled();
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('POST /api/projects/:id/assets/optimize returns 500 when destination path probing throws non-ENOENT', async () => {
    statMap.set('C:/tmp/test-project/uploads/large.png', { size: 2_900_000, isFile: true });

    const accessError = new Error('access denied');
    accessError.code = 'EACCES';
    fsMock.access.mockRejectedValueOnce(accessError);

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/large.png', mode: 'auto' })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to optimize asset' });
  });

  it('POST /api/projects/:id/assets/optimize appends timestamp suffix after exhausting unique path attempts', async () => {
    statMap.set('C:/tmp/test-project/uploads/large.png', { size: 2_900_000, isFile: true });
    fsMock.access.mockResolvedValue(undefined);

    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);

    try {
      const response = await request(app)
        .post('/api/projects/321/assets/optimize')
        .send({ assetPath: 'uploads/large.png', mode: 'auto' })
        .expect(200);

      expect(response.body.path).toBe('uploads/large-optimized-123456.jpg');
      expect(response.body.replacedPath).toBe('uploads/large.png');
      expect(fsMock.access).toHaveBeenCalledTimes(50);
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        'C:/tmp/test-project/uploads/large-optimized-123456.jpg',
        expect.any(Buffer)
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('POST /api/projects/:id/assets/optimize falls back to original dimensions when transformer info is non-finite', async () => {
    statMap.set('C:/tmp/test-project/uploads/fallback-info.png', { size: 900_000, isFile: true });
    optimizeMetadata = { width: 1333, height: 777, hasAlpha: false };
    optimizeTransformer.toBuffer.mockResolvedValueOnce({
      data: Buffer.from('optimized-binary'),
      info: { width: Number.NaN, height: Number.POSITIVE_INFINITY }
    });

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/fallback-info.png', mode: 'manual', options: { format: 'jpeg' } })
      .expect(200);

    expect(response.body.pixelWidth).toBe(1333);
    expect(response.body.pixelHeight).toBe(777);
  });

  it('POST /api/projects/:id/assets/optimize handles source paths ending with a slash when deriving stem', async () => {
    statMap.set('C:/tmp/test-project/uploads/trailing/', { size: 700_000, isFile: true });

    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => ({
      normalized: 'uploads/trailing/',
      fullPath: 'C:/tmp/test-project/uploads/trailing/',
      resolvedPath: 'C:/tmp/test-project/uploads/trailing/',
      projectResolved: 'C:/tmp/test-project'
    }));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/trailing/', mode: 'auto' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toContain('uploads/trailing');
  });

  it('POST /api/projects/:id/assets/optimize covers getExtension non-string sourceName path handling', async () => {
    statMap.set('C:/tmp/test-project/uploads/weird.png', { size: 450_000, isFile: true });

    const weirdNormalized = {
      startsWith: () => true,
      includes: () => false,
      split: () => [123]
    };

    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => ({
      normalized: weirdNormalized,
      fullPath: 'C:/tmp/test-project/uploads/weird.png',
      resolvedPath: 'C:/tmp/test-project/uploads/weird.png',
      projectResolved: 'C:/tmp/test-project'
    }));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/weird.png', mode: 'auto' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.path).toContain('123.');
  });

  it('POST /api/projects/:id/assets/optimize covers getExtension empty-string branch when sourceName trims empty', async () => {
    statMap.set('C:/tmp/test-project/uploads/blank.png', { size: 450_000, isFile: true });

    const blankNormalized = {
      startsWith: () => true,
      includes: () => false,
      split: () => ['   ']
    };

    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => ({
      normalized: blankNormalized,
      fullPath: 'C:/tmp/test-project/uploads/blank.png',
      resolvedPath: 'C:/tmp/test-project/uploads/blank.png',
      projectResolved: 'C:/tmp/test-project'
    }));

    const response = await request(app)
      .post('/api/projects/321/assets/optimize')
      .send({ assetPath: 'uploads/blank.png', mode: 'auto' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(typeof response.body.path).toBe('string');
  });

  it('GET /api/projects/:id/assets/* returns 404 when asset file does not exist', async () => {
    const response = await request(app)
      .get('/api/projects/321/assets/uploads/missing.png')
      .expect(404);

    expect(response.body).toEqual({ success: false, error: 'File not found' });
  });

  it('GET /api/projects/:id/assets/* returns 404 when project is missing', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce(null);

    const response = await request(app)
      .get('/api/projects/999/assets/uploads/missing.png')
      .expect(404);

    expect(response.body).toEqual({ success: false, error: 'Project not found' });
  });

  it('GET /api/projects/:id/assets/* returns 400 when project path is unavailable', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 321, path: '' });

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/missing.png')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'Project path not found. Please re-import or recreate the project.'
    });
  });

  it('GET /api/projects/:id/assets/* returns 400 when project path is out of scope', async () => {
    const cleanup = await import('../routes/projects/cleanup.js');
    cleanup.isWithinManagedProjectsRoot.mockReturnValueOnce(false);

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/missing.png')
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
  });

  it('GET /api/projects/:id/assets/* returns 403 for sensitive asset paths', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.isSensitiveRepoPath.mockReturnValueOnce(true);

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/secret.env')
      .expect(403);

    expect(response.body).toEqual({ success: false, error: 'Access denied' });
  });

  it('GET /api/projects/:id/assets/* returns 500 when path resolution throws unexpected error', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => {
      throw new Error('resolver crash');
    });

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/boom.png')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to stream asset file' });
  });

  it('GET /api/projects/:id/assets/* returns 400 when path resolution has statusCode=400', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => {
      throw { statusCode: 400 };
    });

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/invalid.png')
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('GET /api/projects/:id/assets/* returns 500 when symlink validation throws unexpected error', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce(new Error('symlink check failed'));

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/blocked.png')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to stream asset file' });
  });

  it('GET /api/projects/:id/assets/* returns 400 when target is not a file', async () => {
    statMap.set('C:/tmp/test-project/uploads/not-a-file.png', {
      size: 0,
      isFile: false,
      isDirectory: true
    });

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/not-a-file.png')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'Path is not a file'
    });
  });

  it('GET /api/projects/:id/assets/* returns 500 on unexpected fs errors', async () => {
    const statError = new Error('disk read failure');
    fsMock.stat.mockRejectedValueOnce(statError);

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/crash.png')
      .expect(500);

    expect(response.body).toEqual({
      success: false,
      error: 'Failed to stream asset file'
    });
  });

  it('GET /api/projects/:id/assets/* returns 400 when symlink validation rejects path', async () => {
    const internals = await import('../routes/projects/internals.js');
    internals.assertNoSymlinkSegments.mockRejectedValueOnce({ statusCode: 400 });

    const response = await request(app)
      .get('/api/projects/321/assets/uploads/blocked.png')
      .expect(400);

    expect(response.body).toEqual({ success: false, error: 'Invalid file path' });
  });

  it('GET /api/projects/:id/assets/* streams file content when asset exists', async () => {
    const runtimeDir = path.resolve(process.cwd(), 'test-runtime-projects', `assets-stream-${Date.now()}`);
    const realFilePath = path.join(runtimeDir, 'uploads', 'ok.txt');
    await fs.mkdir(path.dirname(realFilePath), { recursive: true });
    await fs.writeFile(realFilePath, 'stream-ok', 'utf8');

    const internals = await import('../routes/projects/internals.js');
    internals.resolveProjectRelativePath.mockImplementationOnce(() => ({
      normalized: 'uploads/ok.txt',
      fullPath: realFilePath,
      resolvedPath: realFilePath,
      projectResolved: runtimeDir
    }));

    statMap.set(realFilePath, { size: 9, isFile: true });

    try {
      const response = await request(app)
        .get('/api/projects/321/assets/uploads/ok.txt')
        .expect(200);

      expect(response.text).toBe('stream-ok');
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
  });
});