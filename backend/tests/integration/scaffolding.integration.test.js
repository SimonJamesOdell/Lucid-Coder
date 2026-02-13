import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { scaffoldProject, __testing } from '../../services/projectScaffolding.js';
import fs from 'fs/promises';
import path from 'path';

describe('Project Scaffolding Integration Tests', () => {
  const testProjectsDir = process.env.PROJECTS_DIR
    ? path.join(process.env.PROJECTS_DIR, 'scaffolding-projects')
    : path.join(process.cwd(), 'test-projects');
  const createdProjects = [];

  const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

  const assertFrontendHarness = async (frontendPath, config) => {
    const pkg = await readJson(path.join(frontendPath, 'package.json'));

    expect(pkg.scripts).toHaveProperty('test');
    expect(pkg.scripts).toHaveProperty('test:coverage');
    expect(pkg.scripts).toHaveProperty('test:e2e');
    expect(pkg.devDependencies).toHaveProperty('@playwright/test');

    // React templates include Vitest + Testing Library harnesses.
    if (config.framework === 'react') {
      expect(pkg.devDependencies).toHaveProperty('vitest');
      expect(pkg.devDependencies).toHaveProperty('@testing-library/jest-dom');
      expect(pkg.devDependencies).toHaveProperty('@testing-library/react');
    }

    if (config.framework === 'react') {
      const configExt = config.language === 'typescript' ? 'ts' : 'js';
      const testExt = config.language === 'typescript' ? 'tsx' : 'jsx';
      const setupExt = config.language === 'typescript' ? 'ts' : 'js';

      await fs.access(path.join(frontendPath, `vite.config.${configExt}`));
      await fs.access(path.join(frontendPath, `vitest.config.${configExt}`));
      await fs.access(path.join(frontendPath, `playwright.config.${configExt}`));
      await fs.access(path.join(frontendPath, 'src', '__tests__', `App.test.${testExt}`));
      await fs.access(path.join(frontendPath, 'src', 'test', `setup.${setupExt}`));

      const vitestConfig = await fs.readFile(path.join(frontendPath, `vitest.config.${configExt}`), 'utf8');
      expect(vitestConfig).toContain("include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}']");
      expect(vitestConfig).toContain("'**/*.config.{js,ts,cjs,mjs}'");
      expect(vitestConfig).toContain("'playwright.config.{js,ts,cjs,mjs}'");
    }

    if (config.framework === 'vue') {
      await fs.access(path.join(frontendPath, 'vite.config.js'));
      await fs.access(path.join(frontendPath, 'vitest.config.js'));
      await fs.access(path.join(frontendPath, 'playwright.config.js'));
      await fs.access(path.join(frontendPath, 'src', '__tests__', 'App.test.js'));
      await fs.access(path.join(frontendPath, 'src', 'test', 'setup.js'));

      const vitestConfig = await fs.readFile(path.join(frontendPath, 'vitest.config.js'), 'utf8');
      expect(vitestConfig).toContain("include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}']");
      expect(vitestConfig).toContain("'**/*.config.{js,ts,cjs,mjs}'");
      expect(vitestConfig).toContain("'playwright.config.{js,ts,cjs,mjs}'");
    }

    await fs.access(path.join(frontendPath, 'e2e', 'app.spec.js'));
  };

  const assertBackendHarness = async (backendPath, config) => {
    if (config.framework === 'express') {
      const pkg = await readJson(path.join(backendPath, 'package.json'));
      expect(pkg.scripts).toHaveProperty('test');
      expect(pkg.scripts).toHaveProperty('test:coverage');
      expect(pkg.scripts).toHaveProperty('test:e2e');
      expect(pkg.devDependencies).toHaveProperty('jest');
      expect(pkg.devDependencies).toHaveProperty('supertest');

      if (config.language === 'javascript') {
        await fs.access(path.join(backendPath, 'jest.config.js'));
        await fs.access(path.join(backendPath, '__tests__', 'e2e.http.test.js'));
      }

      if (config.language === 'typescript') {
        await fs.access(path.join(backendPath, 'jest.config.ts'));
        await fs.access(path.join(backendPath, 'src', '__tests__', 'e2e.http.test.ts'));
      }
    }

    if (config.framework === 'flask') {
      await fs.access(path.join(backendPath, 'requirements.txt'));
      const requirements = await fs.readFile(path.join(backendPath, 'requirements.txt'), 'utf8');
      expect(requirements).toContain('pytest');
      expect(requirements).toContain('pytest-cov');

      await fs.access(path.join(backendPath, 'pytest.ini'));
      await fs.access(path.join(backendPath, 'tests', 'test_app.py'));
    }
  };

  beforeAll(async () => {
    // Ensure test projects directory exists
    try {
      await fs.access(testProjectsDir);
    } catch {
      await fs.mkdir(testProjectsDir, { recursive: true });
    }
  });

  afterAll(async () => {
    // Clean up all created test projects
    for (const projectPath of createdProjects) {
      try {
        await fs.rm(projectPath, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Failed to cleanup ${projectPath}:`, error.message);
      }
    }
  });

  const createTestProject = async (config) => {
    const projectPath = path.join(testProjectsDir, config.name);
    const fullConfig = { ...config, path: projectPath };
    
    await scaffoldProject(fullConfig);
    createdProjects.push(projectPath);
    
    return projectPath;
  };

  test('should scaffold test/coverage/e2e harnesses for each supported frontend template', async () => {
    const backendBaseline = { framework: 'express', language: 'javascript' };

    for (const [framework, languages] of Object.entries(__testing.templates.frontend)) {
      for (const language of Object.keys(languages)) {
        const frontend = { framework, language };
        const name = `harness-frontend-${frontend.framework}-${frontend.language}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const projectPath = await createTestProject({
          name,
          frontend,
          backend: backendBaseline
        });

        await assertFrontendHarness(path.join(projectPath, 'frontend'), frontend);
        await assertBackendHarness(path.join(projectPath, 'backend'), backendBaseline);
      }
    }
  });

  test('should scaffold test/coverage/e2e harnesses for each supported backend template', async () => {
    const frontendBaseline = { framework: 'react', language: 'javascript' };

    for (const [framework, languages] of Object.entries(__testing.templates.backend)) {
      for (const language of Object.keys(languages)) {
        const backend = { framework, language };
        const name = `harness-backend-${backend.framework}-${backend.language}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const projectPath = await createTestProject({
          name,
          frontend: frontendBaseline,
          backend
        });

        await assertFrontendHarness(path.join(projectPath, 'frontend'), frontendBaseline);
        await assertBackendHarness(path.join(projectPath, 'backend'), backend);
      }
    }
  });

  test('should create React TypeScript project with comprehensive testing setup', async () => {
    const projectPath = await createTestProject({
      name: `react-ts-test-${Date.now()}`,
      frontend: { framework: 'react', language: 'typescript' },
      backend: { framework: 'express', language: 'typescript' }
    });

    const frontendPath = path.join(projectPath, 'frontend');
    const backendPath = path.join(projectPath, 'backend');

    await assertFrontendHarness(frontendPath, { framework: 'react', language: 'typescript' });
    await assertBackendHarness(backendPath, { framework: 'express', language: 'typescript' });

    const viteConfig = await fs.readFile(path.join(frontendPath, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain('jsdom');
  });

  test('should scaffold frontend and backend test suites', async () => {
    const projectPath = await createTestProject({
      name: `tdd-test-${Date.now()}`,
      frontend: { framework: 'react', language: 'javascript' },
      backend: { framework: 'express', language: 'javascript' }
    });

    const frontendPath = path.join(projectPath, 'frontend');
    const backendPath = path.join(projectPath, 'backend');

    // Check for failing test markers in frontend
    const frontendTest = await fs.readFile(
      path.join(frontendPath, 'src', '__tests__', 'App.test.jsx'), 'utf8'
    );
    expect(frontendTest).toContain('renders the project heading');
    expect(frontendTest).toContain('falls back to an error state when the request fails');

    // Check for failing test markers in backend
    const backendAppTest = await fs.readFile(
      path.join(backendPath, '__tests__', 'app.test.js'), 'utf8'
    );
    const backendApiTest = await fs.readFile(
      path.join(backendPath, '__tests__', 'api.test.js'), 'utf8'
    );
    expect(backendAppTest).toContain('handles JSON payloads through /api/echo');
    expect(backendAppTest).toContain('exposes CORS headers');
    expect(backendApiTest).toContain('responds to GET /api/health');
    expect(backendApiTest).toContain('echoes payloads via POST /api/echo');
  });

  test('should create proper test configuration files', async () => {
    const projectPath = await createTestProject({
      name: `config-test-${Date.now()}`,
      frontend: { framework: 'react', language: 'typescript' },
      backend: { framework: 'express', language: 'typescript' }
    });

    const frontendPath = path.join(projectPath, 'frontend');
    const backendPath = path.join(projectPath, 'backend');

    // Verify Jest configuration for backend
    const jestConfig = await fs.readFile(path.join(backendPath, 'jest.config.ts'), 'utf8');
    expect(jestConfig).toContain('testEnvironment');
    expect(jestConfig).toContain('coverage');
    expect(jestConfig).toContain('ts-jest');

    // Verify test setup files exist and have proper content
    const frontendSetup = await fs.readFile(path.join(frontendPath, 'src', 'test', 'setup.ts'), 'utf8');
    expect(frontendSetup).toContain('testing-library');

    const backendSetup = await fs.readFile(path.join(backendPath, 'src', 'test', 'setup.ts'), 'utf8');
    expect(backendSetup).toContain('jest');
  });
});