import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const scanCompatibilityMock = vi.hoisted(() => vi.fn());
vi.mock('../services/importCompatibility.js', () => ({
  scanCompatibility: scanCompatibilityMock
}));

const buildApp = async () => {
  const router = (await import('../routes/fs.js')).default;
  const app = express();
  app.use('/api/fs', router);
  return app;
};

describe('fs routes coverage', () => {
  let app;
  let tempDir;

  beforeEach(async () => {
    scanCompatibilityMock.mockReset();
    app = await buildApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-routes-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('GET /api/fs/list validates required path and unsafe paths', async () => {
    const missingPathRes = await request(app).get('/api/fs/list');
    expect(missingPathRes.status).toBe(400);
    expect(missingPathRes.body).toMatchObject({ success: false, error: 'Path is required' });

    const unsafeRes = await request(app)
      .get('/api/fs/list')
      .query({ path: 'C:\\bad\"path' });
    expect(unsafeRes.status).toBe(400);
    expect(unsafeRes.body).toMatchObject({ success: false, error: 'Invalid path' });
  });

  test('isUnsafePath returns false for falsy input', async () => {
    const { isUnsafePath } = await import('../routes/fs.js');
    expect(isUnsafePath()).toBe(false);
    expect(isUnsafePath(null)).toBe(false);
    expect(isUnsafePath('')).toBe(false);
  });

  test('detectCSharpTech identifies C# projects', async () => {
    const { detectCSharpTech } = await import('../routes/fs.js');
    const csharpDir = path.join(tempDir, 'csharp-helper');
    await fs.mkdir(csharpDir, { recursive: true });
    await fs.writeFile(path.join(csharpDir, 'App.csproj'), '<Project></Project>');

    const result = await detectCSharpTech(csharpDir);
    expect(result).toMatchObject({ language: 'csharp', framework: 'aspnetcore' });
  });

  test('GET /api/fs/list treats array paths as missing input', async () => {
    const res = await request(app)
      .get('/api/fs/list')
      .query({ path: ['one', 'two'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: 'Path is required' });
  });

  test('GET /api/fs/roots ignores missing Windows drives', async () => {
    const originalPlatform = process.platform;
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (candidate) => {
      if (String(candidate).toLowerCase().startsWith('c:')) {
        return undefined;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const rootsRes = await request(app).get('/api/fs/roots');

      expect(rootsRes.status).toBe(200);
      expect(rootsRes.body.success).toBe(true);
      expect(rootsRes.body.roots.some((root) => root.name === 'C:')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      accessSpy.mockRestore();
    }
  });

  test('GET /api/fs/roots sorts Windows drive roots', async () => {
    const originalPlatform = process.platform;
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (candidate) => {
      const resolved = String(candidate).toLowerCase();
      if (resolved.startsWith('c:') || resolved.startsWith('z:')) {
        return undefined;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.resetModules();

      const router = (await import('../routes/fs.js')).default;
      const localApp = express();
      localApp.use('/api/fs', router);

      const res = await request(localApp)
        .get('/api/fs/roots')
        .expect(200);

      const driveNames = res.body.roots
        .filter((root) => root.name.includes(':'))
        .map((root) => root.name);

      expect(driveNames).toEqual(['C:', 'Z:']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      accessSpy.mockRestore();
    }
  });

  test('GET /api/fs/roots returns unix root on non-Windows platforms', async () => {
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.resetModules();

      const router = (await import('../routes/fs.js')).default;
      const localApp = express();
      localApp.use('/api/fs', router);

      const res = await request(localApp)
        .get('/api/fs/roots')
        .expect(200);

      expect(res.body.roots.some((root) => root.path === '/')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  test('GET /api/fs/roots returns 500 when roots listing fails', async () => {
    const homeSpy = vi.spyOn(os, 'homedir').mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await request(app)
      .get('/api/fs/roots')
      .expect(500);

    expect(res.body).toMatchObject({ success: false, error: 'Failed to list filesystem roots' });
    homeSpy.mockRestore();
  });

  test('GET /api/fs/roots skips Home when homedir is empty', async () => {
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue('');
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    const res = await request(app)
      .get('/api/fs/roots')
      .expect(200);

    const hasHome = res.body.roots.some((root) => root.name === 'Home');
    expect(hasHome).toBe(false);

    homeSpy.mockRestore();
    accessSpy.mockRestore();
  });

  test('GET /api/fs/list rejects non-directory paths and missing paths', async () => {
    const filePath = path.join(tempDir, 'file.txt');
    await fs.writeFile(filePath, 'content');

    const fileRes = await request(app)
      .get('/api/fs/list')
      .query({ path: filePath });
    expect(fileRes.status).toBe(400);
    expect(fileRes.body).toMatchObject({ success: false, error: 'Path is not a directory' });

    const missingRes = await request(app)
      .get('/api/fs/list')
      .query({ path: path.join(tempDir, 'missing') });
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toMatchObject({ success: false, error: 'Path not found' });
  });

  test('GET /api/fs/list returns sorted non-hidden directories', async () => {
    const aDir = path.join(tempDir, 'a-dir');
    const bDir = path.join(tempDir, 'b-dir');
    const hiddenDir = path.join(tempDir, '.hidden');
    await fs.mkdir(aDir, { recursive: true });
    await fs.mkdir(bDir, { recursive: true });
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');

    const res = await request(app)
      .get('/api/fs/list')
      .query({ path: tempDir })
      .expect(200);

    const names = res.body.directories.map((entry) => entry.name);
    expect(names).toEqual(['a-dir', 'b-dir']);
    expect(res.body.path).toBe(path.resolve(tempDir));
  });

  test('GET /api/fs/list returns 403 for access errors and 500 otherwise', async () => {
    const protectedPath = path.join(tempDir, 'protected-list');
    const resolved = path.resolve(protectedPath);
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === resolved) {
        const err = new Error('no access');
        err.code = 'EACCES';
        throw err;
      }
      return originalStat(candidate);
    });

    const accessRes = await request(app)
      .get('/api/fs/list')
      .query({ path: protectedPath });
    expect(accessRes.status).toBe(403);
    expect(accessRes.body).toMatchObject({ success: false, error: 'Access denied' });

    statSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const errorRes = await request(app)
      .get('/api/fs/list')
      .query({ path: path.join(tempDir, 'error-list') });
    expect(errorRes.status).toBe(500);
    expect(errorRes.body).toMatchObject({ success: false, error: 'Failed to list filesystem path' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech returns defaults for empty folders', async () => {
    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: tempDir })
      .expect(200);

    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'react' });
    expect(res.body.backend).toMatchObject({ language: 'javascript', framework: 'express' });
  });

  test('GET /api/fs/detect-tech surfaces directory stat errors', async () => {
    const frontendDir = path.join(tempDir, 'frontend');
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === frontendDir) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: tempDir })
      .expect(403);

    expect(res.body).toMatchObject({ success: false, error: 'Access denied' });
    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech surfaces file stat errors', async () => {
    const pkgPath = path.join(tempDir, 'package.json');
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === pkgPath) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: tempDir })
      .expect(403);

    expect(res.body).toMatchObject({ success: false, error: 'Access denied' });
    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech detects node and python stacks', async () => {
    const nodeDir = path.join(tempDir, 'node-app');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0', express: '^4.0.0' },
        devDependencies: {}
      })
    );

    const nodeRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir });

    expect(nodeRes.status).toBe(200);
    expect(nodeRes.body.frontend).toMatchObject({ language: 'javascript', framework: 'react' });
    expect(nodeRes.body.backend).toMatchObject({ language: 'javascript', framework: 'express' });

    const mixedDir = path.join(tempDir, 'mixed-app');
    await fs.mkdir(mixedDir, { recursive: true });
    await fs.writeFile(path.join(mixedDir, 'package.json'), JSON.stringify({ scripts: {} }));
    await fs.writeFile(path.join(mixedDir, 'requirements.txt'), 'flask\n');

    const mixedRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: mixedDir });

    expect(mixedRes.status).toBe(200);
    expect(mixedRes.body.frontend).toMatchObject({ language: 'javascript', framework: 'react' });
    expect(mixedRes.body.backend).toMatchObject({ language: 'python', framework: 'flask' });
  });

  test('GET /api/fs/detect-tech reports TypeScript when tsconfig exists', async () => {
    const nodeDir = path.join(tempDir, 'ts-app');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(path.join(nodeDir, 'package.json'), JSON.stringify({ scripts: {} }));
    await fs.writeFile(path.join(nodeDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir })
      .expect(200);

    expect(res.body.frontend).toMatchObject({ language: 'typescript', framework: 'react' });
    expect(res.body.backend).toMatchObject({ language: 'javascript', framework: 'express' });
  });

  test('GET /api/fs/detect-tech maps nextjs and nestjs frameworks', async () => {
    const nodeDir = path.join(tempDir, 'next-nest');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^13.0.0', '@nestjs/core': '^10.0.0' },
        devDependencies: {}
      })
    );

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir })
      .expect(200);

    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'nextjs' });
    expect(res.body.backend).toMatchObject({ language: 'javascript', framework: 'nestjs' });
  });

  test('GET /api/fs/detect-tech maps nuxt to nuxtjs', async () => {
    const nodeDir = path.join(tempDir, 'nuxt-app');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0' },
        devDependencies: {}
      })
    );

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir })
      .expect(200);

    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'nuxtjs' });
  });

  test('GET /api/fs/detect-tech maps nextjs when framework appears after the first scan', async () => {
    const nodeDir = path.join(tempDir, 'next-delayed');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^13.0.0' },
        devDependencies: {}
      })
    );

    const pkgPath = path.join(nodeDir, 'package.json');
    const originalStat = fs.stat;
    let pkgStatCalls = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === path.resolve(pkgPath)) {
        pkgStatCalls += 1;
        if (pkgStatCalls === 1) {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir });

    expect(res.status).toBe(200);
    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'nextjs' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech maps nuxtjs when framework appears after the first scan', async () => {
    const nodeDir = path.join(tempDir, 'nuxt-delayed');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0' },
        devDependencies: {}
      })
    );

    const pkgPath = path.join(nodeDir, 'package.json');
    const originalStat = fs.stat;
    let pkgStatCalls = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === path.resolve(pkgPath)) {
        pkgStatCalls += 1;
        if (pkgStatCalls === 1) {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir });

    expect(res.status).toBe(200);
    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'nuxtjs' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech maps nuxtjs on second pass after backend scan', async () => {
    const nodeDir = path.join(tempDir, 'nuxt-second-pass');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { nuxt: '^3.0.0' },
        devDependencies: {}
      })
    );

    const pkgPath = path.join(nodeDir, 'package.json');
    const originalStat = fs.stat;
    let pkgStatCalls = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === path.resolve(pkgPath)) {
        pkgStatCalls += 1;
        if (pkgStatCalls === 1) {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir });

    expect(res.status).toBe(200);
    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'nuxtjs' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech maps vue on second pass after missing package.json', async () => {
    const nodeDir = path.join(tempDir, 'vue-delayed');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { vue: '^3.0.0' },
        devDependencies: {}
      })
    );

    const pkgPath = path.join(nodeDir, 'package.json');
    const originalStat = fs.stat;
    let pkgStatCalls = 0;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === path.resolve(pkgPath)) {
        pkgStatCalls += 1;
        if (pkgStatCalls === 1) {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        }
      }
      return originalStat(candidate);
    });

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir });

    expect(res.status).toBe(200);
    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'vue' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech detects additional backend stacks', async () => {
    const cases = [
      {
        name: 'go-app',
        files: [['go.mod', 'module example\nrequire github.com/gin-gonic/gin v1.8.0']]
      },
      {
        name: 'rust-app',
        files: [['Cargo.toml', '[dependencies]\nactix-web = "4"']]
      },
      {
        name: 'php-app',
        files: [['composer.json', '{"require":{"laravel/framework":"^10.0"}}']]
      },
      {
        name: 'ruby-app',
        files: [['Gemfile', 'gem "rails"']]
      },
      {
        name: 'swift-app',
        files: [['Package.swift', 'import Vapor']]
      },
      {
        name: 'java-app',
        files: [['pom.xml', '<dependencies><dependency>spring</dependency></dependencies>']]
      },
      {
        name: 'csharp-app',
        files: [['Project.csproj', '<Project></Project>']]
      },
      {
        name: 'python-default',
        files: [['requirements.txt', 'requests==2.0.0']]
      },
      {
        name: 'java-default',
        files: [['pom.xml', '<project></project>']]
      },
      {
        name: 'go-default',
        files: [['go.mod', 'module example\nrequire example.com/other v1.0.0']]
      },
      {
        name: 'rust-default',
        files: [['Cargo.toml', '[dependencies]\nserde = "1"']]
      },
      {
        name: 'php-default',
        files: [['composer.json', '{"require":{"monolog/monolog":"^3.0"}}']]
      },
      {
        name: 'ruby-default',
        files: [['Gemfile', 'gem "rake"']]
      },
      {
        name: 'swift-default',
        files: [['Package.swift', 'import Foundation']]
      }
    ];

    for (const entry of cases) {
      const dirPath = path.join(tempDir, entry.name);
      await fs.mkdir(dirPath, { recursive: true });
      for (const [fileName, contents] of entry.files) {
        await fs.writeFile(path.join(dirPath, fileName), contents);
      }
    }

    const expectations = [
      { name: 'go-app', expected: { language: 'go', framework: 'gin' } },
      { name: 'rust-app', expected: { language: 'rust', framework: 'actix' } },
      { name: 'php-app', expected: { language: 'php', framework: 'laravel' } },
      { name: 'ruby-app', expected: { language: 'ruby', framework: 'rails' } },
      { name: 'swift-app', expected: { language: 'swift', framework: 'vapor' } },
      { name: 'java-app', expected: { language: 'java', framework: 'spring' } },
      { name: 'csharp-app', expected: { language: 'csharp', framework: 'aspnetcore' } },
      { name: 'python-default', expected: { language: 'python', framework: 'django' } },
      { name: 'java-default', expected: { language: 'java', framework: 'springboot' } },
      { name: 'go-default', expected: { language: 'go', framework: 'gin' } },
      { name: 'rust-default', expected: { language: 'rust', framework: 'actix' } },
      { name: 'php-default', expected: { language: 'php', framework: 'laravel' } },
      { name: 'ruby-default', expected: { language: 'ruby', framework: 'rails' } },
      { name: 'swift-default', expected: { language: 'swift', framework: 'vapor' } }
    ];

    for (const entry of expectations) {
      const res = await request(app)
        .get('/api/fs/detect-tech')
        .query({ path: path.join(tempDir, entry.name) });

      expect(res.status).toBe(200);
      expect(res.body.backend).toMatchObject(entry.expected);
    }
  });

  test('GET /api/fs/detect-tech reads directory entries for C# projects', async () => {
    const csharpDir = path.join(tempDir, 'csharp-direct');
    await fs.mkdir(csharpDir, { recursive: true });
    await fs.writeFile(path.join(csharpDir, 'App.csproj'), '<Project></Project>');

    const readdirSpy = vi.spyOn(fs, 'readdir');

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: csharpDir })
      .expect(200);

    expect(res.body.backend).toMatchObject({ language: 'csharp', framework: 'aspnetcore' });
    expect(readdirSpy).toHaveBeenCalled();

    readdirSpy.mockRestore();
  });

  test('detectCSharpTech returns null when no csproj exists', async () => {
    const emptyDir = path.join(tempDir, 'csharp-empty');
    await fs.mkdir(emptyDir, { recursive: true });

    const { detectCSharpTech } = await import('../routes/fs.js');
    await expect(detectCSharpTech(emptyDir)).resolves.toBeNull();
  });

  test('detectCSharpTech handles readdir failures by returning null', async () => {
    const emptyDir = path.join(tempDir, 'csharp-error');
    await fs.mkdir(emptyDir, { recursive: true });

    const readdirSpy = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('readdir failed'));
    const { detectCSharpTech } = await import('../routes/fs.js');

    await expect(detectCSharpTech(emptyDir)).resolves.toBeNull();

    readdirSpy.mockRestore();
  });

  test('GET /api/fs/detect-tech defaults frontend when only backend deps exist', async () => {
    const nodeDir = path.join(tempDir, 'backend-only-node');
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(
      path.join(nodeDir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '^4.0.0' },
        devDependencies: {}
      })
    );

    const res = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: nodeDir })
      .expect(200);

    expect(res.body.frontend).toMatchObject({ language: 'javascript', framework: 'react' });
    expect(res.body.backend).toMatchObject({ language: 'javascript', framework: 'express' });
  });

  test('GET /api/fs/compatibility returns scan results', async () => {
    const projectDir = path.join(tempDir, 'compat-app');
    await fs.mkdir(projectDir, { recursive: true });

    scanCompatibilityMock.mockResolvedValue({ needsChanges: false, changes: [] });

    const res = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: projectDir });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, plan: { needsChanges: false } });
  });

  test('GET /api/fs/detect-tech validates unsafe, non-directory, and missing paths', async () => {
    const unsafeRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: 'C:\\bad"path' });
    expect(unsafeRes.status).toBe(400);
    expect(unsafeRes.body).toMatchObject({ success: false, error: 'Invalid path' });

    const filePath = path.join(tempDir, 'file.txt');
    await fs.writeFile(filePath, 'content');
    const fileRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: filePath });
    expect(fileRes.status).toBe(400);
    expect(fileRes.body).toMatchObject({ success: false, error: 'Path is not a directory' });

    const missingRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: path.join(tempDir, 'missing') });
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toMatchObject({ success: false, error: 'Path not found' });
  });

  test('GET /api/fs/detect-tech requires a path query', async () => {
    const missingRes = await request(app).get('/api/fs/detect-tech');
    expect(missingRes.status).toBe(400);
    expect(missingRes.body).toMatchObject({ success: false, error: 'Path is required' });
  });

  test('GET /api/fs/detect-tech returns 403 on access errors and 500 otherwise', async () => {
    const protectedPath = path.join(tempDir, 'protected');
    const resolved = path.resolve(protectedPath);
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === resolved) {
        const err = new Error('no access');
        err.code = 'EACCES';
        throw err;
      }
      return originalStat(candidate);
    });

    const accessRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: protectedPath });
    expect(accessRes.status).toBe(403);
    expect(accessRes.body).toMatchObject({ success: false, error: 'Access denied' });

    statSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const errorRes = await request(app)
      .get('/api/fs/detect-tech')
      .query({ path: path.join(tempDir, 'error') });
    expect(errorRes.status).toBe(500);
    expect(errorRes.body).toMatchObject({ success: false, error: 'Failed to detect tech stack' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/compatibility validates missing and unsafe paths', async () => {
    const missingRes = await request(app).get('/api/fs/compatibility');
    expect(missingRes.status).toBe(400);
    expect(missingRes.body).toMatchObject({ success: false, error: 'Path is required' });

    const unsafeRes = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: 'C:\\bad"path' });
    expect(unsafeRes.status).toBe(400);
    expect(unsafeRes.body).toMatchObject({ success: false, error: 'Invalid path' });
  });

  test('GET /api/fs/compatibility handles non-directory and access errors', async () => {
    const filePath = path.join(tempDir, 'file.txt');
    await fs.writeFile(filePath, 'content');
    const fileRes = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: filePath });
    expect(fileRes.status).toBe(400);
    expect(fileRes.body).toMatchObject({ success: false, error: 'Path is not a directory' });

    const protectedPath = path.join(tempDir, 'protected');
    const resolved = path.resolve(protectedPath);
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (path.resolve(candidate) === resolved) {
        const err = new Error('no access');
        err.code = 'EPERM';
        throw err;
      }
      return originalStat(candidate);
    });

    const accessRes = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: protectedPath });
    expect(accessRes.status).toBe(403);
    expect(accessRes.body).toMatchObject({ success: false, error: 'Access denied' });

    statSpy.mockRestore();
  });

  test('GET /api/fs/compatibility returns 404 for missing paths and 500 for unknown errors', async () => {
    const missingRes = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: path.join(tempDir, 'missing') });
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toMatchObject({ success: false, error: 'Path not found' });

    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async () => {
      throw new Error('boom');
    });

    const errorRes = await request(app)
      .get('/api/fs/compatibility')
      .query({ path: path.join(tempDir, 'error') });
    expect(errorRes.status).toBe(500);
    expect(errorRes.body).toMatchObject({ success: false, error: 'Failed to scan compatibility' });

    statSpy.mockRestore();
  });
});
