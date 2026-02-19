import { describe, test, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';

const getRunningProcessEntryMock = vi.hoisted(() => vi.fn());
const getStoredProjectPortsMock = vi.hoisted(() => vi.fn());
const getProjectPortHintsMock = vi.hoisted(() => vi.fn());
const storeRunningProcessesMock = vi.hoisted(() => vi.fn());
const terminateRunningProcessesMock = vi.hoisted(() => vi.fn());
const buildPortOverrideOptionsMock = vi.hoisted(() => vi.fn(() => ({})));
const extractProcessPortsMock = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('../routes/projects/processManager.js', () => ({
  getRunningProcessEntry: getRunningProcessEntryMock,
  getStoredProjectPorts: getStoredProjectPortsMock,
  getProjectPortHints: getProjectPortHintsMock,
  storeRunningProcesses: storeRunningProcessesMock,
  terminateRunningProcesses: terminateRunningProcessesMock,
  buildPortOverrideOptions: buildPortOverrideOptionsMock,
  extractProcessPorts: extractProcessPortsMock
}));

const getProjectMock = vi.hoisted(() => vi.fn());
const getPortSettingsMock = vi.hoisted(() => vi.fn());
const updateProjectPortsMock = vi.hoisted(() => vi.fn());
vi.mock('../database.js', () => ({
  getProject: getProjectMock,
  getPortSettings: getPortSettingsMock,
  updateProjectPorts: updateProjectPortsMock
}));

const startProjectMock = vi.hoisted(() => vi.fn());
vi.mock('../services/projectScaffolding.js', () => ({
  startProject: startProjectMock
}));

const proxyStub = vi.hoisted(() => ({
  on: vi.fn(),
  web: vi.fn(),
  ws: vi.fn()
}));

const createProxyServerMock = vi.hoisted(() => vi.fn(() => proxyStub));
vi.mock('http-proxy', () => ({
  default: {
    createProxyServer: createProxyServerMock
  }
}));

const createReq = (url, headers = {}) => ({
  url,
  headers
});

const createRes = () => {
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn((code) => {
      res.statusCode = code;
      res.headersSent = true;
    }),
    end: vi.fn(),
    status: vi.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    send: vi.fn(() => res)
  };
  return res;
};

const getProxyHandler = (eventName) => {
  const call = proxyStub.on.mock.calls.find(([event]) => event === eventName);
  return call?.[1];
};

const createProxyRes = ({ headers = {}, statusCode = 200 } = {}) => {
  const listeners = new Map();
  return {
    headers,
    statusCode,
    on: vi.fn((event, handler) => {
      listeners.set(event, handler);
    }),
    emit: (event, payload) => {
      const handler = listeners.get(event);
      if (handler) {
        handler(payload);
      }
    },
    pipe: vi.fn()
  };
};

describe('previewProxy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getRunningProcessEntryMock.mockReset();
    getStoredProjectPortsMock.mockReset();
    getProjectPortHintsMock.mockReset();
    storeRunningProcessesMock.mockReset();
    terminateRunningProcessesMock.mockReset();
    buildPortOverrideOptionsMock.mockReset();
    extractProcessPortsMock.mockReset();
    getProjectMock.mockReset();
    getPortSettingsMock.mockReset();
    updateProjectPortsMock.mockReset();
    startProjectMock.mockReset();
    proxyStub.on.mockReset();
    proxyStub.web.mockReset();
    proxyStub.ws.mockReset();
    createProxyServerMock.mockClear();
  });

  test('resolvePreviewTargetHost preserves localhost host header', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/preview/12/', { host: 'LOCALHOST:5173' });
    const resolved = __testOnly.resolvePreviewTargetHost(req);

    expect(resolved).toBe('LOCALHOST');
  });

  test('proxy error handler auto-restarts on repeated connection failures for iframe navigation', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    getPortSettingsMock.mockResolvedValue({});
    buildPortOverrideOptionsMock.mockReturnValue({});
    terminateRunningProcessesMock.mockResolvedValue();
    extractProcessPortsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    startProjectMock.mockResolvedValue({
      success: true,
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } }
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/', { 'sec-fetch-dest': 'iframe' });
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    // First failure: records state but does not trigger restart yet.
    errorHandler(new Error('connect ECONNREFUSED'), req, res);
    await Promise.resolve();
    expect(terminateRunningProcessesMock).not.toHaveBeenCalled();

    // Second failure in the window: triggers background auto-restart.
    errorHandler(new Error('ECONNREFUSED'), req, res);
    for (let i = 0; i < 20 && startProjectMock.mock.calls.length === 0; i += 1) {
      // attemptAutoRestart runs in the background (fire-and-forget).
      await Promise.resolve();
    }

    for (let i = 0; i < 20 && updateProjectPortsMock.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(startProjectMock).toHaveBeenCalled();

    expect(terminateRunningProcessesMock).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        project: expect.objectContaining({ path: 'C:/tmp/project-12' }),
        waitForRelease: true,
        forcePorts: true
      })
    );
    expect(startProjectMock).toHaveBeenCalledWith(
      'C:/tmp/project-12',
      expect.objectContaining({
        frontendPort: 5173,
        backendPort: 3000
      })
    );
    expect(storeRunningProcessesMock).toHaveBeenCalledWith(
      12,
      { frontend: { port: 5173 }, backend: { port: 3000 } },
      'running',
      { launchType: 'auto' }
    );
    expect(updateProjectPortsMock).toHaveBeenCalledWith(12, { frontend: 5173, backend: 3000 });
  });

  test('__testOnly.attemptAutoRestart covers normalizeProjectKey and success path', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    getPortSettingsMock.mockResolvedValue({});
    buildPortOverrideOptionsMock.mockReturnValue({});
    terminateRunningProcessesMock.mockResolvedValue();
    extractProcessPortsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    startProjectMock.mockResolvedValue({
      success: true,
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } }
    });

    await __testOnly.attemptAutoRestart(12, { logger: { warn } });

    expect(terminateRunningProcessesMock).toHaveBeenCalledWith(
      12,
      expect.objectContaining({
        project: expect.objectContaining({ path: 'C:/tmp/project-12' }),
        waitForRelease: true,
        forcePorts: true
      })
    );
    expect(startProjectMock).toHaveBeenCalledWith(
      'C:/tmp/project-12',
      expect.objectContaining({ frontendPort: 5173, backendPort: 3000 })
    );
    expect(storeRunningProcessesMock).toHaveBeenCalledWith(
      12,
      { frontend: { port: 5173 }, backend: { port: 3000 } },
      'running',
      { launchType: 'auto' }
    );
    expect(updateProjectPortsMock).toHaveBeenCalledWith(12, { frontend: 5173, backend: 3000 });
  });

  test('__testOnly.normalizeProjectKey returns null for nullish and blank inputs', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    expect(__testOnly.normalizeProjectKey(undefined)).toBe(null);
    expect(__testOnly.normalizeProjectKey(null)).toBe(null);
    expect(__testOnly.normalizeProjectKey('   ')).toBe(null);
  });

  test('__testOnly.attemptAutoRestart no-ops when projectId is nullish', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    await __testOnly.attemptAutoRestart(null, { logger: { warn } });
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(startProjectMock).not.toHaveBeenCalled();
  });

  test('__testOnly.attemptAutoRestart returns early when restart does not succeed', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    getPortSettingsMock.mockResolvedValue({});
    buildPortOverrideOptionsMock.mockReturnValue({});
    terminateRunningProcessesMock.mockResolvedValue();
    startProjectMock.mockResolvedValue({ success: false });

    await __testOnly.attemptAutoRestart(12, { logger: { warn } });

    expect(startProjectMock).toHaveBeenCalled();
    expect(updateProjectPortsMock).not.toHaveBeenCalled();
    expect(storeRunningProcessesMock).not.toHaveBeenCalledWith(
      12,
      expect.anything(),
      'running',
      expect.objectContaining({ launchType: 'auto' })
    );
  });

  test('__testOnly.attemptAutoRestart logs a warning when auto-restart throws', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    terminateRunningProcessesMock.mockRejectedValue(new Error('terminate failed'));

    await __testOnly.attemptAutoRestart(12, { logger: { warn } });

    expect(warn).toHaveBeenCalled();
  });

  test('__testOnly.attemptAutoRestart logs the raw error when message is blank', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });

    const thrown = { message: '' };
    terminateRunningProcessesMock.mockRejectedValue(thrown);

    await __testOnly.attemptAutoRestart(12, { logger: { warn } });

    expect(warn).toHaveBeenCalledWith('[preview-proxy] auto-restart failed', thrown);
  });

  test('__testOnly.attemptAutoRestart does not log when logger is missing', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    terminateRunningProcessesMock.mockRejectedValue(new Error('terminate failed'));

    await expect(__testOnly.attemptAutoRestart(12)).resolves.toBeUndefined();
  });

  test('__testOnly.shouldAttemptAutoRestart preserves lastRestartAt when failure window expires', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const projectKey = 'project-12';

    // Seed state.
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(false);

    // Move beyond the failure window and record a restart attempt.
    now += 10_000;
    __testOnly.markAutoRestartAttempted(projectKey);

    // Move beyond the window relative to the original firstFailureAt, forcing reset logic.
    now += 10_000;
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(false);

    // Ensure the non-zero lastRestartAt survived the reset (so cooldown logic can use it).
    now += 1;
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(false);

    nowSpy.mockRestore();
  });

  test('__testOnly.shouldAttemptAutoRestart increments within the failure window', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const projectKey = 'project-shouldAttempt-in-window';

    // First failure seeds state.
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(false);

    // Second failure within the window hits the increment path.
    now += 1;
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(true);

    nowSpy.mockRestore();
  });

  test('__testOnly.shouldAttemptAutoRestart tolerates a zero count state', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    const projectKey = 'project-shouldAttempt-zero-count';

    // Create a state shape with count=0 via markAutoRestartAttempted.
    __testOnly.markAutoRestartAttempted(projectKey);

    // Next failure within the window should take the increment path and handle count=0.
    now += 1;
    expect(__testOnly.shouldAttemptAutoRestart(projectKey)).toBe(false);

    nowSpy.mockRestore();
  });

  test('__testOnly.attemptAutoRestart returns early when an auto-restart is already in-flight', async () => {
    const warn = vi.fn();
    const { __testOnly } = await import('../routes/previewProxy.js');

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    getPortSettingsMock.mockResolvedValue({});
    buildPortOverrideOptionsMock.mockReturnValue({});
    terminateRunningProcessesMock.mockResolvedValue();
    extractProcessPortsMock.mockReturnValue({ frontend: 5173, backend: 3000 });

    let resolveStart = null;
    startProjectMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    const first = __testOnly.attemptAutoRestart(12, { logger: { warn } });
    const second = __testOnly.attemptAutoRestart(12, { logger: { warn } });

    // Let the first restart reach the startProject await so we can finish it.
    for (let i = 0; i < 20 && startProjectMock.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(startProjectMock).toHaveBeenCalledTimes(1);
    expect(getProjectMock).toHaveBeenCalledTimes(1);

    resolveStart?.({
      success: true,
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } }
    });

    await Promise.all([first, second]);

    expect(startProjectMock).toHaveBeenCalledTimes(1);
    expect(getProjectMock).toHaveBeenCalledTimes(1);
    expect(terminateRunningProcessesMock).toHaveBeenCalledTimes(1);
  });

  test('proxy error handler does not auto-restart when project path is unavailable', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });
    getProjectMock.mockResolvedValue({ id: 12, path: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/', { accept: 'text/html' });
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    errorHandler(new Error('ECONNREFUSED'), req, res);
    errorHandler(new Error('ECONNREFUSED'), req, res);
    await Promise.resolve();
    await Promise.resolve();

    expect(startProjectMock).not.toHaveBeenCalled();
    expect(terminateRunningProcessesMock).not.toHaveBeenCalled();
    expect(updateProjectPortsMock).not.toHaveBeenCalled();
  });

  test('proxy error handler does not start a second auto-restart while one is in-flight', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    let now = 100_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    getProjectMock.mockResolvedValue({ id: 12, path: 'C:/tmp/project-12' });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5173, backend: 3000 });
    getPortSettingsMock.mockResolvedValue({});
    buildPortOverrideOptionsMock.mockReturnValue({});
    terminateRunningProcessesMock.mockResolvedValue();
    extractProcessPortsMock.mockReturnValue({ frontend: 5173, backend: 3000 });

    let resolveStart = null;
    startProjectMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        })
    );

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/', { accept: 'text/html' });
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    try {
      // Prime the window.
      errorHandler(new Error('ECONNREFUSED'), req, res);
      // Triggers first restart.
      errorHandler(new Error('ECONNREFUSED'), req, res);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(startProjectMock).toHaveBeenCalledTimes(1);

      // Advance beyond cooldown while the restart is still pending, then send a new
      // burst of failures inside the new window. The second failure would normally
      // trigger another restart, but should be blocked by the in-flight guard.
      now += 31_000;
      errorHandler(new Error('ECONNREFUSED'), req, res);
      errorHandler(new Error('ECONNREFUSED'), req, res);
      await Promise.resolve();

      expect(startProjectMock).toHaveBeenCalledTimes(1);

      resolveStart?.({
        success: true,
        processes: { frontend: { port: 5173 }, backend: { port: 3000 } }
      });

      await Promise.resolve();
      await Promise.resolve();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('parsePreviewPath preserves query strings', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const parsed = __testOnly.parsePreviewPath('/preview/12/about?x=1');
    expect(parsed).toEqual({ projectId: '12', forwardPath: '/about?x=1' });
  });

  test('getProjectIdFromRequest resolves preview path context', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/preview/55/app?x=1');
    const info = __testOnly.getProjectIdFromRequest(req);

    expect(info).toEqual({
      source: 'path',
      projectId: '55',
      forwardPath: '/app?x=1'
    });
  });

  test('buildSetCookieHeader encodes project IDs', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.buildSetCookieHeader('a b')).toContain('lucidcoder_preview_project=a%20b');
  });

  test('parseCookieHeader tolerates decodeURIComponent failures', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const cookies = __testOnly.parseCookieHeader('a=%E0%A4%A');
    expect(cookies).toEqual({ a: '%E0%A4%A' });
  });

  test('parseCookieHeader ignores empty cookie keys', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.parseCookieHeader(' =1; a=2')).toEqual({ a: '2' });
  });

  test('parseCookieHeader ignores empty cookie values', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.parseCookieHeader('a=; b=2')).toEqual({ b: '2' });
  });

  test('parsePreviewPath returns null when URL parsing fails', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const originalUrl = globalThis.URL;
    try {
      globalThis.URL = class FakeURL {
        constructor() {
          throw new Error('boom');
        }
      };
      expect(__testOnly.parsePreviewPath('/preview/12/about')).toBe(null);
    } finally {
      globalThis.URL = originalUrl;
    }
  });

  test('parsePreviewPath returns null when normalized pathname loses prefix', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.parsePreviewPath('/preview/../x')).toBe(null);
  });

  test('parsePreviewPath returns null when url is not a string', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.parsePreviewPath(null)).toBe(null);
  });

  test('parsePreviewPath returns null when parsed pathname is missing', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const originalUrl = globalThis.URL;
    try {
      globalThis.URL = class FakeURL {
        constructor() {
          this.pathname = '';
          this.search = '';
        }
      };
      expect(__testOnly.parsePreviewPath('/preview/12/about')).toBe(null);
    } finally {
      globalThis.URL = originalUrl;
    }
  });

  test('parsePreviewPath returns null when project id segment is missing', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.parsePreviewPath('/preview//about')).toBe(null);
  });

  test('buildPreviewBridgeScript falls back when previewPrefix is not a string', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const script = __testOnly.buildPreviewBridgeScript({ previewPrefix: null });
    expect(script).toContain("var prefix = \"\"");
    expect(script).toContain('LUCIDCODER_PREVIEW_BRIDGE_READY');
    expect(script).toContain('LUCIDCODER_PREVIEW_BRIDGE_PONG');
  });

  test('buildPreviewBridgeScript includes preview helper hooks', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const script = __testOnly.buildPreviewBridgeScript({ previewPrefix: '/preview/123' });
    expect(script).toContain('LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU');
    expect(script).toContain('LUCIDCODER_PREVIEW_HELPER_READY');
    expect(script).toContain('LUCIDCODER_PREVIEW_NAVIGATE');
    expect(script).toContain('LUCIDCODER_PREVIEW_BRIDGE_POINTER');
    expect(script).toContain('window.parent === window');
    expect(script).toContain('parentWindow === window');
  });

  test('shouldBypassPreviewProxy tolerates non-string inputs', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.shouldBypassPreviewProxy(null)).toBe(false);
  });

  test('isLikelyPreviewDevAssetPath detects known dev asset paths and handles blank/invalid URLs', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    expect(__testOnly.isLikelyPreviewDevAssetPath('')).toBe(false);
    expect(__testOnly.isLikelyPreviewDevAssetPath(null)).toBe(false);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/@vite/client')).toBe(true);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/@react-refresh')).toBe(true);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/@id/some-module')).toBe(true);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/@fs/C:/tmp/file.js')).toBe(true);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/src/main.jsx')).toBe(true);
    expect(__testOnly.isLikelyPreviewDevAssetPath('/node_modules/react/index.js')).toBe(true);

    const originalUrl = globalThis.URL;
    try {
      globalThis.URL = class FakeURL {
        constructor() {
          throw new Error('boom');
        }
      };

      expect(__testOnly.isLikelyPreviewDevAssetPath('/@vite/client')).toBe(false);
    } finally {
      globalThis.URL = originalUrl;
    }
  });

  test('isLikelyPreviewDevAssetPath falls back when URL pathname is falsy', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const originalUrl = globalThis.URL;
    try {
      globalThis.URL = class FakeURL {
        constructor() {
          this.pathname = '';
        }
      };

      expect(__testOnly.isLikelyPreviewDevAssetPath('/@vite/client')).toBe(false);
    } finally {
      globalThis.URL = originalUrl;
    }
  });

  test('isLikelyViteHmrWebSocketRequest detects vite-hmr protocol and token fallback', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    expect(__testOnly.isLikelyViteHmrWebSocketRequest(createReq('/ws', { upgrade: 'h2c' }))).toBe(false);

    expect(
      __testOnly.isLikelyViteHmrWebSocketRequest(createReq('/ws', { upgrade: 123 }))
    ).toBe(false);

    expect(
      __testOnly.isLikelyViteHmrWebSocketRequest(createReq('/ws', { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' }))
    ).toBe(true);

    expect(
      __testOnly.isLikelyViteHmrWebSocketRequest(createReq('/ws?token=abc', { upgrade: 'websocket' }))
    ).toBe(true);

    expect(
      __testOnly.isLikelyViteHmrWebSocketRequest(createReq('/ws', { upgrade: 'websocket' }))
    ).toBe(false);

    expect(
      __testOnly.isLikelyViteHmrWebSocketRequest(createReq(null, { upgrade: 'websocket' }))
    ).toBe(false);
  });

  test('getProjectIdFromRequest routes via cookie when preview cookie is present', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/assets/app.js', {
      cookie: 'lucidcoder_preview_project=55'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toEqual({
      source: 'cookie',
      projectId: '55',
      forwardPath: '/assets/app.js'
    });
  });

  test('getProjectIdFromRequest cookie routing falls back to empty forwardPath when url is invalid', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq(null, {
      cookie: 'lucidcoder_preview_project=55'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toEqual({
      source: 'cookie',
      projectId: '55',
      forwardPath: ''
    });
  });

  test('getProjectIdFromRequest routes via cookie for iframe preview navigations', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/index.html', {
      'sec-fetch-dest': 'iframe',
      cookie: 'lucidcoder_preview_project=55'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toEqual({
      source: 'cookie',
      projectId: '55',
      forwardPath: '/index.html'
    });
  });

  test('getProjectIdFromRequest tolerates non-string sec-fetch-dest when referer indicates preview origin', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/index.html', {
      'sec-fetch-dest': 123,
      referer: 'http://localhost/preview/55/',
      cookie: 'lucidcoder_preview_project=55'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toEqual({
      source: 'cookie',
      projectId: '55',
      forwardPath: '/index.html'
    });
  });

  test('getProjectIdFromRequest returns null when cookie routing is allowed but cookie is missing', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/index.html', {
      'sec-fetch-dest': 'iframe'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toBe(null);
  });

  test('getProjectIdFromRequest allows cookie routing for Vite HMR websocket token requests', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const req = createReq('/@vite/client?token=abc', {
      upgrade: 'websocket',
      cookie: 'lucidcoder_preview_project=55'
    });

    expect(__testOnly.getProjectIdFromRequest(req)).toEqual({
      source: 'cookie',
      projectId: '55',
      forwardPath: '/@vite/client?token=abc'
    });
  });

  test('resolvePreviewTargetHost uses env override (and maps 0.0.0.0 to localhost)', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const original = process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
    try {
      process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST = '  example.com  ';
      expect(__testOnly.resolvePreviewTargetHost(createReq('/preview/1'))).toBe('example.com');

      process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST = '0.0.0.0';
      expect(__testOnly.resolvePreviewTargetHost(createReq('/preview/1'))).toBe('localhost');
    } finally {
      if (typeof original === 'undefined') {
        delete process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
      } else {
        process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST = original;
      }
    }
  });

  test('resolvePreviewTargetHost prefers x-forwarded-host, strips ports, and handles IPv6 bracket hosts', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const original = process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
    try {
      delete process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;

      expect(
        __testOnly.resolvePreviewTargetHost(createReq('/preview/1', { 'x-forwarded-host': 'myhost:5173, proxy:1234' }))
      ).toBe('localhost');

      expect(
        __testOnly.resolvePreviewTargetHost(createReq('/preview/1', { host: '[::1]:5000' }))
      ).toBe('::1');

      expect(
        __testOnly.resolvePreviewTargetHost(createReq('/preview/1', { host: '[   ]:5000' }))
      ).toBe('localhost');
    } finally {
      if (typeof original === 'undefined') {
        delete process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
      } else {
        process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST = original;
      }
    }
  });

  test('resolvePreviewTargetHost falls back to localhost for missing/0.0.0.0 hosts', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    const original = process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
    try {
      delete process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;

      expect(__testOnly.resolvePreviewTargetHost(createReq('/preview/1', {}))).toBe('localhost');
      expect(__testOnly.resolvePreviewTargetHost(createReq('/preview/1', { host: '' }))).toBe('localhost');
      expect(__testOnly.resolvePreviewTargetHost(createReq('/preview/1', { host: '0.0.0.0:5173' }))).toBe('localhost');
    } finally {
      if (typeof original === 'undefined') {
        delete process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST;
      } else {
        process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST = original;
      }
    }
  });

  test('middleware bypasses /api routes', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/api/health');
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(proxyStub.web).not.toHaveBeenCalled();
  });

  test('middleware falls through when no preview routing applies', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/somewhere');
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(proxyStub.web).not.toHaveBeenCalled();
  });

  test('middleware proxies /preview/:id and sets cookie', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    let proxiedUrl = null;
    let proxyOptions = null;
    proxyStub.web.mockImplementation((req, res, options) => {
      proxiedUrl = req.url;
      proxyOptions = options;
    });

    const req = createReq('/preview/12/');
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxyOptions).toEqual(expect.objectContaining({
      target: 'http://localhost:5173',
      selfHandleResponse: true
    }));
    expect(proxiedUrl).toBe('/');

    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining(`${__testOnly.COOKIE_NAME}=`)
    );

    // Ensure the incoming URL is restored after proxying.
    expect(req.url).toBe('/preview/12/');
  });

  test('middleware targets the incoming host when accessed over the network', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 6100 } },
      state: 'running'
    });

    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    proxyStub.web.mockImplementation(() => {});

    const req = createReq('/preview/12/', {
      host: '192.168.0.60:5000'
    });
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxyStub.web.mock.calls[0][2]).toMatchObject({
      target: 'http://localhost:6100'
    });
  });

  test('middleware forwards errors to next when proxy resolution fails', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    const error = new Error('db down');
    getProjectMock.mockRejectedValue(error);

    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/preview/12/');
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  test('middleware proxies requests when cookie is present', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 6100 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    let proxiedUrl = null;
    proxyStub.web.mockImplementation((req) => {
      proxiedUrl = req.url;
    });

    const req = createReq('/about', {
      cookie: `${__testOnly.COOKIE_NAME}=99`,
      referer: 'http://localhost/preview/12/'
    });
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxiedUrl).toBe('/about');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  test('middleware proxies host app routes when preview cookie is present', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 6100 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    let proxiedUrl = null;
    proxyStub.web.mockImplementation((req) => {
      proxiedUrl = req.url;
    });

    const req = createReq('/', {
      cookie: `${__testOnly.COOKIE_NAME}=99`
    });
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxiedUrl).toBe('/');
  });

  test('middleware serves project uploads directly when preview cookie is present', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'preview-proxy-uploads-'));
    try {
      const uploadsDir = path.join(tmpDir, 'uploads');
      const imagePath = path.join(uploadsDir, 'hero.png');
      await mkdir(uploadsDir, { recursive: true });
      await writeFile(imagePath, Buffer.from('png-binary'));

      getProjectMock.mockResolvedValue({ id: 99, path: tmpDir });

      const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
      const instance = createPreviewProxy({ logger: null });

      const req = createReq('/uploads/hero.png', {
        cookie: `${__testOnly.COOKIE_NAME}=99`
      });
      const res = createRes();
      const next = vi.fn();

      await instance.middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(proxyStub.web).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'image/png'
      }));
      expect(res.end).toHaveBeenCalledWith(expect.any(Buffer));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('middleware proxies Vite dev asset requests when cookie is present even without referer', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 6100 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    let proxiedUrl = null;
    proxyStub.web.mockImplementation((req) => {
      proxiedUrl = req.url;
    });

    const req = createReq('/src/App.jsx', {
      cookie: `${__testOnly.COOKIE_NAME}=99`
    });
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxiedUrl).toBe('/src/App.jsx');
  });

  test('middleware returns 409 html when project is not running', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    getProjectMock.mockResolvedValue(null);

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/preview/77/', {
      cookie: `${__testOnly.COOKIE_NAME}=77`
    });
    const res = createRes();
    const next = vi.fn();

    await instance.middleware(req, res, next);

    expect(proxyStub.web).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Preview unavailable'));
  });

  test('resolveFrontendPort returns stored frontend port when available', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    getProjectMock.mockResolvedValue({ id: 1, name: 'Project' });
    getStoredProjectPortsMock.mockReturnValue({ frontend: 4100 });

    const { __testOnly } = await import('../routes/previewProxy.js');

    await expect(__testOnly.resolveFrontendPort(1)).resolves.toBe(4100);
  });

  test('resolveFrontendPort returns port hints when stored ports are missing', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    getProjectMock.mockResolvedValue({ id: 1, name: 'Project' });
    getStoredProjectPortsMock.mockReturnValue({ frontend: 0 });
    getProjectPortHintsMock.mockReturnValue({ frontend: 4200 });

    const { __testOnly } = await import('../routes/previewProxy.js');

    await expect(__testOnly.resolveFrontendPort(1)).resolves.toBe(4200);
  });

  test('resolveFrontendPort returns null when no stored or hinted ports exist', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    getProjectMock.mockResolvedValue({ id: 1, name: 'Project' });
    getStoredProjectPortsMock.mockReturnValue({ frontend: 0 });
    getProjectPortHintsMock.mockReturnValue({ frontend: 0 });

    const { __testOnly } = await import('../routes/previewProxy.js');

    await expect(__testOnly.resolveFrontendPort(1)).resolves.toBeNull();
  });

  test('proxyRes handler no-ops when request context is missing', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/');
    const res = createRes();
    const proxyRes = createProxyRes({ headers: { 'content-type': 'text/html' } });

    proxyResHandler(proxyRes, req, res);
    expect(res.end).not.toHaveBeenCalled();
    expect(proxyRes.pipe).not.toHaveBeenCalled();
  });

  test('proxyRes handler pipes through non-HTML responses', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    const proxyRes = createProxyRes({
      headers: { 'content-type': 'application/javascript', 'content-length': '123' },
      statusCode: 200
    });

    proxyResHandler(proxyRes, req, res);

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
  });

  test('proxyRes handler treats missing content-type as non-HTML and defaults status code', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    const proxyRes = createProxyRes({ headers: {}, statusCode: 0 });

    proxyResHandler(proxyRes, req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
  });

  test('proxyRes handler does not write headers for non-HTML when response already started', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    res.headersSent = true;

    const proxyRes = createProxyRes({
      headers: { 'content-type': 'application/javascript' },
      statusCode: 200
    });

    proxyResHandler(proxyRes, req, res);

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
  });

  test('proxyRes handler injects bridge script for HTML responses', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    const proxyRes = createProxyRes({
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '1' },
      statusCode: 200
    });

    proxyResHandler(proxyRes, req, res);

    proxyRes.emit('data', Buffer.from('<html><head><title>x</title></head><body>ok</body></html>', 'utf8'));
    proxyRes.emit('end');

    const payload = res.end.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    const html = payload.toString('utf8');
    expect(html).toContain('LUCIDCODER_PREVIEW_NAV');
    expect(html).toContain('/preview/12');
  });

  test('proxyRes handler strips CSP headers for HTML responses', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    const proxyRes = createProxyRes({
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': '1',
        'content-security-policy': "default-src 'self'; script-src 'self'",
        'content-security-policy-report-only': "default-src 'self'"
      },
      statusCode: 200
    });

    proxyResHandler(proxyRes, req, res);
    proxyRes.emit('data', Buffer.from('<html><head><title>x</title></head><body>ok</body></html>', 'utf8'));
    proxyRes.emit('end');

    const headers = res.writeHead.mock.calls[0]?.[1];
    expect(headers).toBeTruthy();
    expect(headers).not.toHaveProperty('content-security-policy');
    expect(headers).not.toHaveProperty('content-security-policy-report-only');
  });

  test('proxyRes handler defaults HTML status code when proxy response status is falsy', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    const proxyRes = createProxyRes({
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '1' },
      statusCode: 0
    });

    proxyResHandler(proxyRes, req, res);

    proxyRes.emit('data', Buffer.from('<html><head></head><body>ok</body></html>', 'utf8'));
    proxyRes.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('proxyRes handler does not write headers for HTML when response already started', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const proxyResHandler = getProxyHandler('proxyRes');
    expect(typeof proxyResHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { previewPrefix: '/preview/12' };

    const res = createRes();
    res.headersSent = true;

    const proxyRes = createProxyRes({
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '1' },
      statusCode: 200
    });

    proxyResHandler(proxyRes, req, res);

    proxyRes.emit('data', Buffer.from('<html><head><title>x</title></head><body>ok</body></html>', 'utf8'));
    proxyRes.emit('end');

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('injectPreviewBridge returns input when html is empty or non-string', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    expect(__testOnly.injectPreviewBridge('', { previewPrefix: '/preview/1' })).toBe('');
    expect(__testOnly.injectPreviewBridge(null, { previewPrefix: '/preview/1' })).toBe(null);
  });

  test('injectPreviewBridge prepends script when <head> is missing', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const injected = __testOnly.injectPreviewBridge('<html><body>ok</body></html>', { previewPrefix: '/preview/1' });
    expect(injected).toMatch(/^\n<script>/);
    expect(injected).toContain('LUCIDCODER_PREVIEW_NAV');
  });

  test('proxy error handler responds 502 and ends the response', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = createRes();
    errorHandler(new Error('explode'), req, res);

    expect(warn).toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
    expect(res.end).toHaveBeenCalledWith('Preview proxy error');
  });

  test('proxy error handler responds 503 when frontend is starting', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: null, backend: { port: 3000 } },
      state: 'idle'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    const err = new Error('ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    errorHandler(err, req, res);

    expect(warn).toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(res.end).toHaveBeenCalledWith('Preview is starting');
  });

  test('proxy error handler clears frontend process on ECONNREFUSED', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12 };
    const res = createRes();

    errorHandler(new Error('ECONNREFUSED'), req, res);

    expect(storeRunningProcessesMock).toHaveBeenCalledWith(
      12,
      { frontend: null, backend: { port: 3000 } },
      'running',
      { exposeSnapshot: true }
    );
  });

  test('proxy error handler clears frontend process for other connection failures via error.code', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    errorHandler(err, req, res);

    expect(storeRunningProcessesMock).toHaveBeenCalledWith(
      12,
      { frontend: null, backend: { port: 3000 } },
      'running',
      { exposeSnapshot: true }
    );
  });

  test('proxy error handler tolerates invalid context.port when remembering a bad port', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: null, backend: { port: 3000 } },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 'not-a-number' };
    const res = createRes();

    expect(() => errorHandler(new Error('connect ECONNREFUSED'), req, res)).not.toThrow();
    expect(storeRunningProcessesMock).not.toHaveBeenCalled();
  });

  test('proxy error handler ignores non-connection errors even when error.message is not a string', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    const err = new Error('');
    err.message = 123;
    errorHandler(err, req, res);

    expect(storeRunningProcessesMock).not.toHaveBeenCalled();
  });

  test('resolveFrontendPort falls back when running port is remembered bad', async () => {
    const warn = vi.fn();
    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
      state: 'running'
    });

    getProjectMock.mockResolvedValue({ id: 12 });
    getStoredProjectPortsMock.mockReturnValue({ frontend: 5174 });
    getProjectPortHintsMock.mockReturnValue({ frontend: 5175 });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
    const res = createRes();

    errorHandler(new Error('connect ECONNREFUSED'), req, res);

    await expect(__testOnly.resolveFrontendPort(12)).resolves.toBe(5174);
  });

  test('resolveFrontendPort forgets expired remembered-bad entries', async () => {
    const warn = vi.fn();
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    try {
      const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
      createPreviewProxy({ logger: { warn } });

      // First: record a bad port while no frontend process is currently tracked.
      getRunningProcessEntryMock.mockReturnValueOnce({
        processes: { frontend: null, backend: { port: 3000 } },
        state: 'running'
      });

      const errorHandler = getProxyHandler('error');
      expect(typeof errorHandler).toBe('function');

      const req = createReq('/preview/12/');
      req.__lucidcoderPreviewProxy = { projectId: 12, port: 5173 };
      const res = createRes();
      errorHandler(new Error('ECONNREFUSED'), req, res);

      // After TTL: the remembered entry is purged and the running port can be used.
      nowSpy.mockReturnValue(10_000);
      getRunningProcessEntryMock.mockReturnValueOnce({
        processes: { frontend: { port: 5173 }, backend: { port: 3000 } },
        state: 'running'
      });

      await expect(__testOnly.resolveFrontendPort(12)).resolves.toBe(5173);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('proxy error handler marks preview stopped when backend is absent', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 }, backend: null },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/99/');
    req.__lucidcoderPreviewProxy = { projectId: 99 };
    const res = createRes();

    errorHandler(new Error('ECONNREFUSED'), req, res);

    expect(storeRunningProcessesMock).toHaveBeenCalledWith(
      99,
      { frontend: null, backend: null },
      'stopped',
      { exposeSnapshot: true }
    );
  });

  test('proxy error handler does not update processes when frontend is already missing', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: null, backend: { port: 3000 } },
      state: 'running'
    });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    req.__lucidcoderPreviewProxy = { projectId: 12 };
    const res = createRes();

    errorHandler(new Error('ECONNREFUSED'), req, res);

    expect(storeRunningProcessesMock).not.toHaveBeenCalled();
  });

  test('proxy error handler sends auto-retrying HTML when the client accepts text/html', async () => {
    const warn = vi.fn();
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: { warn } });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/', { accept: 'text/html' });
    const res = createRes();
    errorHandler(new Error('connect ECONNREFUSED <boom>'), req, res);

    expect(warn).toHaveBeenCalled();
    const headers = res.writeHead.mock.calls[0][1];
    expect(headers['Content-Type']).toMatch(/text\/html/i);
    expect(headers['Cache-Control']).toMatch(/no-store/i);
    expect(res.end).toHaveBeenCalledTimes(1);

    const body = res.end.mock.calls[0][0];
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('Preview proxy error');
    expect(body).toContain('location.reload');
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('<boom>');
  });

  test('proxy error handler tolerates missing logger/res helpers and falls back to default message', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = { headersSent: true, writeHead: vi.fn() };

    expect(() => errorHandler(null, req, res)).not.toThrow();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  test('proxy error handler destroys socket-like responses when writeHead is unavailable', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = {
      destroy: vi.fn()
    };

    expect(() => errorHandler(new Error('ws explode'), req, res)).not.toThrow();
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });

  test('proxy error handler tolerates destroy() throwing on socket-like responses', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = {
      destroy: vi.fn(() => {
        throw new Error('destroy explode');
      })
    };

    expect(() => errorHandler(new Error('ws explode'), req, res)).not.toThrow();
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });

  test('proxy error handler attempts to end responses when only end() exists', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = {
      end: vi.fn(() => {
        throw new Error('end explode');
      })
    };

    expect(() => errorHandler(new Error('explode'), req, res)).not.toThrow();
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('proxy error handler no-ops when response lacks writeHead/destroy/end', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    createPreviewProxy({ logger: null });

    const errorHandler = getProxyHandler('error');
    expect(typeof errorHandler).toBe('function');

    const req = createReq('/preview/12/');
    const res = {};

    expect(() => errorHandler(new Error('explode'), req, res)).not.toThrow();
  });

  test('upgrade handler proxies websocket requests when cookie is present', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    const req = createReq('/ws', {
      cookie: `${__testOnly.COOKIE_NAME}=12`,
      referer: 'http://localhost/preview/12/'
    });
    const socket = { destroy: vi.fn() };
    const head = Buffer.from('');

    upgradeHandler(req, socket, head);
    await new Promise((resolve) => setImmediate(resolve));

    expect(proxyStub.ws).toHaveBeenCalledTimes(1);
    expect(proxyStub.ws.mock.calls[0][3]).toEqual({ target: 'http://localhost:5173' });
  });

  test('upgrade handler proxies Vite HMR websocket on root when cookie is present', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    const req = createReq('/?token=dev', {
      cookie: `${__testOnly.COOKIE_NAME}=12`,
      'sec-websocket-protocol': 'vite-hmr'
    });
    req.headers.upgrade = 'websocket';

    const socket = { destroy: vi.fn() };
    const head = Buffer.from('');

    upgradeHandler(req, socket, head);
    await new Promise((resolve) => setImmediate(resolve));

    expect(proxyStub.ws).toHaveBeenCalledTimes(1);
    expect(proxyStub.ws.mock.calls[0][3]).toEqual({ target: 'http://localhost:5173' });
  });

  test('upgrade handler bypasses non-preview paths', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    upgradeHandler(createReq('/api/health'), { destroy: vi.fn() }, Buffer.from(''));
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxyStub.ws).not.toHaveBeenCalled();
  });

  test('upgrade handler bails when project id cannot be resolved', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    upgradeHandler(createReq('/not-preview'), { destroy: vi.fn() }, Buffer.from(''));
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxyStub.ws).not.toHaveBeenCalled();
  });

  test('upgrade handler bails when preview is not running (no port)', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    const req = createReq('/ws', { cookie: `${__testOnly.COOKIE_NAME}=12`, referer: 'http://localhost/preview/12/' });
    upgradeHandler(req, { destroy: vi.fn() }, Buffer.from(''));
    await new Promise((resolve) => setImmediate(resolve));

    expect(proxyStub.ws).not.toHaveBeenCalled();
  });

  test('upgrade handler destroys socket when resolving the preview port fails', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });
    getProjectMock.mockRejectedValue(new Error('db down'));

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    const req = createReq('/ws', { cookie: `${__testOnly.COOKIE_NAME}=12`, referer: 'http://localhost/preview/12/' });
    const socket = { destroy: vi.fn() };

    upgradeHandler(req, socket, Buffer.from(''));
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  test('upgrade handler swallows proxy websocket errors and socket destroy errors', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: { frontend: { port: 5173 } },
      state: 'running'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    proxyStub.ws.mockImplementation(() => {
      throw new Error('ws explode');
    });

    const server = { on: vi.fn() };
    instance.registerUpgradeHandler(server);

    const upgradeHandler = server.on.mock.calls.find(([event]) => event === 'upgrade')?.[1];
    expect(typeof upgradeHandler).toBe('function');

    const req = createReq('/ws', { cookie: `${__testOnly.COOKIE_NAME}=12`, referer: 'http://localhost/preview/12/' });
    const socket = {
      destroy: vi.fn(() => {
        throw new Error('destroy explode');
      })
    };

    expect(() => upgradeHandler(req, socket, Buffer.from(''))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxyStub.ws).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  test('upgrade handler bails when server does not support events', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const server = { on: null };
    expect(() => instance.registerUpgradeHandler(server)).not.toThrow();
  });

  test('attachPreviewProxy throws when app is missing', async () => {
    const { attachPreviewProxy } = await import('../routes/previewProxy.js');

    expect(() => attachPreviewProxy({ app: null, server: null })).toThrow('attachPreviewProxy requires an express app');
  });

  test('attachPreviewProxy wires middleware and upgrade handler', async () => {
    const { attachPreviewProxy } = await import('../routes/previewProxy.js');

    const app = { use: vi.fn() };
    const server = { on: vi.fn() };

    const proxy = attachPreviewProxy({ app, server, logger: null });
    expect(proxy).toBe(proxyStub);
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(server.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
  });
});
