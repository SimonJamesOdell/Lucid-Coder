let pendingRequest = null;

export const setCleanupResumeRequest = (request) => {
  if (!request || typeof request !== 'object') {
    pendingRequest = null;
    return;
  }

  const token = typeof request.token === 'string' ? request.token.trim() : '';
  if (!token) {
    pendingRequest = null;
    return;
  }

  pendingRequest = {
    token,
    includeFrontend: request.includeFrontend !== false,
    includeBackend: request.includeBackend !== false,
    pruneRedundantTests: request.pruneRedundantTests !== false,
    requestedAt: request.requestedAt || new Date().toISOString()
  };
};

export const peekCleanupResumeRequest = () => pendingRequest;

export const consumeCleanupResumeRequest = () => {
  const value = pendingRequest;
  pendingRequest = null;
  return value;
};
