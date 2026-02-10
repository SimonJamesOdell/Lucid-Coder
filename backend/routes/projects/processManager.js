import { exec, execFile } from 'child_process';
import {
  getAllProjects,
  getProject,
  getProjectByName
} from '../../database.js';
import { sanitizeProjectName } from '../../utils/projectPaths.js';

export const runningProcesses = new Map();

export const buildProcessState = (state, hasProcesses) => {
  if (state === 'running' || state === 'stopped') {
    return state;
  }
  return hasProcesses ? 'running' : 'idle';
};

export const normalizeProcessEntry = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'object' && value !== null && 'processes' in value) {
    const hasProcesses = Boolean(value.processes?.frontend || value.processes?.backend);
    return {
      processes: value.processes || null,
      state: buildProcessState(value.state, hasProcesses),
      updatedAt: value.updatedAt || new Date().toISOString(),
      lastStateChange: value.lastStateChange || value.updatedAt || new Date().toISOString(),
      lastTerminatedAt: value.lastTerminatedAt || null,
      snapshotVisible:
        value.snapshotVisible === false
          ? false
          : value.snapshotVisible === true
            ? true
            : hasProcesses,
      launchType: value.launchType || 'manual'
    };
  }

  const legacyState = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && typeof value.state === 'string'
      ? value.state
      : null;
  const fallbackState = buildProcessState(legacyState, Boolean(value));
  const timestamp = new Date().toISOString();
  return {
    processes: value,
    state: fallbackState,
    updatedAt: timestamp,
    lastStateChange: timestamp,
    lastTerminatedAt: fallbackState === 'stopped' ? timestamp : null,
    snapshotVisible: Boolean(value),
    launchType: 'manual'
  };
};

export const protectedPidSet = new Set(
  [process.pid, process.ppid]
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
);

export const applyExtraProtectedPids = (pidString = process.env.LUCIDCODER_PROTECTED_PIDS || '') => {
  pidString
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .forEach((pid) => protectedPidSet.add(pid));
};

applyExtraProtectedPids();

export const isProtectedPid = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  return protectedPidSet.has(numericPid);
};

export const logProtectedPidSkip = (pid, context = '') => {
  const suffix = context ? ` (${context})` : '';
  console.warn(`⚠️ Skipping protected PID ${pid}${suffix}`);
};

const parsePortList = (value = '') =>
  value
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0);

const defaultFrontendPorts = {
  react: 5173,
  vue: 5173,
  nextjs: 3000,
  angular: 4200
};

const defaultBackendPorts = {
  express: 3000,
  fastapi: 5000,
  flask: 5000,
  django: 8000,
  nestjs: 3000
};

const normalizePortCandidate = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

const defaultHostReservedPorts = [5173, 3000];

export const hostReservedPorts = new Set(
  [
    ...parsePortList(process.env.LUCIDCODER_HOST_PORTS || process.env.VITE_PORT || '5173'),
    ...defaultHostReservedPorts
  ]
);

export const ensureDefaultHostPort = () => {
  if (hostReservedPorts.size === 0) {
    for (const port of defaultHostReservedPorts) {
      hostReservedPorts.add(port);
    }
  }
};

ensureDefaultHostPort();

const isReservedHostPort = (port) => hostReservedPorts.has(Number(port));

export const getProjectFrameworks = (project) => {
  if (!project) {
    return { frontend: '', backend: '' };
  }

  const frameworkField = typeof project.framework === 'string' ? project.framework : '';
  const [combinedFrontendRaw = '', combinedBackendRaw = ''] = frameworkField.split(',');

  const frontendFramework = (project.frontend_framework || combinedFrontendRaw || '').trim().toLowerCase();
  const backendFramework = (project.backend_framework || combinedBackendRaw || '').trim().toLowerCase();

  return {
    frontend: frontendFramework,
    backend: backendFramework
  };
};

export const deriveProjectPorts = (project) => {
  const ports = new Set();

  if (!project) {
    ports.add(5173);
    ports.add(3000);
    return [...ports];
  }

  const addPort = (value) => {
    const port = normalizePortCandidate(value);
    if (port) {
      ports.add(port);
    }
  };

  addPort(project.frontend_port ?? project.frontendPort);
  addPort(project.backend_port ?? project.backendPort);

  const { frontend: frontendFramework, backend: backendFramework } = getProjectFrameworks(project);

  const storedFrontend = normalizePortCandidate(project.frontend_port ?? project.frontendPort);
  const storedBackend = normalizePortCandidate(project.backend_port ?? project.backendPort);

  if (!storedFrontend) {
    addPort(defaultFrontendPorts[frontendFramework] || 5173);
  }

  if (!storedBackend) {
    addPort(defaultBackendPorts[backendFramework] || 3000);
  }

  if (!ports.size) {
    addPort(5173);
    addPort(3000);
  }

  return [...ports].filter(Boolean);
};

export const extractProcessPorts = (processes = {}) => ({
  frontendPort: processes?.frontend?.port,
  backendPort: processes?.backend?.port
});

const MAX_EXPOSED_PROCESS_LOGS = 40;

export const sanitizeProcessSnapshot = (processInfo) => {
  if (!processInfo) {
    return null;
  }

  const trimLogs = Array.isArray(processInfo.logs)
    ? processInfo.logs.slice(-MAX_EXPOSED_PROCESS_LOGS)
    : [];

  return {
    pid: Number.isInteger(processInfo.pid) ? processInfo.pid : null,
    port: Number.isInteger(processInfo.port) ? processInfo.port : null,
    status: processInfo.status || 'unknown',
    startedAt: processInfo.startedAt || null,
    lastHeartbeat: processInfo.lastHeartbeat || null,
    endedAt: processInfo.endedAt || null,
    exitCode: typeof processInfo.exitCode === 'number' ? processInfo.exitCode : null,
    signal: processInfo.signal || null,
    logs: trimLogs
  };
};

export const resolveLastKnownPort = (...candidates) => {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) {
      return candidate;
    }
  }
  return null;
};

export const resolveActivityState = (effectiveState, hasExposedProcesses) =>
  effectiveState || (hasExposedProcesses ? 'running' : 'idle');

export const getStoredProjectPorts = (project) => ({
  frontend: normalizePortCandidate(project?.frontend_port ?? project?.frontendPort),
  backend: normalizePortCandidate(project?.backend_port ?? project?.backendPort)
});

export const getProjectPortHints = (project) => {
  const { frontend: frontendFramework, backend: backendFramework } = getProjectFrameworks(project);
  return {
    frontend:
      normalizePortCandidate(project?.frontend_port ?? project?.frontendPort) ||
      defaultFrontendPorts[frontendFramework] ||
      5173,
    backend:
      normalizePortCandidate(project?.backend_port ?? project?.backendPort) ||
      defaultBackendPorts[backendFramework] ||
      3000
  };
};

export const buildPortOverrideOptions = (settings = {}) => {
  const overrides = {};
  const frontendBase = normalizePortCandidate(settings?.frontendPortBase);
  const backendBase = normalizePortCandidate(settings?.backendPortBase);

  if (frontendBase) {
    overrides.frontendPortBase = frontendBase;
  }
  if (backendBase) {
    overrides.backendPortBase = backendBase;
  }

  return overrides;
};

const isTestEnvironment = process.env.NODE_ENV === 'test';

export const hasLiveProcess = (proc) => {
  if (!proc) {
    return false;
  }
  const isStubEntry = proc.isStub === true;
  if (!proc.pid) {
    if (!isStubEntry && isTestEnvironment && proc.port) {
      return true;
    }
    return false;
  }
  return isPidActive(proc.pid);
};

export const parseSinceParam = (value) => {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return timestamp;
};

export const buildLogEntries = (processInfo, sinceTimestamp) => {
  if (!processInfo || !Array.isArray(processInfo.logs)) {
    return [];
  }

  return processInfo.logs.filter((entry) => {
    if (!sinceTimestamp) {
      return true;
    }
    const entryTimestamp = Date.parse(entry.timestamp);
    return Number.isNaN(entryTimestamp) ? true : entryTimestamp >= sinceTimestamp;
  });
};

const defaultExecCommand = (command, options = {}) =>
  new Promise((resolve) => {
    exec(command, { windowsHide: true, ...options }, (error, stdout) => {
      if (error || !stdout) {
        return resolve('');
      }
      resolve(stdout);
    });
  });

let execCommandImpl = defaultExecCommand;

const execCommand = (command, options = {}) => execCommandImpl(command, options);

export const getExecCommandImpl = () => execCommandImpl;

export const setExecCommandOverride = (fn) => {
  execCommandImpl = typeof fn === 'function' ? fn : defaultExecCommand;
};

export const resetExecCommandOverride = () => {
  execCommandImpl = defaultExecCommand;
};

let execFileImpl = execFile;

const runExecFile = (...args) => execFileImpl(...args);

export const getExecFileImpl = () => execFileImpl;

export const setExecFileOverride = (fn) => {
  execFileImpl = typeof fn === 'function' ? fn : execFile;
};

export const resetExecFileOverride = () => {
  execFileImpl = execFile;
};

let platformOverride = null;

export const getPlatformImpl = () => platformOverride || process.platform;

export const setPlatformOverride = (value) => {
  platformOverride = typeof value === 'string' && value.trim() ? value : null;
};

export const resetPlatformOverride = () => {
  platformOverride = null;
};

export const findPidsByPortWindows = async (port) => {
  const stdout = await execCommand(`netstat -ano | findstr :${port}`);
  if (!stdout) {
    return [];
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const pids = new Set();
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const localAddress = parts[1];
    const pidToken = parts[parts.length - 1];
    if (typeof localAddress === 'string' && localAddress.endsWith(`:${port}`)) {
      const pid = Number.parseInt(pidToken, 10);
      if (!Number.isNaN(pid)) {
        pids.add(pid);
      }
    }
  }
  return [...pids];
};

export const parsePidList = (text) =>
  text
    .split(/\s+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

export const findPidsByPortUnix = async (port) => {
  const lsofOutput = await execCommand(`lsof -ti tcp:${port}`);
  if (lsofOutput) {
    return parsePidList(lsofOutput);
  }

  const fuserOutput = await execCommand(`fuser -n tcp ${port}`);
  if (fuserOutput) {
    return parsePidList(fuserOutput);
  }

  return [];
};

export const findPidsByPort = async (port) => {
  if (!port || !Number.isInteger(port)) {
    return [];
  }
  if (getPlatformImpl() === 'win32') {
    return findPidsByPortWindows(port);
  }
  return findPidsByPortUnix(port);
};

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForPidExit = async (pid, { timeoutMs = 5000, intervalMs = 200 } = {}) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidActive(numericPid)) {
      return true;
    }
    await delay(intervalMs);
  }

  return !isPidActive(numericPid);
};

const terminatePidWithRetry = async (pid, { attempts = 3, waitForExitMs = 2500 } = {}) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return true;
  }
  if (isProtectedPid(numericPid)) {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await killProcessTree(numericPid, { forceDelay: Math.min(1000, Math.max(250, Math.round(waitForExitMs / 4))) });
    if (await waitForPidExit(numericPid, { timeoutMs: waitForExitMs })) {
      return true;
    }
  }

  return !isPidActive(numericPid);
};

export const killProcessTree = async (pid, { forceDelay = 1000 } = {}) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return;
  }

  if (isProtectedPid(numericPid)) {
    logProtectedPidSkip(numericPid, 'host process');
    return;
  }

  const pidString = String(numericPid);
  if (getPlatformImpl() === 'win32') {
    await new Promise((resolve) => {
      runExecFile('taskkill', ['/PID', pidString, '/T', '/F'], (error) => {
        if (error) {
          const stderr = error?.stderr?.toString()?.toLowerCase() || '';
          if (stderr.includes('not found') || stderr.includes('no running instance')) {
            return resolve();
          }
        }
        resolve();
      });
    });
    return;
  }

  const safeKill = (signal) => {
    try {
      process.kill(numericPid, signal);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return false;
      }
      console.warn(`Failed to send ${signal} to ${pid}:`, error.message);
    }
    return true;
  };

  const termSent = safeKill('SIGTERM');
  if (termSent) {
    await delay(forceDelay);
  }
  safeKill('SIGKILL');
};

export const killProcessesOnPort = async (port, { listPids = findPidsByPort, terminatePid = killProcessTree } = {}) => {
  const allPids = await listPids(port);
  if (!allPids.length) {
    return;
  }

  const eligiblePids = [];
  for (const pid of allPids) {
    if (isProtectedPid(pid)) {
      logProtectedPidSkip(pid, `port ${port}`);
      continue;
    }
    eligiblePids.push(pid);
  }

  if (!eligiblePids.length) {
    return;
  }

  for (const pid of eligiblePids) {
    await terminatePid(pid, { forceDelay: 250 });
  }
};

export const ensurePortsFreed = async (ports = [], { killFn = killProcessesOnPort } = {}) => {
  const uniquePorts = [...new Set(ports)].filter((port) => Number.isInteger(port));
  for (const port of uniquePorts) {
    if (isReservedHostPort(port)) {
      console.warn(`⚠️ Skipping reserved host port ${port} during cleanup`);
      continue;
    }
    await killFn(port);
  }
};

const waitForPortsToFree = async (ports = [], { timeoutMs = 6000, intervalMs = 250 } = {}) => {
  const uniquePorts = [...new Set(ports)].filter((port) => Number.isInteger(port));
  if (!uniquePorts.length) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let hasBusyPort = false;

    for (const port of uniquePorts) {
      if (isReservedHostPort(port)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const pids = await findPidsByPort(port);
      const eligible = pids.filter((pid) => !isProtectedPid(pid));
      if (eligible.length > 0) {
        hasBusyPort = true;
        for (const pid of eligible) {
          // eslint-disable-next-line no-await-in-loop
          await terminatePidWithRetry(pid, { attempts: 2, waitForExitMs: intervalMs * 4 });
        }
      }
    }

    if (!hasBusyPort) {
      return true;
    }

    await delay(intervalMs);
  }

  return false;
};

export const isPidActive = (pid) => {
  if (!pid || Number.isNaN(Number(pid))) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return true;
  }
};

export const normalizeProcessKey = (identifier) => {
  if (identifier === undefined || identifier === null) {
    return null;
  }
  const raw = String(identifier).trim();
  return raw.length > 0 ? raw : null;
};

export const buildProcessKeyCandidates = (identifier) => {
  const candidates = [];
  if (identifier !== undefined && identifier !== null) {
    candidates.push(identifier);
  }
  const normalized = normalizeProcessKey(identifier);
  if (normalized) {
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric) && !candidates.includes(numeric)) {
      candidates.push(numeric);
    }
  }
  return candidates;
};

export const getRunningProcessEntry = (identifier) => {
  const candidates = buildProcessKeyCandidates(identifier);
  for (const key of candidates) {
    if (runningProcesses.has(key)) {
      const entry = normalizeProcessEntry(runningProcesses.get(key));
      if (entry !== runningProcesses.get(key)) {
        runningProcesses.set(key, entry);
      }
      return {
        key,
        processes: entry?.processes || null,
        state: entry?.state || null,
        snapshotVisible: entry?.snapshotVisible ?? false,
        launchType: entry?.launchType || 'manual',
        entry
      };
    }
  }
  return { key: null, processes: null, state: null, snapshotVisible: false, launchType: 'manual', entry: null };
};

export const storeRunningProcesses = (identifier, processes, state = 'running', options = {}) => {
  const key = normalizeProcessKey(identifier);
  if (!key) {
    return;
  }

  const normalizedState = state === 'running' ? 'running' : 'stopped';
  const previous = normalizeProcessEntry(runningProcesses.get(key));
  const timestamp = new Date().toISOString();
  const explicitVisibility =
    options.exposeSnapshot === true ? true : options.exposeSnapshot === false ? false : null;
  const snapshotVisible =
    normalizedState === 'running'
      ? true
      : explicitVisibility ?? previous?.snapshotVisible ?? Boolean(previous?.processes);
  const nextLaunchType =
    normalizedState === 'running'
      ? options.launchType || 'manual'
      : previous?.launchType || 'manual';
  const entry = {
    processes: processes || previous?.processes || null,
    state: normalizedState,
    updatedAt: timestamp,
    lastStateChange: normalizedState !== previous?.state
      ? timestamp
      : previous?.lastStateChange || timestamp,
    lastTerminatedAt: normalizedState === 'stopped'
      ? timestamp
      : previous?.lastTerminatedAt || null,
    snapshotVisible,
    launchType: nextLaunchType
  };

  console.log(
    '[storeRunningProcesses]',
    key,
    normalizedState,
    Boolean(entry.processes?.frontend),
    Boolean(entry.processes?.backend),
    { snapshotVisible, launchType: entry.launchType }
  );
  runningProcesses.set(key, entry);

  const numeric = Number(key);
  if (!Number.isNaN(numeric) && `${numeric}` !== key && runningProcesses.has(numeric)) {
    runningProcesses.delete(numeric);
  }
};

export const findProjectByIdentifier = async (identifier) => {
  if (identifier === undefined || identifier === null) {
    return null;
  }

  const raw = String(identifier).trim();
  if (!raw) {
    return null;
  }

  const numericId = Number(raw);
  if (!Number.isNaN(numericId)) {
    const projectById = await getProject(numericId);
    if (projectById) {
      return projectById;
    }
  }

  const projectByName = await getProjectByName(raw);
  if (projectByName) {
    return projectByName;
  }

  const slug = sanitizeProjectName(raw);
  if (!slug) {
    return null;
  }

  const projects = await getAllProjects();
  return projects.find((project) => sanitizeProjectName(project.name) === slug) || null;
};

export const resolveTerminationProject = async (projectId, project) => {
  if (project) {
    return project;
  }
  if (!projectId) {
    return null;
  }
  return findProjectByIdentifier(projectId);
};

export const terminateRunningProcesses = async (projectId, options = {}) => {
  const { key, processes, state: entryState } = getRunningProcessEntry(projectId);
  const project = await resolveTerminationProject(projectId, options.project);
  const requestedTarget = options.target === 'frontend' || options.target === 'backend' ? options.target : null;
  const targetProcess = requestedTarget ? processes?.[requestedTarget] : null;
  const targetPid = normalizePortCandidate(targetProcess?.pid);
  const knownPids = requestedTarget
    ? (targetPid ? [targetPid] : [])
    : [processes?.frontend?.pid, processes?.backend?.pid]
        .map((pid) => (Number.isInteger(pid) ? pid : Number(pid)))
        .filter((pid) => Number.isInteger(pid));
  const hasLiveProcesses = knownPids.some((pid) => isPidActive(pid));
  const targetWasLive = requestedTarget ? hasLiveProcesses : false;
  const dropEntry = options.dropEntry === true;
  const hasProcesses = Boolean(processes?.frontend || processes?.backend);
  const isActiveEntry = entryState === 'running' && hasProcesses;

  if (isActiveEntry) {
    const killProcess = (proc) => {
      if (!proc || !proc.pid) {
        return Promise.resolve();
      }
      const waitForExitMs = options.waitForRelease ? (options.releaseDelay ?? 2000) : 800;
      return terminatePidWithRetry(proc.pid, { waitForExitMs });
    };

    if (requestedTarget) {
      await killProcess(processes?.[requestedTarget]);
    } else {
      await Promise.all([killProcess(processes.frontend), killProcess(processes.backend)]);
    }

    const releaseDelay = options.waitForRelease ? (options.releaseDelay ?? 2000) : 200;
    await delay(releaseDelay);
  }

  if (key !== null) {
    if (dropEntry) {
      runningProcesses.delete(key);
    } else if (isActiveEntry) {
      if (requestedTarget) {
        const remainingKey = requestedTarget === 'frontend' ? 'backend' : 'frontend';
        const nextProcesses = {
          ...processes,
          [requestedTarget]: null
        };
        const remainingProcess = nextProcesses?.[remainingKey] || null;
        const remainingLive = remainingProcess ? hasLiveProcess(remainingProcess) : false;
        const nextState = remainingLive ? 'running' : 'stopped';
        storeRunningProcesses(key, nextProcesses, nextState, { exposeSnapshot: true });
      } else {
        storeRunningProcesses(key, processes, 'stopped', { exposeSnapshot: true });
      }
    }
  }

  const forcePortCleanup = options.forcePorts === true;

  // For targeted restarts, only trust the live snapshot port (not project metadata).
  // Project metadata can be stale/wrong and can overlap with the other target (e.g. nextjs frontend on 3000).
  const resolvedTargetPort = requestedTarget
    ? (normalizePortCandidate(targetProcess?.port) ?? null)
    : null;

  // Important: when a target is specified, never fall back to freeing *both* project ports.
  // Otherwise a backend restart can kill the frontend by freeing the frontend dev-server port.
  const derivedPorts = (() => {
    if (requestedTarget) {
      return resolvedTargetPort ? [resolvedTargetPort] : Array.isArray(options.ports) ? options.ports : [];
    }
    return options.ports ?? deriveProjectPorts(project);
  })();

  const shouldReleasePorts =
    forcePortCleanup ||
    (requestedTarget ? targetWasLive : (hasLiveProcesses || isActiveEntry));

  const portsToFree = shouldReleasePorts ? derivedPorts : [];

  if (shouldReleasePorts && portsToFree.length) {
    await ensurePortsFreed(portsToFree);
    if (options.waitForRelease) {
      await waitForPortsToFree(portsToFree, { timeoutMs: 8000 });
    }
  }

  return {
    wasRunning: isActiveEntry,
    freedPorts: shouldReleasePorts ? portsToFree : []
  };
};
