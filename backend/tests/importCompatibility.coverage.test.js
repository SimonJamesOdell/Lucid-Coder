import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  applyCompatibility,
  applyProjectStructure,
  scanCompatibility,
  __compatibilityInternals
} from '../services/importCompatibility.js';

const writePackageJson = async (dir, data) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(data, null, 2));
};

describe('importCompatibility coverage', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('scanCompatibility reports unsupported when no package.json', async () => {
    const result = await scanCompatibility(tempDir);

    expect(result.supported).toBe(false);
    expect(result.needsChanges).toBe(false);
    expect(result.reason).toBe('No package.json found');
  });

  test('buildCompatibilityPlan handles missing scripts and dependencies', () => {
    const plan = __compatibilityInternals.buildCompatibilityPlan({
      pkg: { name: 'no-deps' },
      packageJsonPath: path.join(tempDir, 'package.json')
    });

    expect(plan.framework).toBe('unknown');
    expect(plan.needsChanges).toBe(false);
  });

  test('detectFramework tolerates missing scripts input', () => {
    const framework = __compatibilityInternals.detectFramework({ deps: {}, scripts: null });
    expect(framework).toBe('unknown');
  });

  test('applyCompatibility updates Vite dev script with host flag', async () => {
    await writePackageJson(tempDir, {
      name: 'vite-app',
      scripts: { dev: 'vite' },
      dependencies: { vite: '^5.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toContain('--host 0.0.0.0');
  });

  test('applyCompatibility adds Vite dev script when scripts are missing', async () => {
    await writePackageJson(tempDir, {
      name: 'vite-empty',
      dependencies: { vite: '^5.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toBe('vite --host 0.0.0.0');
  });

  test('applyCompatibility injects HOST for CRA and adds cross-env', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-app',
      scripts: { dev: 'react-scripts start' },
      dependencies: { 'react-scripts': '^5.0.1' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toMatch(/HOST=0\.0\.0\.0/);
    expect(updated.devDependencies).toHaveProperty('cross-env');
  });

  test('applyCompatibility uses craco base command when dependency is present', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-craco',
      scripts: {},
      dependencies: { '@craco/craco': '^7.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toContain('craco start');
    expect(updated.scripts.dev).toMatch(/HOST=0\.0\.0\.0/);
    expect(updated.devDependencies).toHaveProperty('cross-env');
  });

  test('applyCompatibility injects HOST into existing craco scripts', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-craco-script',
      scripts: { dev: 'craco start' },
      dependencies: { '@craco/craco': '^7.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toMatch(/HOST=0\.0\.0\.0/);
    expect(updated.scripts.dev).toContain('craco start');
  });

  test('applyCompatibility injects HOST into existing cross-env scripts', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-cross-env',
      scripts: { dev: 'cross-env REACT_APP=1 react-scripts start' },
      dependencies: { 'react-scripts': '^5.0.1' },
      devDependencies: { 'cross-env': '^7.0.3' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toMatch(/cross-env\s+HOST=0\.0\.0\.0/);
  });

  test('applyCompatibility skips CRA update when HOST is already set', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-hosted',
      scripts: { dev: 'cross-env HOST=0.0.0.0 react-scripts start' },
      dependencies: { 'react-scripts': '^5.0.1' },
      devDependencies: { 'cross-env': '^7.0.3' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(false);
  });

  test('applyCompatibility injects HOST into CRA scripts without HOST', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-no-host',
      scripts: { dev: 'react-scripts start --port 3000' },
      dependencies: { 'react-scripts': '^5.0.1' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toMatch(/HOST=0\.0\.0\.0/);
    expect(updated.devDependencies).toHaveProperty('cross-env');
  });

  test('applyCompatibility adds scripts when CRA scripts are missing', async () => {
    await writePackageJson(tempDir, {
      name: 'cra-empty',
      scripts: {},
      dependencies: { 'react-scripts': '^5.0.1' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toContain('react-scripts start');
    expect(updated.devDependencies).toHaveProperty('cross-env');
  });

  test('scanCompatibility reports unsupported for unknown frameworks', async () => {
    await writePackageJson(tempDir, {
      name: 'unknown-app',
      scripts: { dev: 'node server.js' },
      dependencies: { lodash: '^4.17.0' }
    });

    const result = await scanCompatibility(tempDir);
    expect(result.supported).toBe(false);
    expect(result.framework).toBe('unknown');
  });

  test('applyCompatibility updates Next.js dev script host', async () => {
    await writePackageJson(tempDir, {
      name: 'next-app',
      scripts: { dev: 'next dev' },
      dependencies: { next: '^13.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(true);

    const updated = JSON.parse(await fs.readFile(path.join(tempDir, 'package.json'), 'utf-8'));
    expect(updated.scripts.dev).toContain('-H 0.0.0.0');
  });

  test('applyCompatibility returns applied false when Next.js script is already updated', async () => {
    await writePackageJson(tempDir, {
      name: 'next-ready',
      scripts: { dev: 'next dev -H 0.0.0.0' },
      dependencies: { next: '^13.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(false);
  });

  test('applyCompatibility returns applied false when no changes are required', async () => {
    await writePackageJson(tempDir, {
      name: 'vite-ready',
      scripts: { dev: 'vite --host 0.0.0.0' },
      dependencies: { vite: '^5.0.0' }
    });

    const result = await applyCompatibility(tempDir);
    expect(result.applied).toBe(false);
  });

  test('buildCompatibilityPlan updates CRA dev script without HOST', () => {
    const plan = __compatibilityInternals.buildCompatibilityPlan({
      pkg: {
        scripts: { dev: 'react-scripts start --port 3000' },
        dependencies: { 'react-scripts': '^5.0.1' }
      },
      packageJsonPath: path.join(tempDir, 'package.json')
    });

    expect(plan.framework).toBe('cra');
    expect(plan.changes.some((change) => change.key === 'scripts.dev')).toBe(true);
  });

  test('applyProjectStructure moves root files into frontend directory', async () => {
    await writePackageJson(tempDir, { name: 'root-app', scripts: { dev: 'vite' }, dependencies: {} });
    await fs.writeFile(path.join(tempDir, 'index.html'), '<!doctype html>');

    const result = await applyProjectStructure(tempDir);
    expect(result.applied).toBe(true);

    const moved = await fs.readFile(path.join(tempDir, 'frontend', 'index.html'), 'utf-8');
    expect(moved).toContain('doctype');
  });

  test('applyProjectStructure returns applied false when no move is needed', async () => {
    await fs.mkdir(path.join(tempDir, 'frontend'), { recursive: true });
    await writePackageJson(tempDir, { name: 'root-app', scripts: { dev: 'vite' }, dependencies: {} });

    const result = await applyProjectStructure(tempDir);
    expect(result).toMatchObject({ applied: false });
  });

  test('resolveFrontendPackageJson prefers frontend package.json', async () => {
    const frontendDir = path.join(tempDir, 'frontend');
    await fs.mkdir(frontendDir, { recursive: true });
    await fs.writeFile(path.join(frontendDir, 'package.json'), JSON.stringify({ name: 'frontend-app' }));

    const resolved = await __compatibilityInternals.resolveFrontendPackageJson(tempDir);
    expect(resolved).toBe(path.join(frontendDir, 'package.json'));
  });

  test('resolveFrontendPackageJson falls back to root package.json', async () => {
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'root-app' }));

    const resolved = await __compatibilityInternals.resolveFrontendPackageJson(tempDir);
    expect(resolved).toBe(path.join(tempDir, 'package.json'));
  });

  test('resolveFrontendPackageJson surfaces stat errors', async () => {
    const frontendPkg = path.join(tempDir, 'frontend', 'package.json');
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === frontendPkg) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalStat(candidate);
    });

    await expect(__compatibilityInternals.resolveFrontendPackageJson(tempDir)).rejects.toThrow('denied');

    statSpy.mockRestore();
  });

  test('injectHostIntoCrossEnv returns empty for empty scripts', () => {
    const result = __compatibilityInternals.injectHostIntoCrossEnv('');
    expect(result).toBe('');
  });

  test('appendArgIfMissing handles empty and existing flags', () => {
    expect(__compatibilityInternals.appendArgIfMissing('', '--host', '0.0.0.0')).toBe('');
    expect(__compatibilityInternals.appendArgIfMissing('vite --host 0.0.0.0', '--host', '0.0.0.0'))
      .toBe('vite --host 0.0.0.0');
    expect(__compatibilityInternals.appendArgIfMissing('vite', '--host', '0.0.0.0'))
      .toBe('vite --host 0.0.0.0');
  });

  test('ensurePrefix handles empty and already-prefixed scripts', () => {
    expect(__compatibilityInternals.ensurePrefix('', 'cross-env HOST=0.0.0.0'))
      .toBe('cross-env HOST=0.0.0.0');
    expect(__compatibilityInternals.ensurePrefix('cross-env HOST=0.0.0.0 vite', 'cross-env HOST=0.0.0.0'))
      .toBe('cross-env HOST=0.0.0.0 vite');
    expect(__compatibilityInternals.ensurePrefix('vite', 'cross-env HOST=0.0.0.0'))
      .toBe('cross-env HOST=0.0.0.0 vite');
  });

  test('buildCompatibilityPlan adds CRA dev script when missing', () => {
    const plan = __compatibilityInternals.buildCompatibilityPlan({
      pkg: { dependencies: { 'react-scripts': '^5.0.1' }, scripts: {} },
      packageJsonPath: path.join(tempDir, 'package.json')
    });

    const devChange = plan.changes.find((change) => change.key === 'scripts.dev');
    const depChange = plan.changes.find((change) => change.key === 'devDependencies.cross-env');

    expect(devChange).toBeTruthy();
    expect(depChange).toBeTruthy();
  });

  test('buildCompatibilityPlan adds Next.js dev script when missing', () => {
    const plan = __compatibilityInternals.buildCompatibilityPlan({
      pkg: { dependencies: { next: '^13.0.0' }, scripts: {} },
      packageJsonPath: path.join(tempDir, 'package.json')
    });

    const devChange = plan.changes.find((change) => change.key === 'scripts.dev');
    expect(devChange?.after).toContain('next dev -H 0.0.0.0');
  });

  test('buildCompatibilityPlan injects HOST for CRA dev scripts without HOST', () => {
    const plan = __compatibilityInternals.buildCompatibilityPlan({
      pkg: { dependencies: { 'react-scripts': '^5.0.1' }, scripts: { dev: 'react-scripts start --port 3000' } },
      packageJsonPath: path.join(tempDir, 'package.json')
    });

    const devChange = plan.changes.find((change) => change.key === 'scripts.dev');
    expect(devChange?.after).toMatch(/HOST=0\.0\.0\.0/);
  });

  test('buildStructurePlan returns false when missing frontend/backend', async () => {
    const plan = await __compatibilityInternals.buildStructurePlan(tempDir);
    expect(plan).toMatchObject({ needsMove: false });
  });

  test('buildStructurePlan returns early when frontend or backend dirs exist', async () => {
    const frontendDir = path.join(tempDir, 'frontend');
    await fs.mkdir(frontendDir, { recursive: true });

    const frontendPlan = await __compatibilityInternals.buildStructurePlan(tempDir);
    expect(frontendPlan).toMatchObject({ needsMove: false });

    await fs.rm(frontendDir, { recursive: true, force: true });
    await fs.mkdir(path.join(tempDir, 'backend'), { recursive: true });

    const backendPlan = await __compatibilityInternals.buildStructurePlan(tempDir);
    expect(backendPlan).toMatchObject({ needsMove: false });
  });

  test('buildStructurePlan skips when root package.json is missing', async () => {
    const plan = await __compatibilityInternals.buildStructurePlan(tempDir);
    expect(plan).toMatchObject({ needsMove: false, reason: 'root package.json not found' });
  });

  test('buildStructurePlan surfaces directory stat errors', async () => {
    const frontendDir = path.join(tempDir, 'frontend');
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === frontendDir) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return originalStat(candidate);
    });

    await expect(__compatibilityInternals.buildStructurePlan(tempDir)).rejects.toThrow('denied');

    statSpy.mockRestore();
  });

  test('applyProjectStructure falls back to copy when rename is cross-device', async () => {
    await writePackageJson(tempDir, { name: 'root-app', scripts: { dev: 'vite' }, dependencies: {} });
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'index.js'), 'console.log("ok");');
    await fs.writeFile(path.join(tempDir, 'README.md'), 'readme');

    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('xdev'), { code: 'EXDEV' }));

    try {
      const result = await applyProjectStructure(tempDir);
      expect(result.applied).toBe(true);

      const movedDirExists = await fs
        .access(path.join(tempDir, 'frontend', 'src'))
        .then(() => true)
        .catch(() => false);
      const movedFileExists = await fs
        .access(path.join(tempDir, 'frontend', 'README.md'))
        .then(() => true)
        .catch(() => false);
      const originalDirExists = await fs
        .access(path.join(tempDir, 'src'))
        .then(() => true)
        .catch(() => false);
      const originalFileExists = await fs
        .access(path.join(tempDir, 'README.md'))
        .then(() => true)
        .catch(() => false);

      expect(movedDirExists).toBe(true);
      expect(movedFileExists).toBe(true);
      expect(originalDirExists).toBe(false);
      expect(originalFileExists).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }
  });

  test('applyProjectStructure surfaces non-EXDEV rename errors', async () => {
    await writePackageJson(tempDir, { name: 'root-app', scripts: { dev: 'vite' }, dependencies: {} });
    await fs.writeFile(path.join(tempDir, 'README.md'), 'readme');

    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

    try {
      await expect(applyProjectStructure(tempDir)).rejects.toThrow('denied');
    } finally {
      renameSpy.mockRestore();
    }
  });
});
