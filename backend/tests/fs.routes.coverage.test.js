import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const scanCompatibilityMock = vi.hoisted(() => vi.fn());
const runGitCommandMock = vi.hoisted(() => vi.fn());
vi.mock('../services/importCompatibility.js', () => ({
  scanCompatibility: scanCompatibilityMock
}));
vi.mock('../utils/git.js', () => ({
  runGitCommand: runGitCommandMock
}));

const buildApp = async () => {
  const router = (await import('../routes/fs.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/fs', router);
  return app;
};

describe('fs routes coverage', () => {
  let app;
  let tempDir;

  beforeEach(async () => {
    scanCompatibilityMock.mockReset();
    runGitCommandMock.mockReset();
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

  test('POST /api/fs/detect-git-tech validates missing and unsafe URLs', async () => {
    const missingRes = await request(app).post('/api/fs/detect-git-tech');
    expect(missingRes.status).toBe(400);
    expect(missingRes.body).toMatchObject({
      success: false,
      error: 'Git repository URL is required'
    });

    const unsafeRes = await request(app)
      .post('/api/fs/detect-git-tech')
      .send({ gitUrl: 'https://example.com/bad"repo.git' });
    expect(unsafeRes.status).toBe(400);
    expect(unsafeRes.body).toMatchObject({
      success: false,
      error: 'Invalid git repository URL'
    });
  });

  test('POST /api/fs/detect-git-tech clones and detects tech stack', async () => {
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' }
        })
      );
      return { stdout: '', stderr: '', code: 0 };
    });

    const res = await request(app)
      .post('/api/fs/detect-git-tech')
      .send({ gitUrl: 'https://github.com/octocat/sample.git' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    });
    expect(runGitCommandMock).toHaveBeenCalled();
  });

  test('POST /api/fs/detect-git-tech handles git clone errors', async () => {
    runGitCommandMock.mockRejectedValue(new Error('Clone failed'));

    const res = await request(app)
      .post('/api/fs/detect-git-tech')
      .send({ gitUrl: 'https://github.com/octocat/sample.git' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      error: 'Failed to detect git tech stack'
    });
  });

  test('POST /api/fs/detect-git-tech handles temp cleanup errors gracefully', async () => {
    // Set up the mock to create temp files so cleanup is attempted
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' }
        })
      );
      return { stdout: '', stderr: '', code: 0 };
    });
    
    // Mock fs.rm to fail during cleanup
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('Cleanup failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await request(app)
        .post('/api/fs/detect-git-tech')
        .send({ gitUrl: 'https://github.com/octocat/sample.git' });

      // Should still return success since the actual operation succeeded
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });
      
      // Verify cleanup error was logged
      expect(warnSpy).toHaveBeenCalled();
      // The warning is called with message and error/details
      const [warnMessage] = warnSpy.mock.calls[0];
      expect(warnMessage).toContain('Failed to clean up git tech detection temp folder');
    } finally {
      rmSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('POST /api/fs/detect-git-tech handles non-string auth parameters', async () => {
    // Test with non-string authMethod (number, boolean, object) to cover type-check branches (lines 385-388)
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' }
        })
      );
      return { stdout: '', stderr: '', code: 0 };
    });

    // Test multiple non-string type scenarios - each test hits different branches
    const testCases = [
      // All non-strings to hit false branches of all typeof checks
      {
        gitUrl: 'https://github.com/octocat/sample1.git',
        authMethod: 123,
        token: { key: 'value' },
        username: true,
        provider: false
      },
      // Mix of string and non-string to ensure both branches of each typeof are hit
      {
        gitUrl: 'https://github.com/octocat/sample2.git',
        authMethod: 'token',  // string - hits true branch of line 385
        token: null,  // null - hits false branch of line 386
        username: ['array'],  // array - hits false branch of line 387
        provider: 789  // number - hits false branch of line 388
      },
      // Different mix
      {
        gitUrl: 'https://github.com/octocat/sample3.git',
        authMethod: {},  // object - hits false branch of line 385
        token: 'mytoken',  // string - hits true branch of line  386
        username: undefined,  // undefined - hits false branch of line 387
        provider: 'github'  // string - hits true branch of line 388
      },
      // Another mix
      {
        gitUrl: 'https://github.com/octocat/sample4.git',
        authMethod: null,  // null - false branch 385
        token: 42,  // number - false branch 386
        username: 'user',  // string - true branch 387
        provider: []  // array - false branch 388
      }
    ];

    for (const testPayload of testCases) {
      const res = await request(app)
        .post('/api/fs/detect-git-tech')
        .send(testPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  test('POST /api/fs/detect-git-tech with minimal request body', async () => {
    // Test that covers line 375: const payload = req.body || {}
    // and lines 385-388: typeof checks for auth fields when not provided
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, 'package.json'),
        JSON.stringify({
          dependencies: { react: '^18.0.0', express: '^4.0.0' }
        })
      );
      return { stdout: '', stderr: '', code: 0 };
    });

    // Send POST with only gitUrl, no auth parameters or undefined auth values
    const res = await request(app)
      .post('/api/fs/detect-git-tech')
      .send({ 
        gitUrl: 'https://github.com/octocat/sample.git',
        authMethod: undefined,
        token: undefined,
        username: undefined,
        provider: undefined
      });

    // Should succeed with defaults (empty auth strings from typeof checks)
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    });
  });

  test('POST /api/fs/detect-git-tech with undefined req.body uses fallback', async () => {
    // Test line 375: req.body || {}
    // Create app without express.json() to leave req.body undefined
    const customApp = express();
    const router = (await import('../routes/fs.js')).default;
    customApp.use('/api/fs', router);

    runGitCommandMock.mockImplementation(async () => {
      throw new Error('Should not reach git command');
    });

    // Without express.json(), req.body is undefined, triggering the || {} fallback
    const res = await request(customApp).post('/api/fs/detect-git-tech');
    
    // Should fail with 'Git repository URL is required' because payload becomes {}
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Git repository URL is required');
  });

  test('POST /api/fs/detect-git-tech confirms cleanup error logging', async () => {
    // Explicitly test line 413: console.warn in cleanup error handler
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      // Create actual temp files so fs.rm is called
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({
        dependencies: { react: '^18.0.0' }
      }));
      return { stdout: '', stderr: '', code: 0 };
    });

    // Mock cleanup error with no message property to test the || fallback
    const errorWithoutMessage = Object.create(Error.prototype);
    errorWithoutMessage.code = 'EPERM';
    errorWithoutMessage.toString = function() { return 'EPERM error'; };
    
    const rmSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(errorWithoutMessage);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await request(app)
        .post('/api/fs/detect-git-tech')
        .send({ gitUrl: 'https://github.com/octocat/sample.git' });

      // Operation succeeds, cleanup fails silently with warning
      expect(res.status).toBe(200);
      expect(warnSpy).toHaveBeenCalled();
      // Verify the cleanup error was logged (covers line 413)
      const [warnMessage, errorMsg] = warnSpy.mock.calls[0];
      expect(warnMessage).toContain('Failed to clean up');
      expect(errorMsg).toBeDefined();
    } finally {
      rmSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('POST /api/fs/detect-git-tech with malformed body types', async () => {
    // Test lines 385-388: typeof checks for non-string auth parameters
    runGitCommandMock.mockImplementation(async (_cwd, args) => {
      const target = args[args.length - 1];
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, 'package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } })
      );
      return { stdout: '', stderr: '', code: 0 };
    });

    // Send non-string types for auth fields to trigger the ':  ''` branches
    const res = await request(app)
      .post('/api/fs/detect-git-tech')
      .send({
        gitUrl: 'https://github.com/octocat/sample.git',
        authMethod: 12345,        // number - triggers line 385 false branch
        token: ['not', 'string'],  // array - triggers line 386 false branch  
        username: { obj: true },   // object - triggers line 387 false branch
        provider: null             // null - triggers line 388 false branch
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
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
