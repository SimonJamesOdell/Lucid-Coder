import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import http from 'http';
import { createProject, deleteProject } from '../../database.js';
import { getProjectsDir } from '../../utils/projectPaths.js';

// Import the actual server app for testing
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logLifecycleProgress = (message) => {
  process.stdout.write(`[LifecycleTest] ${message}\n`);
};

// These tests call the REAL backend APIs without mocking
// They should catch issues like missing database fields, broken process spawning, etc.

describe('Project Lifecycle Integration Tests', () => {
  let app;
  let unmanagedProjectPath;
  
  beforeAll(async () => {
    logLifecycleProgress('Initializing database for lifecycle suite…');
    // Ensure database tables exist before hitting real routes
    const dbModule = await import('../../database.js');
    await dbModule.initializeDatabase();

    logLifecycleProgress('Spinning up backend server instance for lifecycle suite…');
    // Import and start the actual server for testing
    const serverModule = await import('../../server.js');
    app = serverModule.default || serverModule.app;
  }, 60000);

  afterAll(async () => {
    // supertest can exercise the Express app without binding a real port.
  });

  describe('Project Creation Should Include Path', () => {
    let createdProjectId;
    
    afterEach(async () => {
      // Cleanup: delete the test project if it was created
      if (createdProjectId) {
        try {
          await request(app).delete(`/api/projects/${createdProjectId}`);
        } catch (error) {
          console.warn('Failed to cleanup test project:', error.message);
        }
        createdProjectId = null;
      }
    });

    it('should create project with non-null path in database', async () => {
      const projectData = {
        name: `Integration Test Project ${Date.now()}`,
        description: 'Integration test project',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      };

      logLifecycleProgress('Creating project to verify path storage (this runs full scaffolding)…');
      const response = await request(app)
        .post('/api/projects')
        .send(projectData)
        .expect(201);
      logLifecycleProgress('Project creation complete for path storage test.');

      expect(response.body.success).toBe(true);
      expect(response.body.project).toBeDefined();
      expect(response.body.project.path).not.toBeNull();
      expect(response.body.project.path).toContain('projects');
      expect(response.body.project.name).toBe(projectData.name);

      createdProjectId = response.body.project.id;
    });

    it('should retrieve project with same path from database', async () => {
      // First create a project
      const projectData = {
        name: `Path Test Project ${Date.now()}`,
        description: 'Testing path persistence',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      };

      logLifecycleProgress('Creating project to assert persisted path values…');
      const createResponse = await request(app)
        .post('/api/projects')
        .send(projectData)
        .expect(201);
      logLifecycleProgress('Project created; fetching it back from API…');

      createdProjectId = createResponse.body.project.id;
      const expectedPath = createResponse.body.project.path;

      // Then retrieve it and verify path is preserved
      const getResponse = await request(app)
        .get(`/api/projects/${createdProjectId}`)
        .expect(200);

      expect(getResponse.body.success).toBe(true);
      expect(getResponse.body.project.path).toBe(expectedPath);
      expect(getResponse.body.project.path).not.toBeNull();
    });
  });

  describe('Project Starting Should Work With Valid Path', () => {
    let testProjectId;
    let testProjectPath;

    beforeEach(async () => {
      // Create a real test project with files
      const projectData = {
        name: `Start Test Project ${Date.now()}`,
        description: 'Testing project starting',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      };

      logLifecycleProgress('Scaffolding project for start/stop scenario…');
      const response = await request(app)
        .post('/api/projects')
        .send(projectData)
        .expect(201);
      logLifecycleProgress('Project scaffolding complete for start/stop scenario.');

      testProjectId = response.body.project.id;
      testProjectPath = response.body.project.path;
    });

    afterEach(async () => {
      // Stop and cleanup test project
      if (testProjectId) {
        try {
          await request(app).post(`/api/projects/${testProjectId}/stop`);
          await request(app).delete(`/api/projects/${testProjectId}`);
        } catch (error) {
          console.warn('Failed to cleanup test project:', error.message);
        }
      }
    });

    it('should not fail with path error when starting project', async () => {
      // This test would have failed before the fix because path was null
      const response = await request(app)
        .post(`/api/projects/${testProjectId}/start`)
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should not get "path argument must be of type string. Received null" error
    });

    it('should verify project directory actually exists', async () => {
      // Verify the project directory was actually created
      try {
        const stats = await fs.stat(testProjectPath);
        expect(stats.isDirectory()).toBe(true);
        
        // Check for expected subdirectories
        const frontendPath = path.join(testProjectPath, 'frontend');
        const backendPath = path.join(testProjectPath, 'backend');
        
        const frontendExists = await fs.access(frontendPath).then(() => true).catch(() => false);
        const backendExists = await fs.access(backendPath).then(() => true).catch(() => false);
        
        expect(frontendExists).toBe(true);
        expect(backendExists).toBe(true);
      } catch (error) {
        throw new Error(`Project directory does not exist at ${testProjectPath}: ${error.message}`);
      }
    });
  });

  describe('Project Update Should Include Path', () => {
    let testProjectId;

    beforeEach(async () => {
      const projectData = {
        name: `Update Test Project ${Date.now()}`,
        description: 'Testing project updates',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      };

      logLifecycleProgress('Creating project for update-path scenario…');
      const response = await request(app)
        .post('/api/projects')
        .send(projectData)
        .expect(201);
      logLifecycleProgress('Project ready for update-path scenario.');

      testProjectId = response.body.project.id;
    });

    afterEach(async () => {
      if (testProjectId) {
        try {
          await request(app).delete(`/api/projects/${testProjectId}`);
        } catch (error) {
          console.warn('Failed to cleanup test project:', error.message);
        }
      }
    });

    it('should update project path when provided', async () => {
      const newPath = path.join(getProjectsDir(), `update-path-${Date.now()}`);
      const updateData = {
        name: 'Updated Project Name',
        description: 'Updated description',
        language: 'javascript',
        framework: 'react',
        path: newPath
      };

      const response = await request(app)
        .put(`/api/projects/${testProjectId}`)
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.project.path).toBe(newPath);
    });
  });

  describe('Error Handling', () => {
    it('should return proper error for invalid project ID when starting', async () => {
      const response = await request(app)
        .post('/api/projects/99999/start')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('not found');
    });

    it('should handle missing required fields in project creation', async () => {
      const invalidData = {
        description: 'Missing name field'
        // No name, frontend, or backend
      };

      const response = await request(app)
        .post('/api/projects')
        .send(invalidData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('required');
    });
  });

  describe('Closing Projects Should Not Kill External Services', () => {
    let dummyServer;
    let externalPort;
    let unmanagedProject;

    const startDummyServer = () =>
      new Promise((resolve, reject) => {
        const serverInstance = http.createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('still-alive');
        });

        serverInstance.on('error', reject);
        serverInstance.listen(0, '127.0.0.1', () => resolve(serverInstance));
      });

    const pingDummyServer = (port) =>
      new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port }, (res) => {
          const { statusCode } = res;
          res.resume();
          res.on('end', () => resolve(statusCode));
        });
        req.on('error', reject);
      });

    beforeEach(async () => {
      dummyServer = await startDummyServer();
      externalPort = dummyServer.address().port;

      const baseDir = process.env.PROJECTS_DIR || path.join(process.cwd(), 'tmp');
      unmanagedProjectPath = await fs.mkdtemp(path.join(baseDir, 'close-project-test-'));

      unmanagedProject = await createProject({
        name: `close-project-${Date.now()}`,
        description: 'Verifies closing does not kill unrelated services',
        language: 'javascript,javascript',
        framework: 'react,express',
        path: unmanagedProjectPath,
        frontendPort: 5173,
        backendPort: externalPort
      });
    });

    afterEach(async () => {
      if (dummyServer) {
        await new Promise((resolve) => dummyServer.close(resolve));
        dummyServer = null;
      }

      if (unmanagedProject) {
        await deleteProject(unmanagedProject.id);
        unmanagedProject = null;
      }

      if (unmanagedProjectPath) {
        await fs.rm(unmanagedProjectPath, { recursive: true, force: true });
        unmanagedProjectPath = null;
      }
    });

    it('should leave independent local services running when project has no tracked processes', async () => {
      const response = await request(app)
        .post(`/api/projects/${unmanagedProject.id}/stop`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toMatch(/not running|stopped/i);

      const statusCode = await pingDummyServer(externalPort);
      expect(statusCode).toBe(200);
    });
  });
});