import { describe, test, expect, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolveProjectLayout } from '../services/projectLayout.js';

const writeJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
};

describe('projectLayout coverage', () => {
  test('detects backend:start root script as backend workspace signal', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-backend-start-'));

    try {
      await writeJson(path.join(projectPath, 'package.json'), {
        name: 'root-layout',
        scripts: {
          dev: 'vite',
          'backend:start': 'node backend/server.js'
        }
      });

      const layout = await resolveProjectLayout(projectPath);

      expect(layout.hasRootBackendScript).toBe(true);
      expect(layout.rootBackendScriptName).toBe('backend:start');
      expect(layout.backendWorkspacePath).toBe(projectPath);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('returns empty root scripts when root package.json JSON is invalid', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-invalid-json-'));

    try {
      await fs.writeFile(path.join(projectPath, 'package.json'), '{ bad json', 'utf8');

      const layout = await resolveProjectLayout(projectPath);

      expect(layout.rootScripts).toEqual({});
      expect(layout.hasRootFrontendScript).toBe(false);
      expect(layout.frontendWorkspacePath).toBeNull();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('returns empty root scripts when parsed package is not an object', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-array-package-'));

    try {
      await fs.writeFile(path.join(projectPath, 'package.json'), '[]', 'utf8');

      const layout = await resolveProjectLayout(projectPath);

      expect(layout.rootScripts).toEqual({});
      expect(layout.hasRootBackendScript).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('treats array scripts as invalid and disables root frontend script detection', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-scripts-array-'));

    try {
      await fs.writeFile(
        path.join(projectPath, 'package.json'),
        JSON.stringify({ name: 'layout-scripts-array', scripts: [] }),
        'utf8'
      );

      const layout = await resolveProjectLayout(projectPath);

      expect(layout.rootScripts).toEqual({});
      expect(layout.hasRootFrontendScript).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('rethrows non-ENOENT stat errors while resolving manifests', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'layout-stat-error-'));

    try {
      const rootPackage = path.join(projectPath, 'package.json');
      await writeJson(rootPackage, { name: 'layout-error' });

      const originalStat = fs.stat;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
        if (String(candidate) === rootPackage) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return originalStat(candidate, ...rest);
      });

      await expect(resolveProjectLayout(projectPath)).rejects.toThrow('denied');
      statSpy.mockRestore();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
