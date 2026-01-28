const DEFAULT_MAX_ENTRIES = 200;

const SENSITIVE_KEY_PATTERN = /token|apiKey|api_key|password|secret|encrypted/i;

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

export const createLogBuffer = ({
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => new Date().toISOString()
} = {}) => {
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
  const entries = [];

  const add = (entry = {}) => {
    const normalized = entry && typeof entry === 'object' ? entry : { message: String(entry) };

    const payload = {
      ts: typeof normalized.ts === 'string' && normalized.ts.trim() ? normalized.ts : now(),
      level: typeof normalized.level === 'string' && normalized.level.trim() ? normalized.level.trim() : 'info',
      message: typeof normalized.message === 'string' ? normalized.message : String(normalized.message ?? ''),
      correlationId: typeof normalized.correlationId === 'string' && normalized.correlationId.trim()
        ? normalized.correlationId.trim()
        : null,
      meta: redactSensitiveValues(normalized.meta ?? null)
    };

    entries.push(payload);
    while (entries.length > cap) {
      entries.shift();
    }

    return payload;
  };

  const list = ({ limit = cap } = {}) => {
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cap;
    return entries.slice(-normalizedLimit);
  };

  return {
    add,
    list,
    __testing: {
      redactSensitiveValues
    }
  };
};

export const logBuffer = createLogBuffer();
