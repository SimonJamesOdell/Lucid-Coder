const MAX_KEYS = 500;

const nowIso = () => new Date().toISOString();

const safeKeyPart = (value) => {
  if (value === null || value === undefined) return 'unknown';
  const text = String(value).trim();
  return text ? text : 'unknown';
};

const bump = (map, key, delta = 1) => {
  const current = map.get(key) || 0;
  map.set(key, current + delta);
};

const trimMap = (map, maxEntries) => {
  if (map.size <= maxEntries) return;
  const keys = Array.from(map.keys());
  const removeCount = map.size - maxEntries;
  for (let i = 0; i < removeCount; i += 1) {
    map.delete(keys[i]);
  }
};

class LlmRequestMetrics {
  constructor() {
    this._startedAt = Date.now();
    this._counters = new Map();
  }

  reset() {
    this._startedAt = Date.now();
    this._counters.clear();
  }

  record(kind, { phase, requestType, provider, model } = {}) {
    const normalized = {
      kind: safeKeyPart(kind),
      phase: safeKeyPart(phase),
      requestType: safeKeyPart(requestType),
      provider: safeKeyPart(provider),
      model: safeKeyPart(model)
    };

    bump(this._counters, `kind:${normalized.kind}`);
    bump(this._counters, `phase:${normalized.phase}`);
    bump(this._counters, `type:${normalized.requestType}`);
    bump(this._counters, `provider:${normalized.provider}`);
    bump(this._counters, `model:${normalized.model}`);
    bump(this._counters, `phase_type:${normalized.phase}::${normalized.requestType}`);
    bump(this._counters, `kind_phase_type:${normalized.kind}::${normalized.phase}::${normalized.requestType}`);

    trimMap(this._counters, MAX_KEYS);
  }

  snapshot() {
    const counters = Object.fromEntries(this._counters.entries());
    return {
      startedAt: new Date(this._startedAt).toISOString(),
      startedAtMs: this._startedAt,
      now: nowIso(),
      totalKeys: this._counters.size,
      counters
    };
  }
}

export const llmRequestMetrics = new LlmRequestMetrics();
