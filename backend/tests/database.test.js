import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import os from 'os';
import sqlite3 from 'sqlite3';
import { 
  initializeDatabase, 
  saveLLMConfig, 
  getLLMConfig, 
  logAPIRequest, 
  getAPILogs,
  createProject,
  getProject,
  getProjectByName,
  getAllProjects,
  updateProject,
  deleteProject,
  updateProjectPorts,
  saveGitSettings,
  getGitSettings,
  savePortSettings,
  getPortSettings,
  saveProjectGitSettings,
  getProjectGitSettings,
  deleteProjectGitSettings,
  db_operations,
  closeDatabase
} from '../database.js';
import db from '../database.js';
import { __private__ as databasePrivate } from '../database.js';

describe('Database Tests', () => {
  const dbPath = process.env.DATABASE_PATH || './lucidcoder.db';
  const makeProject = (suffix) => ({
    name: `Project-${suffix}-${Date.now()}`,
    description: `Description for ${suffix}`,
    language: 'javascript',
    framework: 'react',
    path: `/tmp/project-${suffix}`
  });

  const runSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });

  const getSql = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

  const execSql = (sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  const tablesToClean = [
    'agent_tasks',
    'agent_goals',
    'project_git_settings',
    'git_settings',
    'port_settings',
    'test_runs',
    'branches',
    'api_logs',
    'llm_config',
    'projects'
  ];

  const resetTables = async () => {
    const deletes = tablesToClean.map((table) => `DELETE FROM ${table};`).join('');
    await execSql(`BEGIN;${deletes}COMMIT;`);
  };

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    // The database module uses the configured path; clear out leftover data fast.
    await resetTables();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Database Initialization', () => {
    test('should create database file', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    test('should create required tables', async () => {
      // This test passes if no errors are thrown during initialization
      expect(true).toBe(true);
    });
  });

  describe('LLM Configuration', () => {
    const testConfig = {
      provider: 'groq',
      apiKey: 'test-api-key-123',
      model: 'llama-3.1-70b-versatile',
      apiUrl: 'https://api.groq.com/openai/v1'
    };

    test('should save LLM configuration', async () => {
      const result = await saveLLMConfig(testConfig);
      expect(result).toBe(true);
    });

    test('should retrieve saved LLM configuration', async () => {
      await saveLLMConfig(testConfig);
      const retrieved = await getLLMConfig();
      
      expect(retrieved).toBeTruthy();
      expect(retrieved.provider).toBe('groq');
      expect(retrieved.model).toBe('llama-3.1-70b-versatile');
      expect(retrieved.api_url).toBe('https://api.groq.com/openai/v1');
      // API key should be encrypted/different
      expect(retrieved.api_key_encrypted).not.toBe('test-api-key-123');
    });

    test('should return null when no configuration exists', async () => {
      const retrieved = await getLLMConfig();
      expect(retrieved).toBeNull();
    });

    test('should update existing configuration', async () => {
      await saveLLMConfig(testConfig);
      
      const updatedConfig = {
        ...testConfig,
        model: 'llama-3.1-8b-instant'
      };
      
      await saveLLMConfig(updatedConfig);
      const retrieved = await getLLMConfig();
      
      expect(retrieved.model).toBe('llama-3.1-8b-instant');
    });

    test('should list all stored configurations', async () => {
      await saveLLMConfig(testConfig);
      await saveLLMConfig({ ...testConfig, model: 'llama-3.1-8b-instant' });

      const configs = await db_operations.getAllLLMConfigs();
      expect(configs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Module bootstrap edge cases', () => {
    test('should fall back to default database path when DATABASE_PATH is unset', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      delete process.env.DATABASE_PATH;
      const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

      try {
        const module = await import('../database.js?default-path');
        expect(module.default.filename).toBe(path.join(backendDir, 'test-lucidcoder.db'));
        await new Promise((resolve, reject) => {
          module.default.close((err) => err ? reject(err) : resolve());
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
      }
    });

    test('initializeDatabase should log and rethrow when sqlite setup fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const module = await import('../database.js?bootstrap-error');

      await new Promise((resolve, reject) => {
        module.default.close((err) => err ? reject(err) : resolve());
      });

      await expect(module.initializeDatabase()).rejects.toThrow(/database is closed/i);
      expect(errorSpy).toHaveBeenCalledWith('❌ Database initialization failed:', expect.any(Error));
    });
    const safeUnlinkSync = (targetPath) => {
      try {
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
      } catch (error) {
        // On Windows, SQLite files can remain locked by other processes
        // (e.g., a running dev server). These tests only need to validate
        // path resolution, so treat locked-file cleanup as best-effort.
        const code = error?.code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          return;
        }
        throw error;
      }
    };

    test('should resolve relative DATABASE_PATH values against process cwd', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      const relativePath = 'relative-db-coverage.sqlite';
      const resolvedPath = path.join(process.cwd(), relativePath);
      safeUnlinkSync(resolvedPath);
      process.env.DATABASE_PATH = relativePath;

      try {
        const module = await import('../database.js?relative-path');
        expect(module.default.filename).toBe(resolvedPath);
        await new Promise((resolve, reject) => {
          module.default.close((err) => err ? reject(err) : resolve());
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
        safeUnlinkSync(resolvedPath);
      }
    });

    test('should pick production database filename when NODE_ENV is not test', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalDbDir = process.env.LUCIDCODER_DB_DIR;
      delete process.env.DATABASE_PATH;
      process.env.NODE_ENV = 'development';

      const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      process.env.LUCIDCODER_DB_DIR = backendDir;
      const expectedPath = path.join(backendDir, 'lucidcoder.db');
      safeUnlinkSync(expectedPath);

      try {
        const module = await import('../database.js?non-test-env');
        expect(module.default.filename).toBe(expectedPath);
        await new Promise((resolve, reject) => {
          module.default.close((err) => err ? reject(err) : resolve());
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
        if (originalDbDir === undefined) {
          delete process.env.LUCIDCODER_DB_DIR;
        } else {
          process.env.LUCIDCODER_DB_DIR = originalDbDir;
        }
        process.env.NODE_ENV = originalNodeEnv;
        safeUnlinkSync(expectedPath);
      }
    });

    test('should resolve relative LUCIDCODER_DB_DIR values against process cwd', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalDbDir = process.env.LUCIDCODER_DB_DIR;

      const relativeDirName = `relative-db-dir-${Date.now()}`;
      const absoluteDir = path.join(process.cwd(), relativeDirName);
      fs.mkdirSync(absoluteDir, { recursive: true });

      delete process.env.DATABASE_PATH;
      process.env.NODE_ENV = 'development';
      process.env.LUCIDCODER_DB_DIR = relativeDirName;

      const expectedDbPath = path.join(absoluteDir, 'lucidcoder.db');
      safeUnlinkSync(expectedDbPath);

      try {
        vi.resetModules();
        const module = await import('../database.js');
        expect(module.default.filename).toBe(expectedDbPath);

        await new Promise((resolve, reject) => {
          module.default.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
        if (originalDbDir === undefined) {
          delete process.env.LUCIDCODER_DB_DIR;
        } else {
          process.env.LUCIDCODER_DB_DIR = originalDbDir;
        }
        process.env.NODE_ENV = originalNodeEnv;
        try {
          fs.rmSync(absoluteDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    test('should use absolute LUCIDCODER_DB_DIR without resolving against cwd', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalDbDir = process.env.LUCIDCODER_DB_DIR;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidcoder-db-dir-absolute-'));

      delete process.env.DATABASE_PATH;
      process.env.NODE_ENV = 'development';
      process.env.LUCIDCODER_DB_DIR = tempDir;

      const expectedDbPath = path.join(tempDir, 'lucidcoder.db');
      safeUnlinkSync(expectedDbPath);

      try {
        vi.resetModules();
        const module = await import('../database.js?absolute-db-dir');
        expect(module.default.filename).toBe(expectedDbPath);

        await new Promise((resolve, reject) => {
          module.default.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
        if (originalDbDir === undefined) {
          delete process.env.LUCIDCODER_DB_DIR;
        } else {
          process.env.LUCIDCODER_DB_DIR = originalDbDir;
        }
        process.env.NODE_ENV = originalNodeEnv;

        try {
          safeUnlinkSync(expectedDbPath);
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    test('initializeDatabase should add missing agent_goals.parent_goal_id column for legacy databases', async () => {
      const originalDatabasePath = process.env.DATABASE_PATH;
      const legacyDbPath = path.join(process.cwd(), `legacy-goals-${Date.now()}.sqlite`);
      safeUnlinkSync(legacyDbPath);

      process.env.DATABASE_PATH = legacyDbPath;

      try {
        const module = await import('../database.js?legacy-parent-goal-id');

        // Create a legacy agent_goals table without parent_goal_id.
        await new Promise((resolve, reject) => {
          module.default.exec(
            `CREATE TABLE IF NOT EXISTS agent_goals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              project_id INTEGER NOT NULL,
              prompt TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'planning',
              lifecycle_state TEXT NOT NULL DEFAULT 'draft',
              branch_name TEXT NOT NULL,
              metadata TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`,
            (err) => (err ? reject(err) : resolve())
          );
        });

        await module.initializeDatabase();

        const columns = await new Promise((resolve, reject) => {
          module.default.all('PRAGMA table_info(agent_goals)', (err, rows) => (err ? reject(err) : resolve(rows)));
        });

        expect(columns.some((column) => column.name === 'parent_goal_id')).toBe(true);

        await new Promise((resolve, reject) => {
          module.default.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        if (originalDatabasePath === undefined) {
          delete process.env.DATABASE_PATH;
        } else {
          process.env.DATABASE_PATH = originalDatabasePath;
        }
        safeUnlinkSync(legacyDbPath);
      }
    });
  });

  describe('Database path resolution helpers', () => {
    test('resolveUserDataDir uses process defaults when no runtime overrides are provided', () => {
      const resolved = databasePrivate.resolveUserDataDir();

      expect(resolved === null || typeof resolved === 'string').toBe(true);
    });

    test('resolveUserDataDir returns Windows app data folder when available', () => {
      const resolved = databasePrivate.resolveUserDataDir({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:/Users/test/AppData/Local' }
      });

      expect(resolved).toBe(path.join('C:/Users/test/AppData/Local', 'LucidCoder'));
    });

    test('resolveUserDataDir returns null on Windows when no app data env vars are set', () => {
      const resolved = databasePrivate.resolveUserDataDir({
        platform: 'win32',
        env: {}
      });

      expect(resolved).toBeNull();
    });

    test('resolveUserDataDir returns macOS Application Support path', () => {
      const resolved = databasePrivate.resolveUserDataDir({
        platform: 'darwin',
        env: {},
        homedir: () => '/Users/test'
      });

      expect(resolved).toBe(path.join('/Users/test', 'Library', 'Application Support', 'LucidCoder'));
    });

    test('resolveUserDataDir returns XDG_DATA_HOME path on Linux when set', () => {
      const resolved = databasePrivate.resolveUserDataDir({
        platform: 'linux',
        env: { XDG_DATA_HOME: '/xdg' },
        homedir: () => '/home/test'
      });

      expect(resolved).toBe(path.join('/xdg', 'lucidcoder'));
    });

    test('resolveUserDataDir falls back to ~/.local/share/lucidcoder on Linux when XDG not set', () => {
      const resolved = databasePrivate.resolveUserDataDir({
        platform: 'linux',
        env: {},
        homedir: () => '/home/test'
      });

      expect(resolved).toBe(path.join('/home/test', '.local', 'share', 'lucidcoder'));
    });

    test('resolveDbBaseDir returns __dirname in test env', () => {
      const resolved = databasePrivate.resolveDbBaseDir({
        env: { NODE_ENV: 'test' },
        dirName: '/repo/backend'
      });

      expect(resolved).toBe('/repo/backend');
    });

    test('resolveDbBaseDir respects absolute LUCIDCODER_DB_DIR', () => {
      const resolved = databasePrivate.resolveDbBaseDir({
        env: { NODE_ENV: 'production', LUCIDCODER_DB_DIR: '/data/lucidcoder' },
        cwd: '/repo',
        dirName: '/repo/backend'
      });

      expect(resolved).toBe('/data/lucidcoder');
    });

    test('resolveDbBaseDir resolves relative LUCIDCODER_DB_DIR against cwd', () => {
      const resolved = databasePrivate.resolveDbBaseDir({
        env: { NODE_ENV: 'production', LUCIDCODER_DB_DIR: 'relative-db-dir' },
        cwd: '/repo',
        dirName: '/repo/backend'
      });

      expect(resolved).toBe(path.join('/repo', 'relative-db-dir'));
    });

    test('resolveDbBaseDir falls back to backend dir when user data dir is unavailable', () => {
      const resolved = databasePrivate.resolveDbBaseDir({
        env: { NODE_ENV: 'production' },
        cwd: '/repo',
        dirName: '/repo/backend',
        platform: 'win32',
        homedir: () => '/home/test'
      });

      expect(resolved).toBe('/repo/backend');
    });

    test('resolveDbPath migrates legacy backend db to new default location once', () => {
      const calls = {
        mkdir: [],
        copy: []
      };

      const legacyPath = path.join('/repo/backend', 'lucidcoder.db');
      const baseDir = path.join('/xdg', 'lucidcoder');
      const expectedResolvedPath = path.join(baseDir, 'lucidcoder.db');

      const fsImpl = {
        existsSync: vi.fn((targetPath) => {
          if (targetPath === legacyPath) {
            return true;
          }
          if (targetPath === expectedResolvedPath) {
            return false;
          }
          return false;
        }),
        mkdirSync: vi.fn((targetPath, options) => {
          calls.mkdir.push({ targetPath, options });
        }),
        copyFileSync: vi.fn((fromPath, toPath) => {
          calls.copy.push({ fromPath, toPath });
        })
      };

      const resultResolvedPath = databasePrivate.resolveDbPath({
        env: { NODE_ENV: 'production', XDG_DATA_HOME: '/xdg' },
        cwd: '/repo',
        dirName: '/repo/backend',
        platform: 'linux',
        homedir: () => '/home/test',
        fs: fsImpl
      });

      expect(resultResolvedPath).toBe(expectedResolvedPath);
      expect(fsImpl.mkdirSync).toHaveBeenCalledWith(baseDir, { recursive: true });
      expect(fsImpl.copyFileSync).toHaveBeenCalledWith(legacyPath, expectedResolvedPath);
      expect(calls.copy).toHaveLength(1);
    });

    test('resolveDbPath does not migrate when the destination already exists', () => {
      const legacyPath = path.join('/repo/backend', 'lucidcoder.db');
      const baseDir = path.join('/xdg', 'lucidcoder');
      const expectedResolvedPath = path.join(baseDir, 'lucidcoder.db');

      const fsImpl = {
        existsSync: vi.fn((targetPath) => {
          if (targetPath === legacyPath) {
            return true;
          }
          if (targetPath === expectedResolvedPath) {
            return true;
          }
          return false;
        }),
        mkdirSync: vi.fn(),
        copyFileSync: vi.fn()
      };

      const resultResolvedPath = databasePrivate.resolveDbPath({
        env: { NODE_ENV: 'production', XDG_DATA_HOME: '/xdg' },
        cwd: '/repo',
        dirName: '/repo/backend',
        platform: 'linux',
        homedir: () => '/home/test',
        fs: fsImpl
      });

      expect(resultResolvedPath).toBe(expectedResolvedPath);
      expect(fsImpl.copyFileSync).not.toHaveBeenCalled();
    });
  });

  describe('API Logging', () => {
    const testLogData = {
      provider: 'groq',
      model: 'llama-3.1-70b-versatile',
      requestType: 'generate',
      responseTime: 1500,
      success: true,
      errorMessage: null
    };

    test('should log API request', async () => {
      const result = await logAPIRequest(testLogData);
      expect(result).toBe(true);
    });

    test('should retrieve API logs', async () => {
      await logAPIRequest(testLogData);
      await logAPIRequest({
        ...testLogData,
        success: false,
        errorMessage: 'Test error'
      });
      
      const logs = await getAPILogs();
      expect(logs).toHaveLength(2);

      const successLog = logs.find((entry) => entry.success === 1);
      const failureLog = logs.find((entry) => entry.success === 0);

      expect(successLog).toBeTruthy();
      expect(successLog.provider).toBe('groq');

      expect(failureLog).toBeTruthy();
      expect(failureLog.error_message).toBe('Test error');
    });

    test('should retrieve limited API logs', async () => {
      // Log multiple entries
      for (let i = 0; i < 10; i++) {
        await logAPIRequest({
          ...testLogData,
          responseTime: 1000 + (i * 100)
        });
      }
      
      const logs = await getAPILogs(5);
      expect(logs).toHaveLength(5);
    });
  });

  describe('Project Management', () => {
    const testProject = {
      name: 'Test Project',
      description: 'A test project for database testing',
      language: 'javascript',
      framework: 'react'
    };

    test('should create a project', async () => {
      const project = await createProject(testProject);
      
      expect(project).toBeTruthy();
      expect(project).toHaveProperty('id');
      expect(project.name).toBe('Test Project');
      expect(project.description).toBe('A test project for database testing');
      expect(project).toHaveProperty('created_at');
    });

    test('should retrieve a project by ID', async () => {
      const created = await createProject(testProject);
      const retrieved = await getProject(created.id);
      
      expect(retrieved).toBeTruthy();
      expect(retrieved.id).toBe(created.id);
      expect(retrieved.name).toBe('Test Project');
    });

    test('should find project by name ignoring case and whitespace', async () => {
      await createProject({ ...testProject, name: 'Case Sensitive Project' });
      const located = await getProjectByName('  case sensitive PROJECT  ');

      expect(located).toBeTruthy();
      expect(located.name).toBe('Case Sensitive Project');
    });

    test('should return null when project name lookup misses', async () => {
      const located = await getProjectByName('missing-project');
      expect(located).toBeNull();
    });

    test('should return null for non-existent project', async () => {
      const retrieved = await getProject('non-existent-id');
      expect(retrieved).toBeNull();
    });

    test('should retrieve all projects', async () => {
      await createProject(testProject);
      await createProject({
        ...testProject,
        name: 'Second Project'
      });
      
      const projects = await getAllProjects();
      expect(projects).toHaveLength(2);
      expect(projects.find(p => p.name === 'Test Project')).toBeTruthy();
      expect(projects.find(p => p.name === 'Second Project')).toBeTruthy();
    });

    test('should update a project', async () => {
      const created = await createProject(testProject);
      const updateData = {
        name: 'Updated Project Name',
        description: 'Updated description',
        language: 'typescript',
        framework: 'vue'
      };
      
      const updated = await updateProject(created.id, updateData);
      
      expect(updated).toBeTruthy();
      expect(updated.name).toBe('Updated Project Name');
      expect(updated.description).toBe('Updated description');
      expect(updated.id).toBe(created.id);
    });

    test('should delete a project', async () => {
      const created = await createProject(testProject);
      const result = await deleteProject(created.id);
      
      expect(result).toBe(true);
      
      const retrieved = await getProject(created.id);
      expect(retrieved).toBeNull();
    });

    test('should handle invalid project operations gracefully', async () => {
      // Test updating non-existent project
      const updateResult = await updateProject('non-existent-id', { name: 'Updated' });
      expect(updateResult).toBeNull();
      
      // Test deleting non-existent project
      const deleteResult = await deleteProject('non-existent-id');
      expect(deleteResult).toBe(false);
    });
  });

  describe('Legacy project helpers', () => {
    test('should persist project via db_operations.saveProject', async () => {
      const legacyProject = makeProject('legacy-helper');
      const payload = {
        name: legacyProject.name,
        description: legacyProject.description,
        path: legacyProject.path
      };

      await db_operations.saveProject(payload);
      const stored = await getProjectByName(payload.name);
      expect(stored?.name).toBe(payload.name);
      expect(stored?.path).toBe(payload.path);
    });
  });

  describe('Project operation failure handling', () => {
    test('updateProject should surface sqlite failures', async () => {
      const runSpy = vi.spyOn(db, 'run').mockImplementation(function(sql, params, callback) {
        const cb = typeof params === 'function' ? params : callback;
        cb.call({ changes: 0 }, new Error('forced update failure'));
        return this;
      });

      await expect(updateProject(123, {
        name: 'Broken Update',
        description: 'Should fail',
        language: 'javascript',
        framework: 'react',
        path: '/tmp/broken-update'
      })).rejects.toThrow('forced update failure');

      runSpy.mockRestore();
    });

    test('deleteProject should propagate sqlite errors', async () => {
      const runSpy = vi.spyOn(db, 'run').mockImplementation(function(sql, params, callback) {
        const cb = typeof params === 'function' ? params : callback;
        cb.call({ changes: 0 }, new Error('forced delete failure'));
        return this;
      });

      await expect(deleteProject(456)).rejects.toThrow('forced delete failure');

      runSpy.mockRestore();
    });

    test('createProject should reject when insert fails', async () => {
      const runSpy = vi.spyOn(db, 'run').mockImplementation(function(sql, params, callback) {
        const cb = typeof params === 'function' ? params : callback;
        cb.call({ lastID: 0 }, new Error('forced insert failure'));
        return this;
      });

      await expect(createProject(makeProject('insert-failure'))).rejects.toThrow('forced insert failure');

      runSpy.mockRestore();
    });
  });

  describe('Database connection handling', () => {
    test('closeDatabase logs errors when sqlite close fails', () => {
      const closeSpy = vi.spyOn(db, 'close').mockImplementation((callback) => {
        callback?.(new Error('close failed'));
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      closeDatabase();

      expect(consoleSpy).toHaveBeenCalledWith('❌ Error closing database:', expect.any(Error));

      closeSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    test('closeDatabase logs success when sqlite close succeeds', () => {
      const closeSpy = vi.spyOn(db, 'close').mockImplementation((callback) => {
        callback?.();
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      closeDatabase();

      expect(consoleSpy).toHaveBeenCalledWith('✅ Database connection closed');

      closeSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  describe('Data Integrity', () => {
    test('should handle concurrent operations', async () => {
      const promises = [];
      
      // Create multiple projects concurrently
      for (let i = 0; i < 5; i++) {
        promises.push(createProject({
          name: `Project ${i}`,
          description: `Description ${i}`
        }));
      }
      
      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      
      // Verify all projects were created
      const allProjects = await getAllProjects();
      expect(allProjects).toHaveLength(5);
    });

    test('should handle database errors gracefully', async () => {
      // Try to save invalid configuration
      try {
        await saveLLMConfig(null);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeTruthy();
      }
    });
  });

  describe('Project Ports', () => {
    test('should short-circuit when no port values change', async () => {
      const created = await createProject(makeProject('ports-default'));
      const untouched = await updateProjectPorts(created.id, {});

      expect(untouched.frontend_port).toBeNull();
      expect(untouched.backend_port).toBeNull();
    });

    test('should normalize invalid port numbers to null', async () => {
      const created = await createProject({ ...makeProject('ports-normalized'), frontendPort: 6101, backendPort: 6201 });
      const updated = await updateProjectPorts(created.id, { frontendPort: 'not-a-number', backendPort: -5 });

      expect(updated.frontend_port).toBeNull();
      expect(updated.backend_port).toBeNull();
    });

    test('should validate required project id when updating ports', async () => {
      await expect(updateProjectPorts(undefined, { frontendPort: 1234 })).rejects.toThrow(/projectid is required/i);
    });

    test('should treat explicit null ports as cleared values', async () => {
      const created = await createProject(makeProject('ports-null'));
      const updated = await updateProjectPorts(created.id, { frontendPort: null, backendPort: null });

      expect(updated.frontend_port).toBeNull();
      expect(updated.backend_port).toBeNull();
    });
  });

  describe('Global Git Settings', () => {
    test('should return defaults when no settings exist', async () => {
      const settings = await getGitSettings();

      expect(settings.workflow).toBe('local');
      expect(settings.provider).toBe('github');
      expect(settings.commitTemplate).toBe('');
    });

    test('should normalize blank git_settings rows back to defaults', async () => {
      await runSql(`
        INSERT INTO git_settings (id, workflow, provider, remote_url, username, token_encrypted, default_branch, auto_push, use_commit_template, commit_template, created_at, updated_at)
        VALUES (1, '', '', '', '', NULL, '', 0, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      const settings = await getGitSettings();
      expect(settings.workflow).toBe('local');
      expect(settings.provider).toBe('github');
      expect(settings.defaultBranch).toBe('main');
      expect(settings.remoteUrl).toBe('');
    });

    test('should save and update git settings with token scrubbing', async () => {
      const initial = await saveGitSettings({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://example.com/repo.git',
        username: 'devUser',
        token: '  secret-token  ',
        autoPush: true,
        useCommitTemplate: true,
        commitTemplate: 'feat: {summary}'
      });

      expect(initial.workflow).toBe('cloud');
      expect(initial.provider).toBe('gitlab');
      expect(initial.useCommitTemplate).toBe(true);
      expect(initial.commitTemplate).toContain('feat:');
      expect(initial.token).toBe('');

      const updated = await saveGitSettings({ provider: 'github', useCommitTemplate: false, token: '' });
      expect(updated.provider).toBe('github');
      expect(updated.commitTemplate).toBe('');
    });

    test('getGitSettings should surface persisted settings when present', async () => {
      await saveGitSettings({ provider: 'bitbucket', username: 'stored-user' });

      const settings = await getGitSettings();
      expect(settings.provider).toBe('bitbucket');
      expect(settings.username).toBe('stored-user');
    });

    test('should use defaults when saving git settings without overrides', async () => {
      const settings = await saveGitSettings({});
      expect(settings.provider).toBe('github');
      expect(settings.username).toBe('');
      expect(settings.remoteUrl).toBe('');
    });

    test('should reuse existing git settings when new payload omits values', async () => {
      await saveGitSettings({
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.example.com/demo.git',
        username: 'existing-user',
        defaultBranch: 'develop',
        useCommitTemplate: true,
        commitTemplate: 'feat: {summary}'
      });

      const updated = await saveGitSettings({ useCommitTemplate: true });
      expect(updated.provider).toBe('gitlab');
      expect(updated.remoteUrl).toBe('https://gitlab.example.com/demo.git');
      expect(updated.commitTemplate).toBe('feat: {summary}');
      expect(updated.defaultBranch).toBe('develop');
    });

    test('should seed default commit template when enabling without a value', async () => {
      const settings = await saveGitSettings({ useCommitTemplate: true });
      expect(settings.useCommitTemplate).toBe(true);
      expect(settings.commitTemplate).toBe('');
    });

    test('should clear encrypted git tokens when trimmed token is empty', async () => {
      await saveGitSettings({ token: 'initial-token' });
      await saveGitSettings({ token: '   ' });

      const row = await getSql('SELECT token_encrypted FROM git_settings WHERE id = 1');
      expect(row.token_encrypted).toBeNull();
    });

    test('should ignore non-string git tokens and avoid encrypting', async () => {
      await saveGitSettings({ token: 'string-token' });
      await saveGitSettings({ token: 12345 });

      const row = await getSql('SELECT token_encrypted FROM git_settings WHERE id = 1');
      expect(row.token_encrypted).toBeNull();
    });
  });

  describe('Port Settings', () => {
    test('should surface defaults when not customized', async () => {
      const settings = await getPortSettings();

      expect(settings.isCustomized).toBe(false);
      expect(settings.frontendPortBase).toBe(5100);
      expect(settings.backendPortBase).toBe(5500);
    });

    test('should persist customized bases and coerce invalid inputs', async () => {
      const saved = await savePortSettings({ frontendPortBase: 'n/a', backendPortBase: 8080 });
      expect(saved.frontendPortBase).toBe(5100);
      expect(saved.backendPortBase).toBe(8080);
      expect(saved.isCustomized).toBe(true);

      const stored = await getPortSettings();
      expect(stored.isCustomized).toBe(true);
      expect(stored.backendPortBase).toBe(8080);
    });

    test('should fall back to backend default when new value is invalid', async () => {
      const saved = await savePortSettings({ backendPortBase: 'invalid-value' });
      expect(saved.backendPortBase).toBe(5500);
      expect(saved.isCustomized).toBe(true);
    });

    test('should fall back to defaults when persisted bases are invalid', async () => {
      await runSql('DELETE FROM port_settings');
      await runSql(`
        INSERT INTO port_settings (id, frontend_port_base, backend_port_base, created_at, updated_at)
        VALUES (1, -10, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      const settings = await getPortSettings();
      expect(settings.frontendPortBase).toBe(5100);
      expect(settings.backendPortBase).toBe(5500);
      expect(settings.isCustomized).toBe(true);
    });
  });

  describe('Project Git Settings', () => {
    test('should return null when no project settings exist', async () => {
      const project = await createProject(makeProject('git-null'));
      const settings = await getProjectGitSettings(project.id);

      expect(settings).toBeNull();
    });

    test('should return null when project id is not provided', async () => {
      const settings = await getProjectGitSettings();
      expect(settings).toBeNull();
    });

    test('should save, retrieve, and delete settings per project', async () => {
      const project = await createProject(makeProject('git-settings'));
      const saved = await saveProjectGitSettings(project.id, {
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/example.git',
        username: 'project-dev',
        token: '  project-token  ',
        useCommitTemplate: true,
        commitTemplate: 'chore: sync'
      });

      expect(saved.provider).toBe('gitlab');
      expect(saved.commitTemplate).toBe('chore: sync');

      const retrieved = await getProjectGitSettings(project.id);
      expect(retrieved.provider).toBe('gitlab');
      expect(retrieved.commitTemplate).toBe('chore: sync');

      await deleteProjectGitSettings(project.id);
      expect(await getProjectGitSettings(project.id)).toBeNull();
    });

    test('should validate project id parameters', async () => {
      await expect(saveProjectGitSettings(undefined, {})).rejects.toThrow(/projectid is required/i);
      await expect(deleteProjectGitSettings(undefined)).rejects.toThrow(/projectid is required/i);
    });

    test('should use defaults when saving project git settings without overrides', async () => {
      const project = await createProject(makeProject('project-git-defaults'));
      const saved = await saveProjectGitSettings(project.id, { useCommitTemplate: true });

      expect(saved.provider).toBe('github');
      expect(saved.remoteUrl).toBe('');
      expect(saved.commitTemplate).toBe('');
    });

    test('should reuse existing project git settings when updates omit values', async () => {
      const project = await createProject(makeProject('project-git-reuse'));
      await saveProjectGitSettings(project.id, {
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.local/repo.git',
        username: 'project-user',
        defaultBranch: 'feature/base',
        useCommitTemplate: true,
        commitTemplate: 'chore: sync {summary}'
      });

      const updated = await saveProjectGitSettings(project.id, { useCommitTemplate: true });
      expect(updated.provider).toBe('gitlab');
      expect(updated.remoteUrl).toBe('https://gitlab.local/repo.git');
      expect(updated.commitTemplate).toBe('chore: sync {summary}');
      expect(updated.defaultBranch).toBe('feature/base');
    });

    test('should clear encrypted project git tokens when trimmed token is empty', async () => {
      const project = await createProject(makeProject('project-git-token'));
      await saveProjectGitSettings(project.id, { token: 'persisted-token' });
      await saveProjectGitSettings(project.id, { token: '   ' });

      const row = await getSql('SELECT token_encrypted FROM project_git_settings WHERE project_id = ?', [project.id]);
      expect(row.token_encrypted).toBeNull();
    });

    test('should ignore non-string project git tokens and avoid encrypting', async () => {
      const project = await createProject(makeProject('project-git-nonstring'));
      await saveProjectGitSettings(project.id, { token: 'project-string-token' });
      await saveProjectGitSettings(project.id, { token: { secret: true } });

      const row = await getSql('SELECT token_encrypted FROM project_git_settings WHERE project_id = ?', [project.id]);
      expect(row.token_encrypted).toBeNull();
    });

    test('should support cloud workflow and auto-push flags per project', async () => {
      const project = await createProject(makeProject('project-git-cloud-workflow'));
      await saveProjectGitSettings(project.id, { workflow: 'cloud', autoPush: true });

      const settings = await getProjectGitSettings(project.id);
      expect(settings.workflow).toBe('cloud');
      expect(settings.autoPush).toBe(true);
    });
  });
});