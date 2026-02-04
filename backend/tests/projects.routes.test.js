import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getProjectsDir } from '../utils/projectPaths.js';
import projectRoutes from '../routes/projects.js';
import db from '../database.js';
import {
  initializeDatabase,
  closeDatabase,
  createProject,
  getProject,
  saveGitSettings,
  saveProjectGitSettings,
  getProjectGitSettings
} from '../database.js';

// Mock the project scaffolding service

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn(),
  scaffoldProject: vi.fn(),
  installDependencies: vi.fn(),
  startProject: vi.fn()
}));

vi.mock('../services/remoteRepoService.js', () => {
  class RemoteRepoCreationError extends Error {
    constructor(message, { statusCode = 400, provider = 'github', details = null } = {}) {
      super(message);
      this.name = 'RemoteRepoCreationError';
      this.statusCode = statusCode;
      this.provider = provider;
      this.details = details;
    }
  }

  return {
    createRemoteRepository: vi.fn(),
    RemoteRepoCreationError
  };
});

const gitUtils = vi.hoisted(() => ({
  ensureGitRepository: vi.fn(),
  configureGitUser: vi.fn(),
  ensureInitialCommit: vi.fn(),
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

vi.mock('../services/projectScaffolding/git.js', () => ({
  initializeAndPushRepository: vi.fn()
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    execSync: vi.fn()
  };
});

const app = express();
app.use(express.json());
app.use('/api/projects', projectRoutes);

describe('Projects API with Scaffolding', () => {
  let scaffoldingService;
  const envProjectsDir = process.env.PROJECTS_DIR;
  const testProjectsDir = envProjectsDir
    ? (path.isAbsolute(envProjectsDir) ? envProjectsDir : path.join(process.cwd(), envProjectsDir))
    : path.join(process.cwd(), 'test-projects-api');
  
  const cleanDatabase = async () => {
    const tables = [
      'project_git_settings',
      'git_settings',
      'port_settings',
      'branches',
      'test_runs',
      'agent_tasks',
      'agent_goals',
      'projects',
      'llm_config'
    ];

    const sql = ['BEGIN;']
      .concat(tables.map((table) => `DELETE FROM ${table};`))
      .concat(['COMMIT;'])
      .join('\n');

    return new Promise((resolve, reject) => {
      db.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const createPersistedProject = async (overrides = {}) => {
    const uniqueName = overrides.name || `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const projectPath = overrides.path || path.join(testProjectsDir, uniqueName);
    await fs.mkdir(projectPath, { recursive: true });

    const projectRecord = await createProject({
      name: uniqueName,
      description: overrides.description || 'Test project',
      language: overrides.language || 'javascript',
      framework: overrides.framework || 'react',
      path: projectPath,
      frontendPort: overrides.frontendPort,
      backendPort: overrides.backendPort
    });

    return { project: projectRecord, projectPath };
  };

  const createProjectWithRealFile = async (nameSuffix = 'default') => {
    const projectName = `file-edit-${nameSuffix}-${Date.now()}`;
    const projectPath = path.join(testProjectsDir, projectName);
    const relativeFilePath = 'src/App.jsx';
    const absoluteFilePath = path.join(projectPath, relativeFilePath);

    await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
    await fs.writeFile(absoluteFilePath, 'export default function App() { return <div>Old</div>; }\n');

    const projectRecord = await createProject({
      name: projectName,
      description: 'File editing test project',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });

    return {
      projectId: projectRecord.id,
      projectPath,
      relativeFilePath,
      absoluteFilePath
    };
  };
  
  beforeAll(async () => {
    process.env.PROJECTS_DIR = testProjectsDir;
    await initializeDatabase();
    await fs.mkdir(testProjectsDir, { recursive: true });
    scaffoldingService = await import('../services/projectScaffolding.js');
  });

  beforeEach(async () => {
    await cleanDatabase();

    Object.values(gitUtils).forEach((mockFn) => mockFn.mockReset?.());
    gitUtils.ensureGitRepository.mockResolvedValue(undefined);
    gitUtils.fetchRemote.mockResolvedValue(undefined);
    gitUtils.getAheadBehind.mockResolvedValue({ ahead: 0, behind: 0 });
    gitUtils.getCurrentBranch.mockResolvedValue('main');
    gitUtils.getRemoteUrl.mockResolvedValue('https://github.com/octo/repo.git');
    gitUtils.hasWorkingTreeChanges.mockResolvedValue(false);
    gitUtils.runGitCommand.mockResolvedValue({ code: 0, stdout: '' });

    // Setup mocks
    const { createProjectWithFiles, scaffoldProject, installDependencies, startProject } = scaffoldingService;
    
    vi.mocked(createProjectWithFiles).mockResolvedValue({
      success: true,
      project: {
        id: 1,
        name: 'test-project',
        path: '/test/path',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      processes: {
        frontend: { pid: 1234, port: 5173 },
        backend: { pid: 1235, port: 3000 }
      }
    });
    
    vi.mocked(scaffoldProject).mockResolvedValue({ success: true });
    vi.mocked(installDependencies).mockResolvedValue(undefined);
    vi.mocked(startProject).mockResolvedValue({
      success: true,
      processes: {
        frontend: { pid: 1234, port: 5173 },
        backend: { pid: 1235, port: 3000 }
      }
    });

    const { initializeAndPushRepository } = await import('../services/projectScaffolding/git.js');
    vi.mocked(initializeAndPushRepository).mockResolvedValue({
      initialized: true,
      pushed: true,
      branch: 'main',
      remote: 'https://github.com/octo/repo.git'
    });
    
  });

  afterAll(async () => {
    // Clean up the database from any test data
    try {
      await cleanDatabase();
      console.log('Database cleaned up after projects routes tests');
    } catch (error) {
      console.warn('Warning: Could not clean database:', error.message);
    }
    
    // Close database connections properly
    try {
      const { closeDatabase } = await import('../database.js');
      await closeDatabase();
    } catch (error) {
      // Database might already be closed
    }

    if (envProjectsDir === undefined) {
      delete process.env.PROJECTS_DIR;
    } else {
      process.env.PROJECTS_DIR = envProjectsDir;
    }
  }, 15000);

  afterEach(() => {
    // Reset mocks between tests. (Directory cleanup is handled per-worker in the parallel test setup.)
    vi.clearAllMocks();
  });

  describe('POST /api/projects - Enhanced Project Creation', () => {
    test('creates project with full-stack scaffolding', async () => {
      const projectName = 'test-fullstack-project';
      const projectPath = path.join(testProjectsDir, projectName);
      const scaffoldingService = await import('../services/projectScaffolding.js');

      vi.mocked(scaffoldingService.createProjectWithFiles).mockResolvedValue({
        success: true,
        project: {
          id: 1,
          name: projectName,
          description: 'Test full-stack project',
          frontend: { language: 'typescript', framework: 'react' },
          backend: { language: 'typescript', framework: 'express' },
          path: projectPath,
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 1234, port: 5173 },
          backend: { pid: 1235, port: 3000 }
        }
      });

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Test full-stack project',
          frontend: { language: 'typescript', framework: 'react' },
          backend: { language: 'typescript', framework: 'express' }
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.project.name).toBe(projectName);
      expect(response.body.project.frontend.language).toBe('typescript');
      expect(response.body.project.backend.framework).toBe('express');
      expect(response.body.processes?.frontend?.port).toBe(5173);
      expect(response.body.processes?.backend?.port).toBe(3000);

      expect(vi.mocked(scaffoldingService.createProjectWithFiles)).toHaveBeenCalledWith(
        {
          name: projectName,
          description: 'Test full-stack project',
          frontend: { language: 'typescript', framework: 'react' },
          backend: { language: 'typescript', framework: 'express' },
          path: projectPath
        },
        expect.any(Object)
      );
    });

    test('handles React + Express project creation', async () => {
      const projectName = 'react-express-project';
      
      const { createProjectWithFiles } = await import('../services/projectScaffolding.js');
      vi.mocked(createProjectWithFiles).mockResolvedValue({
        success: true,
        project: {
          id: 2,
          name: projectName,
          description: 'React with Express backend',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 2234, port: 5173 },
          backend: { pid: 2235, port: 3000 }
        }
      });

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'React with Express backend',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.project.frontend.framework).toBe('react');
      expect(response.body.project.backend.framework).toBe('express');
    });

    test('handles Vue + Python Flask project creation', async () => {
      const projectName = 'vue-flask-project';
      
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockResolvedValue({
        success: true,
        project: {
          id: 3,
          name: projectName,
          description: 'Vue with Flask backend',
          frontend: { language: 'javascript', framework: 'vue' },
          backend: { language: 'python', framework: 'flask' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 3234, port: 5173 },
          backend: { pid: 3235, port: 5000 }
        }
      });

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Vue with Flask backend',
          frontend: { language: 'javascript', framework: 'vue' },
          backend: { language: 'python', framework: 'flask' }
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.project.frontend.framework).toBe('vue');
      expect(response.body.project.backend.framework).toBe('flask');
    });

    test('validates required fields for enhanced project creation', async () => {
      // Test missing name
      let response = await request(app)
        .post('/api/projects')
        .send({
          description: 'Project without name',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('name is required');

      // Test missing frontend configuration
      response = await request(app)
        .post('/api/projects')
        .send({
          name: 'test-project',
          description: 'Project without frontend config',
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Frontend configuration is required');

      // Test missing backend configuration
      response = await request(app)
        .post('/api/projects')
        .send({
          name: 'test-project',
          description: 'Project without backend config',
          frontend: { language: 'javascript', framework: 'react' }
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Backend configuration is required');
    });

    test('handles scaffolding service errors', async () => {
      const projectName = 'failing-project';
      
      // Mock scaffolding service failure
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockRejectedValue(new Error('Failed to create project files'));

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'This project should fail',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Failed to create project');
    });

    test('notifies progress completion when a progress key is provided', async () => {
      const projectName = `progress-complete-${Date.now()}`;
      const progressKey = `progress-${Date.now()}`;
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.createProjectWithFiles).mockResolvedValueOnce({
        success: true,
        project: {
          id: 11,
          name: projectName,
          description: 'Progress test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 3211, port: 5174 },
          backend: null
        },
        progress: { steps: [], completion: 100 }
      });

      await cleanDatabase();
      const progressTracker = await import('../services/progressTracker.js');
      const completeSpy = vi.spyOn(progressTracker, 'completeProgress').mockResolvedValue();
      const initSpy = vi.spyOn(progressTracker, 'initProgress').mockImplementation(() => {});
      const updateSpy = vi.spyOn(progressTracker, 'updateProgress').mockImplementation(() => {});

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Progress test project',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          progressKey
        });

      expect(response.status).toBe(201);
      expect(completeSpy).toHaveBeenCalledWith(progressKey, expect.stringMatching(/created successfully/i));

      completeSpy.mockRestore();
      initSpy.mockRestore();
      updateSpy.mockRestore();
    });

    test('pipes scaffolding progress updates through the tracker when a progress key is provided', async () => {
      await cleanDatabase();
      const progressKey = `progress-pipe-${Date.now()}`;
      const projectName = `progress-pipe-${Date.now()}`;

      const progressTracker = await import('../services/progressTracker.js');
      const scaffoldingService = await import('../services/projectScaffolding.js');

      const initSpy = vi.spyOn(progressTracker, 'initProgress').mockImplementation(() => {});
      const updateSpy = vi.spyOn(progressTracker, 'updateProgress').mockImplementation(() => {});
      const completeSpy = vi.spyOn(progressTracker, 'completeProgress').mockImplementation(() => {});

      vi.mocked(scaffoldingService.createProjectWithFiles).mockImplementationOnce(async (config, options) => {
        options?.onProgress?.({ step: 'files', completion: 25 });
        return {
          success: true,
          project: {
            id: 901,
            name: config.name,
            description: config.description,
            frontend: config.frontend,
            backend: config.backend,
            path: config.path,
            createdAt: new Date().toISOString()
          },
          processes: null,
          progress: { completion: 25 }
        };
      });

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Progress piping test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          progressKey
        });

      expect(response.status).toBe(201);
      expect(updateSpy).toHaveBeenCalledWith(progressKey, expect.objectContaining({ step: 'files' }));

      completeSpy.mockRestore();
      updateSpy.mockRestore();
      initSpy.mockRestore();
    });

    test('fails progress when scaffolding throws after initialization', async () => {
      await cleanDatabase();
      const progressKey = `progress-fail-${Date.now()}`;
      const projectName = `progress-fail-${Date.now()}`;

      const progressTracker = await import('../services/progressTracker.js');
      const scaffoldingService = await import('../services/projectScaffolding.js');

      const initSpy = vi.spyOn(progressTracker, 'initProgress').mockImplementation(() => {});
      const failSpy = vi.spyOn(progressTracker, 'failProgress').mockImplementation(() => {});

      vi.mocked(scaffoldingService.createProjectWithFiles).mockRejectedValueOnce(new Error('scaffolding exploded'));

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Progress failure test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          progressKey
        });

      expect(response.status).toBe(500);
      expect(failSpy).toHaveBeenCalledWith(progressKey, 'scaffolding exploded');

      failSpy.mockRestore();
      initSpy.mockRestore();
    });

    test('fails progress with a default message when scaffolding error lacks details', async () => {
      await cleanDatabase();
      const progressKey = `progress-fallback-${Date.now()}`;
      const projectName = `progress-fallback-${Date.now()}`;

      const progressTracker = await import('../services/progressTracker.js');
      const scaffoldingService = await import('../services/projectScaffolding.js');

      const failSpy = vi.spyOn(progressTracker, 'failProgress').mockImplementation(() => {});
      const initSpy = vi.spyOn(progressTracker, 'initProgress').mockImplementation(() => {});

      const silentError = new Error();
      silentError.message = '';
      vi.mocked(scaffoldingService.createProjectWithFiles).mockRejectedValueOnce(silentError);

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Missing message test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          progressKey
        });

      expect(response.status).toBe(500);
      expect(failSpy).toHaveBeenCalledWith(progressKey, 'Failed to create project');

      failSpy.mockRestore();
      initSpy.mockRestore();
    });

    test('defaults missing descriptions to empty strings when creating projects', async () => {
      await cleanDatabase();
      const projectName = `desc-optional-${Date.now()}`;

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(201);
      expect(response.body.project.description).toBe('');

      const stored = await getProject(response.body.project.id);
      expect(stored.description).toBe('');
    });

    test('rejects progress stream requests without a key', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const routerInstance = projectRoutesModule.default;
      const targetLayer = routerInstance.stack.find(
        (layer) => layer.route?.path === '/progress/:progressKey/stream' && layer.route?.methods?.get
      );
      const handler = targetLayer.route.stack[0].handle;

      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        }
      };

      await handler({ params: {} }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error).toMatch(/progress key is required/i);
    });

    test('handles duplicate project names', async () => {
      const projectName = 'duplicate-project';
      
      // First project creation succeeds
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockResolvedValueOnce({
        success: true,
        project: {
          id: 1,
          name: projectName,
          description: 'First project',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: { frontend: { pid: 1234, port: 5173 }, backend: { pid: 1235, port: 3000 } }
      });

      // First request
      const response1 = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'First project',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response1.status).toBe(201);

      // Second project creation with same name should fail
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockRejectedValueOnce(new Error('UNIQUE constraint failed'));

      const response2 = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Duplicate project',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response2.status).toBe(400);
      expect(response2.body.success).toBe(false);
      expect(response2.body.error).toContain('already exists');
    });

    test('surfaces duplicate project errors from the database layer', async () => {
      const projectName = `duplicate-db-${Date.now()}`;
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.createProjectWithFiles).mockRejectedValueOnce(new Error('UNIQUE constraint failed: projects.name'));

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Duplicate name',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/already exists/i);
    });

    test('fails progress tracking when project creation errors occur', async () => {
      const projectName = `progress-fail-${randomUUID()}`;
      await cleanDatabase();

      const progressTracker = await import('../services/progressTracker.js');
      const databaseModule = await import('../database.js');

      const failSpy = vi.spyOn(progressTracker, 'failProgress').mockImplementation(() => {});
      const initSpy = vi.spyOn(progressTracker, 'initProgress').mockImplementation(() => {});
      const updateSpy = vi.spyOn(progressTracker, 'updateProgress').mockImplementation(() => {});
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName').mockResolvedValue(null);
      const getGitSettingsSpy = vi
        .spyOn(databaseModule, 'getGitSettings')
        .mockRejectedValueOnce(new Error('database offline'));

      try {
        const response = await request(app)
          .post('/api/projects')
          .send({
            name: projectName,
            description: 'Progress failure',
            frontend: { language: 'javascript', framework: 'react' },
            backend: { language: 'javascript', framework: 'express' },
            progressKey: 'progress-fail'
          });

        expect(getGitSettingsSpy).toHaveBeenCalled();
        expect(failSpy).toHaveBeenCalledWith('progress-fail', expect.stringContaining('database offline'));
        expect(response.status).toBe(500);
      } finally {
        failSpy.mockRestore();
        initSpy.mockRestore();
        updateSpy.mockRestore();
        getGitSettingsSpy.mockRestore();
        getProjectByNameSpy.mockRestore();
      }
    });

    test('exposes troubleshooting details when project creation fails in tests', async () => {
      const projectName = `progress-debug-${randomUUID()}`;
      await cleanDatabase();

      const progressTracker = await import('../services/progressTracker.js');
      const failSpy = vi.spyOn(progressTracker, 'failProgress').mockImplementation(() => {});
      const databaseModule = await import('../database.js');
      const lookupError = new Error('db lookup failed');
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName').mockRejectedValueOnce(lookupError);

      try {
        const response = await request(app)
          .post('/api/projects')
          .send({
            name: projectName,
            description: 'should error',
            frontend: { language: 'javascript', framework: 'react' },
            backend: { language: 'javascript', framework: 'express' },
            progressKey: 'progress-debug'
          });

        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('Failed to create project');
        expect(response.body.details).toContain('db lookup failed');
        expect(response.body.stack).toMatch(/db lookup failed/);
        expect(failSpy).toHaveBeenCalledWith('progress-debug', expect.stringContaining('db lookup failed'));
      } finally {
        failSpy.mockRestore();
        getProjectByNameSpy.mockRestore();
      }
    });

    test.skip('provides progress updates during project creation', async () => {
      const projectName = `progress-project-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Clean database before this test to avoid duplicate name conflicts
      await cleanDatabase();
      
      // Mock project creation with progress updates
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockResolvedValue({
        success: true,
        project: {
          id: 4,
          name: projectName,
          description: 'Project with progress tracking',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 4234, port: 5173 },
          backend: { pid: 4235, port: 3000 }
        },
        progress: {
          steps: [
            { name: 'Creating directories', completed: true },
            { name: 'Generating files', completed: true },
            { name: 'Initializing git repository', completed: true },
            { name: 'Installing dependencies', completed: true },
            { name: 'Starting development servers', completed: true }
          ],
          completion: 100
        }
      });

      const response = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Project with progress tracking',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      if (response.status !== 201) {
        console.log('Progress test failed with status:', response.status);
        console.log('Error response:', response.body);
      }
      
      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.progress).toBeDefined();
      expect(response.body.progress.completion).toBe(100);
      expect(response.body.progress.steps).toHaveLength(5);
    });
  });

  describe('DELETE /api/projects/:id - release delay coverage', () => {
    test('uses a longer release delay outside test env (coverage)', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const routerInstance = projectRoutesModule.default;
      const {
        resetRunningProcessesStore,
        setCleanupDirectoryExecutor,
        resetCleanupDirectoryExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      resetRunningProcessesStore();
      setCleanupDirectoryExecutor(async () => {});

      const deleteLayer = routerInstance.stack.find(
        (layer) => layer.route?.path === '/:id' && layer.route?.methods?.delete
      );
      const deleteHandler = deleteLayer?.route?.stack?.[0]?.handle;
      expect(deleteHandler).toBeTypeOf('function');

      try {
        const { project } = await createPersistedProject({ name: `delete-delay-${Date.now()}` });

        const req = {
          params: { id: String(project.id) },
          headers: { 'x-confirm-destructive': 'true' }
        };
        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn()
        };

        await deleteHandler(req, res);

        expect(res.status).not.toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: true, message: 'Project deleted successfully' })
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        resetCleanupDirectoryExecutor();
        resetRunningProcessesStore();
      }
    });
  });

  describe('Project creation progress endpoints', () => {
    test('streams progress updates over SSE connections', async () => {
      const progressKey = `progress-stream-${Date.now()}`;
      const progressTracker = await import('../services/progressTracker.js');
      const attachSpy = vi.spyOn(progressTracker, 'attachProgressStream').mockImplementation((key, res) => {
        expect(key).toBe(progressKey);
        res.write('data: {"step":"init"}\n\n');
        res.end();
      });

      const response = await request(app)
        .get(`/api/projects/progress/${progressKey}/stream`)
        .set('Accept', 'text/event-stream');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('retry: 1000');
      expect(attachSpy).toHaveBeenCalledWith(progressKey, expect.any(Object));

      attachSpy.mockRestore();
    });

    test('flushes SSE headers when the response supports it', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const routerInstance = projectRoutesModule.default;
      const targetLayer = routerInstance.stack.find(
        (layer) => layer.route?.path === '/progress/:progressKey/stream' && layer.route?.methods?.get
      );
      const handler = targetLayer.route.stack[0].handle;

      const progressTracker = await import('../services/progressTracker.js');
      const attachSpy = vi.spyOn(progressTracker, 'attachProgressStream').mockImplementation(() => {});
      const flushSpy = vi.fn();
      const res = {
        setHeader: vi.fn(),
        flushHeaders: flushSpy,
        write: vi.fn(),
        end: vi.fn()
      };

      await handler({ params: { progressKey: 'flush-stream-key' } }, res);

      expect(flushSpy).toHaveBeenCalledTimes(1);
      expect(res.write).toHaveBeenCalledWith('retry: 1000\n\n');
      expect(attachSpy).toHaveBeenCalledWith('flush-stream-key', res);

      attachSpy.mockRestore();
    });

    test('handles SSE streaming when flushHeaders is unavailable', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const routerInstance = projectRoutesModule.default;
      const targetLayer = routerInstance.stack.find(
        (layer) => layer.route?.path === '/progress/:progressKey/stream' && layer.route?.methods?.get
      );
      const handler = targetLayer.route.stack[0].handle;

      const progressTracker = await import('../services/progressTracker.js');
      const attachSpy = vi.spyOn(progressTracker, 'attachProgressStream').mockImplementation(() => {});
      const res = {
        setHeader: vi.fn(),
        write: vi.fn(),
        end: vi.fn()
      };

      await handler({ params: { progressKey: 'no-flush-stream-key' } }, res);

      expect(res.write).toHaveBeenCalledWith('retry: 1000\n\n');
      expect(attachSpy).toHaveBeenCalledWith('no-flush-stream-key', res);
      expect(res.end).not.toHaveBeenCalled();

      attachSpy.mockRestore();
    });

    test('returns 404 when a progress snapshot cannot be found', async () => {
      const response = await request(app)
        .get(`/api/projects/progress/missing-${Date.now()}`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/progress not found/i);
    });

    test('returns an existing progress snapshot payload', async () => {
      const progressTracker = await import('../services/progressTracker.js');
      const snapshot = { status: 'pending', completion: 10 };
      const snapshotSpy = vi.spyOn(progressTracker, 'getProgressSnapshot').mockReturnValueOnce(snapshot);

      const response = await request(app)
        .get('/api/projects/progress/demo-key');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.progress).toEqual(snapshot);

      snapshotSpy.mockRestore();
    });

    test('returns 400 when reading a progress snapshot without a key', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const routerInstance = projectRoutesModule.default;
      const targetLayer = routerInstance.stack.find(
        (layer) => layer.route?.path === '/progress/:progressKey' && layer.route?.methods?.get
      );
      const handler = targetLayer.route.stack[0].handle;

      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        }
      };

      handler({ params: {} }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body?.error).toMatch(/progress key is required/i);
    });
  });

  describe('GET /api/projects', () => {
    test('returns 500 when fetching projects fails', async () => {
      const databaseModule = await import('../database.js');
      const getAllProjectsSpy = vi.spyOn(databaseModule, 'getAllProjects').mockRejectedValueOnce(new Error('Database offline'));

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to fetch projects/i);

      getAllProjectsSpy.mockRestore();
    });

    test('returns the list of projects when the lookup succeeds', async () => {
      await cleanDatabase();
      const { project } = await createPersistedProject({ name: `projects-list-${Date.now()}` });

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.projects)).toBe(true);
      expect(response.body.projects.some((entry) => entry.id === project.id)).toBe(true);
    });

    test('returns an empty array when the database yields no projects', async () => {
      const databaseModule = await import('../database.js');
      const getAllProjectsSpy = vi.spyOn(databaseModule, 'getAllProjects').mockResolvedValueOnce(null);

      const response = await request(app).get('/api/projects');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.projects).toEqual([]);

      getAllProjectsSpy.mockRestore();
    });
  });

  describe('GET /api/projects/:id - Single project', () => {
    test('returns 200 with the project when it exists', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app)
        .get(`/api/projects/${project.id}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.project).toEqual(expect.objectContaining({
        id: project.id,
        name: project.name
      }));
    });

    test('returns 500 when fetching a project fails unexpectedly', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockRejectedValueOnce(new Error('lookup failed'));

      const response = await request(app)
        .get(`/api/projects/failure-${Date.now()}`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to fetch project/i);

      getProjectSpy.mockRestore();
    });
  });

  describe('Project route internals', () => {
    test('router does not register debug route when NODE_ENV is not test', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const uniqueSuffix = Date.now();
      const projectRoutesModule = await import(
        /* @vite-ignore */ `../routes/projects.js?nonTest=${uniqueSuffix}`
      );
      const routerInstance = projectRoutesModule.default;
      const hasDebugRoute = routerInstance.stack?.some((layer) => layer.route?.path === '/__debug/running-processes');
      expect(hasDebugRoute).toBe(false);
      process.env.NODE_ENV = originalEnv;
    });

    test('router exposes debug running-processes route when NODE_ENV is test', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      const routerInstance = projectRoutesModule.default;
      const tempApp = express();
      tempApp.use(routerInstance);

      storeRunningProcesses('debug-project', { frontend: { pid: 999 } }, 'running', {
        exposeSnapshot: true
      });

      try {
        const response = await request(tempApp).get('/__debug/running-processes');
        expect(response.status).toBe(200);
        expect(Array.isArray(response.body.entries)).toBe(true);
        expect(response.body.entries.some(([key]) => key === 'debug-project')).toBe(true);
      } finally {
        resetRunningProcessesStore();
      }
    });

    test('isWithinManagedProjectsRoot handles roots that already end with path separators', async () => {
      const actualProjectPathsModule = await vi.importActual('../utils/projectPaths.js');
      const managedRootWithSep = `${actualProjectPathsModule.getProjectsDir()}${path.sep}`;
      const originalResolve = path.resolve;

      vi.doMock('../utils/projectPaths.js', () => ({
        ...actualProjectPathsModule,
        getProjectsDir: () => managedRootWithSep
      }));

      path.resolve = (...segments) => {
        if (segments.length === 1 && segments[0] === managedRootWithSep) {
          return managedRootWithSep;
        }
        return originalResolve(...segments);
      };

      try {
        const projectRoutesModule = await import(
          /* @vite-ignore */ `../routes/projects.js?managedRoot=${Date.now()}`
        );
        const { isWithinManagedProjectsRoot } = projectRoutesModule.__projectRoutesInternals;
        expect(isWithinManagedProjectsRoot(path.join(actualProjectPathsModule.getProjectsDir(), 'child'))).toBe(true);
      } finally {
        vi.doUnmock('../utils/projectPaths.js');
        path.resolve = originalResolve;
      }
    });

    test('isPidActive returns false for invalid identifiers', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { isPidActive } = projectRoutesModule.__projectRoutesInternals;

      expect(isPidActive(undefined)).toBe(false);
      expect(isPidActive('not-a-number')).toBe(false);
    });

    test('isPidActive treats non-ESRCH errors as active', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { isPidActive } = projectRoutesModule.__projectRoutesInternals;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('permission denied');
        error.code = 'EPERM';
        throw error;
      });

      try {
        expect(isPidActive(43210)).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(43210, 0);
      } finally {
        killSpy.mockRestore();
      }
    });

    test('isProtectedPid rejects invalid identifiers', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { isProtectedPid } = projectRoutesModule;

      expect(isProtectedPid('not-a-number')).toBe(false);
      expect(isProtectedPid(-10)).toBe(false);
      expect(isProtectedPid(0)).toBe(false);
    });

    test('normalizeProcessKey trims identifiers and returns null when empty', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { normalizeProcessKey } = projectRoutesModule.__projectRoutesInternals;

      expect(normalizeProcessKey(undefined)).toBeNull();
      expect(normalizeProcessKey('   ')).toBeNull();
      expect(normalizeProcessKey('  abc  ')).toBe('abc');
    });

    test('buildProcessKeyCandidates includes raw, normalized and numeric identifiers', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProcessKeyCandidates } = projectRoutesModule.__projectRoutesInternals;

      expect(buildProcessKeyCandidates(' 0042 ')).toEqual([' 0042 ', '0042', 42]);
    });

    test('buildProcessKeyCandidates preserves numeric inputs and their string representations', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProcessKeyCandidates } = projectRoutesModule.__projectRoutesInternals;

      expect(buildProcessKeyCandidates(77)).toEqual([77, '77']);
    });

    test('buildProcessKeyCandidates handles blank and null identifiers gracefully', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProcessKeyCandidates } = projectRoutesModule.__projectRoutesInternals;

      expect(buildProcessKeyCandidates('   ')).toEqual(['   ']);
      expect(buildProcessKeyCandidates(null)).toEqual([]);
    });

    test('sanitizeProcessSnapshot normalizes missing or invalid snapshot values', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { sanitizeProcessSnapshot } = projectRoutesModule.__projectRoutesInternals;

      expect(sanitizeProcessSnapshot(null)).toBeNull();

      const normalized = sanitizeProcessSnapshot({
        pid: 'abc',
        port: 'xyz',
        exitCode: 'oops',
        logs: null,
        status: '',
        startedAt: undefined,
        lastHeartbeat: undefined,
        endedAt: undefined,
        signal: undefined
      });

      expect(normalized.pid).toBeNull();
      expect(normalized.port).toBeNull();
      expect(normalized.exitCode).toBeNull();
      expect(normalized.logs).toEqual([]);
      expect(normalized.status).toBe('unknown');
    });

    test('sanitizeProcessSnapshot preserves numeric exit codes and signals', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { sanitizeProcessSnapshot } = projectRoutesModule.__projectRoutesInternals;

      const snapshot = sanitizeProcessSnapshot({
        pid: 1111,
        port: 2222,
        exitCode: 0,
        signal: 'SIGTERM',
        logs: [{ timestamp: new Date().toISOString(), output: 'done' }]
      });

      expect(snapshot.exitCode).toBe(0);
      expect(snapshot.signal).toBe('SIGTERM');
      expect(snapshot.logs).toHaveLength(1);
    });

    test('storeRunningProcesses ignores missing identifiers and removes numeric duplicates', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        getRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(undefined, { frontend: null });
      expect(getRunningProcessesStore().size).toBe(0);

      const processes = { frontend: { pid: process.pid, port: 1234 } };
      getRunningProcessesStore().set(7, { processes: null, state: 'running' });

      storeRunningProcesses('007', processes);

      expect(getRunningProcessesStore().has(7)).toBe(false);
      expect(getRunningProcessesStore().has('007')).toBe(true);
    });

    test('storeRunningProcesses reuses previous snapshots when updates omit processes', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
        const processes = { frontend: { pid: process.pid, port: 6123 } };
        storeRunningProcesses('reuse-snapshot', processes, 'running');
        const firstEntry = getRunningProcessEntry('reuse-snapshot');
        const initialLastChange = firstEntry.entry.lastStateChange;

        vi.setSystemTime(new Date('2024-01-01T00:05:00Z'));
        storeRunningProcesses('reuse-snapshot', null, 'running', { exposeSnapshot: false });

        const nextEntry = getRunningProcessEntry('reuse-snapshot');
        expect(nextEntry.processes.frontend.port).toBe(6123);
        expect(nextEntry.entry.lastStateChange).toBe(initialLastChange);
      } finally {
        vi.useRealTimers();
        resetRunningProcessesStore();
      }
    });

    test('storeRunningProcesses records null processes when no prior entry exists', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses('null-snapshot', null, 'stopped');
      const entry = getRunningProcessEntry('null-snapshot');
      expect(entry.processes).toBeNull();
      expect(entry.state).toBe('stopped');
      resetRunningProcessesStore();
    });

    test('getRunningProcessEntry normalizes cached entries and updates the store', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        getRunningProcessEntry,
        getRunningProcessesStore,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      const legacyEntry = {
        processes: { frontend: { pid: process.pid } },
        state: 'unknown',
        snapshotVisible: undefined,
        launchType: ''
      };
      getRunningProcessesStore().set('legacy', legacyEntry);

      const normalized = getRunningProcessEntry(' legacy ');
      expect(normalized.key).toBe('legacy');
      expect(normalized.state).toBe('running');
      expect(normalized.snapshotVisible).toBe(true);
      expect(normalized.launchType).toBe('manual');
      expect(getRunningProcessesStore().get('legacy')).not.toBe(legacyEntry);
      resetRunningProcessesStore();
    });

    test('getRunningProcessEntry returns default values when no entry is present', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      expect(getRunningProcessEntry('missing')).toEqual({
        key: null,
        processes: null,
        state: null,
        snapshotVisible: false,
        launchType: 'manual',
        entry: null
      });
    });

    test('getRunningProcessEntry falls back to manual launch type when missing', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        getRunningProcessEntry,
        getRunningProcessesStore,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      getRunningProcessesStore().set('launchless', { processes: null, state: 'running' });

      const entry = getRunningProcessEntry('launchless');
      expect(entry.launchType).toBe('manual');
      expect(entry.key).toBe('launchless');
      resetRunningProcessesStore();
    });

    test('getRunningProcessEntry tolerates null cache entries without rewriting the store', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        getRunningProcessEntry,
        getRunningProcessesStore,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      const store = getRunningProcessesStore();
      store.set('nullish', null);

      const entry = getRunningProcessEntry('nullish');
      expect(entry.key).toBe('nullish');
      expect(entry.processes).toBeNull();
      expect(entry.state).toBeNull();
      expect(store.get('nullish')).toBeNull();
      resetRunningProcessesStore();
    });

    test('getRunningProcessEntry reports snapshot visibility when processes expose a pid', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses('visible', { frontend: { pid: process.pid } }, 'running');
      const entry = getRunningProcessEntry('visible');
      expect(entry.snapshotVisible).toBe(true);
      resetRunningProcessesStore();
    });

    test('storeRunningProcesses preserves lastStateChange when subsequent updates keep the state', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
        storeRunningProcesses('no-change', { frontend: { pid: process.pid } }, 'running');
        const first = getRunningProcessEntry('no-change').entry.lastStateChange;

        vi.setSystemTime(new Date('2024-01-01T00:10:00.000Z'));
        storeRunningProcesses('no-change', { frontend: { pid: process.pid } }, 'running');
        const second = getRunningProcessEntry('no-change').entry.lastStateChange;

        expect(second).toBe(first);
      } finally {
        vi.useRealTimers();
        resetRunningProcessesStore();
      }
    });

    test('storeRunningProcesses updates termination metadata when transitioning to stopped', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      vi.useFakeTimers();
      try {
        const runningTime = new Date('2024-03-01T10:00:00.000Z');
        vi.setSystemTime(runningTime);
        storeRunningProcesses('transition', { frontend: { pid: process.pid } }, 'running');

        const stoppedTime = new Date('2024-03-01T10:05:00.000Z');
        vi.setSystemTime(stoppedTime);
        storeRunningProcesses('transition', null, 'stopped');

        const entry = getRunningProcessEntry('transition').entry;
        expect(entry.state).toBe('stopped');
        expect(entry.lastStateChange).toBe(stoppedTime.toISOString());
        expect(entry.lastTerminatedAt).toBe(stoppedTime.toISOString());
      } finally {
        vi.useRealTimers();
        resetRunningProcessesStore();
      }
    });

    test('storeRunningProcesses falls back to current timestamp when legacy entries omit lastStateChange', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        getRunningProcessesStore,
        resetRunningProcessesStore
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      const store = getRunningProcessesStore();
      store.set('legacy-time', {
        processes: null,
        state: 'running',
        lastStateChange: '',
        updatedAt: ''
      });

      const fallbackIso = '2024-04-02T00:00:00.000Z';
      const isoSpy = vi.spyOn(Date.prototype, 'toISOString')
        .mockImplementationOnce(() => '')
        .mockImplementationOnce(() => '')
        .mockImplementationOnce(() => fallbackIso)
        .mockImplementation(() => fallbackIso);

      try {
        storeRunningProcesses('legacy-time', null, 'running');
        const entry = getRunningProcessEntry('legacy-time').entry;
        expect(entry.lastStateChange).toBe(fallbackIso);
      } finally {
        isoSpy.mockRestore();
        resetRunningProcessesStore();
      }
    });

    test('isWithinManagedProjectsRoot returns false for falsy and root candidates', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { isWithinManagedProjectsRoot } = projectRoutesModule.__projectRoutesInternals;

      expect(isWithinManagedProjectsRoot(undefined)).toBe(false);
      const managedRoot = path.resolve(getProjectsDir());
      expect(isWithinManagedProjectsRoot(managedRoot)).toBe(false);
    });

    test('addCleanupTarget ignores falsy candidates', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { addCleanupTarget } = projectRoutesModule.__projectRoutesInternals;

      const targets = new Set();
      expect(addCleanupTarget(targets, '')).toBe(false);
      expect(targets.size).toBe(0);
    });

    test('addCleanupTarget rejects candidates outside the managed root', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { addCleanupTarget } = projectRoutesModule.__projectRoutesInternals;

      const targets = new Set();
      const managedRoot = path.resolve(getProjectsDir());
      const outside = path.resolve(path.join(managedRoot, '..', 'outside-managed-root'));
      expect(addCleanupTarget(targets, outside)).toBe(false);
      expect(targets.size).toBe(0);
    });

    test('addCleanupTarget rejects candidates containing unsafe characters', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { addCleanupTarget } = projectRoutesModule.__projectRoutesInternals;

      const targets = new Set();
      const managedRoot = path.resolve(getProjectsDir());
      const unsafe = path.join(managedRoot, "bad'path");
      expect(addCleanupTarget(targets, unsafe)).toBe(false);
      expect(targets.size).toBe(0);
    });

    test('buildCleanupTargets adds nested parent paths inside managed root', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildCleanupTargets } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const nestedPath = path.join(managedRoot, 'demo', 'backend');
      const targets = buildCleanupTargets({ name: 'demo', path: nestedPath });

      expect(targets).toContain(nestedPath);
      expect(targets).toContain(path.join(managedRoot, 'demo'));
    });

    test('buildCleanupTargets returns empty array when project lacks both path and name', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildCleanupTargets } = projectRoutesModule.__projectRoutesInternals;

      expect(buildCleanupTargets({})).toEqual([]);
    });

    test('buildCleanupTargets tracks standalone paths outside the managed root without parent additions', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildCleanupTargets } = projectRoutesModule.__projectRoutesInternals;

      const externalPath = path.resolve(path.join(process.cwd(), 'external-project'));
      const targets = buildCleanupTargets({ name: 'external', path: externalPath });

      // For safety, the API only cleans up managed project paths.
      expect(targets).toEqual([]);
    });

    test('cleanupDirectoryWithRetry resolves when the directory is already gone', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'missing');

      const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
      const fsMock = {
        rm: vi.fn().mockRejectedValue(missingError)
      };

      await cleanupDirectoryWithRetry(fsMock, safeTarget, 1, 0);
      expect(fsMock.rm).toHaveBeenCalledTimes(1);
    });

    test('cleanupDirectoryWithRetry refuses deletion outside the managed root', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const outside = path.resolve(path.join(managedRoot, '..', 'outside-managed-root'));
      const fsMock = {
        rm: vi.fn()
      };

      await expect(cleanupDirectoryWithRetry(fsMock, outside, 1, 0)).rejects.toMatchObject({
        code: 'EUNSAFE_DELETE_TARGET'
      });
      expect(fsMock.rm).not.toHaveBeenCalled();
    });

    test('cleanupDirectoryWithRetry refuses deletion for paths containing unsafe characters', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const unsafe = path.join(managedRoot, "bad'path");
      const fsMock = {
        rm: vi.fn()
      };

      await expect(cleanupDirectoryWithRetry(fsMock, unsafe, 1, 0)).rejects.toMatchObject({
        code: 'EUNSAFE_DELETE_TARGET'
      });
      expect(fsMock.rm).not.toHaveBeenCalled();
    });

    test('cleanupDirectoryWithRetry refuses deletion when the target path is empty', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const fsMock = {
        rm: vi.fn()
      };

      await expect(cleanupDirectoryWithRetry(fsMock, '', 1, 0)).rejects.toMatchObject({
        code: 'EUNSAFE_DELETE_TARGET'
      });
      expect(fsMock.rm).not.toHaveBeenCalled();
    });

    test('cleanupDirectoryWithRetry refuses deletion when the managed root is the filesystem root', async () => {
      const originalProjectsDir = process.env.PROJECTS_DIR;
      const originalNodeEnv = process.env.NODE_ENV;
      const fsRoot = path.parse(process.cwd()).root;

      try {
        process.env.NODE_ENV = 'test';
        process.env.PROJECTS_DIR = fsRoot;

        // Use a literal query-string import so Vite can statically analyze it,
        // and so it doesn't interfere with the main module instance used by the app.
        const projectRoutesModule = await import('../routes/projects.js?unsafe-root=1');
        const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

        const fsMock = { rm: vi.fn() };
        await expect(
          cleanupDirectoryWithRetry(fsMock, path.join(fsRoot, 'demo'), 1, 0)
        ).rejects.toMatchObject({ code: 'EUNSAFE_MANAGED_ROOT' });
        expect(fsMock.rm).not.toHaveBeenCalled();
      } finally {
        process.env.PROJECTS_DIR = originalProjectsDir;
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    test('cleanupDirectoryWithRetry backs off before retrying', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'retry');

      const busyError = Object.assign(new Error('busy'), { code: 'EBUSY' });
      const fsMock = {
        rm: vi.fn().mockRejectedValueOnce(busyError).mockResolvedValueOnce()
      };

      vi.useFakeTimers();
      try {
        const pending = cleanupDirectoryWithRetry(fsMock, safeTarget, 2, 200);
        await vi.advanceTimersByTimeAsync(200);
        await pending;
        expect(fsMock.rm).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    test('cleanupDirectoryWithRetry rethrows non-retryable errors', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { cleanupDirectoryWithRetry } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'fatal');

      const fatalError = Object.assign(new Error('fatal'), { code: 'UNKNOWN' });
      const fsMock = {
        rm: vi.fn().mockRejectedValue(fatalError)
      };

      await expect(cleanupDirectoryWithRetry(fsMock, safeTarget, 2, 0)).rejects.toBe(fatalError);
      expect(fsMock.rm).toHaveBeenCalledTimes(1);
    });

    test('cleanupDirectoryWithRetry escalates to alternative cleanup after retries', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        cleanupDirectoryWithRetry,
        setAlternativeCleanupExecutor,
        resetAlternativeCleanupExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'stubborn');

      const busyError = Object.assign(new Error('busy'), { code: 'EBUSY' });
      const fsMock = {
        rm: vi.fn().mockRejectedValue(busyError)
      };

      const altSpy = vi.fn().mockResolvedValue();
      setAlternativeCleanupExecutor(altSpy);

      try {
        await cleanupDirectoryWithRetry(fsMock, safeTarget, 1, 0);
        expect(altSpy).toHaveBeenCalledWith(fsMock, safeTarget);
      } finally {
        resetAlternativeCleanupExecutor();
      }
    });

    test('alternativeCleanup succeeds after reapplying permissions', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { alternativeCleanup } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'attributes');

      const fsMock = {
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([]),
        rm: vi.fn().mockResolvedValue()
      };

      await alternativeCleanup(fsMock, safeTarget);
      expect(fsMock.rm).toHaveBeenCalledTimes(1);
    });

    test('alternativeCleanup retries PowerShell after Windows cmd failure', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { alternativeCleanup } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'demo');

      const fsMock = {
        rm: vi.fn().mockRejectedValue(new Error('rm failed')),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([])
      };

      const childProcess = await import('child_process');
      childProcess.execSync.mockReset();
      childProcess.execSync
        .mockImplementationOnce(() => {
          throw new Error('cmd failed');
        })
        .mockImplementationOnce(() => undefined);

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await alternativeCleanup(fsMock, safeTarget);
        expect(childProcess.execSync).toHaveBeenNthCalledWith(1, expect.stringContaining('rmdir'), expect.any(Object));
        expect(childProcess.execSync).toHaveBeenNthCalledWith(2, expect.stringContaining('powershell'), expect.any(Object));
      } finally {
        platformSpy.mockRestore();
      }
    });

    test('alternativeCleanup logs when PowerShell cleanup also fails', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        alternativeCleanup,
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'power');

      const fsMock = {
        rm: vi.fn().mockRejectedValue(new Error('rm failed')),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([])
      };

      const manualSpy = vi.fn().mockResolvedValue();
      setManualRecursiveRemovalExecutor(manualSpy);

      const childProcess = await import('child_process');
      childProcess.execSync.mockReset();
      childProcess.execSync
        .mockImplementationOnce(() => {
          throw new Error('cmd failed');
        })
        .mockImplementationOnce(() => {
          throw new Error('powershell failed');
        });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await alternativeCleanup(fsMock, safeTarget);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PowerShell cleanup also failed'), 'powershell failed');
        expect(manualSpy).toHaveBeenCalledWith(fsMock, safeTarget);
      } finally {
        platformSpy.mockRestore();
        warnSpy.mockRestore();
        resetManualRecursiveRemovalExecutor();
      }
    });

    test('alternativeCleanup warns before falling back after PowerShell failure', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        alternativeCleanup,
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'warn');

      const fsMock = {
        rm: vi.fn().mockRejectedValue(new Error('rm failed')),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([])
      };

      const manualSpy = vi.fn().mockResolvedValue();
      setManualRecursiveRemovalExecutor(manualSpy);

      const childProcess = await import('child_process');
      childProcess.execSync.mockReset();
      childProcess.execSync
        .mockImplementationOnce(() => {
          throw new Error('cmd blowup');
        })
        .mockImplementationOnce(() => {
          throw new Error('powershell blowup');
        });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await alternativeCleanup(fsMock, safeTarget);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('PowerShell cleanup also failed'),
          'powershell blowup'
        );
        expect(manualSpy).toHaveBeenCalledWith(fsMock, safeTarget);
      } finally {
        platformSpy.mockRestore();
        warnSpy.mockRestore();
        resetManualRecursiveRemovalExecutor();
      }
    });

    test('alternativeCleanup falls back to manual removal on Unix failures', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        alternativeCleanup,
        setPlatformOverride,
        resetPlatformOverride,
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'unix-demo');

      const fsMock = {
        rm: vi.fn().mockRejectedValue(new Error('rm failed')),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([])
      };
      const manualSpy = vi.fn().mockResolvedValue();
      setManualRecursiveRemovalExecutor(manualSpy);

      const childProcess = await import('child_process');
      childProcess.execSync.mockImplementation(() => {
        throw new Error('rm failed');
      });
      setPlatformOverride('linux');

      try {
        await alternativeCleanup(fsMock, safeTarget);
        expect(manualSpy).toHaveBeenCalledWith(fsMock, safeTarget);
      } finally {
        resetPlatformOverride();
        resetManualRecursiveRemovalExecutor();
      }
    });

    test('alternativeCleanup surfaces manual cleanup failures', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        alternativeCleanup,
        setPlatformOverride,
        resetPlatformOverride,
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'unrecoverable');

      const fsMock = {
        rm: vi.fn().mockRejectedValue(new Error('rm failed')),
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue([])
      };

      const manualSpy = vi.fn().mockRejectedValue(new Error('manual fail'));
      setManualRecursiveRemovalExecutor(manualSpy);

      const childProcess = await import('child_process');
      childProcess.execSync.mockReset();
      childProcess.execSync.mockImplementation(() => {
        throw new Error('rm failed');
      });

      setPlatformOverride('linux');

      try {
        await expect(alternativeCleanup(fsMock, safeTarget)).rejects.toThrow(/Failed to clean up directory/);
        expect(manualSpy).toHaveBeenCalledWith(fsMock, safeTarget);
      } finally {
        resetPlatformOverride();
        resetManualRecursiveRemovalExecutor();
      }
    });

    test('exposes cleanup executor getters for inspection', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        alternativeCleanup,
        setAlternativeCleanupExecutor,
        resetAlternativeCleanupExecutor,
        getAlternativeCleanupExecutor,
        manualRecursiveRemoval,
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor,
        getManualRecursiveRemovalExecutor,
        makeDirectoryWritable,
        setMakeDirectoryWritableExecutor,
        resetMakeDirectoryWritableExecutor,
        getMakeDirectoryWritableExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const altSpy = vi.fn();
      const manualSpy = vi.fn();
      const writableSpy = vi.fn();

      setAlternativeCleanupExecutor(altSpy);
      setManualRecursiveRemovalExecutor(manualSpy);
      setMakeDirectoryWritableExecutor(writableSpy);

      try {
        expect(getAlternativeCleanupExecutor()).toBe(altSpy);
        expect(getManualRecursiveRemovalExecutor()).toBe(manualSpy);
        expect(getMakeDirectoryWritableExecutor()).toBe(writableSpy);
      } finally {
        resetAlternativeCleanupExecutor();
        resetManualRecursiveRemovalExecutor();
        resetMakeDirectoryWritableExecutor();
      }

      expect(getAlternativeCleanupExecutor()).toBe(alternativeCleanup);
      expect(getManualRecursiveRemovalExecutor()).toBe(manualRecursiveRemoval);
      expect(getMakeDirectoryWritableExecutor()).toBe(makeDirectoryWritable);
    });

    test('setMakeDirectoryWritableExecutor falls back to default when override is invalid', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setMakeDirectoryWritableExecutor,
        resetMakeDirectoryWritableExecutor,
        getMakeDirectoryWritableExecutor,
        makeDirectoryWritable
      } = projectRoutesModule.__projectRoutesInternals;

      resetMakeDirectoryWritableExecutor();
      const defaultImpl = getMakeDirectoryWritableExecutor();
      expect(defaultImpl).toBe(makeDirectoryWritable);

      setMakeDirectoryWritableExecutor(null);
      expect(getMakeDirectoryWritableExecutor()).toBe(makeDirectoryWritable);

      const custom = vi.fn();
      setMakeDirectoryWritableExecutor(custom);
      expect(getMakeDirectoryWritableExecutor()).toBe(custom);
      resetMakeDirectoryWritableExecutor();
    });

    test('setAlternativeCleanupExecutor ignores non-function overrides', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setAlternativeCleanupExecutor,
        resetAlternativeCleanupExecutor,
        getAlternativeCleanupExecutor,
        alternativeCleanup
      } = projectRoutesModule.__projectRoutesInternals;

      resetAlternativeCleanupExecutor();
      expect(getAlternativeCleanupExecutor()).toBe(alternativeCleanup);

      setAlternativeCleanupExecutor('not a function');
      expect(getAlternativeCleanupExecutor()).toBe(alternativeCleanup);

      const custom = vi.fn();
      setAlternativeCleanupExecutor(custom);
      expect(getAlternativeCleanupExecutor()).toBe(custom);
      resetAlternativeCleanupExecutor();
    });

    test('makeDirectoryWritable updates file permissions when target is a file', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { makeDirectoryWritable } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'file.txt');

      const fsMock = {
        stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
        chmod: vi.fn().mockResolvedValue()
      };

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await makeDirectoryWritable(fsMock, safeTarget);
        expect(fsMock.chmod).toHaveBeenCalledWith(safeTarget, 0o666);
      } finally {
        platformSpy.mockRestore();
      }
    });

    test('makeDirectoryWritable applies unix-friendly permissions outside Windows', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { makeDirectoryWritable } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'file-unix.txt');

      const fsMock = {
        stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
        chmod: vi.fn().mockResolvedValue()
      };

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

      try {
        await makeDirectoryWritable(fsMock, safeTarget);
        expect(fsMock.chmod).toHaveBeenCalledWith(safeTarget, 0o644);
      } finally {
        platformSpy.mockRestore();
      }
    });

    test('setManualRecursiveRemovalExecutor ignores non-function overrides', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setManualRecursiveRemovalExecutor,
        resetManualRecursiveRemovalExecutor,
        getManualRecursiveRemovalExecutor,
        manualRecursiveRemoval
      } = projectRoutesModule.__projectRoutesInternals;

      resetManualRecursiveRemovalExecutor();
      expect(getManualRecursiveRemovalExecutor()).toBe(manualRecursiveRemoval);

      setManualRecursiveRemovalExecutor(undefined);
      expect(getManualRecursiveRemovalExecutor()).toBe(manualRecursiveRemoval);

      const custom = vi.fn();
      setManualRecursiveRemovalExecutor(custom);
      expect(getManualRecursiveRemovalExecutor()).toBe(custom);
      resetManualRecursiveRemovalExecutor();
    });

    test('attachTestErrorDetails populates debug metadata only in test environments', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { attachTestErrorDetails } = projectRoutesModule.__projectRoutesInternals;

      const previousEnv = process.env.NODE_ENV;
      const target = {};
      const error = new Error('boom');

      try {
        process.env.NODE_ENV = 'test';
        attachTestErrorDetails(error, target);
        expect(target.details).toBe('boom');
        expect(target.stack).toMatch(/boom/);

        process.env.NODE_ENV = 'production';
        attachTestErrorDetails(new Error('ignored'), target);
        expect(target.details).toBe('boom');
      } finally {
        process.env.NODE_ENV = previousEnv;
      }
    });

    test('buildProjectUpdatePayload trims inputs and applies defaults', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProjectUpdatePayload } = projectRoutesModule.__projectRoutesInternals;

      const payload = buildProjectUpdatePayload({
        name: '  Demo  ',
        description: '  Desc  ',
        path: undefined
      });

      expect(payload).toEqual({
        name: 'Demo',
        description: 'Desc',
        language: 'javascript',
        framework: 'react',
        path: null
      });
    });

    test('buildProjectUpdatePayload fills in defaults when nothing is provided', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProjectUpdatePayload } = projectRoutesModule.__projectRoutesInternals;

      expect(buildProjectUpdatePayload()).toEqual({
        name: '',
        description: '',
        language: 'javascript',
        framework: 'react',
        path: null
      });
    });

    test('extractFileContentFromRequest normalizes body payloads', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { extractFileContentFromRequest } = projectRoutesModule.__projectRoutesInternals;

      expect(extractFileContentFromRequest(null)).toBeUndefined();
      expect(extractFileContentFromRequest({})).toBeUndefined();
      expect(extractFileContentFromRequest({ content: 'hello' })).toBe('hello');
    });

    test('manualRecursiveRemoval removes nested files and directories', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { manualRecursiveRemoval } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const demoPath = path.join(managedRoot, 'tmp', 'demo');

      const dirEntry = { name: 'nested', isDirectory: () => true };
      const fileEntry = { name: 'file.txt', isDirectory: () => false };
      const fsMock = {
        readdir: vi.fn().mockImplementation(async (dirPath) => {
          if (dirPath === demoPath) {
            return [dirEntry, fileEntry];
          }
          return [];
        }),
        chmod: vi.fn().mockResolvedValue(),
        unlink: vi.fn().mockResolvedValue(),
        rmdir: vi.fn().mockResolvedValue()
      };

      await manualRecursiveRemoval(fsMock, demoPath);

      expect(fsMock.unlink).toHaveBeenCalledWith(path.join(demoPath, 'file.txt'));
      expect(fsMock.rmdir).toHaveBeenCalledWith(demoPath);
    });

    test('manualRecursiveRemoval ignores already-removed directories', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { manualRecursiveRemoval } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'ghost');

      const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
      const fsMock = {
        readdir: vi.fn().mockRejectedValue(missingError)
      };

      await expect(manualRecursiveRemoval(fsMock, safeTarget)).resolves.toBeUndefined();
      expect(fsMock.readdir).toHaveBeenCalledTimes(1);
    });

    test('manualRecursiveRemoval logs entry removal failures', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { manualRecursiveRemoval } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'noisy');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fsMock = {
        readdir: vi.fn().mockResolvedValue([
          { name: 'bad.txt', isDirectory: () => false }
        ]),
        chmod: vi.fn().mockResolvedValue(),
        unlink: vi.fn().mockRejectedValue(new Error('denied')),
        rmdir: vi.fn().mockResolvedValue()
      };

      try {
        await manualRecursiveRemoval(fsMock, safeTarget);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bad.txt'), 'denied');
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('manualRecursiveRemoval rethrows unexpected read errors', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { manualRecursiveRemoval } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'locked');

      const readError = Object.assign(new Error('blocked'), { code: 'EACCES' });
      const fsMock = {
        readdir: vi.fn().mockRejectedValue(readError)
      };

      await expect(manualRecursiveRemoval(fsMock, safeTarget)).rejects.toBe(readError);
    });

    test('makeDirectoryWritable applies recursive chmod operations', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { makeDirectoryWritable } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const demoPath = path.join(managedRoot, 'tmp', 'demo');

      const fsMock = {
        stat: vi.fn(async (target) => ({
          isDirectory: () => target === demoPath
        })),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue(['file.txt'])
      };

      await makeDirectoryWritable(fsMock, demoPath);

      expect(fsMock.chmod).toHaveBeenCalledWith(demoPath, expect.any(Number));
      expect(fsMock.chmod).toHaveBeenCalledWith(path.join(demoPath, 'file.txt'), expect.any(Number));
    });

    test('makeDirectoryWritable logs when stat fails', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { makeDirectoryWritable } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const safeTarget = path.join(managedRoot, 'tmp', 'fail');

      const fsMock = {
        stat: vi.fn().mockRejectedValue(new Error('nope'))
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await makeDirectoryWritable(fsMock, safeTarget);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('makeDirectoryWritable returns silently for unsafe paths outside the managed root', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { makeDirectoryWritable } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const outside = path.resolve(path.join(managedRoot, '..', 'outside-managed-root'));
      const fsMock = {
        stat: vi.fn(),
        chmod: vi.fn(),
        readdir: vi.fn()
      };

      await expect(makeDirectoryWritable(fsMock, outside)).resolves.toBeUndefined();
      expect(fsMock.stat).not.toHaveBeenCalled();
      expect(fsMock.chmod).not.toHaveBeenCalled();
    });

    test('makeDirectoryWritable logs when recursive calls reject', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        makeDirectoryWritable,
        setMakeDirectoryWritableExecutor,
        resetMakeDirectoryWritableExecutor
      } = projectRoutesModule.__projectRoutesInternals;

      const managedRoot = path.resolve(getProjectsDir());
      const parentPath = path.join(managedRoot, 'tmp', 'parent');

      const original = makeDirectoryWritable;
      const fsMock = {
        stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
        chmod: vi.fn().mockResolvedValue(),
        readdir: vi.fn().mockResolvedValue(['file.txt'])
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setMakeDirectoryWritableExecutor(async (innerFs, targetPath) => {
        if (targetPath.endsWith('file.txt')) {
          throw new Error('child fail');
        }
        return original(innerFs, targetPath);
      });

      try {
        await original(fsMock, parentPath);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('file.txt'), 'child fail');
      } finally {
        resetMakeDirectoryWritableExecutor();
        warnSpy.mockRestore();
      }
    });

    test('logProtectedPidSkip adds contextual suffix when provided', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { logProtectedPidSkip } = projectRoutesModule.__projectRoutesInternals;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        logProtectedPidSkip(4242, 'port 9999');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('(port 9999)'));
        warnSpy.mockClear();
        logProtectedPidSkip(4242);
        const [[message]] = warnSpy.mock.calls;
        expect(message).not.toContain('(');
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('buildProcessState falls back to idle when processes are missing', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildProcessState } = projectRoutesModule.__projectRoutesInternals;

      expect(buildProcessState('unknown', false)).toBe('idle');
      expect(buildProcessState('unknown', true)).toBe('running');
    });

    test('normalizeProcessEntry builds snapshots for legacy shapes', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { normalizeProcessEntry } = projectRoutesModule.__projectRoutesInternals;

      const entry = normalizeProcessEntry({ frontend: 1 });
      expect(entry.processes.frontend).toBe(1);
      expect(entry.state).toBe('running');
      expect(entry.snapshotVisible).toBe(true);
    });

    test('normalizeProcessEntry respects legacy string states for timestamps', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { normalizeProcessEntry } = projectRoutesModule.__projectRoutesInternals;

      vi.useFakeTimers();
      try {
        const now = new Date('2024-02-02T02:02:02.000Z');
        vi.setSystemTime(now);
        const stoppedEntry = normalizeProcessEntry('stopped');
        expect(stoppedEntry.state).toBe('stopped');
        expect(stoppedEntry.lastTerminatedAt).toBe(now.toISOString());

        const runningEntry = normalizeProcessEntry('running');
        expect(runningEntry.state).toBe('running');
        expect(runningEntry.lastTerminatedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    test('normalizeProcessEntry derives snapshots from legacy objects containing only state', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { normalizeProcessEntry } = projectRoutesModule.__projectRoutesInternals;

      const entry = normalizeProcessEntry({ state: 'stopped' });
      expect(entry.state).toBe('stopped');
      expect(entry.lastTerminatedAt).not.toBeNull();
      expect(entry.snapshotVisible).toBe(true);
    });

    test('getProjectFrameworks returns empty values when project is missing', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { getProjectFrameworks } = projectRoutesModule.__projectRoutesInternals;

      expect(getProjectFrameworks(undefined)).toEqual({ frontend: '', backend: '' });
    });

    test('deriveProjectPorts returns defaults when project is undefined', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { deriveProjectPorts } = projectRoutesModule.__projectRoutesInternals;

      expect(deriveProjectPorts(undefined).sort()).toEqual([3000, 5173]);
    });

    test('getStoredProjectPorts normalizes both legacy and camelCase port fields', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { getStoredProjectPorts } = projectRoutesModule.__projectRoutesInternals;

      const ports = getStoredProjectPorts({ frontend_port: '6500', backendPort: '07440' });
      expect(ports).toEqual({ frontend: 6500, backend: 7440 });
    });

    test('resolveLastKnownPort returns the first defined candidate or null', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { resolveLastKnownPort } = projectRoutesModule.__projectRoutesInternals;

      expect(resolveLastKnownPort(6100, 6200)).toBe(6100);
      expect(resolveLastKnownPort(undefined, 6300)).toBe(6300);
      expect(resolveLastKnownPort(null, undefined)).toBeNull();
    });

    test('resolveActivityState infers running or idle fallbacks', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { resolveActivityState } = projectRoutesModule.__projectRoutesInternals;

      expect(resolveActivityState('running', false)).toBe('running');
      expect(resolveActivityState(undefined, true)).toBe('running');
      expect(resolveActivityState(null, false)).toBe('idle');
    });

    test('resolveTerminationProject returns the provided project when present', async () => {
      const { project } = await createPersistedProject({ name: `terminate-helper-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { resolveTerminationProject } = projectRoutesModule.__projectRoutesInternals;

      const resolved = await resolveTerminationProject(project.id, project);
      expect(resolved).toEqual(project);
    });

    test('resolveTerminationProject falls back to identifier lookups when project is missing', async () => {
      const { project } = await createPersistedProject({ name: `terminate-lookup-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { resolveTerminationProject } = projectRoutesModule.__projectRoutesInternals;

      const resolved = await resolveTerminationProject(project.id, null);
      expect(resolved?.id).toBe(project.id);
    });

    test('resolveTerminationProject returns null when neither identifier nor project is provided', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { resolveTerminationProject } = projectRoutesModule.__projectRoutesInternals;

      const resolved = await resolveTerminationProject(undefined, null);
      expect(resolved).toBeNull();
    });

    test('terminateRunningProcesses waits for release delay and preserves snapshots', async () => {
      const { project } = await createPersistedProject({ name: `terminate-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore,
        terminateRunningProcesses
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      const processes = {
        frontend: { port: 6401 },
        backend: { port: 7401 }
      };
      storeRunningProcesses(project.id, processes, 'running');

      vi.useFakeTimers();
      try {
        const pending = terminateRunningProcesses(project.id, { waitForRelease: true, project });
        await vi.advanceTimersByTimeAsync(2000);
        const result = await pending;
        expect(result.wasRunning).toBe(true);
      } finally {
        vi.useRealTimers();
      }

      const entry = getRunningProcessEntry(project.id);
      expect(entry.state).toBe('stopped');
      expect(entry.entry.snapshotVisible).toBe(true);
      resetRunningProcessesStore();
    });

    test('terminateRunningProcesses can stop only one target and keep the other snapshot running', async () => {
      const { project } = await createPersistedProject({ name: `terminate-target-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(project.id, {
        frontend: { pid: 11111 },
        backend: { port: 7401 }
      }, 'running');

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      vi.useFakeTimers();
      try {
        const pending = terminateRunningProcesses(project.id, { project, target: 'frontend' });
        await vi.advanceTimersByTimeAsync(250);
        const result = await pending;
        expect(result.wasRunning).toBe(true);
      } finally {
        vi.useRealTimers();
        platformSpy.mockRestore();
        resetExecFileOverride();
      }

      expect(execCalls).toHaveLength(1);
      expect(execCalls[0].file).toBe('taskkill');
      expect(execCalls[0].args).toEqual(['/PID', '11111', '/T', '/F']);

      const entry = getRunningProcessEntry(project.id);
      expect(entry.state).toBe('running');
      expect(entry.processes.frontend).toBeNull();
      expect(entry.processes.backend).toBeTruthy();
      resetRunningProcessesStore();
    });

    test('terminateRunningProcesses can drop a stored entry when dropEntry is true', async () => {
      const { project } = await createPersistedProject({ name: `terminate-drop-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessesStore,
        resetRunningProcessesStore,
        terminateRunningProcesses
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(project.id, { frontend: { port: 6401 } }, 'stopped');
      expect(getRunningProcessesStore().size).toBe(1);

      const result = await terminateRunningProcesses(project.id, { project, dropEntry: true });
      expect(result.wasRunning).toBe(false);
      expect(getRunningProcessesStore().size).toBe(0);
    });

    test('terminateRunningProcesses does not mutate stored entry when key exists but entry is not active', async () => {
      const { project } = await createPersistedProject({ name: `terminate-inactive-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const internals = projectRoutesModule.__projectRoutesInternals;

      internals.resetRunningProcessesStore();
      internals.storeRunningProcesses(project.id, { frontend: { port: 6401 }, backend: null }, 'stopped');

      const storeSpy = vi.spyOn(internals, 'storeRunningProcesses');

      const result = await internals.terminateRunningProcesses(project.id, {
        project,
        dropEntry: false,
        ports: []
      });

      expect(result).toEqual({ wasRunning: false, freedPorts: [] });
      expect(storeSpy).not.toHaveBeenCalled();
    });

    test('terminateRunningProcesses stopping backend keeps the frontend snapshot running', async () => {
      const { project } = await createPersistedProject({ name: `terminate-backend-target-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        getRunningProcessEntry,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(project.id, {
        frontend: { port: 6401 },
        backend: { pid: 22222 }
      }, 'running');

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        const result = await terminateRunningProcesses(project.id, { project, target: 'backend' });
        expect(result.wasRunning).toBe(true);
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
      }

      expect(execCalls).toHaveLength(1);
      expect(execCalls[0].file).toBe('taskkill');
      expect(execCalls[0].args).toEqual(['/PID', '22222', '/T', '/F']);

      const entry = getRunningProcessEntry(project.id);
      expect(entry.state).toBe('running');
      expect(entry.processes.backend).toBeNull();
      expect(entry.processes.frontend).toBeTruthy();
      resetRunningProcessesStore();
    });

    test('terminateRunningProcesses targeted port cleanup does not free non-target ports (regression)', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();

      // Simulate a stale/non-running snapshot: state is stopped, but we still have
      // project port metadata. Targeted termination must not free the other port.
      const project = {
        id: 'terminate-port-regression',
        name: 'terminate-port-regression',
        frontendPort: 5100,
        backendPort: 5500,
        framework: 'react,express'
      };

      storeRunningProcesses(project.id, {
        frontend: { port: 5100 },
        backend: { port: 5500 }
      }, 'stopped');

      const execCommands = [];
      setExecCommandOverride(async (command) => {
        execCommands.push(command);
        if (command.includes(':5100')) {
          return 'TCP 0.0.0.0:5100 0.0.0.0:0 LISTENING 11111\n';
        }
        if (command.includes(':5500')) {
          return 'TCP 0.0.0.0:5500 0.0.0.0:0 LISTENING 22222\n';
        }
        return '';
      });

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await terminateRunningProcesses(project.id, { project, target: 'backend', forcePorts: true });
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
        resetExecCommandOverride();
        resetRunningProcessesStore();
      }

      expect(execCommands.some((cmd) => cmd.includes(':5100'))).toBe(false);
      expect(execCommands.some((cmd) => cmd.includes(':5500'))).toBe(true);
      expect(execCalls).toEqual([
        { file: 'taskkill', args: ['/PID', '22222', '/T', '/F'] }
      ]);
    });

    test('terminateRunningProcesses uses explicit ports list when target port cannot be resolved (coverage)', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();

      const project = {
        id: 'terminate-explicit-ports-coverage',
        name: 'terminate-explicit-ports-coverage',
        framework: 'react,express'
      };

      storeRunningProcesses(project.id, {
        frontend: { port: 5100 },
        backend: { port: null }
      }, 'stopped');

      const execCommands = [];
      setExecCommandOverride(async (command) => {
        execCommands.push(command);
        if (command.includes(':5100')) {
          return 'TCP 0.0.0.0:5100 0.0.0.0:0 LISTENING 11111\n';
        }
        if (command.includes(':5500')) {
          return 'TCP 0.0.0.0:5500 0.0.0.0:0 LISTENING 22222\n';
        }
        return '';
      });

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await terminateRunningProcesses(project.id, {
          project,
          target: 'backend',
          forcePorts: true,
          ports: [5500]
        });
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
        resetExecCommandOverride();
        resetRunningProcessesStore();
      }

      expect(execCommands.some((cmd) => cmd.includes(':5100'))).toBe(false);
      expect(execCommands.some((cmd) => cmd.includes(':5500'))).toBe(true);
      expect(execCalls).toEqual([
        { file: 'taskkill', args: ['/PID', '22222', '/T', '/F'] }
      ]);
    });

    test('terminateRunningProcesses backend target does not attempt port cleanup when only frontend pid is live (regression)', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();

      const project = {
        id: 'terminate-no-cleanup-frontend-live',
        name: 'terminate-no-cleanup-frontend-live',
        // Intentionally set a backendPort that could overlap with a frontend (e.g. nextjs on 3000).
        backendPort: 3000,
        framework: 'nextjs,express'
      };

      // Frontend pid is definitely live (current test runner), backend is missing.
      storeRunningProcesses(project.id, {
        frontend: { pid: process.pid, port: 3000 },
        backend: null
      }, 'running');

      const execCommands = [];
      setExecCommandOverride(async (command) => {
        execCommands.push(command);
        return '';
      });

      try {
        await terminateRunningProcesses(project.id, { project, target: 'backend' });
      } finally {
        resetExecCommandOverride();
        resetRunningProcessesStore();
      }

      // No netstat/lsof calls should occur; targeted restarts should not free ports just because
      // the *other* process is alive.
      expect(execCommands.length).toBe(0);
    });

    test('terminateRunningProcesses covers both remaining-key branches', async () => {
      const { project } = await createPersistedProject({ name: `terminate-remaining-key-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();

      setExecFileOverride((file, args, callback) => {
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });
      setExecCommandOverride(async () => '');
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        storeRunningProcesses(project.id, {
          frontend: { pid: 44444, port: 6401 },
          backend: { pid: 44445, port: 7401 }
        }, 'running');
        await terminateRunningProcesses(project.id, { project, target: 'frontend' });

        resetRunningProcessesStore();
        storeRunningProcesses(project.id, {
          frontend: { pid: 44444, port: 6401 },
          backend: { pid: 44445, port: 7401 }
        }, 'running');
        await terminateRunningProcesses(project.id, { project, target: 'backend' });
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
        resetExecCommandOverride();
        resetRunningProcessesStore();
      }
    });

    test('terminateRunningProcesses handles target ports when the target port is an integer', async () => {
      const { project } = await createPersistedProject({ name: `terminate-target-port-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        terminateRunningProcesses,
        setExecFileOverride,
        resetExecFileOverride,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(project.id, {
        frontend: { pid: 33333, port: 5173 },
        backend: null
      }, 'running');

      // Avoid touching real processes/ports: taskkill and netstat are stubbed.
      setExecFileOverride((file, args, callback) => {
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });
      setExecCommandOverride(async () => '');
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        const result = await terminateRunningProcesses(project.id, { project, target: 'frontend' });
        expect(result.wasRunning).toBe(true);
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
        resetExecCommandOverride();
        resetRunningProcessesStore();
      }
    });

    test('killProcessTree ignores invalid pid inputs', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree } = projectRoutesModule;
      const { setExecFileOverride, resetExecFileOverride } = projectRoutesModule.__projectRoutesInternals;
      const execSpy = vi.fn();

      setExecFileOverride(execSpy);
      try {
        await killProcessTree('invalid');
        await killProcessTree(-42);
        expect(execSpy).not.toHaveBeenCalled();
      } finally {
        resetExecFileOverride();
      }
    });

    test('killProcessTree uses taskkill on Windows and tolerates missing processes', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree } = projectRoutesModule;
      const {
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        const error = new Error('not found');
        error.stderr = Buffer.from('not found');
        callback(error);
      });

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await killProcessTree(5050);
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]).toEqual({ file: 'taskkill', args: ['/PID', '5050', '/T', '/F'] });
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
      }
    });

    test('killProcessTree ignores Windows errors that mention no running instance', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree } = projectRoutesModule;
      const {
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      setExecFileOverride((file, args, callback) => {
        expect(file).toBe('taskkill');
        const error = new Error('No running instance');
        error.stderr = Buffer.from('NO RUNNING INSTANCE(S)');
        callback(error);
      });

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await expect(killProcessTree(6060)).resolves.toBeUndefined();
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
      }
    });

    test('killProcessTree resolves successfully when taskkill reports no error', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree } = projectRoutesModule;
      const {
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const execCalls = [];
      setExecFileOverride((file, args, callback) => {
        execCalls.push({ file, args });
        callback(null);
      });

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      try {
        await killProcessTree(7070);
        expect(execCalls).toEqual([{ file: 'taskkill', args: ['/PID', '7070', '/T', '/F'] }]);
      } finally {
        platformSpy.mockRestore();
        resetExecFileOverride();
      }
    });

    test('getProjectPortHints prioritizes stored project ports when available', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { getProjectPortHints } = projectRoutesModule.__projectRoutesInternals;

      const hints = getProjectPortHints({
        frontend_port: 6101,
        backendPort: 7101,
        frontend_framework: 'react',
        backend_framework: 'express'
      });

      expect(hints).toEqual({ frontend: 6101, backend: 7101 });
    });

    test('getProjectPortHints falls back to framework and base defaults', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { getProjectPortHints } = projectRoutesModule.__projectRoutesInternals;

      const frameworkHints = getProjectPortHints({
        frontend_framework: 'vue',
        backend_framework: 'fastapi'
      });

      expect(frameworkHints).toEqual({ frontend: 5173, backend: 5000 });

      const baseHints = getProjectPortHints({ name: 'unknown-mono' });
      expect(baseHints).toEqual({ frontend: 5173, backend: 3000 });
    });

    test('hasLiveProcess returns false when entry is missing', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { hasLiveProcess } = projectRoutesModule.__projectRoutesInternals;

      expect(hasLiveProcess(null)).toBe(false);
    });

    test('applyExtraProtectedPids registers configured values', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { applyExtraProtectedPids, getProtectedPidSet } = projectRoutesModule.__projectRoutesInternals;

      const protectedSet = getProtectedPidSet();
      const samplePid = 42424;
      protectedSet.delete(samplePid);

      applyExtraProtectedPids(String(samplePid));
      expect(protectedSet.has(samplePid)).toBe(true);
      protectedSet.delete(samplePid);
    });

    test('ensureDefaultHostPort seeds fallback value when needed', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { ensureDefaultHostPort, getHostReservedPorts } = projectRoutesModule.__projectRoutesInternals;

      const portsSet = getHostReservedPorts();
      const original = [...portsSet];
      portsSet.clear();

      try {
        ensureDefaultHostPort();
        expect(portsSet.has(5173)).toBe(true);
      } finally {
        portsSet.clear();
        for (const port of original) {
          portsSet.add(port);
        }
      }
    });

    test('deriveProjectPorts infers defaults when stored values are missing', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { deriveProjectPorts } = projectRoutesModule.__projectRoutesInternals;

      const ports = deriveProjectPorts({
        frontend_framework: 'vue',
        backend_framework: 'fastapi'
      });

      expect(ports).toContain(5173);
      expect(ports).toContain(5000);
    });

    test('deriveProjectPorts preserves stored backend ports without adding fallback duplicates', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { deriveProjectPorts } = projectRoutesModule.__projectRoutesInternals;

      const ports = deriveProjectPorts({
        frontend_port: 4100,
        backend_port: 9200,
        backend_framework: 'fastapi'
      }).sort();

      expect(ports).toEqual([4100, 9200]);
    });

    test('deriveProjectPorts falls back to base defaults when normalization rejects every port', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { deriveProjectPorts } = projectRoutesModule.__projectRoutesInternals;
      const intSpy = vi.spyOn(Number, 'isInteger').mockReturnValue(false);

      try {
        const ports = deriveProjectPorts({ name: 'broken-project' });
        expect(ports).toEqual([]);
      } finally {
        intSpy.mockRestore();
      }
    });

    test('buildFileTree still puts folders ahead of files when filesystem order is inverted', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        buildFileTree,
        setFsModuleOverride,
        resetFsModuleOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const rootPath = path.join(process.cwd(), 'virtual-tree');
      const makeEntry = (name, type) => ({
        name,
        isDirectory: () => type === 'dir',
        isFile: () => type === 'file'
      });

      const entriesByPath = new Map([
        [rootPath, [
          makeEntry('b.js', 'file'),
          makeEntry('src', 'dir'),
          makeEntry('a.js', 'file')
        ]],
        [path.join(rootPath, 'src'), []]
      ]);

      const fakeFs = {
        readdir: vi.fn(async (dirPath) => entriesByPath.get(dirPath) || [])
      };

      setFsModuleOverride(fakeFs);
      try {
        const tree = await buildFileTree(rootPath);
        expect(tree.map((entry) => entry.name)).toEqual(['src', 'a.js', 'b.js']);
      } finally {
        resetFsModuleOverride();
      }
    });

    test('hasLiveProcess treats test-environment stubs correctly', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { hasLiveProcess } = projectRoutesModule.__projectRoutesInternals;

      expect(hasLiveProcess({ port: 6500 })).toBe(true);
      expect(hasLiveProcess({ port: 6500, isStub: true })).toBe(false);
      expect(hasLiveProcess({})).toBe(false);
    });

    test('buildLogEntries returns an empty array when logs are unavailable', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildLogEntries } = projectRoutesModule.__projectRoutesInternals;

      expect(buildLogEntries(null, null)).toEqual([]);
    });

    test('buildLogEntries retains entries with invalid timestamps when applying since filters', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { buildLogEntries } = projectRoutesModule.__projectRoutesInternals;

      const since = Date.parse('2024-02-01T00:00:00.000Z');
      const entries = buildLogEntries(
        {
          logs: [
            { timestamp: 'not-a-date', output: 'fallback' },
            { timestamp: '2024-01-15T12:00:00.000Z', output: 'filtered' }
          ]
        },
        since
      );

      expect(entries).toEqual([{ timestamp: 'not-a-date', output: 'fallback' }]);
    });

    test('exposes exec implementation getters for overrides', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setExecCommandOverride,
        resetExecCommandOverride,
        getExecCommandImpl,
        setExecFileOverride,
        resetExecFileOverride,
        getExecFileImpl
      } = projectRoutesModule.__projectRoutesInternals;

      const execCommandOverride = vi.fn();
      const execFileOverride = vi.fn();

      setExecCommandOverride(execCommandOverride);
      setExecFileOverride(execFileOverride);

      try {
        expect(getExecCommandImpl()).toBe(execCommandOverride);
        expect(getExecFileImpl()).toBe(execFileOverride);
      } finally {
        resetExecCommandOverride();
        resetExecFileOverride();
      }

      expect(getExecCommandImpl()).not.toBe(execCommandOverride);
      expect(getExecFileImpl()).not.toBe(execFileOverride);
    });

    test('setExecCommandOverride falls back to default when override is invalid', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setExecCommandOverride,
        resetExecCommandOverride,
        getExecCommandImpl
      } = projectRoutesModule.__projectRoutesInternals;

      resetExecCommandOverride();
      const defaultImpl = getExecCommandImpl();
      setExecCommandOverride(null);
      expect(getExecCommandImpl()).toBe(defaultImpl);

      const custom = vi.fn();
      setExecCommandOverride(custom);
      expect(getExecCommandImpl()).toBe(custom);
      resetExecCommandOverride();
    });

    test('setExecFileOverride falls back to default when override is invalid', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        setExecFileOverride,
        resetExecFileOverride,
        getExecFileImpl
      } = projectRoutesModule.__projectRoutesInternals;

      resetExecFileOverride();
      const defaultImpl = getExecFileImpl();
      setExecFileOverride(undefined);
      expect(getExecFileImpl()).toBe(defaultImpl);

      const custom = vi.fn();
      setExecFileOverride(custom);
      expect(getExecFileImpl()).toBe(custom);
      resetExecFileOverride();
    });

    test('findPidsByPortWindows resolves gracefully when exec returns no output', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortWindows,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;
      resetExecCommandOverride();

      const childProcess = await import('child_process');
      const execSpy = vi.spyOn(childProcess, 'exec').mockImplementation((command, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        cb(new Error('netstat unavailable'));
        return { kill: () => {} };
      });

      try {
        const result = await findPidsByPortWindows(4321);
        expect(result).toEqual([]);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('findPidsByPortWindows parses stdout when exec succeeds', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortWindows,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;
      resetExecCommandOverride();

      const childProcess = await import('child_process');
      const execSpy = vi.spyOn(childProcess, 'exec').mockImplementation((command, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        cb(null, 'TCP    0.0.0.0:4321     0.0.0.0:0     LISTENING     4242\r\n');
        return { kill: () => {} };
      });

      try {
        const result = await findPidsByPortWindows(4321);
        expect(result).toEqual([4242]);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('findPidsByPortWindows collects only rows matching the requested port', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortWindows,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const netstatOutput = [
        'TCP    127.0.0.1:5000   0.0.0.0:0      LISTENING       1111',
        'TCP    127.0.0.1:6000   0.0.0.0:0      LISTENING       2222'
      ].join('\n');

      setExecCommandOverride(async () => netstatOutput);

      try {
        const pids = await findPidsByPortWindows(5000);
        expect(pids).toEqual([1111]);
      } finally {
        resetExecCommandOverride();
      }
    });

    test('findPidsByPortWindows ignores rows that lack numeric pid tokens', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortWindows,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      setExecCommandOverride(async () => 'TCP    127.0.0.1:7000   0.0.0.0:0      LISTENING       abcd');

      try {
        const pids = await findPidsByPortWindows(7000);
        expect(pids).toEqual([]);
      } finally {
        resetExecCommandOverride();
      }
    });

    test('parsePidList filters invalid tokens', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { parsePidList } = projectRoutesModule.__projectRoutesInternals;

      expect(parsePidList('123 four 0 555 -10 42')).toEqual([123, 555, 42]);
    });

    test('findPidsByPortUnix falls back to fuser output when lsof is empty', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortUnix,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const executed = [];
      setExecCommandOverride(async (command) => {
        executed.push(command);
        if (command.startsWith('lsof')) {
          return '';
        }
        if (command.startsWith('fuser')) {
          return '101 202';
        }
        return '';
      });

      try {
        const pids = await findPidsByPortUnix(8081);
        expect(pids).toEqual([101, 202]);
        expect(executed).toEqual([
          'lsof -ti tcp:8081',
          'fuser -n tcp 8081'
        ]);
      } finally {
        resetExecCommandOverride();
      }
    });

    test('findPidsByPortUnix returns an empty array when no command reports matches', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPortUnix,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const executed = [];
      setExecCommandOverride(async (command) => {
        executed.push(command);
        return '';
      });

      try {
        const pids = await findPidsByPortUnix(9090);
        expect(pids).toEqual([]);
        expect(executed).toEqual([
          'lsof -ti tcp:9090',
          'fuser -n tcp 9090'
        ]);
      } finally {
        resetExecCommandOverride();
      }
    });

    test('findPidsByPort returns empty array for non-integer ports', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findPidsByPort } = projectRoutesModule.__projectRoutesInternals;

      expect(await findPidsByPort(undefined)).toEqual([]);
      expect(await findPidsByPort(3.14)).toEqual([]);
    });

    test('platform override helpers ignore blank/non-string values', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        getPlatformImpl,
        setPlatformOverride,
        resetPlatformOverride
      } = projectRoutesModule.__projectRoutesInternals;

      try {
        setPlatformOverride('linux');
        expect(getPlatformImpl()).toBe('linux');

        setPlatformOverride('   ');
        expect(getPlatformImpl()).toBe(process.platform);

        setPlatformOverride(123);
        expect(getPlatformImpl()).toBe(process.platform);
      } finally {
        resetPlatformOverride();
      }
    });

    test('findPidsByPort delegates to the Unix helper when not on Windows', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPort,
        setPlatformOverride,
        resetPlatformOverride,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const commands = [];
      setPlatformOverride('linux');
      setExecCommandOverride(async (command) => {
        commands.push(command);
        if (command.startsWith('lsof')) {
          return '111 222';
        }
        return '';
      });

      try {
        const pids = await findPidsByPort(6060);
        expect(pids).toEqual([111, 222]);
        expect(commands).toEqual(['lsof -ti tcp:6060']);
      } finally {
        resetPlatformOverride();
        resetExecCommandOverride();
      }
    });

    test('findPidsByPort parses Windows netstat output and skips malformed rows', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        findPidsByPort,
        setExecCommandOverride,
        resetExecCommandOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const netstatOutput = [
        'incomplete line',
        '  TCP    0.0.0.0:8080   0.0.0.0:0      LISTENING       4321',
        '  UDP    0.0.0.0:8080   *:*            9876'
      ].join('\n');

      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      setExecCommandOverride(async (command) => {
        expect(command).toContain('findstr :8080');
        return netstatOutput;
      });

      try {
        const pids = await findPidsByPort(8080);
        expect(pids).toEqual([4321, 9876]);
      } finally {
        platformSpy.mockRestore();
        resetExecCommandOverride();
      }
    });

    test('killProcessesOnPort skips protected pids', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessesOnPort } = projectRoutesModule.__projectRoutesInternals;

      const terminatePid = vi.fn();
      await killProcessesOnPort(7777, {
        listPids: vi.fn().mockResolvedValue([process.pid]),
        terminatePid
      });

      expect(terminatePid).not.toHaveBeenCalled();
    });

    test('ensurePortsFreed skips reserved host ports and deduplicates inputs', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { ensurePortsFreed } = projectRoutesModule.__projectRoutesInternals;

      const killFn = vi.fn().mockResolvedValue();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await ensurePortsFreed([5173, 5173, 6500], { killFn });
      } finally {
        warnSpy.mockRestore();
      }

      expect(killFn).toHaveBeenCalledTimes(1);
      expect(killFn).toHaveBeenCalledWith(6500);
    });

    test('killProcessTree ignores missing Windows tasks', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const {
        killProcessTree,
        setPlatformOverride,
        resetPlatformOverride,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      setPlatformOverride('win32');
      const execFileMock = vi.fn((cmd, args, callback) => {
        expect(cmd).toBe('taskkill');
        const error = new Error('not found');
        error.stderr = 'No running instance matches';
        callback(error);
      });
      setExecFileOverride(execFileMock);

      try {
        await killProcessTree('4321');
        expect(execFileMock).toHaveBeenCalled();
      } finally {
        resetPlatformOverride();
        resetExecFileOverride();
      }
    });

    test('killProcessTree sends graceful then forced signals on Unix-like platforms', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree, setPlatformOverride, resetPlatformOverride } = projectRoutesModule.__projectRoutesInternals;

      setPlatformOverride('darwin');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

      vi.useFakeTimers();
      try {
        const targetPid = process.pid + 2000;
        const promise = killProcessTree(targetPid, { forceDelay: 5 });
        await vi.advanceTimersByTimeAsync(5);
        await promise;
        expect(killSpy).toHaveBeenNthCalledWith(1, targetPid, 'SIGTERM');
        expect(killSpy).toHaveBeenNthCalledWith(2, targetPid, 'SIGKILL');
      } finally {
        vi.useRealTimers();
        killSpy.mockRestore();
        resetPlatformOverride();
      }
    });

    test('killProcessTree treats ESRCH errors as already terminated', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree, setPlatformOverride, resetPlatformOverride } = projectRoutesModule.__projectRoutesInternals;

      setPlatformOverride('linux');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('gone');
        error.code = 'ESRCH';
        throw error;
      });

      try {
        await killProcessTree(process.pid + 3100);
        expect(killSpy).toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
        warnSpy.mockRestore();
        resetPlatformOverride();
      }
    });

    test('killProcessTree logs unexpected signal failures', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { killProcessTree, setPlatformOverride, resetPlatformOverride } = projectRoutesModule.__projectRoutesInternals;

      setPlatformOverride('linux');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      });

      vi.useFakeTimers();
      try {
        const targetPid = process.pid + 3200;
        const promise = killProcessTree(targetPid, { forceDelay: 5 });
        await vi.advanceTimersByTimeAsync(5);
        await promise;
        expect(killSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        killSpy.mockRestore();
        warnSpy.mockRestore();
        resetPlatformOverride();
      }
    });
  });

  describe('findProjectByIdentifier helper', () => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    test('returns null when identifier is missing or blank', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;

      expect(await findProjectByIdentifier(undefined)).toBeNull();
      expect(await findProjectByIdentifier('   ')).toBeNull();
    });

    test('prefers numeric identifier lookups before falling back to names', async () => {
      const { project } = await createPersistedProject({ name: `identifier-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;
      const databaseModule = await import('../database.js');
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName');

      try {
        const located = await findProjectByIdentifier(`${project.id}`);
        expect(located?.id).toBe(project.id);
        expect(getProjectByNameSpy).not.toHaveBeenCalled();
      } finally {
        getProjectByNameSpy.mockRestore();
      }
    });

    test('trims numeric identifiers before performing database lookups', async () => {
      const { project } = await createPersistedProject({ name: `identifier-trim-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;

      const located = await findProjectByIdentifier(`  ${project.id}  `);
      expect(located?.id).toBe(project.id);
    });

    test('finds a project by case-insensitive name', async () => {
      const projectName = 'Identifier Lookup';
      const { project } = await createPersistedProject({ name: projectName });
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;

      const located = await findProjectByIdentifier(projectName.toUpperCase());
      expect(located?.id).toBe(project.id);
    });

    test('falls back to slug matching when no direct name hit is found', async () => {
      const projectName = 'Slug Friendly Project';
      const { project } = await createPersistedProject({ name: projectName });
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;

      const located = await findProjectByIdentifier('slug-friendly-project');
      expect(located?.id).toBe(project.id);
    });

    test('returns null when no slug can be derived for lookup', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;

      expect(await findProjectByIdentifier('!!!')).toBeNull();
    });

    test('loads all projects for slug fallback when direct lookups miss', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;
      const databaseModule = await import('../database.js');

      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValue(null);
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName').mockResolvedValue(null);
      const getAllProjectsSpy = vi
        .spyOn(databaseModule, 'getAllProjects')
        .mockResolvedValue([{ id: 77, name: 'Slug Friendly Project' }]);

      try {
        const located = await findProjectByIdentifier('slug-friendly-project');
        expect(located?.id).toBe(77);
        expect(getAllProjectsSpy).toHaveBeenCalledTimes(1);
      } finally {
        getProjectSpy.mockRestore();
        getProjectByNameSpy.mockRestore();
        getAllProjectsSpy.mockRestore();
      }
    });

    test('returns null when slug sanitization yields an empty token', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;
      const projectPathsModule = await import('../utils/projectPaths.js');
      const slugSpy = vi.spyOn(projectPathsModule, 'sanitizeProjectName').mockReturnValue('');

      try {
        expect(await findProjectByIdentifier('@@@')).toBeNull();
      } finally {
        slugSpy.mockRestore();
      }
    });

    test('findProjectByIdentifier returns numeric matches before performing name lookups', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;
      const databaseModule = await import('../database.js');

      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValue({ id: 321, name: 'Direct' });
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName').mockResolvedValue(null);

      try {
        const project = await findProjectByIdentifier('321');
        expect(project?.id).toBe(321);
        expect(getProjectSpy).toHaveBeenCalledWith(321);
        expect(getProjectByNameSpy).not.toHaveBeenCalled();
      } finally {
        getProjectSpy.mockRestore();
        getProjectByNameSpy.mockRestore();
      }
    });

    test('findProjectByIdentifier falls back to name lookup when numeric lookup fails', async () => {
      const projectRoutesModule = await import('../routes/projects.js');
      const { findProjectByIdentifier } = projectRoutesModule.__projectRoutesInternals;
      const databaseModule = await import('../database.js');

      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValue(null);
      const getProjectByNameSpy = vi.spyOn(databaseModule, 'getProjectByName').mockResolvedValue({ id: 654, name: 'Fallback' });

      try {
        const project = await findProjectByIdentifier('654');
        expect(project?.name).toBe('Fallback');
        expect(getProjectSpy).toHaveBeenCalledWith(654);
        expect(getProjectByNameSpy).toHaveBeenCalledWith('654');
      } finally {
        getProjectSpy.mockRestore();
        getProjectByNameSpy.mockRestore();
      }
    });
  });

  describe('PUT /api/projects/:id - Update Project', () => {
    test('updates project details successfully', async () => {
      const { project } = await createPersistedProject({ name: `update-success-${Date.now()}` });
      const newName = `${project.name}-renamed`;

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({
          name: newName,
          description: 'Updated description',
          language: 'typescript',
          framework: 'nextjs',
          path: project.path
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.project.name).toBe(newName);
      expect(response.body.project.description).toBe('Updated description');

      const stored = await getProject(project.id);
      expect(stored.name).toBe(newName);
      expect(stored.description).toBe('Updated description');
    });

    test('rejects project path updates containing unsafe characters', async () => {
      const { project } = await createPersistedProject({ name: `update-path-reject-${Date.now()}` });
      const unsafePath = `${project.path}"\n`;

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({
          name: project.name,
          description: 'attempt path swap',
          path: unsafePath
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid project path/i);

      const stored = await getProject(project.id);
      expect(stored.path).toBe(project.path);
    });

    test('rejects non-string project path updates', async () => {
      const { project } = await createPersistedProject({ name: `update-path-type-${Date.now()}` });

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({
          name: project.name,
          description: 'attempt path swap',
          path: { bad: true }
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid project path/i);

      const stored = await getProject(project.id);
      expect(stored.path).toBe(project.path);
    });

    test('trims incoming values and applies defaults when updating', async () => {
      const { project } = await createPersistedProject({ name: `update-trim-${Date.now()}` });

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({
          name: `  ${project.name}-tidy  `,
          description: '  trimmed desc  ',
          language: undefined,
          framework: undefined,
          path: project.path
        });

      expect(response.status).toBe(200);
      expect(response.body.project.name).toBe(`${project.name}-tidy`);
      expect(response.body.project.description).toBe('trimmed desc');
      expect(response.body.project.language).toBe('javascript');
      expect(response.body.project.framework).toBe('react');
    });

    test('requires a project name when updating', async () => {
      const response = await request(app)
        .put(`/api/projects/${Date.now()}`)
        .send({ description: 'nameless update' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project name is required/i);
    });

    test('returns 404 when the project cannot be updated', async () => {
      const databaseModule = await import('../database.js');
      const updateSpy = vi.spyOn(databaseModule, 'updateProject').mockResolvedValueOnce(null);

      const response = await request(app)
        .put(`/api/projects/update-missing-${Date.now()}`)
        .send({
          name: 'missing-project',
          description: 'ghost',
          language: 'javascript',
          framework: 'react'
        });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);

      updateSpy.mockRestore();
    });

    test('returns 400 when updating to a duplicate project name', async () => {
      const { project } = await createPersistedProject({ name: `update-duplicate-${Date.now()}` });
      const databaseModule = await import('../database.js');
      const duplicateError = new Error('UNIQUE constraint failed: projects.name');
      const updateSpy = vi.spyOn(databaseModule, 'updateProject').mockRejectedValueOnce(duplicateError);

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({
          name: 'existing-project',
          description: 'duplicate attempt'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/name already exists/i);

      updateSpy.mockRestore();
    });

    test('returns 500 when updating a project fails unexpectedly', async () => {
      const { project } = await createPersistedProject({ name: `update-error-${Date.now()}` });
      const databaseModule = await import('../database.js');
      const updateSpy = vi.spyOn(databaseModule, 'updateProject').mockRejectedValueOnce(new Error('db offline'));

      const response = await request(app)
        .put(`/api/projects/${project.id}`)
        .send({ name: `${project.name}-error`, description: 'should fail' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to update project/i);

      updateSpy.mockRestore();
    });
  });

  describe('Project file editing API', () => {
    test('saves file content via PUT endpoint', async () => {
      const { projectId, relativeFilePath, absoluteFilePath } = await createProjectWithRealFile('save');

      const newContent = 'export default function App() { return <div>New</div>; }\n';
      const response = await request(app)
        .put(`/api/projects/${projectId}/files/${relativeFilePath}`)
        .send({ content: newContent });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({ success: true, path: relativeFilePath }));

      const storedContent = await fs.readFile(absoluteFilePath, 'utf-8');
      expect(storedContent).toBe(newContent);
    });

    test('returns 404 when saving files for a missing project', async () => {
      const response = await request(app)
        .put(`/api/projects/save-missing-${Date.now()}/files/src/App.jsx`)
        .send({ content: 'missing-project' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('rejects save requests without string content', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('missing-content');

      const response = await request(app)
        .put(`/api/projects/${projectId}/files/${relativeFilePath}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/content/i);
    });

    test('rejects save requests when the body payload is missing entirely', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('missing-body');

      const response = await request(app)
        .put(`/api/projects/${projectId}/files/${relativeFilePath}`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/content/i);
    });

    test('returns 400 when the project path is missing while saving files', async () => {
      const project = await createProject({
        name: `missing-path-save-${Date.now()}`,
        description: 'Project without filesystem path',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .put(`/api/projects/${project.id}/files/src/App.jsx`)
        .send({ content: 'console.log("noop");' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project path not found/i);
    });

    test('rejects invalid file paths containing traversal sequences when saving', async () => {
      const { projectId } = await createProjectWithRealFile('save-traversal');

      const response = await request(app)
        .put(`/api/projects/${projectId}/files/..%2Foutside.txt`)
        .send({ content: 'malicious' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid file path/i);
    });

    test('prevents writes when the resolved path escapes the project root', async () => {
      const { projectId, projectPath } = await createProjectWithRealFile('save-escape');
      const targetPath = path.join(projectPath, 'src', 'App.jsx');
      const realResolve = path.resolve;
      const resolveSpy = vi.spyOn(path, 'resolve').mockImplementation((...args) => {
        if (args.length === 1 && args[0] === targetPath) {
          return path.join(projectPath, '..', 'outside', 'App.jsx');
        }
        return realResolve(...args);
      });

      try {
        const response = await request(app)
          .put(`/api/projects/${projectId}/files/src/App.jsx`)
          .send({ content: 'escape' });

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/invalid file path/i);
      } finally {
        resolveSpy.mockRestore();
      }
    });

    test('rejects save requests targeting directories', async () => {
      const { projectId } = await createProjectWithRealFile('save-directory');

      const response = await request(app)
        .put(`/api/projects/${projectId}/files/src`)
        .send({ content: 'noop' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/not a file/i);
    });

    test('returns 404 when saving a file that does not exist yet', async () => {
      const projectName = `save-missing-${Date.now()}`;
      const projectPath = path.join(testProjectsDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      const project = await createProject({
        name: projectName,
        description: 'Missing file save attempt',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app)
        .put(`/api/projects/${project.id}/files/src/NewFile.jsx`)
        .send({ content: 'export default null;' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/file not found/i);
    });

    test('returns 500 when saving fails unexpectedly', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('save-error');
      const joinSpy = vi.spyOn(path, 'join').mockImplementationOnce(() => {
        throw new Error('join failed');
      });

      const response = await request(app)
        .put(`/api/projects/${projectId}/files/${relativeFilePath}`)
        .send({ content: 'will-fail' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to save file/i);

      joinSpy.mockRestore();
    });

    test('rethrows unexpected filesystem errors during stat checks', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('save-stat-error');
      const projectRoutesModule = await import('../routes/projects.js');
      const actualFs = await import('fs/promises');
      const statMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error('stat denied'), { code: 'EPERM' }));
      const fsMock = { ...actualFs, stat: statMock };
      projectRoutesModule.__projectRoutesInternals.setFsModuleOverride(fsMock);

      try {
        const response = await request(app)
          .put(`/api/projects/${projectId}/files/${relativeFilePath}`)
          .send({ content: 'stat-fail' });

        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/failed to save file/i);
      } finally {
        projectRoutesModule.__projectRoutesInternals.resetFsModuleOverride();
      }
    });
  });

  describe('Project file browsing API', () => {
    test('fails when project path is missing', async () => {
      const project = await createProject({
        name: `missing-path-${Date.now()}`,
        description: 'Missing path project',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app).get(`/api/projects/${project.id}/files`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project path not found/i);
    });

    test('returns 404 when requesting file listings for a missing project', async () => {
      const response = await request(app).get(`/api/projects/listing-missing-${Date.now()}/files`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns 404 when requesting file content for a missing project', async () => {
      const response = await request(app)
        .get(`/api/projects/read-missing-${Date.now()}/files/src/App.jsx`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns 400 when the project path is missing while reading file content', async () => {
      const project = await createProject({
        name: `read-missing-path-${Date.now()}`,
        description: 'No path for reading',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .get(`/api/projects/${project.id}/files/src/App.jsx`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project path not found/i);
    });

    test('rejects listing when the filesystem directory is missing', async () => {
      const ghostPath = path.join(testProjectsDir, `ghost-${Date.now()}`);
      const project = await createProject({
        name: `ghost-project-${Date.now()}`,
        description: 'Ghost project',
        language: 'javascript',
        framework: 'react',
        path: ghostPath
      });

      const response = await request(app).get(`/api/projects/${project.id}/files`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('does not exist');
    });

    test('returns 500 when building the file tree fails unexpectedly', async () => {
      const projectName = `file-tree-fail-${Date.now()}`;
      const projectPath = path.join(testProjectsDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      const project = await createProject({
        name: projectName,
        description: 'Tree failure',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const projectRoutesModule = await import('../routes/projects.js');
      const actualFs = await import('fs/promises');
      const fsMock = {
        ...actualFs,
        access: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockRejectedValue(new Error('tree blowup'))
      };
      projectRoutesModule.__projectRoutesInternals.setFsModuleOverride(fsMock);

      try {
        const response = await request(app).get(`/api/projects/${project.id}/files`);

        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/failed to fetch project files/i);
      } finally {
        projectRoutesModule.__projectRoutesInternals.resetFsModuleOverride();
      }
    });

    test('guards against path traversal when reading files', async () => {
      const { projectId } = await createProjectWithRealFile('traversal');

      const response = await request(app)
        .get(`/api/projects/${projectId}/files/..%2Fsecret.txt`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid file path/i);
    });

    test('prevents reads when the resolved path escapes the project root', async () => {
      const { projectId, projectPath } = await createProjectWithRealFile('read-escape');
      const targetPath = path.join(projectPath, 'src', 'App.jsx');
      const realResolve = path.resolve;
      const resolveSpy = vi.spyOn(path, 'resolve').mockImplementation((...args) => {
        if (args.length === 1 && args[0] === targetPath) {
          return path.join(projectPath, '..', 'outside', 'App.jsx');
        }
        return realResolve(...args);
      });

      try {
        const response = await request(app)
          .get(`/api/projects/${projectId}/files/src/App.jsx`);

        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/invalid file path/i);
      } finally {
        resolveSpy.mockRestore();
      }
    });

    test('rejects directory targets when reading file content', async () => {
      const { projectId } = await createProjectWithRealFile('directory');

      const response = await request(app)
        .get(`/api/projects/${projectId}/files/src`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/not a file/i);
    });

    test('returns 404 for missing files', async () => {
      const { projectId } = await createProjectWithRealFile('missing-file');

      const response = await request(app)
        .get(`/api/projects/${projectId}/files/src/MissingComponent.jsx`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/file not found/i);
    });

    test('reads file content when a valid file is requested', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('read-file');

      const response = await request(app)
        .get(`/api/projects/${projectId}/files/${relativeFilePath}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.path).toBe(relativeFilePath);
      expect(response.body.content).toContain('<div>Old</div>');
    });

    test('returns 500 when reading file content fails unexpectedly', async () => {
      const { projectId, relativeFilePath } = await createProjectWithRealFile('read-error');
      const projectRoutesModule = await import('../routes/projects.js');
      const actualFs = await import('fs/promises');
      const fsMock = {
        ...actualFs,
        stat: vi.fn().mockResolvedValue({ isFile: () => true }),
        readFile: vi.fn().mockRejectedValue(new Error('read failed'))
      };
      projectRoutesModule.__projectRoutesInternals.setFsModuleOverride(fsMock);

      try {
        const response = await request(app)
          .get(`/api/projects/${projectId}/files/${relativeFilePath}`);

        expect(response.status).toBe(500);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatch(/failed to read file/i);
      } finally {
        projectRoutesModule.__projectRoutesInternals.resetFsModuleOverride();
      }
    });

    test('omits hidden and ignored entries from the file tree', async () => {
      const projectName = `file-tree-${Date.now()}`;
      const projectPath = path.join(testProjectsDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(path.join(projectPath, '.git'), { recursive: true });
      await fs.mkdir(path.join(projectPath, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'src', 'index.js'), 'console.log("hi");');
      await fs.writeFile(path.join(projectPath, '.env.local'), 'SECRET=1');
      await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules');
      await fs.writeFile(path.join(projectPath, '.hidden-file'), 'nope');

      const project = await createProject({
        name: projectName,
        description: 'tree project',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app).get(`/api/projects/${project.id}/files`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      const names = response.body.files.map((entry) => entry.name);
      expect(names).toContain('src');
      expect(names).not.toContain('.git');
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.env.local');
      expect(names).not.toContain('.hidden-file');
    });

    test('omits operating system junk files from the file tree', async () => {
      const projectName = `file-tree-osjunk-${Date.now()}`;
      const projectPath = path.join(testProjectsDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(path.join(projectPath, 'Thumbs.db'), 'binary');
      await fs.writeFile(path.join(projectPath, 'index.js'), 'console.log("ok");');

      const project = await createProject({
        name: projectName,
        description: 'OS junk test',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app).get(`/api/projects/${project.id}/files`);

      expect(response.status).toBe(200);
      const names = response.body.files.map((entry) => entry.name);
      expect(names).toContain('index.js');
      expect(names).not.toContain('Thumbs.db');
    });

    test('sorts file tree entries alphabetically within their type groups', async () => {
      const projectName = `file-tree-sorting-${Date.now()}`;
      const projectPath = path.join(testProjectsDir, projectName);
      await fs.mkdir(projectPath, { recursive: true });
      await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
      await fs.mkdir(path.join(projectPath, 'docs'), { recursive: true });
      await fs.mkdir(path.join(projectPath, 'public'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'b.js'), 'console.log("b");');
      await fs.writeFile(path.join(projectPath, 'a.js'), 'console.log("a");');

      const project = await createProject({
        name: projectName,
        description: 'sorting project',
        language: 'javascript',
        framework: 'react',
        path: projectPath
      });

      const response = await request(app).get(`/api/projects/${project.id}/files`);

      expect(response.status).toBe(200);
      const names = response.body.files.map((entry) => entry.name);
      expect(names.slice(0, 3)).toEqual(['docs', 'public', 'src']);
      expect(names.slice(3)).toEqual(['a.js', 'b.js']);
    });
  });

  describe('GET /api/projects/:id/processes - Process snapshots', () => {
    test('returns 404 when requesting processes for a missing project', async () => {
      const response = await request(app).get('/api/projects/missing-processes/processes');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns sanitized running process snapshots with trimmed logs', async () => {
      const { project } = await createPersistedProject({ name: `process-snapshot-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      const logs = Array.from({ length: 45 }, (_, index) => ({
        timestamp: new Date(2024, 0, index + 1).toISOString(),
        output: `log-${index}`
      }));
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 6500, logs },
          backend: null
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${project.id}/start`);
      expect(startResponse.status).toBe(200);

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.processes.frontend.logs).toHaveLength(40);
      expect(response.body.processes.frontend.logs[0].output).toBe('log-5');
      expect(response.body.ports.active.frontend).toBe(6500);
      expect(response.body.lastKnownPorts.frontend).toBe(6500);
    });

    test('reports idle activity with derived port hints when no processes exist', async () => {
      const { project } = await createPersistedProject({ name: `process-idle-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { resetRunningProcessesStore } = projectRoutesModule.__projectRoutesInternals;
      resetRunningProcessesStore();

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes`);

      expect(response.status).toBe(200);
      expect(response.body.activity).toBe('idle');
      expect(response.body.running).toBe(false);
      expect(response.body.ports.active.frontend).toBe(5173);
      expect(response.body.ports.active.backend).toBe(3000);
      expect(response.body.lastKnownPorts.frontend).toBe(5173);
      expect(response.body.lastKnownPorts.backend).toBe(3000);
    });

    test('uses stored project ports as last-known values when snapshots are missing', async () => {
      const { project } = await createPersistedProject({
        name: `process-stored-${Date.now()}`,
        frontendPort: 6111,
        backendPort: 7444
      });
      const projectRoutesModule = await import('../routes/projects.js');
      const { resetRunningProcessesStore } = projectRoutesModule.__projectRoutesInternals;
      resetRunningProcessesStore();

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes`);

      expect(response.status).toBe(200);
      expect(response.body.lastKnownPorts.frontend).toBe(6111);
      expect(response.body.lastKnownPorts.backend).toBe(7444);
      expect(response.body.ports.active.frontend).toBe(6111);
      expect(response.body.ports.active.backend).toBe(7444);
    });

    test('returns 500 when fetching process snapshots fails unexpectedly', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockRejectedValueOnce(new Error('process lookup failed'));

      const response = await request(app)
        .get(`/api/projects/${Date.now()}/processes`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to load process status/i);

      getProjectSpy.mockRestore();
    });
  });

  describe('GET /api/projects/:id/status - Project Status', () => {
    test('returns project status with running processes', async () => {
      const { project } = await createPersistedProject({ name: `status-running-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 6300 },
          backend: { pid: process.pid + 1, port: 7300 }
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${project.id}/start`);
      expect(startResponse.status).toBe(200);

      const statusResponse = await request(app)
        .get(`/api/projects/${project.id}/status`);

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.success).toBe(true);
      expect(statusResponse.body.status.project.id).toBe(project.id);
      expect(statusResponse.body.status.running).toBe(true);
      expect(statusResponse.body.status.processes.frontend.port).toBe(6300);
      expect(statusResponse.body.status.processes.backend.port).toBe(7300);
    });

    test('reports idle status when no processes are tracked', async () => {
      const { project } = await createPersistedProject({ name: `status-idle-${Date.now()}` });

      const statusResponse = await request(app)
        .get(`/api/projects/${project.id}/status`);

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status.running).toBe(false);
      expect(statusResponse.body.status.processes).toBeNull();
    });

    test('handles project not found for status check', async () => {
      const response = await request(app)
        .get('/api/projects/999/status');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('not found');
    });

    test('returns 500 when project status lookup fails unexpectedly', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockRejectedValueOnce(new Error('status failed'));

      const response = await request(app)
        .get(`/api/projects/status-error-${Date.now()}/status`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to fetch project status/i);

      getProjectSpy.mockRestore();
    });
  });

  describe('GET /api/projects/:id/processes/logs', () => {
    test('returns 404 when requesting logs for a missing project', async () => {
      const response = await request(app)
        .get(`/api/projects/logs-missing-${Date.now()}/processes/logs`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('rejects invalid process type filters', async () => {
      const { project } = await createPersistedProject({ name: `logs-${Date.now()}` });

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes/logs?type=cli`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/type must be one of frontend, backend/i);
    });

    test('rejects malformed since parameters', async () => {
      const { project } = await createPersistedProject({ name: `logs-since-${Date.now()}` });

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes/logs?since=not-a-timestamp`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/since must be a valid timestamp/i);
    });

    test('filters logs using a valid since timestamp', async () => {
      const { project } = await createPersistedProject({ name: `logs-filter-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: {
            pid: process.pid,
            port: 7001,
            logs: [
              { timestamp: '2024-01-01T00:00:00Z', output: 'old log' },
              { timestamp: '2024-02-01T00:00:00Z', output: 'new log' }
            ]
          },
          backend: null
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${project.id}/start`);
      expect(startResponse.status).toBe(200);

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes/logs?type=frontend&since=2024-02-01T00:00:00Z`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.logs.frontend).toHaveLength(1);
      expect(response.body.logs.frontend[0].output).toBe('new log');
    });

    test('returns backend process logs when requested', async () => {
      const { project } = await createPersistedProject({ name: `logs-backend-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: null,
          backend: {
            pid: process.pid,
            port: 7100,
            logs: [
              { timestamp: '2024-03-01T00:00:00Z', output: 'backend-started' }
            ]
          }
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${project.id}/start`);
      expect(startResponse.status).toBe(200);

      const response = await request(app)
        .get(`/api/projects/${project.id}/processes/logs?type=backend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.logs.backend).toHaveLength(1);
      expect(response.body.logs.backend[0].output).toBe('backend-started');
      expect(response.body.logs.frontend).toBeUndefined();
    });

    test('returns 500 when fetching process logs fails unexpectedly', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockRejectedValueOnce(new Error('logs db offline'));

      const response = await request(app)
        .get(`/api/projects/logs-error-${Date.now()}/processes/logs`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to fetch process logs/i);

      getProjectSpy.mockRestore();
    });
  });

  describe('POST /api/projects/:id/start - Start Project', () => {
    test.skip('starts development servers for existing project', async () => {
      const projectName = 'start-project';
      
      // Create project first
      vi.mocked((await import('../services/projectScaffolding.js')).createProjectWithFiles).mockResolvedValue({
        success: true,
        project: {
          id: 6,
          name: projectName,
          description: 'Project for start testing',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, projectName),
          createdAt: new Date().toISOString()
        },
        processes: null // Initially not running
      });

      const createResponse = await request(app)
        .post('/api/projects')
        .send({
          name: projectName,
          description: 'Project for start testing',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      // Mock starting the project
      vi.mocked((await import('../services/projectScaffolding.js')).startProject).mockResolvedValue({
        success: true,
        processes: {
          frontend: { pid: 6234, port: 5173 },
          backend: { pid: 6235, port: 3000 }
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${createResponse.body.project.id}/start`);

      expect(startResponse.status).toBe(200);
      expect(startResponse.body.success).toBe(true);
      expect(startResponse.body.processes.frontend.port).toBe(5173);
      expect(startResponse.body.processes.backend.port).toBe(3000);
    });

    test('returns 404 when starting a missing project', async () => {
      const response = await request(app)
        .post(`/api/projects/start-missing-${Date.now()}/start`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns descriptive error when project path is missing', async () => {
      const project = await createProject({
        name: `start-missing-path-${Date.now()}`,
        description: 'Missing path',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project path not found/i);
    });

    test('returns cached processes when project is already running', async () => {
      const { project } = await createPersistedProject({ name: `start-running-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValue({
        success: true,
        processes: {
          frontend: { pid: 9100, port: 6010 },
          backend: { pid: 9101, port: 7010 }
        }
      });

      const firstStart = await request(app)
        .post(`/api/projects/${project.id}/start`);
      expect(firstStart.status).toBe(200);

      const secondStart = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(secondStart.status).toBe(200);
      expect(secondStart.body.success).toBe(true);
      expect(secondStart.body.message).toMatch(/already running/i);
      expect(secondStart.body.processes.frontend.port).toBe(6010);
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledTimes(1);
    });

    test('starts a project and allows it to be stopped', async () => {
      const { project } = await createPersistedProject({ name: `start-stop-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 6200 },
          backend: null
        }
      });

      const startResponse = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(startResponse.status).toBe(200);
      expect(startResponse.body.success).toBe(true);
      expect(startResponse.body.processes.frontend.port).toBe(6200);

      const stopResponse = await request(app)
        .post(`/api/projects/${project.id}/stop`);

      expect(stopResponse.status).toBe(200);
      expect(stopResponse.body.success).toBe(true);
      expect(stopResponse.body.message).toMatch(/stopped successfully/i);
    });

    test('forces port reassignment when global overrides are configured', async () => {
      const { project } = await createPersistedProject({ name: `start-overrides-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: false,
        processes: null
      });

      const databaseModule = await import('../database.js');
      const portSettingsSpy = vi.spyOn(databaseModule, 'getPortSettings').mockResolvedValueOnce({
        frontendPortBase: 6105,
        backendPortBase: 9105
      });
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(response.status).toBe(200);
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledWith(
        expect.stringContaining(project.name),
        expect.objectContaining({
          frontendPort: null,
          backendPort: null,
          frontendPortBase: 6105,
          backendPortBase: 9105
        })
      );
      expect(updatePortsSpy).not.toHaveBeenCalled();

      portSettingsSpy.mockRestore();
      updatePortsSpy.mockRestore();
    });

    test('reuses stored port hints when overrides are not provided', async () => {
      const { project } = await createPersistedProject({
        name: `start-hints-${Date.now()}`,
        frontendPort: 6111,
        backendPort: 7111
      });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: 8001, port: 6111 },
          backend: { pid: 8002, port: 7111 }
        }
      });

      const databaseModule = await import('../database.js');
      const portSettingsSpy = vi.spyOn(databaseModule, 'getPortSettings').mockResolvedValueOnce({});

      const response = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(response.status).toBe(200);
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledWith(
        expect.stringContaining(project.name),
        expect.objectContaining({
          frontendPort: 6111,
          backendPort: 7111
        })
      );

      portSettingsSpy.mockRestore();
    });

    test('handles errors thrown while starting a project', async () => {
      const { project } = await createPersistedProject({ name: `start-error-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockRejectedValueOnce(new Error('start failed'));

      const response = await request(app)
        .post(`/api/projects/${project.id}/start`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to start project/i);
    });
  });

  describe('POST /api/projects/:id/stop - Stop Project', () => {
    test.skip('stops development servers for running project', async () => {
      // Create a project first
      const createResponse = await request(app)
        .post('/api/projects')
        .send({
          name: 'stop-test-project',
          description: 'Project for stop testing',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        });

      expect(createResponse.status).toBe(201);

      // Now test stopping the project
      const response = await request(app)
        .post(`/api/projects/${createResponse.body.project.id}/stop`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('stopped successfully');
    });

    test('returns 404 when stopping a missing project', async () => {
      const missingId = `stop-missing-${Date.now()}`;

      const response = await request(app)
        .post(`/api/projects/${missingId}/stop`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('reports when the project has no running processes', async () => {
      const { project } = await createPersistedProject({ name: `stop-idle-${Date.now()}` });

      const response = await request(app)
        .post(`/api/projects/${project.id}/stop`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/not running/i);
    });

    test('reports when a valid stop target is not running', async () => {
      const { project } = await createPersistedProject({ name: `stop-idle-target-${Date.now()}` });

      const response = await request(app)
        .post(`/api/projects/${project.id}/stop?target=frontend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('frontend is not running');
    });

    test('stops only the requested target when running', async () => {
      const { project } = await createPersistedProject({ name: `stop-target-running-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const { storeRunningProcesses, resetRunningProcessesStore } = projectRoutesModule.__projectRoutesInternals;

      resetRunningProcessesStore();
      storeRunningProcesses(project.id, {
        frontend: { pid: 'not-a-real-pid', port: null },
        backend: { pid: 'also-not-real', port: null }
      }, 'running');

      const response = await request(app)
        .post(`/api/projects/${project.id}/stop?target=frontend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('frontend stopped successfully');
    });

    test('returns a 500 when terminating processes fails', async () => {
      const { project } = await createPersistedProject({ name: `stop-error-${Date.now()}` });
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockRejectedValueOnce(new Error('db unavailable'));

      const response = await request(app)
        .post(`/api/projects/${project.id}/stop`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to stop project/i);

      getProjectSpy.mockRestore();
    });

    test('returns 400 when stop target is invalid', async () => {
      const { project } = await createPersistedProject({ name: `stop-invalid-target-${Date.now()}` });

      const response = await request(app)
        .post(`/api/projects/${project.id}/stop?target=wat`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid stop target/i);
    });
  });

  describe('POST /api/projects/:id/restart - Restart Project', () => {
    test('returns 404 when project does not exist', async () => {
      const response = await request(app)
        .post(`/api/projects/restart-missing-${Date.now()}/restart`);

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('requires a valid project path', async () => {
      const project = await createProject({
        name: `restart-missing-path-${Date.now()}`,
        description: 'Restart with missing path',
        language: 'javascript',
        framework: 'react',
        path: null
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project path not found/i);
    });

    test('restarts a project and returns refreshed processes', async () => {
      const { project } = await createPersistedProject({ name: `restart-success-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 6400 },
          backend: { pid: process.pid + 1, port: 7400 }
        }
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/restarted successfully/i);
      expect(response.body.processes.frontend.port).toBe(6400);
      expect(response.body.processes.backend.port).toBe(7400);
      expect(scaffoldingService.startProject).toHaveBeenCalledWith(expect.stringContaining(project.name), expect.any(Object));
    });

    test('windows backend target restart recovers frontend when it is tree-killed (regression)', async () => {
      const { project } = await createPersistedProject({ name: `restart-win32-recovery-${Date.now()}` });

      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        setPlatformOverride,
        resetPlatformOverride,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      resetRunningProcessesStore();
      setPlatformOverride('win32');

      // Simulate frontend being live, then being dead after backend restart.
      const frontendPid = 45678;
      storeRunningProcesses(project.id, {
        frontend: { pid: frontendPid, port: 5100 },
        backend: { pid: 56789, port: 5500 }
      }, 'running');

      // Prevent taskkill from running for real.
      setExecFileOverride((file, args, cb) => cb(null, '', ''));

      let killZeroCallCount = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0 && pid === frontendPid) {
          killZeroCallCount += 1;
          if (killZeroCallCount >= 2) {
            const err = new Error('ESRCH');
            // @ts-expect-error vitest stub
            err.code = 'ESRCH';
            throw err;
          }
          return true;
        }
        return true;
      });

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject)
        .mockResolvedValueOnce({
          success: true,
          processes: { backend: { pid: 90001, port: 5501 } }
        })
        .mockResolvedValueOnce({
          success: true,
          processes: { frontend: { pid: 90002, port: 5101 } }
        });

      try {
        const response = await request(app)
          .post(`/api/projects/${project.id}/restart?target=backend`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.processes.frontend.pid).toBe(90002);
        expect(response.body.processes.backend.pid).toBe(90001);
        expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(scaffoldingService.startProject).mock.calls[0][1]).toEqual(expect.objectContaining({ target: 'backend' }));
        expect(vi.mocked(scaffoldingService.startProject).mock.calls[1][1]).toEqual(expect.objectContaining({ target: 'frontend' }));

        expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({
          backendPort: 5501,
          frontendPort: 5101
        }));
      } finally {
        killSpy.mockRestore();
        updatePortsSpy.mockRestore();
        resetExecFileOverride();
        resetPlatformOverride();
        resetRunningProcessesStore();
      }
    });

    test('windows backend target restart skips recovered frontend port update when recovered port is zero', async () => {
      const { project } = await createPersistedProject({ name: `restart-win32-recovery-port0-${Date.now()}` });

      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        setPlatformOverride,
        resetPlatformOverride,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      resetRunningProcessesStore();
      setPlatformOverride('win32');

      const frontendPid = 45679;
      storeRunningProcesses(project.id, {
        frontend: { pid: frontendPid, port: 5100 },
        backend: { pid: 56790, port: 5500 }
      }, 'running');

      setExecFileOverride((file, args, cb) => cb(null, '', ''));

      let killZeroCallCount = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0 && pid === frontendPid) {
          killZeroCallCount += 1;
          if (killZeroCallCount >= 2) {
            const err = new Error('ESRCH');
            // @ts-expect-error vitest stub
            err.code = 'ESRCH';
            throw err;
          }
          return true;
        }
        return true;
      });

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject)
        .mockResolvedValueOnce({
          success: true,
          processes: { backend: { pid: 91001, port: 5502 } }
        })
        .mockResolvedValueOnce({
          success: true,
          processes: { frontend: { pid: 91002, port: 0 } }
        });

      try {
        const response = await request(app)
          .post(`/api/projects/${project.id}/restart?target=backend`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({
          backendPort: 5502
        }));
        expect(updatePortsSpy).not.toHaveBeenCalledWith(project.id, expect.objectContaining({
          frontendPort: expect.any(Number)
        }));
      } finally {
        killSpy.mockRestore();
        updatePortsSpy.mockRestore();
        resetExecFileOverride();
        resetPlatformOverride();
        resetRunningProcessesStore();
      }
    });

    test('windows backend target restart skips frontend recovery when frontend remains live', async () => {
      const { project } = await createPersistedProject({ name: `restart-win32-no-recovery-${Date.now()}` });

      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        setPlatformOverride,
        resetPlatformOverride,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      resetRunningProcessesStore();
      setPlatformOverride('win32');

      const frontendPid = 45680;
      storeRunningProcesses(project.id, {
        frontend: { pid: frontendPid, port: 5100 },
        backend: { pid: 56791, port: 5500 }
      }, 'running');

      setExecFileOverride((file, args, cb) => cb(null, '', ''));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: { backend: { pid: 92001, port: 5503 } }
      });

      try {
        const response = await request(app)
          .post(`/api/projects/${project.id}/restart?target=backend`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(scaffoldingService.startProject).mock.calls[0][1]).toEqual(expect.objectContaining({ target: 'backend' }));

        expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({
          backendPort: 5503
        }));
      } finally {
        killSpy.mockRestore();
        updatePortsSpy.mockRestore();
        resetExecFileOverride();
        resetPlatformOverride();
        resetRunningProcessesStore();
      }
    });

    test('windows backend target restart does not apply frontend recovery when recovery fails', async () => {
      const { project } = await createPersistedProject({ name: `restart-win32-recovery-fail-${Date.now()}` });

      const projectRoutesModule = await import('../routes/projects.js');
      const {
        storeRunningProcesses,
        resetRunningProcessesStore,
        setPlatformOverride,
        resetPlatformOverride,
        setExecFileOverride,
        resetExecFileOverride
      } = projectRoutesModule.__projectRoutesInternals;

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      resetRunningProcessesStore();
      setPlatformOverride('win32');

      const frontendPid = 45681;
      storeRunningProcesses(project.id, {
        frontend: { pid: frontendPid, port: 0 },
        backend: { pid: 56792, port: 5500 }
      }, 'running');

      setExecFileOverride((file, args, cb) => cb(null, '', ''));

      let killZeroCallCount = 0;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0 && pid === frontendPid) {
          killZeroCallCount += 1;
          if (killZeroCallCount >= 2) {
            const err = new Error('ESRCH');
            // @ts-expect-error vitest stub
            err.code = 'ESRCH';
            throw err;
          }
          return true;
        }
        return true;
      });

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject)
        .mockResolvedValueOnce({
          success: true,
          processes: { backend: { pid: 93001, port: 5504 } }
        })
        .mockResolvedValueOnce({
          success: false
        });

      try {
        const response = await request(app)
          .post(`/api/projects/${project.id}/restart?target=backend`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.processes.frontend.pid).toBe(frontendPid);
        expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(scaffoldingService.startProject).mock.calls[0][1]).toEqual(expect.objectContaining({ target: 'backend' }));
        expect(vi.mocked(scaffoldingService.startProject).mock.calls[1][1]).toEqual(expect.objectContaining({ target: 'frontend' }));

        expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({
          backendPort: 5504
        }));
        expect(updatePortsSpy).not.toHaveBeenCalledWith(project.id, expect.objectContaining({
          frontendPort: expect.any(Number)
        }));
      } finally {
        killSpy.mockRestore();
        updatePortsSpy.mockRestore();
        resetExecFileOverride();
        resetPlatformOverride();
        resetRunningProcessesStore();
      }
    });

    test('surfaces restart errors when startProject fails', async () => {
      const { project } = await createPersistedProject({ name: `restart-error-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockRejectedValueOnce(new Error('restart failure'));

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to restart project/i);
    });

    test('restarts honor custom port bases even when startProject returns no processes', async () => {
      const { project } = await createPersistedProject({ name: `restart-overrides-${Date.now()}` });
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: false,
        processes: undefined
      });

      const databaseModule = await import('../database.js');
      const portSettingsSpy = vi.spyOn(databaseModule, 'getPortSettings').mockResolvedValueOnce({
        frontendPortBase: 6401,
        backendPortBase: 9401
      });
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`);

      expect(response.status).toBe(200);
      expect(response.body.processes).toBeNull();
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledWith(
        expect.stringContaining(project.name),
        expect.objectContaining({
          frontendPort: null,
          backendPort: null,
          frontendPortBase: 6401,
          backendPortBase: 9401
        })
      );
      expect(updatePortsSpy).not.toHaveBeenCalled();

      portSettingsSpy.mockRestore();
      updatePortsSpy.mockRestore();
    });

    test('restarts reuse stored port hints when no overrides exist', async () => {
      const { project } = await createPersistedProject({
        name: `restart-hints-${Date.now()}`,
        frontendPort: 6215,
        backendPort: 9215
      });
      const projectRoutesModule = await import('../routes/projects.js');
      const { getProjectPortHints } = projectRoutesModule.__projectRoutesInternals;
      const expectedHints = getProjectPortHints(project);
      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: expectedHints.frontend },
          backend: { pid: process.pid + 1, port: expectedHints.backend }
        }
      });

      const databaseModule = await import('../database.js');
      const portSettingsSpy = vi.spyOn(databaseModule, 'getPortSettings').mockResolvedValueOnce(undefined);

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart`);

      expect(response.status).toBe(200);

      const startCall = vi.mocked(scaffoldingService.startProject).mock.calls.at(-1);
      expect(startCall).toBeDefined();
      const [, startOptions] = startCall;
      expect(startOptions).toEqual(expect.objectContaining({
        frontendPort: expectedHints.frontend,
        backendPort: expectedHints.backend
      }));
      expect(startOptions.frontendPortBase).toBeUndefined();
      expect(startOptions.backendPortBase).toBeUndefined();

      portSettingsSpy.mockRestore();
    });

    test('returns 400 when restart target is invalid', async () => {
      const { project } = await createPersistedProject({ name: `restart-invalid-target-${Date.now()}` });

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart?target=wat`);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/invalid restart target/i);
    });

    test('restarts only the requested target when target is provided', async () => {
      const { project } = await createPersistedProject({ name: `restart-target-${Date.now()}` });

      const processManager = await import('../routes/projects/processManager.js');
      processManager.runningProcesses.clear();
      processManager.storeRunningProcesses(
        project.id,
        {
          frontend: { pid: process.pid, port: 5173, status: 'running' },
          backend: { pid: process.pid, port: 3000, status: 'running' }
        },
        'running',
        { launchType: 'manual' }
      );

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 6400 },
          backend: null
        }
      });

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart?target=frontend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.processes.frontend.port).toBe(6400);
      expect(response.body.processes.backend.port).toBe(3000);
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledWith(
        expect.stringContaining(project.name),
        expect.objectContaining({ target: 'frontend' })
      );
      expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({ frontendPort: 6400 }));

      updatePortsSpy.mockRestore();
    });

    test('restarts backend target and preserves the other process snapshot', async () => {
      const { project } = await createPersistedProject({ name: `restart-target-backend-${Date.now()}` });

      const processManager = await import('../routes/projects/processManager.js');
      processManager.runningProcesses.clear();
      processManager.storeRunningProcesses(
        project.id,
        {
          frontend: { pid: process.pid, port: 5173, status: 'running' },
          backend: { pid: process.pid, port: 3000, status: 'running' }
        },
        'running',
        { launchType: 'manual' }
      );

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: null,
          backend: { pid: process.pid, port: 6500 }
        }
      });

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart?target=backend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.processes.backend.port).toBe(6500);
      expect(response.body.processes.frontend.port).toBe(5173);
      expect(vi.mocked(scaffoldingService.startProject)).toHaveBeenCalledWith(
        expect.stringContaining(project.name),
        expect.objectContaining({ target: 'backend' })
      );
      expect(updatePortsSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({ backendPort: 6500 }));

      updatePortsSpy.mockRestore();
    });

    test('target restart skips port update when started port is missing and marks state stopped', async () => {
      const { project } = await createPersistedProject({ name: `restart-target-missing-port-${Date.now()}` });

      const processManager = await import('../routes/projects/processManager.js');
      processManager.runningProcesses.clear();

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: null,
          backend: null
        }
      });

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart?target=frontend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.processes.frontend).toBeNull();
      expect(response.body.processes.backend).toBeNull();
      expect(updatePortsSpy).toHaveBeenCalledWith(project.id, {});

      const entry = processManager.getRunningProcessEntry(project.id);
      expect(entry.state).toBe('stopped');

      updatePortsSpy.mockRestore();
    });

    test('target restart skips port update when started port is zero', async () => {
      const { project } = await createPersistedProject({ name: `restart-target-zero-port-${Date.now()}` });

      const processManager = await import('../routes/projects/processManager.js');
      processManager.runningProcesses.clear();

      const scaffoldingService = await import('../services/projectScaffolding.js');
      vi.mocked(scaffoldingService.startProject).mockResolvedValueOnce({
        success: true,
        processes: {
          frontend: { pid: process.pid, port: 0 },
          backend: null
        }
      });

      const databaseModule = await import('../database.js');
      const updatePortsSpy = vi.spyOn(databaseModule, 'updateProjectPorts');

      const response = await request(app)
        .post(`/api/projects/${project.id}/restart?target=frontend`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(updatePortsSpy).toHaveBeenCalledWith(project.id, {});

      updatePortsSpy.mockRestore();
    });
  });

  describe('DELETE /api/projects/:id - Project removal', () => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    test('returns 409 when deletion confirmation is missing', async () => {
      const { project } = await createPersistedProject({ name: `delete-no-confirm-${Date.now()}` });

      const blocked = await request(app).delete(`/api/projects/${project.id}`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.success).toBe(false);
      expect(blocked.body.error).toMatch(/confirmation required/i);

      const stillThere = await getProject(project.id);
      expect(stillThere).not.toBeNull();

      await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true')
        .expect(200);
    });

    test('removes database record and cleans up directories', async () => {
      const { project, projectPath } = await createPersistedProject({ name: `delete-${Date.now()}` });
      await fs.writeFile(path.join(projectPath, 'README.md'), '# Remove me');

      const response = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/deleted successfully/i);

      const stored = await getProject(project.id);
      expect(stored).toBeNull();
      await expect(fs.stat(projectPath)).rejects.toThrow();
    });

    test('returns 404 when deleting a missing project', async () => {
      const response = await request(app).delete('/api/projects/missing-project-for-delete');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/not found/i);
    });

    test('warns but succeeds when filesystem cleanup fails', async () => {
      const { project } = await createPersistedProject({ name: `delete-fs-fail-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const failingCleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      projectRoutesModule.__projectRoutesInternals.setCleanupDirectoryExecutor(failingCleanup);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/deleted successfully/i);
      expect(failingCleanup).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Could not clean up project directories/), expect.any(Array), expect.stringMatching(/cleanup failed/));

      projectRoutesModule.__projectRoutesInternals.resetCleanupDirectoryExecutor();
      warnSpy.mockRestore();
    });

    test('returns response without waiting for cleanup outside test env', async () => {
      const { project } = await createPersistedProject({ name: `delete-async-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const processManager = await import('../routes/projects/processManager.js');
      const previousEnv = process.env.NODE_ENV;

      let releaseCleanup;
      const cleanupPromise = new Promise((resolve) => {
        releaseCleanup = resolve;
      });
      const cleanupExecutor = vi.fn(async () => {
        await cleanupPromise;
      });

      const terminateSpy = vi.spyOn(processManager, 'terminateRunningProcesses').mockResolvedValue();
      projectRoutesModule.__projectRoutesInternals.setCleanupDirectoryExecutor(cleanupExecutor);
      process.env.NODE_ENV = 'production';

      try {
        const response = await request(app)
          .delete(`/api/projects/${project.id}`)
          .set('x-confirm-destructive', 'true');

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(cleanupExecutor).toHaveBeenCalled();
      } finally {
        releaseCleanup?.();
        projectRoutesModule.__projectRoutesInternals.resetCleanupDirectoryExecutor();
        terminateSpy.mockRestore();
        process.env.NODE_ENV = previousEnv;
      }
    });

    test('uses a fallback cleanup warning message when errors omit details (coverage)', async () => {
      const { project } = await createPersistedProject({ name: `delete-fs-fail-empty-${Date.now()}` });
      const projectRoutesModule = await import('../routes/projects.js');
      const failingCleanup = vi.fn().mockRejectedValue({});
      projectRoutesModule.__projectRoutesInternals.setCleanupDirectoryExecutor(failingCleanup);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/deleted successfully/i);
      expect(failingCleanup).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Could not clean up project directories/),
        expect.any(Array),
        'cleanup failed'
      );

      projectRoutesModule.__projectRoutesInternals.resetCleanupDirectoryExecutor();
      warnSpy.mockRestore();
    });

    test('returns 500 when project deletion fails unexpectedly', async () => {
      const { project } = await createPersistedProject({ name: `delete-error-${Date.now()}` });
      const databaseModule = await import('../database.js');
      const deleteSpy = vi.spyOn(databaseModule, 'deleteProject').mockRejectedValueOnce(new Error('DB down'));

      const response = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to delete project/i);

      deleteSpy.mockRestore();
    });

    test('returns 500 when the database deletion reports no changes', async () => {
      const { project } = await createPersistedProject({ name: `delete-no-change-${Date.now()}` });
      const databaseModule = await import('../database.js');
      const deleteSpy = vi.spyOn(databaseModule, 'deleteProject').mockResolvedValueOnce(false);

      const response = await request(app)
        .delete(`/api/projects/${project.id}`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to delete project from database/i);

      deleteSpy.mockRestore();
    });
  });

  describe('Project Git settings API', () => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    test('returns 404 when saving git settings for a missing project', async () => {
      const response = await request(app)
        .put('/api/projects/git-missing-project/git-settings')
        .send({ workflow: 'cloud', provider: 'github', remoteUrl: 'https://github.com/lucidcoder/missing.git' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns global git settings when project-specific settings are missing', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inheritsFromGlobal).toBe(true);
      expect(response.body.settings).toMatchObject({ workflow: 'local', provider: 'github' });
      expect(response.body.projectSettings).toBeNull();
    });

    test('backfills project git settings from git remote when global connection is cloud', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: 'github', defaultBranch: 'main' });

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/octo/repo.git'
      });

      const stored = await getProjectGitSettings(project.id);
      expect(stored.remoteUrl).toBe('https://github.com/octo/repo.git');
    });

    test('recovers git remote and persists default provider/branch', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: '', defaultBranch: '' });

      gitUtils.getRemoteUrl.mockResolvedValueOnce('https://github.com/octo/recovered.git');

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'github',
        defaultBranch: 'main',
        remoteUrl: 'https://github.com/octo/recovered.git'
      });
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });

      const stored = await getProjectGitSettings(project.id);
      expect(stored).toMatchObject({
        workflow: 'cloud',
        provider: 'github',
        defaultBranch: 'main',
        remoteUrl: 'https://github.com/octo/recovered.git'
      });
    });

    test('persists recovered remote settings with defaults when project settings are missing', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: '', defaultBranch: '', username: '' });

      gitUtils.getRemoteUrl.mockResolvedValueOnce('https://github.com/octo/recovered.git');

      const databaseModule = await import('../database.js');
      const saveSpy = vi.spyOn(databaseModule, 'saveProjectGitSettings');

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/octo/recovered.git',
        username: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      });

      expect(saveSpy).toHaveBeenCalledWith(String(project.id), expect.objectContaining({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/octo/recovered.git',
        username: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      }));

      saveSpy.mockRestore();
    });

    test('backfills with global defaults when provider and branch are missing', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: '', defaultBranch: '' });

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'github',
        defaultBranch: 'main'
      });
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });
    });

    test('backfills when project remoteUrl is blank and preserves project defaults', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: 'github', defaultBranch: 'main' });
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: '   ',
        username: 'ci-bot',
        defaultBranch: 'develop',
        autoPush: false
      });

      gitUtils.getRemoteUrl.mockResolvedValueOnce('https://github.com/octo/blank.git');

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'gitlab',
        username: 'ci-bot',
        defaultBranch: 'develop',
        remoteUrl: 'https://github.com/octo/blank.git'
      });
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'develop' });
    });

    test('does not backfill when git remote recovery fails', async () => {
      const { project } = await createPersistedProject();
      await saveGitSettings({ workflow: 'cloud', provider: 'github', defaultBranch: 'main' });

      gitUtils.ensureGitRepository.mockRejectedValueOnce(new Error('no repo'));

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inheritsFromGlobal).toBe(true);
      expect(response.body.projectSettings).toBeNull();
      expect(response.body.settings).toMatchObject({ workflow: 'cloud', provider: 'github' });
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });
      expect(gitUtils.getRemoteUrl).not.toHaveBeenCalled();
    });

    test('returns project git settings when they exist', async () => {
      const { project } = await createPersistedProject();
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/acme/demo.git',
        username: 'ci-bot',
        defaultBranch: 'develop',
        autoPush: true
      });

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(200);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings).toMatchObject({
        workflow: 'cloud',
        provider: 'gitlab',
        defaultBranch: 'develop'
      });
      expect(response.body.effectiveSettings.provider).toBe('gitlab');
    });

    test('saves project git settings via PUT endpoint', async () => {
      const { project } = await createPersistedProject();
      const payload = {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucidcoder/example.git',
        username: 'octocat',
        defaultBranch: 'main',
        token: 'ghp_test-token',
        autoPush: true,
        useCommitTemplate: true,
        commitTemplate: 'feat: ${summary}'
      };

      const response = await request(app)
        .put(`/api/projects/${project.id}/git-settings`)
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inheritsFromGlobal).toBe(false);

      const stored = await getProjectGitSettings(project.id);
      expect(stored.workflow).toBe('cloud');
      expect(stored.remoteUrl).toBe(payload.remoteUrl);
      expect(stored.defaultBranch).toBe('main');
      expect(stored.useCommitTemplate).toBe(true);
    });

    test('applies default git settings when a null body is provided', async () => {
      const { project } = await createPersistedProject();

      const rawApp = express();
      rawApp.use('/api/projects', projectRoutes);

      const response = await request(rawApp)
        .put(`/api/projects/${project.id}/git-settings`)
        .set('Content-Type', 'text/plain')
        .send('');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.workflow).toBe('local');
      expect(response.body.settings.provider).toBe('github');

      const stored = await getProjectGitSettings(project.id);
      expect(stored.workflow).toBe('local');
      expect(stored.provider).toBe('github');
    });

    test('rejects invalid git settings payloads', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app)
        .put(`/api/projects/${project.id}/git-settings`)
        .send({ workflow: 'cloud', provider: 'github' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/remoteurl is required/i);
    });

    test('clears project git settings and falls back to global defaults', async () => {
      const { project } = await createPersistedProject();
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucidcoder/delete-me.git'
      });

      const response = await request(app)
        .delete(`/api/projects/${project.id}/git-settings`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.inheritsFromGlobal).toBe(true);
      expect(response.body.projectSettings).toBeNull();

      const stored = await getProjectGitSettings(project.id);
      expect(stored).toBeNull();
    });

    test('returns 409 when clearing git settings without confirmation', async () => {
      const { project } = await createPersistedProject();
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucidcoder/delete-me.git'
      });

      const blocked = await request(app).delete(`/api/projects/${project.id}/git-settings`);

      expect(blocked.status).toBe(409);
      expect(blocked.body.success).toBe(false);
      expect(blocked.body.error).toMatch(/confirmation required/i);

      const stillStored = await getProjectGitSettings(project.id);
      expect(stillStored).not.toBeNull();
    });

    test('returns 404 when clearing git settings for a missing project', async () => {
      const response = await request(app).delete('/api/projects/99999/git-settings');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('handles unexpected errors when clearing git settings', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const deleteSpy = vi.spyOn(databaseModule, 'deleteProjectGitSettings').mockRejectedValueOnce(new Error('Cannot delete'));

      const response = await request(app)
        .delete(`/api/projects/${project.id}/git-settings`)
        .set('x-confirm-destructive', 'true');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to clear project git settings/i);

      deleteSpy.mockRestore();
    });

    test('returns 404 when requesting git settings for a missing project', async () => {
      const response = await request(app).get('/api/projects/88888/git-settings');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('handles errors when fetching git settings data', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const gitSettingsSpy = vi.spyOn(databaseModule, 'getProjectGitSettings').mockRejectedValueOnce(new Error('query failed'));

      const response = await request(app).get(`/api/projects/${project.id}/git-settings`);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to fetch project git settings/i);

      gitSettingsSpy.mockRestore();
    });

    test('returns 500 when saving git settings fails', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const saveSpy = vi.spyOn(databaseModule, 'saveProjectGitSettings').mockRejectedValueOnce(new Error('persist error'));

      const response = await request(app)
        .put(`/api/projects/${project.id}/git-settings`)
        .send({ workflow: 'cloud', provider: 'github', remoteUrl: 'https://github.com/lucidcoder/error.git' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to save project git settings/i);

      saveSpy.mockRestore();
    });
  });

  describe('GET /api/projects/:projectId/git/status', () => {
    test('returns 404 when project is missing', async () => {
      const response = await request(app).get('/api/projects/99999/git/status');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns status when project path is missing', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        id: 123,
        name: 'No Path',
        path: ''
      });

      const response = await request(app).get('/api/projects/123/git/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toMatchObject({
        hasRemote: false,
        remoteUrl: null,
        error: 'Project path is not configured.'
      });

      getProjectSpy.mockRestore();
    });

    test('returns status without remote when origin is missing', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

      const response = await request(app).get(`/api/projects/${project.id}/git/status`);

      expect(response.status).toBe(200);
      expect(response.body.status.hasRemote).toBe(false);
      expect(response.body.status.remoteUrl).toBeNull();
    });

    test('includes compare errors when ahead/behind cannot be computed', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getAheadBehind.mockResolvedValueOnce({ ahead: 0, behind: 0, error: 'Compare failed' });

      const response = await request(app).get(`/api/projects/${project.id}/git/status`);

      expect(response.status).toBe(200);
      expect(response.body.status.error).toBe('Compare failed');
      expect(response.body.status.hasRemote).toBe(true);
    });

    test('uses project git settings when available', async () => {
      const { project } = await createPersistedProject();
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/octo/custom.git',
        defaultBranch: 'develop'
      });

      const response = await request(app).get(`/api/projects/${project.id}/git/status`);

      expect(response.status).toBe(200);
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'develop' });
    });

    test('falls back to global settings when project settings lookup fails', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const projectSettingsSpy = vi.spyOn(databaseModule, 'getProjectGitSettings')
        .mockRejectedValueOnce(new Error('db failure'));
      const globalSettingsSpy = vi.spyOn(databaseModule, 'getGitSettings')
        .mockResolvedValueOnce({ defaultBranch: '' });

      const response = await request(app).get(`/api/projects/${project.id}/git/status`);

      expect(response.status).toBe(200);
      expect(globalSettingsSpy).toHaveBeenCalledTimes(1);
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });

      projectSettingsSpy.mockRestore();
      globalSettingsSpy.mockRestore();
    });

    test('handles git status helpers rejecting', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getCurrentBranch.mockRejectedValueOnce(new Error('branch failed'));
      gitUtils.hasWorkingTreeChanges.mockRejectedValueOnce(new Error('dirty failed'));

      const response = await request(app).get(`/api/projects/${project.id}/git/status`);

      expect(response.status).toBe(200);
      expect(response.body.status.currentBranch).toBeNull();
      expect(response.body.status.dirty).toBe(false);
    });

    test('returns 500 when status lookup throws', async () => {
      const databaseModule = await import('../database.js');
      const projectSpy = vi.spyOn(databaseModule, 'getProject')
        .mockRejectedValueOnce(new Error('boom'));

      const response = await request(app).get('/api/projects/123/git/status');

      expect(response.status).toBe(500);
      expect(response.body.error).toMatch(/failed to fetch git status/i);

      projectSpy.mockRestore();
    });
  });

  describe('POST /api/projects/:projectId/git/fetch', () => {
    test('returns 404 when project is missing', async () => {
      const response = await request(app).post('/api/projects/99999/git/fetch');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });

    test('returns 400 when project path is missing', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        id: 222,
        name: 'No Path',
        path: ''
      });

      const response = await request(app).post('/api/projects/222/git/fetch');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/project path is not configured/i);

      getProjectSpy.mockRestore();
    });

    test('returns 400 when remote is missing', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

      const response = await request(app).post(`/api/projects/${project.id}/git/fetch`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/remote origin is not configured/i);
    });

    test('returns status after fetch', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app).post(`/api/projects/${project.id}/git/fetch`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(gitUtils.fetchRemote).toHaveBeenCalledWith(project.path, 'origin');
    });

    test('returns 500 when fetch fails', async () => {
      const { project } = await createPersistedProject();
      gitUtils.fetchRemote.mockRejectedValueOnce(new Error('fetch failed'));

      const response = await request(app).post(`/api/projects/${project.id}/git/fetch`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('fetch failed');
    });

    test('returns default error when fetch fails without message', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const globalSettingsSpy = vi.spyOn(databaseModule, 'getGitSettings')
        .mockResolvedValueOnce({ defaultBranch: '' });
      gitUtils.fetchRemote.mockRejectedValueOnce({});

      const response = await request(app).post(`/api/projects/${project.id}/git/fetch`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to fetch git remote');
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });

      globalSettingsSpy.mockRestore();
    });
  });

  describe('POST /api/projects/:projectId/git/pull', () => {
    test('returns 404 when project is missing', async () => {
      const response = await request(app).post('/api/projects/99999/git/pull');

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('returns 400 when project path is missing', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        id: 456,
        name: 'No Path',
        path: ''
      });

      const response = await request(app).post('/api/projects/456/git/pull');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/project path is not configured/i);

      getProjectSpy.mockRestore();
    });

    test('returns 400 when remote is missing', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/remote origin is not configured/i);
    });

    test('returns 400 when working tree is dirty', async () => {
      const { project } = await createPersistedProject();
      gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/uncommitted changes/i);
    });

    test('returns 400 when on the wrong branch', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getCurrentBranch.mockResolvedValueOnce('feature');

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/checkout main/i);
    });

    test('returns 400 when compare fails', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getAheadBehind.mockResolvedValueOnce({ ahead: 0, behind: 0, error: 'blocked' });

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('blocked');
    });

    test('uses fast-forward strategy when behind only', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getAheadBehind
        .mockResolvedValueOnce({ ahead: 0, behind: 2 })
        .mockResolvedValueOnce({ ahead: 0, behind: 0 });

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('ff-only');
      expect(gitUtils.runGitCommand).toHaveBeenCalledWith(project.path, ['merge', '--ff-only', 'origin/main']);
    });

    test('uses rebase strategy when ahead and behind', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getAheadBehind
        .mockResolvedValueOnce({ ahead: 1, behind: 1 })
        .mockResolvedValueOnce({ ahead: 0, behind: 0 });

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('rebase');
      expect(gitUtils.runGitCommand).toHaveBeenCalledWith(project.path, ['rebase', 'origin/main']);
    });

    test('returns noop strategy when already up to date', async () => {
      const { project } = await createPersistedProject();
      gitUtils.getAheadBehind
        .mockResolvedValueOnce({ ahead: 0, behind: 0 })
        .mockResolvedValueOnce({ ahead: 0, behind: 0 });

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('noop');
      expect(gitUtils.runGitCommand).not.toHaveBeenCalledWith(project.path, ['merge', '--ff-only', 'origin/main']);
      expect(gitUtils.runGitCommand).not.toHaveBeenCalledWith(project.path, ['rebase', 'origin/main']);
    });

    test('handles helper rejections and defaults to noop strategy', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const globalSettingsSpy = vi.spyOn(databaseModule, 'getGitSettings')
        .mockResolvedValueOnce({ defaultBranch: '' });
      gitUtils.hasWorkingTreeChanges.mockRejectedValueOnce(new Error('dirty failed'));
      gitUtils.getCurrentBranch.mockRejectedValueOnce(new Error('branch failed'));
      gitUtils.getAheadBehind
        .mockResolvedValueOnce({ ahead: 0, behind: 0 })
        .mockResolvedValueOnce({ ahead: 0, behind: 0 });

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(200);
      expect(response.body.strategy).toBe('noop');
      expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(project.path, { defaultBranch: 'main' });

      globalSettingsSpy.mockRestore();
    });

    test('returns default error when pull fails without message', async () => {
      const { project } = await createPersistedProject();
      gitUtils.fetchRemote.mockRejectedValueOnce({});

      const response = await request(app).post(`/api/projects/${project.id}/git/pull`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to pull from remote');
    });
  });

  describe('POST /api/projects/:projectId/git/remotes', () => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    test('creates a remote repository and saves settings', async () => {
      const { project } = await createPersistedProject();
      const mockRepository = {
        provider: 'github',
        id: '123',
        name: 'demo',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main'
      };
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue(mockRepository);

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({
          provider: 'github',
          name: 'demo',
          token: 'ghp_test-token',
          visibility: 'public',
          description: 'Demo repo'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.repository.remoteUrl).toBe(mockRepository.remoteUrl);
      expect(response.body.appliedSettings).toBe(true);

      const stored = await getProjectGitSettings(project.id);
      expect(stored.remoteUrl).toBe(mockRepository.remoteUrl);
      expect(stored.defaultBranch).toBe(mockRepository.defaultBranch);
    });

    test('reports initialization error when project path is missing', async () => {
      const { project } = await createPersistedProject();
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        ...project,
        path: ''
      });
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '321',
        name: 'demo-pathless',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo-pathless.git',
        defaultBranch: 'main'
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo-pathless', token: 'ghp_pathless' });

      expect(response.status).toBe(200);
      expect(response.body.initialization).toMatchObject({
        success: false,
        error: 'Project path is not configured.'
      });

      getProjectSpy.mockRestore();
    });

    test('uses default initialization error when init fails without message', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '654',
        name: 'demo-init',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo-init.git',
        defaultBranch: 'main'
      });
      const { initializeAndPushRepository } = await import('../services/projectScaffolding/git.js');
      vi.mocked(initializeAndPushRepository).mockRejectedValueOnce({});

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo-init', token: 'ghp_init' });

      expect(response.status).toBe(200);
      expect(response.body.initialization).toMatchObject({
        success: false,
        error: 'Failed to initialize and push repository.'
      });
    });

    test('validates remote creation payloads when the request body is null', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockClear();

      const rawApp = express();
      rawApp.use('/api/projects', projectRoutes);

      const response = await request(rawApp)
        .post(`/api/projects/${project.id}/git/remotes`)
        .set('Content-Type', 'text/plain')
        .send('');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/personal access token/i);
      expect(remoteService.createRemoteRepository).not.toHaveBeenCalled();
    });

    test('rejects unsupported providers', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'bitbucket', name: 'demo', token: 'token' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/unsupported git provider/i);
    });

    test('surface provider errors from remote creation service', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      const { RemoteRepoCreationError } = remoteService;
      vi.mocked(remoteService.createRemoteRepository).mockRejectedValue(
        new RemoteRepoCreationError('Provider rejected request', { statusCode: 422, provider: 'github' })
      );

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo', token: 'token', remoteUrl: 'n/a' });

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
      expect(response.body.provider).toBe('github');
      expect(response.body.error).toContain('Provider rejected request');
    });

    test('falls back to HTTP 400 when a RemoteRepoCreationError omits status codes', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      const { RemoteRepoCreationError } = remoteService;
      vi.mocked(remoteService.createRemoteRepository).mockRejectedValueOnce(
        new RemoteRepoCreationError('Missing status', { provider: 'github', statusCode: null })
      );

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo', token: 'ghp-statusless' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.details).toBeNull();
      expect(response.body.error).toContain('Missing status');
    });

    test('allows skipping git setting application when creating remotes', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '999',
        name: 'demo-no-settings',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo-no-settings.git',
        defaultBranch: 'main'
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({
          provider: 'github',
          name: 'demo-no-settings',
          token: 'ghp_skip',
          applySettings: false
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.appliedSettings).toBe(false);
      expect(response.body.inheritsFromGlobal).toBe(true);
      expect(response.body.projectSettings).toBeNull();

      const stored = await getProjectGitSettings(project.id);
      expect(stored).toBeNull();
    });

    test('trims owner input and falls back to project name/default branch', async () => {
      const { project } = await createPersistedProject({ name: 'fallback-source' });
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '555',
        name: 'ignored',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/fallback-source.git',
        defaultBranch: ''
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({
          provider: 'github',
          owner: '  OrgName  ',
          token: 'ghp_fallback',
          defaultBranch: '   develop   '
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.defaultBranch).toBe('develop');

      const lastCall = vi.mocked(remoteService.createRemoteRepository).mock.calls.at(-1)?.[0];
      expect(lastCall.name).toBe(project.name);
      expect(lastCall.owner).toBe('OrgName');
    });

    test('falls back to main when the provided defaultBranch is blank', async () => {
      const { project } = await createPersistedProject({ name: 'blank-branch-source' });
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValueOnce({
        provider: 'github',
        id: '777',
        name: 'blank-branch',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/blank-branch.git',
        defaultBranch: ''
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({
          token: 'ghp_blank_default',
          defaultBranch: '     '
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.settings.defaultBranch).toBe('main');

      const stored = await getProjectGitSettings(project.id);
      expect(stored.defaultBranch).toBe('main');
    });

    test('requires a personal access token when creating remotes', async () => {
      const { project } = await createPersistedProject();

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo-without-token' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/personal access token/i);
    });

    test('uses stored token when payload omits token', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '321',
        name: 'demo',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main'
      });

      const databaseModule = await import('../database.js');
      const tokenSpy = vi.spyOn(databaseModule, 'getGitSettingsToken').mockResolvedValueOnce('stored-token');

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo' });

      expect(response.status).toBe(200);
      expect(vi.mocked(remoteService.createRemoteRepository)).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'stored-token' })
      );

      tokenSpy.mockRestore();
    });

    test('does not persist stored token into project settings when payload omits token', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValueOnce({
        provider: 'github',
        id: '321',
        name: 'demo',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main'
      });

      const databaseModule = await import('../database.js');
      const tokenSpy = vi.spyOn(databaseModule, 'getGitSettingsToken').mockResolvedValueOnce('stored-token');

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const stored = await getProjectGitSettings(project.id);
      expect(stored.remoteUrl).toBe('https://github.com/octocat/demo.git');
      expect(stored.tokenPresent).toBe(false);

      tokenSpy.mockRestore();
    });

    test('returns initialization error when initial push fails', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '444',
        name: 'demo',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main'
      });

      const { initializeAndPushRepository } = await import('../services/projectScaffolding/git.js');
      vi.mocked(initializeAndPushRepository).mockRejectedValueOnce(new Error('init failed'));

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo', token: 'token' });

      expect(response.status).toBe(200);
      expect(response.body.initialization).toMatchObject({ success: false, error: 'init failed' });
    });

    test('falls back to project name when remote payload omits repository name', async () => {
      const { project } = await createPersistedProject({ name: `remote-fallback-${Date.now()}` });
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValueOnce({
        provider: 'github',
        id: '777',
        name: project.name,
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: 'main'
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', token: 'ghp_use_project' });

      expect(response.status).toBe(200);
      expect(vi.mocked(remoteService.createRemoteRepository)).toHaveBeenCalledWith(
        expect.objectContaining({ name: project.name })
      );
      expect(response.body.repository.name).toBe(project.name);
    });

    test('returns 404 when creating a remote for a missing project', async () => {
      const response = await request(app)
        .post('/api/projects/9999/git/remotes')
        .send({ provider: 'github', name: 'demo', token: 'missing-project' });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/project not found/i);
    });

    test('rejects requests when a repository name cannot be determined', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        id: 4242,
        name: '   ',
        description: 'nameless project'
      });

      const response = await request(app)
        .post('/api/projects/4242/git/remotes')
        .send({ provider: 'github', token: 'ghp_no-name' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/repository name is required/i);

      getProjectSpy.mockRestore();
    });

    test('requires repository name when project metadata is also blank', async () => {
      const databaseModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(databaseModule, 'getProject').mockResolvedValueOnce({
        id: 5252,
        name: null,
        description: 'empty project'
      });

      const response = await request(app)
        .post('/api/projects/5252/git/remotes')
        .send({ provider: 'github', token: 'ghp_no-fallback' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/repository name is required/i);

      getProjectSpy.mockRestore();
    });

    test('uses payload defaultBranch when provider response omits it', async () => {
      const { project } = await createPersistedProject({ name: `remote-branch-${Date.now()}` });
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValueOnce({
        provider: 'github',
        id: '888',
        name: 'demo',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo.git',
        defaultBranch: ''
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', token: 'ghp_branch', defaultBranch: 'release' });

      expect(response.status).toBe(200);
      expect(response.body.settings.defaultBranch).toBe('release');
    });

    test('saves trimmed usernames when applying git settings for remotes', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '222',
        name: 'demo-with-username',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo-with-username.git',
        defaultBranch: 'main'
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({
          provider: 'github',
          name: 'demo-with-username',
          token: 'ghp_username',
          username: '  ci-bot  '
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const stored = await getProjectGitSettings(project.id);
      expect(stored.username).toBe('ci-bot');
    });

    test('reuses existing project git settings when skipping applySettings', async () => {
      const { project } = await createPersistedProject();
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/octocat/pre-existing.git',
        defaultBranch: 'legacy',
        token: 'ghp_previous'
      });

      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockResolvedValue({
        provider: 'github',
        id: '333',
        name: 'demo-existing',
        owner: 'octocat',
        remoteUrl: 'https://github.com/octocat/demo-existing.git',
        defaultBranch: 'main'
      });

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', token: 'ghp_skip', applySettings: false });

      expect(response.status).toBe(200);
      expect(response.body.appliedSettings).toBe(false);
      expect(response.body.inheritsFromGlobal).toBe(false);
      expect(response.body.projectSettings.remoteUrl).toBe('https://github.com/octocat/pre-existing.git');
      expect(response.body.projectSettings.defaultBranch).toBe('legacy');
    });

    test('returns 500 when remote repository creation fails unexpectedly', async () => {
      const { project } = await createPersistedProject();
      const remoteService = await import('../services/remoteRepoService.js');
      vi.mocked(remoteService.createRemoteRepository).mockRejectedValue(new Error('Network down'));

      const response = await request(app)
        .post(`/api/projects/${project.id}/git/remotes`)
        .send({ provider: 'github', name: 'demo', token: 'ghp_fail' });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to create remote repository/i);
    });
  });
});
