import db from '../database.js';

const DEFAULT_MAX_PAYLOAD_CHARS = 10_000;

const pendingWrites = new Set();

const nowIso = () => new Date().toISOString();

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ lastID: this?.lastID ?? null, changes: this?.changes ?? null });
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows || []);
    });
  });
};

const safeJsonStringify = (value, { maxChars = DEFAULT_MAX_PAYLOAD_CHARS } = {}) => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return null;
    }
    if (serialized.length <= maxChars) {
      return serialized;
    }
    return serialized.slice(0, maxChars);
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
    if (/token|apiKey|api_key|password|secret/i.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    result[key] = redactSensitiveValues(entry);
  }
  return result;
};

const extractProjectId = (req) => {
  const candidate = req?.params?.projectId ?? req?.params?.id;
  const parsed = Number(candidate);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  const originalUrl = typeof req?.originalUrl === 'string' ? req.originalUrl : '';
  const match = originalUrl.match(/\/api\/projects\/(\d+)\b/i);
  if (match) {
    const fromPath = Number(match[1]);
    if (Number.isInteger(fromPath) && fromPath > 0) {
      return fromPath;
    }
  }

  return null;
};

export const appendAuditLog = async (event) => {
  const source = typeof event?.source === 'string' && event.source.trim() ? event.source.trim() : 'unknown';
  const eventType = typeof event?.eventType === 'string' && event.eventType.trim() ? event.eventType.trim() : 'unknown';
  const method = typeof event?.method === 'string' ? event.method : null;
  const path = typeof event?.path === 'string' ? event.path : null;
  const statusCode = Number.isInteger(event?.statusCode) ? event.statusCode : null;
  const projectId = Number.isInteger(event?.projectId) ? event.projectId : null;
  const sessionId = typeof event?.sessionId === 'string' ? event.sessionId : null;

  const payload = safeJsonStringify(redactSensitiveValues(event?.payload ?? null));

  const promise = dbRun(
    `INSERT INTO audit_logs (source, event_type, method, path, status_code, project_id, session_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [source, eventType, method, path, statusCode, projectId, sessionId, payload]
  );

  pendingWrites.add(promise);
  try {
    await promise;
  } finally {
    pendingWrites.delete(promise);
  }
};

export const auditHttpRequestsMiddleware = (options = {}) => {
  const {
    source = 'http',
    shouldLog = (req) => {
      const method = String(req?.method || '').toUpperCase();
      if (!/^\/api\b/i.test(String(req?.originalUrl || req?.path || ''))) {
        return false;
      }
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return false;
      }
      if (/^\/api\/health\b/i.test(String(req?.originalUrl || ''))) {
        return false;
      }
      return true;
    }
  } = options;

  return (req, res, next) => {
    const enabled = Boolean(shouldLog(req));
    if (!enabled) {
      return next();
    }

    const startedAt = Date.now();
    const method = req.method;
    const path = req.originalUrl || req.path;
    const projectId = extractProjectId(req);

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const payload = {
        durationMs,
        correlationId: typeof req?.correlationId === 'string' && req.correlationId.trim() ? req.correlationId.trim() : null,
        body: redactSensitiveValues(req.body),
        query: redactSensitiveValues(req.query)
      };

      appendAuditLog({
        source,
        eventType: 'http_request',
        method,
        path,
        statusCode: res.statusCode,
        projectId,
        sessionId: null,
        payload
      }).catch(() => {
        // Best-effort: never crash request handling for audit logging.
      });
    });

    next();
  };
};

export const __auditLogTesting = {
  waitForIdle: async () => {
    if (!pendingWrites.size) {
      return;
    }
    await Promise.allSettled([...pendingWrites]);
  },
  listLatest: async (limit = 10) => {
    const normalized = Number.isFinite(limit) ? Math.max(Math.floor(limit), 1) : 10;
    const rows = await dbAll(
      'SELECT id, source, event_type, method, path, status_code, project_id, session_id, payload, created_at FROM audit_logs ORDER BY id DESC LIMIT ?',
      [normalized]
    );
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      eventType: row.event_type,
      method: row.method,
      path: row.path,
      statusCode: row.status_code,
      projectId: row.project_id,
      sessionId: row.session_id,
      payload: row.payload,
      createdAt: row.created_at
    }));
  },
  clearAll: async () => {
    await dbRun('DELETE FROM audit_logs');
  },
  nowIso
};
