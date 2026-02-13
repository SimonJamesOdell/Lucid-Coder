import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import { encryptApiKey, decryptApiKey } from './encryption.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveUserDataDir = (runtime = {}) => {
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  const homedir = runtime.homedir ?? os.homedir;

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || env.APPDATA;
    return base ? path.join(base, 'LucidCoder') : null;
  }

  if (platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'LucidCoder');
  }

  const xdgDataHome = env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'lucidcoder');
  }

  return path.join(homedir(), '.local', 'share', 'lucidcoder');
};

const resolveDbBaseDir = (runtime = {}) => {
  const env = runtime.env ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const dirName = runtime.dirName ?? __dirname;

  // Tests should keep the DB under the repo to keep fixtures predictable.
  if (env.NODE_ENV === 'test') {
    return dirName;
  }

  if (env.LUCIDCODER_DB_DIR) {
    return path.isAbsolute(env.LUCIDCODER_DB_DIR)
      ? env.LUCIDCODER_DB_DIR
      : path.join(cwd, env.LUCIDCODER_DB_DIR);
  }

  const userDataDir = resolveUserDataDir(runtime);
  return userDataDir || dirName;
};

// Determine database path (tests can override with DATABASE_PATH)
const resolveDbPath = (runtime = {}) => {
  const env = runtime.env ?? process.env;
  const cwd = runtime.cwd ?? process.cwd();
  const dirName = runtime.dirName ?? __dirname;
  const fsImpl = runtime.fs ?? fs;

  if (env.DATABASE_PATH) {
    return path.isAbsolute(env.DATABASE_PATH)
      ? env.DATABASE_PATH
      : path.join(cwd, env.DATABASE_PATH)
  }
  const defaultName = env.NODE_ENV === 'test'
    ? 'test-lucidcoder.db'
    : 'lucidcoder.db'

  const baseDir = resolveDbBaseDir(runtime);
  const resolved = path.join(baseDir, defaultName);

  // Best-effort legacy migration: if the DB previously lived under backend/,
  // carry it over to the new default location exactly once.
  if (
    env.NODE_ENV !== 'test' &&
    !env.LUCIDCODER_DB_DIR &&
    !env.DATABASE_PATH
  ) {
    const legacyPath = path.join(dirName, defaultName);
    try {
      if (legacyPath !== resolved && fsImpl.existsSync(legacyPath) && !fsImpl.existsSync(resolved)) {
        fsImpl.mkdirSync(baseDir, { recursive: true });
        fsImpl.copyFileSync(legacyPath, resolved);
      }
    } catch {
      // Best-effort only: never prevent startup.
    }
  }

  return resolved;
}

export const __private__ = {
  resolveUserDataDir,
  resolveDbBaseDir,
  resolveDbPath
};

const dbPath = resolveDbPath()

try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
} catch {
  // Best-effort.
}

if (process.env.NODE_ENV !== 'test') {
  console.log(`\uD83D\uDDC4\uFE0F Using SQLite DB: ${dbPath}`);
}

const db = new sqlite3.Database(dbPath);

// Promisify database methods
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

const defaultGitSettingsRecord = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  defaultBranch: 'main',
  autoPush: false,
  useCommitTemplate: false,
  commitTemplate: '',
  tokenExpiresAt: null,
  tokenPresent: false,
  token: ''
};

const defaultPortSettingsRecord = {
  frontendPortBase: Number(process.env.LUCIDCODER_PROJECT_FRONTEND_PORT_BASE) || 5100,
  backendPortBase: Number(process.env.LUCIDCODER_PROJECT_BACKEND_PORT_BASE) || 5500
};

const defaultTestingSettingsRecord = {
  coverageTarget: 100
};

const normalizePortValue = (value) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

const ensureTableColumn = async (tableName, columnName, definition) => {
  const columns = await dbAll(`PRAGMA table_info(${tableName})`);
  const hasColumn = columns?.some((column) => column.name === columnName);
  if (!hasColumn) {
    await dbRun(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const normalizeGitSettingsRow = (row = {}) => ({
  workflow: row.workflow || defaultGitSettingsRecord.workflow,
  provider: row.provider || defaultGitSettingsRecord.provider,
  remoteUrl: row.remote_url || defaultGitSettingsRecord.remoteUrl,
  username: row.username || defaultGitSettingsRecord.username,
  defaultBranch: row.default_branch || defaultGitSettingsRecord.defaultBranch,
  autoPush: Boolean(row.auto_push),
  useCommitTemplate: Boolean(row.use_commit_template),
  commitTemplate: row.commit_template || defaultGitSettingsRecord.commitTemplate,
  tokenExpiresAt: row.token_expires_at || defaultGitSettingsRecord.tokenExpiresAt,
  tokenPresent: Boolean(row.token_encrypted),
  token: ''
});

// Initialize database tables
export const initializeDatabase = async () => {
  try {
    // LLM Configuration table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS llm_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        api_url TEXT NOT NULL,
        api_key_encrypted TEXT,
        requires_api_key BOOLEAN DEFAULT 1,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add endpoint_path column for storing the probed API endpoint (e.g. /responses)
    await ensureTableColumn('llm_config', 'endpoint_path', 'TEXT');

    // API Request logs table (for debugging and monitoring)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_type TEXT NOT NULL,
        response_time INTEGER,
        success BOOLEAN,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Append-only audit log (user requests + agent actions).
    await dbRun(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        method TEXT,
        path TEXT,
        status_code INTEGER,
        project_id INTEGER,
        session_id TEXT,
        payload TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Runs (canonical execution unit for goal/autopilot work).
    await dbRun(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        goal_id INTEGER,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        status_message TEXT,
        metadata TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        finished_at DATETIME
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        session_event_id TEXT,
        timestamp DATETIME NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        payload TEXT,
        meta TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      )
    `);

    // Trace-oriented fields (kept optional for backward compatibility).
    await ensureTableColumn('run_events', 'correlation_id', 'TEXT');
    await ensureTableColumn('run_events', 'source', 'TEXT');
    await ensureTableColumn('run_events', 'level', 'TEXT');

    // Common indexes for timeline/pagination queries.
    await dbRun('CREATE INDEX IF NOT EXISTS idx_run_events_run_id_id ON run_events(run_id, id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_run_events_run_id_type_id ON run_events(run_id, type, id)');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_run_events_correlation_id ON run_events(correlation_id)');

    await ensureTableColumn('runs', 'status_message', 'TEXT');
    await ensureTableColumn('runs', 'metadata', 'TEXT');
    await ensureTableColumn('runs', 'error', 'TEXT');
    await ensureTableColumn('runs', 'started_at', 'DATETIME');
    await ensureTableColumn('runs', 'finished_at', 'DATETIME');
    await ensureTableColumn('runs', 'session_id', 'TEXT');
    await ensureTableColumn('runs', 'goal_id', 'INTEGER');

    // Projects table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        language TEXT NOT NULL DEFAULT 'javascript',
        framework TEXT NOT NULL DEFAULT 'react',
        path TEXT,
        frontend_language TEXT,
        frontend_framework TEXT,
        backend_language TEXT,
        backend_framework TEXT,
        status TEXT DEFAULT 'created',
        frontend_port INTEGER,
        backend_port INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Ensure legacy databases get the new port columns
    await ensureTableColumn('projects', 'frontend_port', 'INTEGER');
    await ensureTableColumn('projects', 'backend_port', 'INTEGER');

    await dbRun(`
      CREATE TABLE IF NOT EXISTS git_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        workflow TEXT NOT NULL DEFAULT 'local',
        provider TEXT NOT NULL DEFAULT 'github',
        remote_url TEXT,
        username TEXT,
        token_encrypted TEXT,
        token_expires_at TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        auto_push INTEGER NOT NULL DEFAULT 0,
        use_commit_template INTEGER NOT NULL DEFAULT 0,
        commit_template TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS project_git_settings (
        project_id INTEGER PRIMARY KEY,
        workflow TEXT NOT NULL DEFAULT 'local',
        provider TEXT NOT NULL DEFAULT 'github',
        remote_url TEXT,
        username TEXT,
        token_encrypted TEXT,
        token_expires_at TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        auto_push INTEGER NOT NULL DEFAULT 0,
        use_commit_template INTEGER NOT NULL DEFAULT 0,
        commit_template TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    await ensureTableColumn('git_settings', 'token_expires_at', 'TEXT');
    await ensureTableColumn('project_git_settings', 'token_expires_at', 'TEXT');

    await dbRun(`
      CREATE TABLE IF NOT EXISTS port_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        frontend_port_base INTEGER NOT NULL DEFAULT ${defaultPortSettingsRecord.frontendPortBase},
        backend_port_base INTEGER NOT NULL DEFAULT ${defaultPortSettingsRecord.backendPortBase},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS testing_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        coverage_target INTEGER NOT NULL DEFAULT ${defaultTestingSettingsRecord.coverageTarget},
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Branch workflow tables
    await dbRun(`
      CREATE TABLE IF NOT EXISTS branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL DEFAULT 'feature',
        status TEXT NOT NULL DEFAULT 'active',
        is_current BOOLEAN NOT NULL DEFAULT 0,
        ahead_commits INTEGER NOT NULL DEFAULT 0,
        behind_commits INTEGER NOT NULL DEFAULT 0,
        last_test_run_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, name),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    await ensureTableColumn('branches', 'staged_files', 'TEXT');

    await dbRun(`
      CREATE TABLE IF NOT EXISTS test_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        branch_id INTEGER,
        status TEXT NOT NULL,
        summary TEXT,
        details TEXT,
        total_tests INTEGER DEFAULT 0,
        passed_tests INTEGER DEFAULT 0,
        failed_tests INTEGER DEFAULT 0,
        skipped_tests INTEGER DEFAULT 0,
        duration REAL,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(branch_id) REFERENCES branches(id) ON DELETE SET NULL
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS agent_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        lifecycle_state TEXT NOT NULL DEFAULT 'draft',
        branch_name TEXT NOT NULL,
        parent_goal_id INTEGER,
        title TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);

    // Ensure legacy databases get the lifecycle_state column.
    await ensureTableColumn('agent_goals', 'lifecycle_state', "TEXT NOT NULL DEFAULT 'draft'");

    // Ensure legacy databases get the parent_goal_id column.
    await ensureTableColumn('agent_goals', 'parent_goal_id', 'INTEGER');

    // Ensure legacy databases can store human-friendly titles.
    await ensureTableColumn('agent_goals', 'title', 'TEXT');

    await dbRun(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(goal_id) REFERENCES agent_goals(id) ON DELETE CASCADE
      )
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
};

export const getGitSettingsToken = async () => {
  const row = await dbGet('SELECT token_encrypted FROM git_settings WHERE id = 1');
  if (!row?.token_encrypted) {
    return null;
  }
  return decryptApiKey(row.token_encrypted, { quiet: true });
};

// Database operations
export const db_operations = {
  // LLM Configuration operations
  async saveLLMConfig(config) {
    const { provider, model, apiUrl, apiKeyEncrypted, requiresApiKey, endpointPath } = config;
    
    // First, deactivate any existing active config
    await dbRun('UPDATE llm_config SET is_active = 0 WHERE is_active = 1');
    
    // Insert new config
    await dbRun(`
      INSERT INTO llm_config (provider, model, api_url, api_key_encrypted, requires_api_key, is_active, endpoint_path)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `, [provider, model, apiUrl, apiKeyEncrypted, requiresApiKey, endpointPath || null]);
    
    return true;
  },

  async getActiveLLMConfig() {
    const config = await dbGet('SELECT * FROM llm_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1');
    return config || null;
  },

  async getAllLLMConfigs() {
    const configs = await dbAll('SELECT * FROM llm_config ORDER BY created_at DESC');
    return configs;
  },

  // API logging operations
  async logAPIRequest(logData) {
    const { provider, model, requestType, responseTime, success, errorMessage } = logData;
    
    await dbRun(`
      INSERT INTO api_logs (provider, model, request_type, response_time, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [provider, model, requestType, responseTime, success, errorMessage]);
    
    return true;
  },

  // Get API logs
  async getAPILogs(limit = null) {
    const query = limit ? 
      'SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ?' : 
      'SELECT * FROM api_logs ORDER BY created_at DESC';
    
    const params = limit ? [limit] : [];
    const logs = await dbAll(query, params);
    return logs;
  },

  // Project operations (for future use)
  async saveProject(project) {
    const { name, description, path } = project;
    
    const result = await dbRun(`
      INSERT INTO projects (name, description, path)
      VALUES (?, ?, ?)
    `, [name, description, path]);
    
    return result;
  },

  async getAllProjects() {
    const projects = await dbAll('SELECT * FROM projects ORDER BY created_at DESC');
    return projects;
  },

  async getProject(id) {
    const project = await dbGet('SELECT * FROM projects WHERE id = ?', [id]);
    return project || null;
  },

  async updateProject(id, updates) {
    const { name, description, language, framework, path } = updates;
    
    return new Promise((resolve, reject) => {
      db.run(`
        UPDATE projects 
        SET name = ?, description = ?, language = ?, framework = ?, path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [name, description, language, framework, path, id], function(err) {
        if (err) {
          reject(err);
        } else if (this.changes === 0) {
          resolve(null);
        } else {
          db_operations.getProject(id).then(resolve).catch(reject);
        }
      });
    });
  },

  async deleteProject(id) {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM projects WHERE id = ?', [id], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  },

  async getProjectByName(name) {
    const normalizedName = name.trim().toLowerCase();
    const project = await dbGet('SELECT * FROM projects WHERE LOWER(TRIM(name)) = ?', [normalizedName]);
    return project || null;
  },

  async createProject(project) {
    const {
      name,
      description,
      language = 'javascript',
      framework = 'react',
      path,
      frontendPort,
      backendPort
    } = project;
    
    return new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO projects (name, description, language, framework, path, frontend_port, backend_port)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        name,
        description,
        language,
        framework,
        path,
        normalizePortValue(frontendPort) ?? null,
        normalizePortValue(backendPort) ?? null
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          // Use this.lastID which is available in the callback context
          db_operations.getProject(this.lastID).then(resolve).catch(reject);
        }
      });
    });
  },

  async updateProjectPorts(projectId, ports = {}) {
    if (!projectId) {
      throw new Error('projectId is required to update ports');
    }

    const setClauses = [];
    const params = [];

    if (Object.prototype.hasOwnProperty.call(ports, 'frontendPort')) {
      setClauses.push('frontend_port = ?');
      params.push(normalizePortValue(ports.frontendPort));
    }

    if (Object.prototype.hasOwnProperty.call(ports, 'backendPort')) {
      setClauses.push('backend_port = ?');
      params.push(normalizePortValue(ports.backendPort));
    }

    if (setClauses.length === 0) {
      return db_operations.getProject(projectId);
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(projectId);

    await dbRun(`
      UPDATE projects
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `, params);

    return db_operations.getProject(projectId);
  },

  async saveGitSettings(settings = {}) {
    const existing = await dbGet('SELECT * FROM git_settings WHERE id = 1');

    const workflow = settings.workflow === 'cloud' ? 'cloud' : 'local';
    const provider = (settings.provider || existing?.provider || defaultGitSettingsRecord.provider);
    const remoteUrl = settings.remoteUrl ?? existing?.remote_url ?? defaultGitSettingsRecord.remoteUrl;
    const username = settings.username ?? existing?.username ?? defaultGitSettingsRecord.username;
    const defaultBranch = settings.defaultBranch || existing?.default_branch || defaultGitSettingsRecord.defaultBranch;
    const autoPush = settings.autoPush ? 1 : 0;
    const useCommitTemplate = settings.useCommitTemplate ? 1 : 0;
    const commitTemplate = useCommitTemplate
      ? (settings.commitTemplate ?? existing?.commit_template ?? defaultGitSettingsRecord.commitTemplate)
      : '';
    const tokenExpiresAt = Object.prototype.hasOwnProperty.call(settings, 'tokenExpiresAt')
      ? (settings.tokenExpiresAt || null)
      : (existing?.token_expires_at ?? defaultGitSettingsRecord.tokenExpiresAt);

    let tokenEncrypted = existing?.token_encrypted || null;
    if (Object.prototype.hasOwnProperty.call(settings, 'token')) {
      const tokenValue = typeof settings.token === 'string' ? settings.token.trim() : '';
      if (tokenValue) {
        tokenEncrypted = encryptApiKey(tokenValue);
        if (!tokenEncrypted) {
          throw new Error('Failed to encrypt Git token. Check ENCRYPTION_KEY configuration.');
        }
      } else {
        tokenEncrypted = null;
      }
    }

    await dbRun(`
      INSERT INTO git_settings (id, workflow, provider, remote_url, username, token_encrypted, token_expires_at, default_branch, auto_push, use_commit_template, commit_template, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        workflow = excluded.workflow,
        provider = excluded.provider,
        remote_url = excluded.remote_url,
        username = excluded.username,
        token_encrypted = excluded.token_encrypted,
        token_expires_at = excluded.token_expires_at,
        default_branch = excluded.default_branch,
        auto_push = excluded.auto_push,
        use_commit_template = excluded.use_commit_template,
        commit_template = excluded.commit_template,
        updated_at = CURRENT_TIMESTAMP
    `, [
      workflow,
      provider,
      remoteUrl,
      username,
      tokenEncrypted,
      tokenExpiresAt,
      defaultBranch,
      autoPush,
      useCommitTemplate,
      commitTemplate
    ]);

    const row = await dbGet('SELECT * FROM git_settings WHERE id = 1');
    return normalizeGitSettingsRow(row);
  },

  async getGitSettings() {
    const row = await dbGet('SELECT * FROM git_settings WHERE id = 1');
    if (!row) {
      return defaultGitSettingsRecord;
    }
    return normalizeGitSettingsRow(row);
  },

  async savePortSettings(settings = {}) {
    const frontendPortBase = normalizePortValue(settings.frontendPortBase) || defaultPortSettingsRecord.frontendPortBase;
    const backendPortBase = normalizePortValue(settings.backendPortBase) || defaultPortSettingsRecord.backendPortBase;

    await dbRun(`
      INSERT INTO port_settings (id, frontend_port_base, backend_port_base, created_at, updated_at)
      VALUES (1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        frontend_port_base = excluded.frontend_port_base,
        backend_port_base = excluded.backend_port_base,
        updated_at = CURRENT_TIMESTAMP
    `, [frontendPortBase, backendPortBase]);

    return {
      frontendPortBase,
      backendPortBase,
      isCustomized: true
    };
  },

  async getPortSettings() {
    const row = await dbGet('SELECT * FROM port_settings WHERE id = 1');
    if (!row) {
      return { ...defaultPortSettingsRecord, isCustomized: false };
    }
    return {
      frontendPortBase: normalizePortValue(row.frontend_port_base) || defaultPortSettingsRecord.frontendPortBase,
      backendPortBase: normalizePortValue(row.backend_port_base) || defaultPortSettingsRecord.backendPortBase,
      isCustomized: true
    };
  },

  async saveTestingSettings(settings = {}) {
    const parsed = Number(settings.coverageTarget);
    const coverageTarget = Number.isInteger(parsed)
      ? Math.max(50, Math.min(100, parsed))
      : defaultTestingSettingsRecord.coverageTarget;

    await dbRun(`
      INSERT INTO testing_settings (id, coverage_target, created_at, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        coverage_target = excluded.coverage_target,
        updated_at = CURRENT_TIMESTAMP
    `, [coverageTarget]);

    return {
      coverageTarget
    };
  },

  async getTestingSettings() {
    const row = await dbGet('SELECT * FROM testing_settings WHERE id = 1');
    if (!row) {
      return { ...defaultTestingSettingsRecord };
    }

    const parsed = Number(row.coverage_target);
    const coverageTarget = Number.isInteger(parsed)
      ? Math.max(50, Math.min(100, parsed))
      : defaultTestingSettingsRecord.coverageTarget;

    return { coverageTarget };
  },

  async saveProjectGitSettings(projectId, settings = {}) {
    if (!projectId) {
      throw new Error('projectId is required');
    }

    const existing = await dbGet('SELECT * FROM project_git_settings WHERE project_id = ?', [projectId]);

    const workflow = settings.workflow === 'cloud' ? 'cloud' : 'local';
    const provider = settings.provider || existing?.provider || defaultGitSettingsRecord.provider;
    const remoteUrl = settings.remoteUrl ?? existing?.remote_url ?? defaultGitSettingsRecord.remoteUrl;
    const username = settings.username ?? existing?.username ?? defaultGitSettingsRecord.username;
    const defaultBranch = settings.defaultBranch || existing?.default_branch || defaultGitSettingsRecord.defaultBranch;
    const autoPush = settings.autoPush ? 1 : 0;
    const useCommitTemplate = settings.useCommitTemplate ? 1 : 0;
    const commitTemplate = useCommitTemplate
      ? (settings.commitTemplate ?? existing?.commit_template ?? defaultGitSettingsRecord.commitTemplate)
      : '';
    const tokenExpiresAt = Object.prototype.hasOwnProperty.call(settings, 'tokenExpiresAt')
      ? (settings.tokenExpiresAt || null)
      : (existing?.token_expires_at ?? defaultGitSettingsRecord.tokenExpiresAt);

    let tokenEncrypted = existing?.token_encrypted || null;
    if (Object.prototype.hasOwnProperty.call(settings, 'token')) {
      const tokenValue = typeof settings.token === 'string' ? settings.token.trim() : '';
      if (tokenValue) {
        tokenEncrypted = encryptApiKey(tokenValue);
        if (!tokenEncrypted) {
          throw new Error('Failed to encrypt Git token. Check ENCRYPTION_KEY configuration.');
        }
      } else {
        tokenEncrypted = null;
      }
    }

    await dbRun(`
      INSERT INTO project_git_settings (project_id, workflow, provider, remote_url, username, token_encrypted, token_expires_at, default_branch, auto_push, use_commit_template, commit_template, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(project_id) DO UPDATE SET
        workflow = excluded.workflow,
        provider = excluded.provider,
        remote_url = excluded.remote_url,
        username = excluded.username,
        token_encrypted = excluded.token_encrypted,
        token_expires_at = excluded.token_expires_at,
        default_branch = excluded.default_branch,
        auto_push = excluded.auto_push,
        use_commit_template = excluded.use_commit_template,
        commit_template = excluded.commit_template,
        updated_at = CURRENT_TIMESTAMP
    `, [
      projectId,
      workflow,
      provider,
      remoteUrl,
      username,
      tokenEncrypted,
      tokenExpiresAt,
      defaultBranch,
      autoPush,
      useCommitTemplate,
      commitTemplate
    ]);

    const row = await dbGet('SELECT * FROM project_git_settings WHERE project_id = ?', [projectId]);
    return normalizeGitSettingsRow(row);
  },

  async getProjectGitSettings(projectId) {
    if (!projectId) {
      return null;
    }
    const row = await dbGet('SELECT * FROM project_git_settings WHERE project_id = ?', [projectId]);
    if (!row) {
      return null;
    }
    return normalizeGitSettingsRow(row);
  },

  async deleteProjectGitSettings(projectId) {
    if (!projectId) {
      throw new Error('projectId is required');
    }
    await dbRun('DELETE FROM project_git_settings WHERE project_id = ?', [projectId]);
    return true;
  }
};

// Close database connection
// Individual exports for easier testing
export const saveLLMConfig = db_operations.saveLLMConfig;
export const getLLMConfig = db_operations.getActiveLLMConfig;
export const logAPIRequest = db_operations.logAPIRequest;
export const getAPILogs = db_operations.getAPILogs;
export const createProject = db_operations.createProject;
export const getProject = db_operations.getProject;
export const getProjectByName = db_operations.getProjectByName;
export const getAllProjects = db_operations.getAllProjects;
export const updateProject = db_operations.updateProject;
export const deleteProject = db_operations.deleteProject;
export const updateProjectPorts = db_operations.updateProjectPorts;
export const saveGitSettings = db_operations.saveGitSettings;
export const getGitSettings = db_operations.getGitSettings;
export const savePortSettings = db_operations.savePortSettings;
export const getPortSettings = db_operations.getPortSettings;
export const saveTestingSettings = db_operations.saveTestingSettings;
export const getTestingSettings = db_operations.getTestingSettings;
export const saveProjectGitSettings = db_operations.saveProjectGitSettings;
export const getProjectGitSettings = db_operations.getProjectGitSettings;
export const deleteProjectGitSettings = db_operations.deleteProjectGitSettings;

export const closeDatabase = () => {
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err);
    } else {
      console.log('✅ Database connection closed');
    }
  });
};

export default db;