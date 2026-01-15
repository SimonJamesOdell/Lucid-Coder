const detectFileTokens = (prompt) => {
  if (!prompt) {
    return [];
  }
  const pattern = /[A-Za-z0-9_./-]+\.(?:tsx|jsx|ts|js|json|css|scss|sass|html|md|py|rb|go|java|c|cpp|cs)/gi;
  const matches = prompt.match(pattern) || [];
  const normalized = matches
    .map((match) => match.replace(/^\.\//, '').replace(/^\./, '').replace(/^\//, ''))
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, 5);
};

const normalizeRepoPath = (value) => String(value ?? '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .trim();

const normalizePortNumber = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
};

const buildEmptyPortBundle = () => ({
  active: { frontend: null, backend: null },
  stored: { frontend: null, backend: null },
  preferred: { frontend: null, backend: null }
});

const coercePortBundle = (ports = {}) => {
  const bundle = buildEmptyPortBundle();
  if (!ports || typeof ports !== 'object') {
    return bundle;
  }

  const applyPort = (target, value) => {
    target.frontend = normalizePortNumber(value?.frontend ?? value?.frontendPort ?? null);
    target.backend = normalizePortNumber(value?.backend ?? value?.backendPort ?? null);
  };

  applyPort(bundle.active, ports.active || {});
  applyPort(bundle.stored, ports.stored || {});
  applyPort(bundle.preferred, ports.preferred || {});
  return bundle;
};

const resolveProcessPayload = (payload) => {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'processes')) {
    return payload.processes || {};
  }
  return payload && typeof payload === 'object' ? payload : {};
};

const buildProcessStateSnapshot = (projectId, payload = {}) => {
  if (!projectId) {
    return null;
  }

  const rawProcesses = resolveProcessPayload(payload);
  const normalizedProcesses = {
    frontend: rawProcesses?.frontend || null,
    backend: rawProcesses?.backend || null
  };

  const hasRunningProcess = Boolean(normalizedProcesses.frontend || normalizedProcesses.backend);
  const ports = payload?.ports
    ? coercePortBundle(payload.ports)
    : (() => {
        const defaults = buildEmptyPortBundle();
        defaults.active.frontend = normalizePortNumber(normalizedProcesses.frontend?.port);
        defaults.active.backend = normalizePortNumber(normalizedProcesses.backend?.port);
        return defaults;
      })();

  return {
    projectId,
    fetchedAt: new Date().toISOString(),
    isRunning: hasRunningProcess,
    processes: normalizedProcesses,
    ports
  };
};

const sortJobsByCreatedAt = (jobs = []) =>
  [...jobs].sort((a, b) => new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0));

const JOB_FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

const initialJobState = {
  jobsByProject: {},
  isLoading: false,
  error: null
};

const buildInitialShutdownState = () => ({
  isStopping: false,
  projectId: null,
  projectName: '',
  startedAt: null,
  error: null
});

const sanitizeGitSettings = (settings = null) => {
  if (!settings) {
    return null;
  }
  return {
    ...settings,
    token: ''
  };
};

export {
  detectFileTokens,
  normalizeRepoPath,
  normalizePortNumber,
  buildEmptyPortBundle,
  coercePortBundle,
  resolveProcessPayload,
  buildProcessStateSnapshot,
  sortJobsByCreatedAt,
  JOB_FINAL_STATES,
  initialJobState,
  buildInitialShutdownState,
  sanitizeGitSettings
};
