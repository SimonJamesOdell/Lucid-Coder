import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import net from 'net';
import { EventEmitter } from 'events';
import * as projectScaffolding from '../services/projectScaffolding.js';

const { execMock, spawnMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  spawnMock: vi.fn()
}));

vi.mock('child_process', async () => ({
  __esModule: true,
  ...(await vi.importActual('child_process')),
  exec: execMock,
  spawn: spawnMock
}));

const gitUtils = vi.hoisted(() => ({
  runGitCommand: vi.fn(),
  ensureGitRepository: vi.fn().mockResolvedValue({ initialized: true }),
  configureGitUser: vi.fn().mockResolvedValue(undefined),
  ensureInitialCommit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../utils/git.js', () => ({
  __esModule: true,
  ...gitUtils
}));

const defaultExecImpl = (command, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  if (cb) {
    setImmediate(() => cb(null, { stdout: '', stderr: '' }));
  }
};

const makeProjectConfig = (rootDir, overrides = {}) => ({
  name: 'Sample Project',
  description: 'End-to-end test project',
  frontend: { language: 'javascript', framework: 'react' },
  backend: { language: 'javascript', framework: 'express' },
  path: path.join(rootDir, 'sample-project'),
  ...overrides
});

const ensurePkg = async (targetPath, data) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(data));
};

const writeTextFile = async (targetPath, content = '') => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
};

const createChildProcessStub = () => {
  const child = new EventEmitter();
  child.pid = Math.floor(Math.random() * 10000) + 2000;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.on = child.on.bind(child);
  return child;
};

const runWithRealModeProjectScaffolding = async (callback) => {
  const previousForceFlag = process.env.LUCIDCODER_FORCE_REAL_START;
  try {
    vi.resetModules();
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';
    const module = await import('../services/projectScaffolding.js');
    await callback(module);
  } finally {
    vi.resetModules();
    if (previousForceFlag === undefined) {
      delete process.env.LUCIDCODER_FORCE_REAL_START;
    } else {
      process.env.LUCIDCODER_FORCE_REAL_START = previousForceFlag;
    }
  }
};

const originalEnv = { ...process.env };
let tempDir;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.LUCIDCODER_FORCE_REAL_START;
});

afterAll(() => {
  process.env.NODE_ENV = originalEnv.NODE_ENV;
  if (originalEnv.LUCIDCODER_FORCE_REAL_START === undefined) {
    delete process.env.LUCIDCODER_FORCE_REAL_START;
  } else {
    process.env.LUCIDCODER_FORCE_REAL_START = originalEnv.LUCIDCODER_FORCE_REAL_START;
  }
});

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-tests-'));
  execMock.mockReset();
  execMock.mockImplementation(defaultExecImpl);
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => createChildProcessStub());
  Object.values(gitUtils).forEach((mockFn) => mockFn.mockClear?.());
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('generateProjectFiles', () => {
  test('creates frontend and backend scaffolds', async () => {
    const config = makeProjectConfig(tempDir, { name: 'Super App' });

    await projectScaffolding.generateProjectFiles(config);

    const readme = await fs.readFile(path.join(config.path, 'README.md'), 'utf8');
    expect(readme).toContain('# Super App');
    expect(readme).toMatch(/Version:\s*0\.1\.0/);

    const versionFile = await fs.readFile(path.join(config.path, 'VERSION'), 'utf8');
    expect(versionFile.trim()).toBe('0.1.0');

    const changelog = await fs.readFile(path.join(config.path, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('# Changelog');
    expect(changelog).toMatch(/##\s+0\.1\.0\s+\(\d{4}-\d{2}-\d{2}\)/);
    expect(changelog).toMatch(/-\s+Project scaffold created\./);
    expect(changelog).not.toMatch(/##\s+Unreleased/);

    const bumpTool = await fs.readFile(path.join(config.path, 'tools', 'bump-version.mjs'), 'utf8');
    expect(bumpTool).toContain('node tools/bump-version.mjs');

    const frontendPackage = JSON.parse(
      await fs.readFile(path.join(config.path, 'frontend', 'package.json'), 'utf8')
    );
    expect(frontendPackage.name).toBe('super-app-frontend');
    expect(frontendPackage.version).toBe('0.1.0');

    const backendServer = await fs.readFile(path.join(config.path, 'backend', 'server.js'), 'utf8');
    expect(backendServer).toContain('express');

    const backendPackage = JSON.parse(
      await fs.readFile(path.join(config.path, 'backend', 'package.json'), 'utf8')
    );
    expect(backendPackage.version).toBe('0.1.0');
    const backendServerTest = await fs.readFile(
      path.join(config.path, 'backend', '__tests__', 'server.test.js'),
      'utf8'
    );
    expect(backendServerTest).toContain('Express app instance');

    const backendRoutesTest = await fs.readFile(
      path.join(config.path, 'backend', '__tests__', 'routes.test.js'),
      'utf8'
    );
    expect(backendRoutesTest).toContain('API helper examples');
  });

  test('falls back to default README description when missing', async () => {
    const config = makeProjectConfig(tempDir, { description: '' });

    await projectScaffolding.generateProjectFiles(config);

    const readme = await fs.readFile(path.join(config.path, 'README.md'), 'utf8');
    expect(readme).toContain('A full-stack web application');
  });

  test('validates project name input', async () => {
    const config = makeProjectConfig(tempDir, { name: '   ' });
    await expect(projectScaffolding.generateProjectFiles(config)).rejects.toThrow('Project name is required');
  });

  test('creates vitest config for react typescript frontends', async () => {
    const config = makeProjectConfig(tempDir, {
      name: 'TS Frontend',
      frontend: { language: 'typescript', framework: 'react' }
    });

    await projectScaffolding.generateProjectFiles(config);

    const vitestConfig = await fs.readFile(
      path.join(config.path, 'frontend', 'vitest.config.ts'),
      'utf8'
    );
    expect(vitestConfig).toContain('defineConfig');
    const tsConfig = await fs.readFile(path.join(config.path, 'frontend', 'tsconfig.json'), 'utf8');
    expect(tsConfig).toContain('compilerOptions');
  });

  test('creates vue frontend scaffolding', async () => {
    const config = makeProjectConfig(tempDir, {
      name: 'Vue Frontend',
      frontend: { language: 'javascript', framework: 'vue' }
    });

    await projectScaffolding.generateProjectFiles(config);

    const appVue = await fs.readFile(path.join(config.path, 'frontend', 'src', 'App.vue'), 'utf8');
    expect(appVue).toContain('<template>');
  });

  test('throws when frontend template is unavailable', async () => {
    const config = makeProjectConfig(tempDir, {
      frontend: { language: 'javascript', framework: 'svelte' }
    });

    await expect(projectScaffolding.generateProjectFiles(config))
      .rejects.toThrow('Unsupported frontend combination: svelte with javascript');
  });

  test('creates flask backend scaffolding', async () => {
    const config = makeProjectConfig(tempDir, {
      name: 'Flask API',
      backend: { language: 'python', framework: 'flask' }
    });

    await projectScaffolding.generateProjectFiles(config);

    const appPy = await fs.readFile(path.join(config.path, 'backend', 'app.py'), 'utf8');
    expect(appPy).toContain('Flask');
    const requirements = await fs.readFile(path.join(config.path, 'backend', 'requirements.txt'), 'utf8');
    expect(requirements).toContain('Flask');
  });

  test('creates express typescript backend scaffolding', async () => {
    const config = makeProjectConfig(tempDir, {
      name: 'TS API',
      backend: { language: 'typescript', framework: 'express' }
    });

    await projectScaffolding.generateProjectFiles(config);

    const serverTs = await fs.readFile(path.join(config.path, 'backend', 'src', 'server.ts'), 'utf8');
    expect(serverTs).toContain('express');
    const tsConfig = await fs.readFile(path.join(config.path, 'backend', 'tsconfig.json'), 'utf8');
    expect(tsConfig).toContain('"rootDir"');
    const serverTestTs = await fs.readFile(
      path.join(config.path, 'backend', 'src', '__tests__', 'server.test.ts'),
      'utf8'
    );
    expect(serverTestTs).toContain('Express app instance');
    const routesTestTs = await fs.readFile(
      path.join(config.path, 'backend', 'src', '__tests__', 'routes.test.ts'),
      'utf8'
    );
    expect(routesTestTs).toContain('API helper examples');
  });

  test('throws when backend template is unavailable', async () => {
    const config = makeProjectConfig(tempDir, {
      backend: { language: 'javascript', framework: 'rails' }
    });

    await expect(projectScaffolding.generateProjectFiles(config))
      .rejects.toThrow('Unsupported backend combination: rails with javascript');
  });

  test('documents test:e2e but omits playwright install step when dependency missing', async () => {
    const config = makeProjectConfig(tempDir, { name: 'Docs Without Playwright' });
    const template = projectScaffolding.__testing.templates.frontend.react.javascript;
    const originalPackageJson = template.packageJson;

    template.packageJson = (name) => {
      const pkg = originalPackageJson(name);
      if (pkg?.devDependencies) {
        delete pkg.devDependencies['@playwright/test'];
      }
      return pkg;
    };

    try {
      await projectScaffolding.__testing.generateMainProjectFiles(config.path, {
        name: config.name,
        description: config.description,
        frontend: config.frontend,
        backend: config.backend
      });

      const readme = await fs.readFile(path.join(config.path, 'README.md'), 'utf8');
      expect(readme).toContain('npm run test:e2e');
      expect(readme).not.toContain('npx playwright install');
    } finally {
      template.packageJson = originalPackageJson;
    }
  });

  test('skips optional React e2e harness when template omits it', async () => {
    const frontendPath = path.join(tempDir, 'react-no-e2e');
    const template = projectScaffolding.__testing.templates.frontend.react.javascript;
    const originalPlaywrightConfig = template.playwrightConfig;
    const originalE2eTest = template.e2eTest;

    delete template.playwrightConfig;
    delete template.e2eTest;

    try {
      await projectScaffolding.__testing.generateFrontendFiles(frontendPath, {
        name: 'React No E2E',
        framework: 'react',
        language: 'javascript'
      });

      const playwrightExists = await fs
        .access(path.join(frontendPath, 'playwright.config.js'))
        .then(() => true)
        .catch(() => false);
      const e2eExists = await fs
        .access(path.join(frontendPath, 'e2e', 'app.spec.js'))
        .then(() => true)
        .catch(() => false);

      expect(playwrightExists).toBe(false);
      expect(e2eExists).toBe(false);
    } finally {
      template.playwrightConfig = originalPlaywrightConfig;
      template.e2eTest = originalE2eTest;
    }
  });

  test('skips optional Vue harness files when template omits them', async () => {
    const frontendPath = path.join(tempDir, 'vue-no-harness');
    const template = projectScaffolding.__testing.templates.frontend.vue.javascript;
    const originals = {
      vitestConfig: template.vitestConfig,
      testSetup: template.testSetup,
      appTestJs: template.appTestJs,
      playwrightConfig: template.playwrightConfig,
      e2eTest: template.e2eTest
    };

    delete template.vitestConfig;
    delete template.testSetup;
    delete template.appTestJs;
    delete template.playwrightConfig;
    delete template.e2eTest;

    try {
      await projectScaffolding.__testing.generateFrontendFiles(frontendPath, {
        name: 'Vue No Harness',
        framework: 'vue',
        language: 'javascript'
      });

      const vitestExists = await fs
        .access(path.join(frontendPath, 'vitest.config.js'))
        .then(() => true)
        .catch(() => false);
      const setupExists = await fs
        .access(path.join(frontendPath, 'src', 'test', 'setup.js'))
        .then(() => true)
        .catch(() => false);
      const unitTestExists = await fs
        .access(path.join(frontendPath, 'src', '__tests__', 'App.test.js'))
        .then(() => true)
        .catch(() => false);
      const playwrightExists = await fs
        .access(path.join(frontendPath, 'playwright.config.js'))
        .then(() => true)
        .catch(() => false);
      const e2eExists = await fs
        .access(path.join(frontendPath, 'e2e', 'app.spec.js'))
        .then(() => true)
        .catch(() => false);

      expect(vitestExists).toBe(false);
      expect(setupExists).toBe(false);
      expect(unitTestExists).toBe(false);
      expect(playwrightExists).toBe(false);
      expect(e2eExists).toBe(false);
    } finally {
      Object.assign(template, originals);
    }
  });

  test('skips optional backend harness files when template omits them', async () => {
    const backendPath = path.join(tempDir, 'express-no-harness');
    const template = projectScaffolding.__testing.templates.backend.express.javascript;
    const originalBabelConfig = template.babelConfig;
    const originalE2eHttpTest = template.e2eHttpTestJs;

    delete template.babelConfig;
    delete template.e2eHttpTestJs;

    try {
      await projectScaffolding.__testing.generateBackendFiles(backendPath, {
        name: 'Express No Harness',
        framework: 'express',
        language: 'javascript'
      });

      const babelExists = await fs
        .access(path.join(backendPath, 'babel.config.cjs'))
        .then(() => true)
        .catch(() => false);
      const e2eExists = await fs
        .access(path.join(backendPath, '__tests__', 'e2e.http.test.js'))
        .then(() => true)
        .catch(() => false);

      expect(babelExists).toBe(false);
      expect(e2eExists).toBe(false);
    } finally {
      template.babelConfig = originalBabelConfig;
      template.e2eHttpTestJs = originalE2eHttpTest;
    }
  });

  test('writes optional express typescript e2e harness when template provides it', async () => {
    const backendPath = path.join(tempDir, 'express-ts-with-e2e');
    const template = projectScaffolding.__testing.templates.backend.express.typescript;
    const originalE2eHttpTest = template.e2eHttpTestTs;

    template.e2eHttpTestTs = (name) => `// E2E HTTP test for ${name}`;

    try {
      await projectScaffolding.__testing.generateBackendFiles(backendPath, {
        name: 'Express TS With E2E',
        framework: 'express',
        language: 'typescript'
      });

      const e2eTest = await fs.readFile(
        path.join(backendPath, 'src', '__tests__', 'e2e.http.test.ts'),
        'utf8'
      );
      expect(e2eTest).toContain('E2E HTTP test');
    } finally {
      template.e2eHttpTestTs = originalE2eHttpTest;
    }
  });

  test('skips optional express typescript e2e harness when template omits it', async () => {
    const backendPath = path.join(tempDir, 'express-ts-no-e2e');
    const template = projectScaffolding.__testing.templates.backend.express.typescript;
    const originalE2eHttpTest = template.e2eHttpTestTs;

    delete template.e2eHttpTestTs;

    try {
      await projectScaffolding.__testing.generateBackendFiles(backendPath, {
        name: 'Express TS No E2E',
        framework: 'express',
        language: 'typescript'
      });

      const e2eExists = await fs
        .access(path.join(backendPath, 'src', '__tests__', 'e2e.http.test.ts'))
        .then(() => true)
        .catch(() => false);

      expect(e2eExists).toBe(false);
    } finally {
      template.e2eHttpTestTs = originalE2eHttpTest;
    }
  });

  test('skips optional Flask harness files when template omits them', async () => {
    const backendPath = path.join(tempDir, 'flask-no-harness');
    const template = projectScaffolding.__testing.templates.backend.flask.python;
    const originalPytestIni = template.pytestIni;
    const originalTestAppPy = template.testAppPy;

    delete template.pytestIni;
    delete template.testAppPy;

    try {
      await projectScaffolding.__testing.generateBackendFiles(backendPath, {
        name: 'Flask No Harness',
        framework: 'flask',
        language: 'python'
      });

      const pytestIniExists = await fs
        .access(path.join(backendPath, 'pytest.ini'))
        .then(() => true)
        .catch(() => false);
      const testsExist = await fs
        .access(path.join(backendPath, 'tests', 'test_app.py'))
        .then(() => true)
        .catch(() => false);

      expect(pytestIniExists).toBe(false);
      expect(testsExist).toBe(false);
    } finally {
      template.pytestIni = originalPytestIni;
      template.testAppPy = originalTestAppPy;
    }
  });
});

describe('installDependencies', () => {
  test('installs frontend and backend npm packages', async () => {
    const projectPath = path.join(tempDir, 'node-stack');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await ensurePkg(path.join(projectPath, 'backend', 'package.json'), { name: 'backend-app' });

    await projectScaffolding.installDependencies(projectPath);

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][0]).toBe('npm install');
    expect(execMock.mock.calls[0][1]).toMatchObject({ cwd: path.join(projectPath, 'frontend') });
    expect(execMock.mock.calls[1][1]).toMatchObject({ cwd: path.join(projectPath, 'backend') });
  });

  test('handles python backend dependency flow', async () => {
    const projectPath = path.join(tempDir, 'python-stack');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await fs.mkdir(path.join(projectPath, 'backend'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'backend', 'requirements.txt'), 'flask==3.0.0');

    await projectScaffolding.installDependencies(projectPath);

    expect(execMock).toHaveBeenCalledTimes(3);
    const activateCmd = process.platform === 'win32'
      ? path.join('venv', 'Scripts', 'activate.bat') + ' && pip install -r requirements.txt'
      : 'source ' + path.join('venv', 'bin', 'activate') + ' && pip install -r requirements.txt';
    expect(execMock.mock.calls[1][0]).toBe('python -m venv venv');
    expect(execMock.mock.calls[2][0]).toBe(activateCmd);
    expect(execMock.mock.calls[2][1]).toMatchObject({ cwd: path.join(projectPath, 'backend'), shell: true });
  });

  test('uses unix activation command for python backend when not on Windows', async () => {
    const projectPath = path.join(tempDir, 'python-unix-stack');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await fs.mkdir(path.join(projectPath, 'backend'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'backend', 'requirements.txt'), 'flask==3.0.0');

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    try {
      await projectScaffolding.installDependencies(projectPath);
    } finally {
      platformSpy.mockRestore();
    }

    const activateCmd = 'source ' + path.join('venv', 'bin', 'activate') + ' && pip install -r requirements.txt';
    const activateCall = execMock.mock.calls.find(([command]) => command === activateCmd);
    expect(activateCall).toBeDefined();
    expect(activateCall[1]).toMatchObject({ cwd: path.join(projectPath, 'backend'), shell: true });
  });

  test('bubbles backend install errors with context', async () => {
    const projectPath = path.join(tempDir, 'failing-stack');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await ensurePkg(path.join(projectPath, 'backend', 'package.json'), { name: 'backend-app' });

    execMock
      .mockImplementationOnce(defaultExecImpl)
      .mockImplementationOnce((command, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        setImmediate(() => cb(new Error('npm exploded')));
      });

    await expect(projectScaffolding.installDependencies(projectPath))
      .rejects.toThrow('Backend dependency installation failed: npm exploded');
  });

  test('bubbles frontend install errors with context', async () => {
    const projectPath = path.join(tempDir, 'frontend-failure');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await ensurePkg(path.join(projectPath, 'backend', 'package.json'), { name: 'backend-app' });

    execMock.mockImplementationOnce((command, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      setImmediate(() => cb(new Error('frontend boom')));
    });

    await expect(projectScaffolding.installDependencies(projectPath))
      .rejects.toThrow('Frontend dependency installation failed: frontend boom');
  });

  test('completes when backend type cannot be detected', async () => {
    const projectPath = path.join(tempDir, 'unknown-backend');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await fs.mkdir(path.join(projectPath, 'backend'), { recursive: true });

    await projectScaffolding.installDependencies(projectPath);

    expect(execMock).toHaveBeenCalled();
    const backendNpmInstalls = execMock.mock.calls.filter((call) =>
      call[0] === 'npm install' && call[1]?.cwd === path.join(projectPath, 'backend')
    );
    const backendVenvCreates = execMock.mock.calls.filter((call) => call[0] === 'python -m venv venv');
    expect(backendNpmInstalls.length).toBe(0);
    expect(backendVenvCreates.length).toBe(0);
  });
});

describe('startProject', () => {
  const createProjectFolders = async () => {
    const projectPath = path.join(tempDir, 'runtime');
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await ensurePkg(path.join(projectPath, 'backend', 'package.json'), { name: 'backend-app' });
    return projectPath;
  };

  const setupPythonProject = async (name, { winVenv = false, unixVenv = false } = {}) => {
    const projectPath = path.join(tempDir, name);
    await ensurePkg(path.join(projectPath, 'frontend', 'package.json'), { name: 'frontend-app' });
    await fs.mkdir(path.join(projectPath, 'backend'), { recursive: true });
    await writeTextFile(path.join(projectPath, 'backend', 'app.py'), 'print("ok")');
    if (winVenv) {
      await writeTextFile(path.join(projectPath, 'backend', 'venv', 'Scripts', 'activate.bat'), '@echo off');
    }
    if (unixVenv) {
      await writeTextFile(path.join(projectPath, 'backend', 'venv', 'bin', 'activate'), 'source env');
    }
    return projectPath;
  };

  const runRealStart = async (projectPath, platform, runner) => {
    await runWithRealModeProjectScaffolding(async (realModule) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const timeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn, ms, ...args) => {
          if (typeof fn === 'function') {
            fn(...args);
          }
          return 0;
        });

      try {
        await runner(realModule);
      } finally {
        platformSpy.mockRestore();
        timeoutSpy.mockRestore();
      }
    });
  };

  test('selects fallback ports when preferred ports are blocked', async () => {
    const projectPath = await createProjectFolders();

    const result = await projectScaffolding.startProject(projectPath, {
      frontendPort: 5173,
      frontendPortBase: 6200,
      backendPortBase: 6600
    });

    expect(result.success).toBe(true);
    expect(result.processes.frontend.port).toBeGreaterThanOrEqual(6200);
    expect(result.processes.backend.port).toBeGreaterThanOrEqual(6600);
  });

  test('validates project path input', async () => {
    await expect(projectScaffolding.startProject('', {})).rejects.toThrow('Invalid project path');
  });

  test('drops preferred frontend port when below explicit base', async () => {
    const projectPath = await createProjectFolders();

    const result = await projectScaffolding.startProject(projectPath, {
      frontendPort: 6100,
      frontendPortBase: 6500
    });

    expect(result.processes.frontend.port).toBeGreaterThanOrEqual(6500);
  });

  test('prefers backend default when base is below default port', async () => {
    const projectPath = await createProjectFolders();

    const canBind = (port) => new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => {
        server.close(() => resolve(true));
      });
    });

    const result = await projectScaffolding.startProject(projectPath, {
      backendPortBase: 2500
    });

    const reservedBackendPorts = new Set(projectScaffolding.__testing.snapshotReservedPorts().backend);
    const isDefaultPortReserved = reservedBackendPorts.has(3000);
    const isDefaultPortFree = await canBind(3000);
    if (!isDefaultPortReserved && isDefaultPortFree) {
      expect(result.processes.backend.port).toBe(3000);
      return;
    }

    expect(result.processes.backend.port).toBeGreaterThanOrEqual(2500);
    expect(reservedBackendPorts.has(result.processes.backend.port)).toBe(false);
  });

  test('respects explicit backend port when available', async () => {
    const projectPath = await createProjectFolders();

    const result = await projectScaffolding.startProject(projectPath, {
      backendPort: 7100
    });

    expect(result.processes.backend.port).toBe(7100);
  });

  test('drops preferred backend port when below explicit base', async () => {
    const projectPath = await createProjectFolders();

    const result = await projectScaffolding.startProject(projectPath, {
      backendPort: 4200,
      backendPortBase: 6800
    });

    expect(result.processes.backend.port).toBeGreaterThanOrEqual(6800);
  });

  test('uses Windows virtualenv when available for python backend', async () => {
    const projectPath = await setupPythonProject('py-win-venv', { winVenv: true });

    await runRealStart(projectPath, 'win32', async (realModule) => {
      const result = await realModule.startProject(projectPath);
      expect(result.success).toBe(true);
    });

    const backendCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'cmd');
    expect(backendCall).toBeDefined();
    expect(backendCall[1][1]).toContain('activate.bat');
  });

  test('falls back to system python on Windows when virtualenv missing', async () => {
    const projectPath = await setupPythonProject('py-win-fallback');

    await runRealStart(projectPath, 'win32', async (realModule) => {
      await realModule.startProject(projectPath);
    });

    const backendCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'python');
    expect(backendCall).toBeDefined();
    expect(backendCall[1]).toEqual(['app.py']);
  });

  test('uses bash activation on unix when virtualenv exists', async () => {
    const projectPath = await setupPythonProject('py-unix-venv', { unixVenv: true });

    await runRealStart(projectPath, 'linux', async (realModule) => {
      await realModule.startProject(projectPath);
    });

    const backendCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'bash');
    expect(backendCall).toBeDefined();
    expect(backendCall[1][1]).toContain('source');
  });

  test('falls back to python3 on unix when virtualenv missing', async () => {
    const projectPath = await setupPythonProject('py-unix-fallback');

    await runRealStart(projectPath, 'darwin', async (realModule) => {
      await realModule.startProject(projectPath);
    });

    const backendCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'python3');
    expect(backendCall).toBeDefined();
    expect(backendCall[1]).toEqual(['app.py']);
  });

  test('surfaces backend startup failures with context', async () => {
    const projectPath = await createProjectFolders();
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn crash');
    });

    await expect(
      runRealStart(projectPath, 'linux', async (realModule) => {
        await realModule.startProject(projectPath);
      })
    ).rejects.toThrow('Failed to start project: spawn crash');
  });
});

describe('scaffoldProject', () => {
  test('returns success after generating project files', async () => {
    const config = makeProjectConfig(tempDir, { name: 'CLI Tool' });
    const result = await projectScaffolding.scaffoldProject(config);
    expect(result).toEqual({ success: true });
    const readme = await fs.readFile(path.join(config.path, 'README.md'), 'utf8');
    expect(readme).toContain('CLI Tool');
  });

  test('propagates errors from generateProjectFiles', async () => {
    const config = makeProjectConfig(tempDir, { name: '' });
    await expect(projectScaffolding.scaffoldProject(config)).rejects.toThrow('Project name is required');
  });
});

describe('createProjectWithFiles', () => {
  test('emits progress updates and forwards port overrides', async () => {
    const config = makeProjectConfig(tempDir, { path: path.join(tempDir, 'workflow') });
    const onProgress = vi.fn();
    const portSettings = { frontendPortBase: '6300', backendPortBase: '7300' };

    const result = await projectScaffolding.createProjectWithFiles(config, {
      onProgress,
      portSettings
    });

    expect(onProgress).toHaveBeenCalled();
    expect(result.processes.frontend.port).toBeGreaterThanOrEqual(6300);
    expect(result.processes.backend.port).toBeGreaterThanOrEqual(7300);
  });

  test('bubbles directory creation errors', async () => {
    const config = makeProjectConfig(tempDir, { name: '' });
    await expect(projectScaffolding.createProjectWithFiles(config, {})).rejects.toThrow('Project name is required');
  });

  test('warns when progress reporters throw', async () => {
    const config = makeProjectConfig(tempDir, { path: path.join(tempDir, 'warn-progress') });
    const noisyReporter = vi.fn(() => {
      throw new Error('listener offline');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const result = await projectScaffolding.createProjectWithFiles(config, {
        onProgress: noisyReporter
      });

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith('Progress reporter failed:', 'listener offline');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('completes test-mode workflow without progress handler', async () => {
    const config = makeProjectConfig(tempDir, { path: path.join(tempDir, 'test-mode-flow') });

    const result = await projectScaffolding.createProjectWithFiles(config);

    expect(result.success).toBe(true);
    expect(result.progress.status).toBe('completed');
    expect(result.processes.frontend.port).toBeGreaterThan(0);
    expect(result.processes.backend.port).toBeGreaterThan(0);
  });
});

describe('createProjectWithFiles (real mode)', () => {
  test('runs full workflow with git initialization and dependency install', async () => {
    const config = makeProjectConfig(tempDir, { path: path.join(tempDir, 'real-workflow') });

    await runWithRealModeProjectScaffolding(async (realModule) => {
      const onProgress = vi.fn();
      const gitSettings = {
        defaultBranch: 'main',
        remoteUrl: 'git@example.com/ci/project.git',
        username: 'ci-bot'
      };

      const timeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn) => {
          if (typeof fn === 'function') {
            fn();
          }
          return 0;
        });

      try {
        const result = await realModule.createProjectWithFiles(config, {
          onProgress,
          gitSettings,
          portSettings: { frontendPortBase: '6400', backendPortBase: '8400' }
        });

        expect(result.success).toBe(true);
        expect(result.project.path).toBe(config.path);
        expect(result.processes.frontend.port).toBeGreaterThanOrEqual(6400);
        expect(result.processes.backend.port).toBeGreaterThanOrEqual(8400);
        expect(result.progress.status).toBe('completed');

        expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(config.path, { defaultBranch: 'main' });
        expect(gitUtils.runGitCommand).toHaveBeenCalledWith(config.path, [
          'remote',
          'add',
          'origin',
          gitSettings.remoteUrl
        ]);
        expect(gitUtils.configureGitUser).toHaveBeenCalledWith(config.path, {
          name: 'ci-bot',
          email: 'ci-bot@users.noreply.github.com'
        });

        expect(execMock).toHaveBeenCalledTimes(2);
        expect(spawnMock).toHaveBeenCalledTimes(2);

        const finalProgress = onProgress.mock.calls.at(-1)?.[0];
        expect(finalProgress.status).toBe('completed');
        expect(finalProgress.statusMessage).toBe('Development servers running');
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  test('surfaces git initialization failures and halts remaining steps', async () => {
    const config = makeProjectConfig(tempDir, { path: path.join(tempDir, 'real-workflow-failure') });

    await runWithRealModeProjectScaffolding(async (realModule) => {
      const onProgress = vi.fn();

      gitUtils.ensureGitRepository.mockRejectedValueOnce(new Error('git init failed'));

      await expect(
        realModule.createProjectWithFiles(config, {
          onProgress,
          gitSettings: { defaultBranch: 'develop' }
        })
      ).rejects.toThrow('git init failed');

      expect(execMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(gitUtils.runGitCommand).not.toHaveBeenCalled();

      const readme = await fs.readFile(path.join(config.path, 'README.md'), 'utf8');
      expect(readme).toContain(config.name);

      const messages = onProgress.mock.calls.map(([payload]) => payload.statusMessage);
      expect(messages).toContain('Initializing git repository...');
    });
  });
});

describe('__testing helpers', () => {
  const helpers = projectScaffolding.__testing;

  test('looksLikeWindowsLock returns false on non-win32 platforms', () => {
    expect(helpers.looksLikeWindowsLock({ message: 'EPERM: locked' }, 'linux')).toBe(false);
  });

  test('looksLikeWindowsLock matches win32 lock tokens across message/stderr/stdout', () => {
    expect(helpers.looksLikeWindowsLock({ message: 'EPERM: operation not permitted' }, 'win32')).toBe(true);
    expect(helpers.looksLikeWindowsLock({ stderr: 'EBUSY: resource busy', stdout: '' }, 'win32')).toBe(true);
    expect(helpers.looksLikeWindowsLock({ stdout: 'EACCES: permission denied' }, 'win32')).toBe(true);
    expect(helpers.looksLikeWindowsLock({ message: 'some other error' }, 'win32')).toBe(false);
  });

  test('buildExecErrorTail returns empty when stderr/stdout are missing', () => {
    expect(helpers.buildExecErrorTail({})).toBe('');
  });

  test('buildExecErrorTail prefixes a newline when output exists', () => {
    const tail = helpers.buildExecErrorTail({ stderr: 'line1\nline2' });
    expect(tail.startsWith('\n')).toBe(true);
    expect(tail).toContain('line2');
  });

  test('buildExecErrorTail includes stdout when present', () => {
    const tail = helpers.buildExecErrorTail({ stdout: 'hello from stdout' });
    expect(tail).toContain('hello from stdout');
  });

  test('execWithRetry returns immediately on first success', async () => {
    const execFn = vi.fn().mockResolvedValueOnce({ stdout: 'ok', stderr: '' });
    const sleepFn = vi.fn();

    await expect(
      helpers.execWithRetry(execFn, 'echo ok', { cwd: tempDir }, { platform: 'win32', delays: [1], sleepFn, maxBuffer: 123 })
    ).resolves.toEqual({ stdout: 'ok', stderr: '' });

    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn).toHaveBeenCalledWith('echo ok', expect.objectContaining({ cwd: tempDir, maxBuffer: 123 }));
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test('execWithRetry retries once for win32 lock errors and succeeds', async () => {
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: locked'), { stderr: '', stdout: '' }))
      .mockResolvedValueOnce({ stdout: 'recovered', stderr: '' });
    const sleepFn = vi.fn().mockResolvedValue();

    await expect(
      helpers.execWithRetry(execFn, 'rm -rf something', null, { platform: 'win32', delays: [1], sleepFn })
    ).resolves.toEqual({ stdout: 'recovered', stderr: '' });

    expect(execFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(1);
  });

  test('execWithRetry breaks early when a retry error is not a win32 lock error', async () => {
    const first = Object.assign(new Error('EBUSY: locked'), { stderr: '', stdout: '' });
    const second = new Error('something else');
    const execFn = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const sleepFn = vi.fn().mockResolvedValue();

    await expect(
      helpers.execWithRetry(execFn, 'rm -rf something', null, { platform: 'win32', delays: [1, 2], sleepFn })
    ).rejects.toBe(second);

    expect(execFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(1);
  });

  test('execWithRetry keeps retrying when subsequent failures are also win32 lock errors', async () => {
    const first = Object.assign(new Error('EBUSY: locked'), { stderr: '', stdout: '' });
    const second = Object.assign(new Error('EPERM: locked again'), { stderr: '', stdout: '' });
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockResolvedValueOnce({ stdout: 'finally', stderr: '' });
    const sleepFn = vi.fn().mockResolvedValue();

    await expect(
      helpers.execWithRetry(execFn, 'rm -rf something', null, { platform: 'win32', delays: [1, 2], sleepFn })
    ).resolves.toEqual({ stdout: 'finally', stderr: '' });

    expect(execFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 1);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 2);
  });

  test('execWithRetry uses the default sleep helper when sleepFn is omitted (coverage)', async () => {
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: locked'), { stderr: '', stdout: '' }))
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '' });

    await expect(
      helpers.execWithRetry(execFn, 'rm -rf something', null, { platform: 'win32', delays: [0] })
    ).resolves.toEqual({ stdout: 'ok', stderr: '' });

    expect(execFn).toHaveBeenCalledTimes(2);
  });

  test('findAvailablePort uses default base when fallback missing', async () => {
    const createServerSpy = vi.spyOn(net, 'createServer').mockImplementation(() => {
      const server = new EventEmitter();
      server.unref = vi.fn();
      server.close = vi.fn((cb) => cb?.());
      server.listen = vi.fn(() => {
        setImmediate(() => server.emit('listening'));
        return server;
      });
      return server;
    });

    try {
      const port = await helpers.findAvailablePort(null, null, new Set());
      expect(port).toBeGreaterThanOrEqual(6000);
    } finally {
      createServerSpy.mockRestore();
    }
  });

  test('createProcessInfo handles missing child processes gracefully', () => {
    const info = helpers.createProcessInfo('frontend', null, null);
    expect(info.status).toBe('stopped');
    expect(info.pid).toBeNull();
    expect(info.port).toBeNull();
    expect(info.logs).toEqual([]);
  });

  test('createProcessInfo handles error events without numeric codes', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const info = helpers.createProcessInfo('frontend', child, 4000);
    child.emit('error', { message: 'boom' });
    expect(info.exitCode).toBeNull();

    child.emit('exit', undefined, 'SIGTERM');
    expect(info.exitCode).toBeNull();
    expect(info.signal).toBe('SIGTERM');
  });

  test('createProcessInfo records stderr output with timestamps', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const info = helpers.createProcessInfo('backend', child, 3100);
    child.stderr.emit('data', Buffer.from('first line\nsecond line'));

    expect(info.logs.filter((log) => log.stream === 'stderr')).toHaveLength(2);
    expect(info.lastHeartbeat).toEqual(expect.any(String));
  });

  test('createProcessInfo logs plain string stdout chunks', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const info = helpers.createProcessInfo('backend', child, 3101);
    child.stdout.emit('data', 'hello from stdout');

    expect(info.logs.some((log) => log.stream === 'stdout' && log.message === 'hello from stdout')).toBe(true);
  });

  test('createProcessInfo falls back to default error messages and keeps exit codes', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const info = helpers.createProcessInfo('frontend', child, 4100);
    child.emit('error', {});
    child.emit('exit', 0, null);

    const lastLog = info.logs[info.logs.length - 1];
    expect(lastLog.message).toBe('Process error');
    expect(info.exitCode).toBe(0);
  });

  test('buildStubProcesses applies overrides', () => {
    const overrides = {
      frontendPort: 7001,
      frontendStatus: 'idle',
      backendPort: 9002,
      backendStatus: 'stopped'
    };

    const processes = helpers.buildStubProcesses(overrides);
    expect(processes.frontend.port).toBe(7001);
    expect(processes.frontend.status).toBe('idle');
    expect(processes.backend.port).toBe(9002);
    expect(processes.backend.status).toBe('stopped');
  });

  test('buildStubProcesses fills in sensible defaults when overrides omitted', () => {
    const processes = helpers.buildStubProcesses();
    expect(processes.frontend.port).toBe(5173);
    expect(processes.backend.port).toBe(3000);
    expect(processes.frontend.status).toBe('running');
    expect(processes.backend.status).toBe('running');
  });

  test('ensureDirectory ignores EEXIST errors', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
      Object.assign(new Error('already exists'), { code: 'EEXIST' })
    );

    try {
      await expect(helpers.ensureDirectory(path.join(tempDir, 'existing'))).resolves.toBeUndefined();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test('initializeGitRepository normalizes blank inputs', async () => {
    const projectPath = path.join(tempDir, 'git-defaults');
    await fs.mkdir(projectPath, { recursive: true });

    const result = await helpers.initializeGitRepository(projectPath, {
      defaultBranch: '   ',
      remoteUrl: '   ',
      username: 'cli-bot'
    });

    expect(result.branch).toBe('main');
    expect(result.remote).toBeNull();
    expect(gitUtils.runGitCommand).not.toHaveBeenCalled();
    expect(gitUtils.configureGitUser).toHaveBeenCalledWith(projectPath, {
      name: 'cli-bot',
      email: 'cli-bot@users.noreply.github.com'
    });
  });

  test('initializeGitRepository ignores already existing remotes', async () => {
    const projectPath = path.join(tempDir, 'git-existing');
    await fs.mkdir(projectPath, { recursive: true });

    const error = new Error('remote origin already exists');
    gitUtils.runGitCommand.mockRejectedValueOnce(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorSpy.mockClear();

    try {
      const result = await helpers.initializeGitRepository(projectPath, {
        remoteUrl: 'git@example.com/repo.git'
      });

      expect(result.remote).toBe('git@example.com/repo.git');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('initializeGitRepository skips remote configuration when no URL provided', async () => {
    const projectPath = path.join(tempDir, 'git-no-remote');
    await fs.mkdir(projectPath, { recursive: true });

    const result = await helpers.initializeGitRepository(projectPath, {
      username: 'cli-bot'
    });

    expect(gitUtils.runGitCommand).not.toHaveBeenCalled();
    expect(result.remote).toBeNull();
  });

  test('generateFrontendFiles skips optional template artifacts when missing', async () => {
    const frontendPath = path.join(tempDir, 'vue-optional');
    const vueTemplate = helpers.templates.frontend.vue.javascript;
    const backup = {
      viteConfig: vueTemplate.viteConfig,
      vitestConfig: vueTemplate.vitestConfig,
      indexHtml: vueTemplate.indexHtml
    };

    delete vueTemplate.viteConfig;
    delete vueTemplate.vitestConfig;
    delete vueTemplate.indexHtml;

    try {
      await helpers.generateFrontendFiles(frontendPath, {
        name: 'Vue Optional',
        framework: 'vue',
        language: 'javascript'
      });

      await expect(fs.access(path.join(frontendPath, 'vite.config.js'))).rejects.toThrow();
      await expect(fs.access(path.join(frontendPath, 'vitest.config.js'))).rejects.toThrow();
      await expect(fs.access(path.join(frontendPath, 'index.html'))).rejects.toThrow();

      const appVue = await fs.readFile(path.join(frontendPath, 'src', 'App.vue'), 'utf8');
      expect(appVue).toContain('Vue Optional');
    } finally {
      Object.assign(vueTemplate, backup);
    }
  });

  test('generateBackendFiles writes flask scaffold files directly', async () => {
    const backendPath = path.join(tempDir, 'flask-direct');

    await helpers.generateBackendFiles(backendPath, {
      name: 'Direct Flask',
      language: 'python',
      framework: 'flask'
    });

    const requirements = await fs.readFile(path.join(backendPath, 'requirements.txt'), 'utf8');
    expect(requirements).toContain('Flask');

    const envExample = await fs.readFile(path.join(backendPath, '.env.example'), 'utf8');
    expect(envExample).toContain('PORT');
  });

  test('writeFile rejects undefined content', async () => {
    const filePath = path.join(tempDir, 'internal', 'invalid.txt');
    await expect(helpers.writeFile(filePath)).rejects.toThrow('Content is undefined for file');
  });

  test('writeFile stringifies non-string content', async () => {
    const filePath = path.join(tempDir, 'internal', 'numeric.txt');
    await helpers.writeFile(filePath, 12345);
    const contents = await fs.readFile(filePath, 'utf8');
    expect(contents).toBe('12345');
  });

  test('pathExists reports accurate status', async () => {
    const missingPath = path.join(tempDir, 'internal', 'missing.txt');
    expect(await helpers.pathExists(missingPath)).toBe(false);
    await fs.mkdir(path.dirname(missingPath), { recursive: true });
    await fs.writeFile(missingPath, 'ok');
    expect(await helpers.pathExists(missingPath)).toBe(true);
  });

  test('initializeGitRepository validates project path', async () => {
    await expect(helpers.initializeGitRepository('', {})).rejects.toThrow('Project path is required');
  });

  test('initializeGitRepository surfaces remote failures', async () => {
    const projectPath = path.join(tempDir, 'repo');
    await fs.mkdir(projectPath, { recursive: true });
    const remoteError = new Error();
    remoteError.message = '';
    gitUtils.runGitCommand.mockRejectedValueOnce(remoteError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      helpers.initializeGitRepository(projectPath, {
        remoteUrl: 'git@example.com/repo.git',
        username: 'ci-bot'
      })
    ).rejects.toThrow('Failed to configure git remote');

    expect(errorSpy).toHaveBeenCalledWith('❌ Failed to configure git remote:', '');
    errorSpy.mockRestore();
  });

  test('ensureDirectory rethrows unexpected errors', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
      Object.assign(new Error('disk offline'), { code: 'EACCES' })
    );

    try {
      await expect(helpers.ensureDirectory(path.join(tempDir, 'broken'))).rejects.toThrow('disk offline');
      expect(mkdirSpy).toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  test('createProcessInfo filters noisy logs and tracks errors', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const info = helpers.createProcessInfo('backend', child, 3000);

    child.stdout.emit('data', null);
    child.stdout.emit('data', Buffer.from('\n\n'));

    const verboseChunk = Buffer.from(
      Array.from({ length: helpers.MAX_LOG_LINES + 5 }, (_, idx) => `log-${idx}`).join('\n')
    );
    child.stdout.emit('data', verboseChunk);

    expect(info.logs.length).toBe(helpers.MAX_LOG_LINES);

    child.emit('error', { message: 'boom', code: 77 });

    expect(info.status).toBe('error');
    expect(info.exitCode).toBe(77);
    expect(info.endedAt).toEqual(expect.any(String));
  });

  test('findAvailablePort throws when every candidate is busy', async () => {
    const createServerSpy = vi.spyOn(net, 'createServer').mockImplementation(() => {
      const server = new EventEmitter();
      server.unref = vi.fn();
      server.close = vi.fn((cb) => cb?.());
      server.listen = vi.fn(() => {
        setImmediate(() => server.emit('error', new Error('busy')));
        return server;
      });
      return server;
    });

    try {
      await expect(helpers.findAvailablePort(6000, 6000, new Set())).rejects.toThrow(
        'Unable to find an available port'
      );
    } finally {
      createServerSpy.mockRestore();
    }
  });

  test('normalizePortBase falls back when value outside safe range', () => {
    expect(helpers.normalizePortBase(80, 6100)).toBe(6100);
    expect(helpers.normalizePortBase(70000, 6200)).toBe(6200);
  });

  test('reserved port lists populate defaults when env yields no valid entries', async () => {
    const envBackup = {
      LUCIDCODER_HOST_PORTS: process.env.LUCIDCODER_HOST_PORTS,
      VITE_PORT: process.env.VITE_PORT,
      LUCIDCODER_BACKEND_HOST_PORTS: process.env.LUCIDCODER_BACKEND_HOST_PORTS
    };

    const restoreEnv = (key, value) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };

    vi.resetModules();
    process.env.LUCIDCODER_HOST_PORTS = 'alpha';
    process.env.VITE_PORT = 'beta';
    process.env.LUCIDCODER_BACKEND_HOST_PORTS = 'gamma';

    try {
      const reloaded = await import('../services/projectScaffolding.js');
      const snapshot = reloaded.__testing.snapshotReservedPorts();
      expect(snapshot.frontend).toContain(5173);
      expect(snapshot.backend).toContain(5000);
    } finally {
      restoreEnv('LUCIDCODER_HOST_PORTS', envBackup.LUCIDCODER_HOST_PORTS);
      restoreEnv('VITE_PORT', envBackup.VITE_PORT);
      restoreEnv('LUCIDCODER_BACKEND_HOST_PORTS', envBackup.LUCIDCODER_BACKEND_HOST_PORTS);
      vi.resetModules();
    }
  });
});
