import os from 'os';
import db from '../database.js';
import { VERSION } from '../../shared/version.mjs';
import { logBuffer } from './logBuffer.js';

const SENSITIVE_KEY_PATTERN = /token|apiKey|api_key|password|secret|encrypted/i;

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row || null);
  });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows || []);
  });
});

const parseJson = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const redactSensitiveValues = (value) => {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = redactSensitiveValues(entry);
  }
  return result;
};

const getTableCount = async (table) => {
  const row = await dbGet(`SELECT COUNT(*) as count FROM ${table}`);
  return Number.isFinite(row?.count) ? row.count : Number(row?.count ?? 0);
};

const listRecentRunEvents = async (limit = 100) => {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
  const rows = await dbAll(
    `SELECT id, run_id, session_event_id, timestamp, type, level, source, correlation_id, message, payload, meta, created_at
     FROM run_events
     ORDER BY id DESC
     LIMIT ?`,
    [normalizedLimit]
  );

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    sessionEventId: row.session_event_id ?? null,
    timestamp: row.timestamp,
    type: row.type,
    level: row.level ?? null,
    source: row.source ?? null,
    correlationId: row.correlation_id ?? null,
    message: row.message ?? '',
    payload: redactSensitiveValues(parseJson(row.payload)),
    meta: redactSensitiveValues(parseJson(row.meta)),
    createdAt: row.created_at ?? null
  }));
};

const listRecentAuditLogs = async (limit = 50) => {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const rows = await dbAll(
    `SELECT id, source, event_type, method, path, status_code, project_id, session_id, payload, created_at
     FROM audit_logs
     ORDER BY id DESC
     LIMIT ?`,
    [normalizedLimit]
  );

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    eventType: row.event_type,
    method: row.method,
    path: row.path,
    statusCode: row.status_code,
    projectId: row.project_id ?? null,
    sessionId: row.session_id ?? null,
    payload: redactSensitiveValues(parseJson(row.payload) ?? row.payload ?? null),
    createdAt: row.created_at ?? null
  }));
};

const getDatabaseStats = async () => {
  const tables = [
    'projects',
    'branches',
    'test_runs',
    'agent_goals',
    'agent_tasks',
    'runs',
    'run_events',
    'audit_logs',
    'api_logs',
    'llm_config',
    'git_settings',
    'project_git_settings',
    'port_settings'
  ];

  const counts = {};
  await Promise.all(
    tables.map(async (table) => {
      try {
        counts[table] = await getTableCount(table);
      } catch {
        counts[table] = null;
      }
    })
  );

  return {
    databasePath: process.env.DATABASE_PATH || null,
    counts
  };
};

const getEnvironmentInfo = () => {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    hostname: os.hostname(),
    cpus: os.cpus()?.length ?? null,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem()
  };
};

const getSafeEnvSnapshot = () => {
  const allowed = [
    'NODE_ENV',
    'PORT',
    'DATABASE_PATH',
    'PROJECTS_DIR',
    'ENABLE_SOCKET_IO',
    'E2E_SKIP_SCAFFOLDING'
  ];

  const values = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      values[key] = process.env[key];
    }
  }

  return {
    allowedKeys: allowed,
    values
  };
};

export const buildDiagnosticsBundle = async ({
  runEventsLimit = 100,
  auditLogsLimit = 50,
  logsLimit = 200
} = {}) => {
  const generatedAt = new Date().toISOString();

  const [database, runEvents, auditLogs] = await Promise.all([
    getDatabaseStats(),
    listRecentRunEvents(runEventsLimit),
    listRecentAuditLogs(auditLogsLimit)
  ]);

  return {
    generatedAt,
    version: VERSION,
    environment: getEnvironmentInfo(),
    env: getSafeEnvSnapshot(),
    database,
    recent: {
      logs: logBuffer.list({ limit: logsLimit }),
      auditLogs,
      runEvents
    }
  };
};

export const __diagnosticsTesting = {
  dbGet,
  dbAll,
  parseJson,
  redactSensitiveValues,
  getTableCount,
  listRecentRunEvents,
  listRecentAuditLogs,
  getDatabaseStats,
  getEnvironmentInfo,
  getSafeEnvSnapshot
};
