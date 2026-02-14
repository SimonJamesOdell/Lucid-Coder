export const normalizeHostname = (value) => {
  if (typeof value !== 'string') {
    return 'localhost';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return 'localhost';
  }

  if (trimmed === '0.0.0.0') {
    return 'localhost';
  }

  return trimmed;
};

export const normalizeBrowserProtocol = (value) => {
  if (typeof value !== 'string') {
    return 'http:';
  }

  const trimmed = value.trim();
  if (trimmed === 'http:' || trimmed === 'https:') {
    return trimmed;
  }

  return 'http:';
};

export const getDevServerOriginFromWindow = ({ port, hostnameOverride } = {}) => {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const protocol = normalizeBrowserProtocol(window.location?.protocol || 'http:');
  const hostname = normalizeHostname(hostnameOverride || window.location?.hostname || 'localhost');
  return `${protocol}//${hostname}:${port}`;
};

export const getBackendOriginFromEnv = () => {
  try {
    const raw = import.meta?.env?.VITE_API_TARGET;
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};
