import db from '../database.js';

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function callback(err) {
    if (err) {
      reject(err);
    } else {
      resolve({ lastID: this?.lastID ?? null, changes: this?.changes ?? null });
    }
  });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) {
      reject(err);
    } else {
      resolve(row || null);
    }
  });
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) {
      reject(err);
    } else {
      resolve(rows || []);
    }
  });
});

const parseJson = (value) => {
  if (!value) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const toIsoOrNull = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }
  return null;
};

const serializeJson = (value) => {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const normalizeRunRow = (row) => {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    goalId: row.goal_id ?? null,
    kind: row.kind,
    status: row.status,
    sessionId: row.session_id ?? null,
    statusMessage: row.status_message ?? null,
    metadata: parseJson(row.metadata),
    error: row.error ?? null,
    createdAt: row.created_at ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null
  };
};

const normalizeEventRow = (row) => {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    runId: row.run_id,
    sessionEventId: row.session_event_id ?? null,
    timestamp: row.timestamp,
    type: row.type,
    level: row.level ?? null,
    source: row.source ?? null,
    correlationId: row.correlation_id ?? null,
    message: row.message ?? '',
    payload: parseJson(row.payload),
    meta: parseJson(row.meta),
    createdAt: row.created_at ?? null
  };
};

export const createRun = async ({
  projectId,
  goalId = null,
  kind,
  status = 'pending',
  sessionId = null,
  statusMessage = null,
  metadata = null,
  error = null,
  startedAt = null,
  finishedAt = null
} = {}) => {
  if (!kind || typeof kind !== 'string' || !kind.trim()) {
    throw new Error('kind is required');
  }

  const insert = await run(
    `INSERT INTO runs (
      project_id,
      goal_id,
      kind,
      status,
      session_id,
      status_message,
      metadata,
      error,
      started_at,
      finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId ?? null,
      goalId ?? null,
      kind.trim(),
      status,
      sessionId ?? null,
      statusMessage ?? null,
      serializeJson(metadata),
      error ?? null,
      toIsoOrNull(startedAt),
      toIsoOrNull(finishedAt)
    ]
  );

  const created = await get('SELECT * FROM runs WHERE id = ?', [insert.lastID]);
  return normalizeRunRow(created);
};

export const updateRun = async (runId, updates = {}) => {
  const id = Number(runId);
  if (!Number.isFinite(id)) {
    throw new Error('runId is required');
  }

  const current = await get('SELECT * FROM runs WHERE id = ?', [id]);
  if (!current) {
    return null;
  }

  const next = {
    status: updates.status ?? current.status,
    session_id: updates.sessionId ?? current.session_id,
    status_message: updates.statusMessage ?? current.status_message,
    metadata: updates.metadata === undefined ? current.metadata : serializeJson(updates.metadata),
    error: updates.error ?? current.error,
    started_at: updates.startedAt === undefined ? current.started_at : toIsoOrNull(updates.startedAt),
    finished_at: updates.finishedAt === undefined ? current.finished_at : toIsoOrNull(updates.finishedAt)
  };

  await run(
    `UPDATE runs
     SET status = ?,
         session_id = ?,
         status_message = ?,
         metadata = ?,
         error = ?,
         started_at = ?,
         finished_at = ?
     WHERE id = ?`,
    [
      next.status,
      next.session_id,
      next.status_message,
      next.metadata,
      next.error,
      next.started_at,
      next.finished_at,
      id
    ]
  );

  const updated = await get('SELECT * FROM runs WHERE id = ?', [id]);
  return normalizeRunRow(updated);
};

export const appendRunEvent = async (runId, event = {}) => {
  const id = Number(runId);
  if (!Number.isFinite(id)) {
    throw new Error('runId is required');
  }

  const type = typeof event.type === 'string' && event.type.trim() ? event.type.trim() : 'log';
  const timestamp = toIsoOrNull(event.timestamp) || new Date().toISOString();
  const level = typeof event.level === 'string' && event.level.trim() ? event.level.trim() : null;
  const source = typeof event.source === 'string' && event.source.trim() ? event.source.trim() : null;
  const correlationId = typeof event.correlationId === 'string' && event.correlationId.trim()
    ? event.correlationId.trim()
    : (typeof event.correlation_id === 'string' && event.correlation_id.trim() ? event.correlation_id.trim() : null);
  const message = typeof event.message === 'string' ? event.message : String(event.message ?? '');

  const insert = await run(
    `INSERT INTO run_events (
      run_id,
      session_event_id,
      timestamp,
      type,
      level,
      source,
      correlation_id,
      message,
      payload,
      meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.id ? String(event.id) : null,
      timestamp,
      type,
      level,
      source,
      correlationId,
      message,
      serializeJson(event.payload ?? null),
      serializeJson(event.meta ?? null)
    ]
  );

  const created = await get('SELECT * FROM run_events WHERE id = ?', [insert.lastID]);
  return normalizeEventRow(created);
};

export const getRun = async (runId) => {
  const id = Number(runId);
  if (!Number.isFinite(id)) {
    throw new Error('runId is required');
  }
  const row = await get('SELECT * FROM runs WHERE id = ?', [id]);
  return normalizeRunRow(row);
};

export const getRunBySessionId = async (sessionId) => {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized) {
    return null;
  }
  const row = await get('SELECT * FROM runs WHERE session_id = ? ORDER BY id DESC LIMIT 1', [normalized]);
  return normalizeRunRow(row);
};

export const listRunsForProject = async (projectId, { limit = 50 } = {}) => {
  const normalized = Number(projectId);
  if (!Number.isFinite(normalized)) {
    throw new Error('projectId is required');
  }
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const rows = await all(
    'SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT ?',
    [normalized, normalizedLimit]
  );
  return rows.map(normalizeRunRow);
};

export const listRunEvents = async (runId, { limit = 500, afterId = null, types = null } = {}) => {
  const id = Number(runId);
  if (!Number.isFinite(id)) {
    throw new Error('runId is required');
  }

  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;

  const normalizedAfterId = Number.isFinite(Number(afterId))
    ? Math.floor(Number(afterId))
    : null;

  const normalizedTypes = Array.isArray(types)
    ? types
    : (typeof types === 'string' ? types.split(',') : []);
  const filteredTypes = normalizedTypes
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  const where = ['run_id = ?'];
  const params = [id];

  if (Number.isFinite(normalizedAfterId) && normalizedAfterId > 0) {
    where.push('id > ?');
    params.push(normalizedAfterId);
  }

  if (filteredTypes.length > 0) {
    where.push(`type IN (${filteredTypes.map(() => '?').join(', ')})`);
    params.push(...filteredTypes);
  }

  const rows = await all(
    `SELECT * FROM run_events WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`,
    [...params, normalizedLimit]
  );
  return rows.map(normalizeEventRow);
};

export const __testing = {
  run,
  get,
  all,
  parseJson,
  toIsoOrNull,
  serializeJson,
  normalizeRunRow,
  normalizeEventRow
};
