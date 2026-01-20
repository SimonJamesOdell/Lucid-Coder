export const MAX_LOG_LINES = 200;

export const createProcessInfo = (type, childProcess, port) => {
  const now = new Date().toISOString();

  const processInfo = {
    pid: childProcess?.pid ?? null,
    port: port ?? null,
    type,
    status: childProcess ? 'running' : 'stopped',
    startedAt: childProcess ? now : null,
    endedAt: null,
    lastHeartbeat: childProcess ? now : null,
    logs: [],
    exitCode: null,
    signal: null,
    isStub: false
  };

  if (!childProcess) {
    return processInfo;
  }

  const pushLog = (stream, message) => {
    const trimmed = String(message).trim();
    if (!trimmed) {
      return;
    }

    processInfo.lastHeartbeat = new Date().toISOString();
    processInfo.logs.push({
      timestamp: processInfo.lastHeartbeat,
      stream,
      message: trimmed
    });

    if (processInfo.logs.length > MAX_LOG_LINES) {
      processInfo.logs.splice(0, processInfo.logs.length - MAX_LOG_LINES);
    }
  };

  const handleChunk = (stream) => (chunk) => {
    if (!chunk) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      pushLog(stream, line);
    }
  };

  childProcess.stdout?.on?.('data', handleChunk('stdout'));
  childProcess.stderr?.on?.('data', handleChunk('stderr'));

  childProcess.on?.('error', (error) => {
    const code = Number.isInteger(error?.code) ? error.code : null;
    processInfo.status = 'error';
    processInfo.endedAt = new Date().toISOString();
    processInfo.exitCode = code;
    pushLog('error', error?.message || 'Process error');
  });

  childProcess.on?.('exit', (code, signal) => {
    processInfo.status = 'stopped';
    processInfo.endedAt = new Date().toISOString();
    processInfo.signal = signal ?? null;

    if (Number.isInteger(code)) {
      processInfo.exitCode = code;
    }
  });

  return processInfo;
};

export const buildStubProcesses = (overrides = {}) => {
  const now = new Date().toISOString();
  return {
    frontend: {
      pid: overrides.frontendPid ?? 10001,
      port: overrides.frontendPort ?? 5173,
      type: 'frontend',
      status: overrides.frontendStatus ?? 'running',
      startedAt: overrides.frontendStartedAt ?? now,
      lastHeartbeat: overrides.frontendLastHeartbeat ?? now,
      logs: overrides.frontendLogs ?? [],
      isStub: true
    },
    backend: {
      pid: overrides.backendPid ?? 10002,
      port: overrides.backendPort ?? 3000,
      type: 'backend',
      status: overrides.backendStatus ?? 'running',
      startedAt: overrides.backendStartedAt ?? now,
      lastHeartbeat: overrides.backendLastHeartbeat ?? now,
      logs: overrides.backendLogs ?? [],
      isStub: true
    }
  };
};
