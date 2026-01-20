import net from 'net';

export const DEFAULT_FRONTEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_FRONTEND_PORT_BASE) || 5100;
export const DEFAULT_BACKEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_BACKEND_PORT_BASE) || 5500;

const reservedFrontendPorts = new Set(
  (process.env.LUCIDCODER_HOST_PORTS || process.env.VITE_PORT || '5173,3000')
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0)
);

const reservedBackendPorts = new Set(
  (process.env.LUCIDCODER_BACKEND_HOST_PORTS || '5000')
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0)
);

if (!reservedFrontendPorts.size) {
  reservedFrontendPorts.add(5173);
}

if (!reservedBackendPorts.size) {
  reservedBackendPorts.add(5000);
}

export const RESERVED_FRONTEND_PORTS = reservedFrontendPorts;
export const RESERVED_BACKEND_PORTS = reservedBackendPorts;

export const normalizePortCandidate = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

export const normalizePortBase = (value, fallback) => {
  const normalized = normalizePortCandidate(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized < 1024 || normalized > 65535) {
    return fallback;
  }
  return normalized;
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

const isPortAvailable = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();

    server.unref();

    server.once('error', () => {
      server.close(() => resolve(false));
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '0.0.0.0');
  });

export const findAvailablePort = async (preferredPort, fallbackBase, blockedPorts = reservedFrontendPorts) => {
  const attempts = [];
  const cleanedPreferred = normalizePortCandidate(preferredPort);
  if (cleanedPreferred && !blockedPorts.has(cleanedPreferred)) {
    attempts.push(cleanedPreferred);
  }

  const base = fallbackBase || 6000;
  for (let offset = 0; offset < 2000; offset += 1) {
    const candidate = base + offset;
    if (blockedPorts.has(candidate)) {
      continue;
    }
    if (cleanedPreferred && candidate === cleanedPreferred) {
      continue;
    }
    attempts.push(candidate);
  }

  for (const candidate of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error('Unable to find an available port');
};

export const snapshotReservedPorts = () => ({
  frontend: Array.from(reservedFrontendPorts),
  backend: Array.from(reservedBackendPorts)
});
