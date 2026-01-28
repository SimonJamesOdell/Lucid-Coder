import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { VERSION } from '../../shared/version.mjs';

const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock
}));

const httpServerStub = vi.hoisted(() => ({
  close: vi.fn(),
  on: vi.fn(),
  listen: vi.fn()
}));

const createServerMock = vi.hoisted(() => vi.fn(() => httpServerStub));

vi.mock('http', () => ({
  default: {
    createServer: createServerMock
  }
}));

const routerStub = vi.hoisted(() => vi.fn((req, res, next) => next()));

vi.mock('../routes/llm.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/projects.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/branches.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/commits.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/tests.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/settings.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/jobs.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/goals.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/agent.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/runs.js', () => ({ __esModule: true, default: routerStub }));
vi.mock('../routes/diagnostics.js', () => ({ __esModule: true, default: routerStub }));

const attachSocketServerMock = vi.hoisted(() => vi.fn(() => ({ connected: true })));
vi.mock('../socket/createSocketServer.js', () => ({
  attachSocketServer: attachSocketServerMock
}));

const initializeDatabaseMock = vi.hoisted(() => vi.fn());
const dbStub = vi.hoisted(() => ({
  run: (sql, params, cb) => {
    const callback = typeof params === 'function' ? params : cb;
    callback?.(null);
  },
  get: (sql, params, cb) => {
    const callback = typeof params === 'function' ? params : cb;
    callback?.(null, null);
  },
  all: (sql, params, cb) => {
    const callback = typeof params === 'function' ? params : cb;
    callback?.(null, []);
  }
}));
vi.mock('../database.js', () => ({
  __esModule: true,
  default: dbStub,
  initializeDatabase: initializeDatabaseMock
}));

const llmClientStub = vi.hoisted(() => ({
  initialize: vi.fn(),
  config: null,
  apiKey: null
}));
vi.mock('../llm-client.js', () => ({
  llmClient: llmClientStub
}));

let app;
let startServer;
const registeredSignalHandlers = [];

const trackSignalHandlers = () => {
  ['SIGINT', 'SIGTERM'].forEach(event => {
    const handlers = process.listeners(event);
    const handler = handlers[handlers.length - 1];
    if (handler) {
      registeredSignalHandlers.push({ event, handler });
    }
  });
};

const cleanupSignalHandlers = () => {
  while (registeredSignalHandlers.length) {
    const { event, handler } = registeredSignalHandlers.pop();
    process.removeListener(event, handler);
  }
};

const getTrackedHandler = (event) => {
  for (let i = registeredSignalHandlers.length - 1; i >= 0; i -= 1) {
    if (registeredSignalHandlers[i].event === event) {
      return registeredSignalHandlers[i].handler;
    }
  }
  return undefined;
};

const loadServerModule = async (options = {}) => {
  process.env.NODE_ENV = options.nodeEnv ?? 'test';
  if ('port' in options) {
    if (options.port == null) {
      delete process.env.PORT;
    } else {
      process.env.PORT = options.port;
    }
  } else {
    process.env.PORT = '5050';
  }

  const serverModule = await import('../server.js');
  app = serverModule.app;
  startServer = serverModule.startServer;
  trackSignalHandlers();
  return serverModule;
};

describe('server bootstrap and middleware', () => {
  beforeEach(async () => {
    vi.resetModules();
    initializeDatabaseMock.mockReset();
    llmClientStub.initialize.mockReset();
    llmClientStub.config = null;
    attachSocketServerMock.mockReset();
    readFileSyncMock.mockReset();
    routerStub.mockImplementation((req, res, next) => next());
    createServerMock.mockClear();
    httpServerStub.close.mockReset();
    httpServerStub.on.mockReset();
    httpServerStub.listen.mockReset();
    httpServerStub.listen.mockImplementation((port, cb) => {
      cb?.();
      return httpServerStub;
    });
    await loadServerModule();
  });

  afterEach(() => {
    cleanupSignalHandlers();
  });

  test('health endpoint reports status and llm flag', async () => {
    llmClientStub.config = { provider: 'groq' };

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      message: 'Backend server is running!',
      database: 'connected',
      llm: 'configured'
    }));
  });

  test('health endpoint reports when llm is not configured', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.llm).toBe('not configured');
  });

  test('version endpoint reports the repo versions', async () => {
    readFileSyncMock.mockImplementation((filePath) => {
      const normalized = String(filePath).replace(/\\/g, '/');

      if (normalized.endsWith('/VERSION')) {
        return `${VERSION}\n`;
      }

      if (normalized.endsWith('/frontend/package.json')) {
        return JSON.stringify({ name: 'lucidcoder-frontend', version: VERSION });
      }

      if (normalized.endsWith('/backend/package.json')) {
        return JSON.stringify({ name: 'lucidcoder-backend', version: VERSION });
      }

      if (normalized.endsWith('/package.json')) {
        return JSON.stringify({ name: 'lucidcoder', version: VERSION });
      }

      return '';
    });

    const response = await request(app).get('/api/version');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      version: VERSION,
      versionFile: VERSION
    }));
    expect(response.body.root).toEqual({ name: 'lucidcoder', version: VERSION });
    expect(response.body.backend).toEqual({ name: 'lucidcoder-backend', version: VERSION });
    expect(response.body.frontend).toEqual({ name: 'lucidcoder-frontend', version: VERSION });
  });

  test('version endpoint returns 500 when reading versions fails', async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const response = await request(app).get('/api/version');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to load version information'
    });
  });

  test('blocks POST /api/agent/request when llm is not configured', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'LLM is not configured',
      configured: false,
      ready: false,
      reason: 'No LLM configuration found'
    });
  });

  test('blocks POST /api/agent/request when api key is missing for key-required providers', async () => {
    llmClientStub.config = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      api_url: 'https://api.openai.com/v1',
      api_key_encrypted: ''
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'LLM is not configured',
      configured: true,
      ready: false,
      reason: 'Missing API key'
    });
  });

  test('treats a falsy provider as requiring an API key', async () => {
    llmClientStub.config = {
      provider: null,
      model: 'gpt-4o-mini',
      api_url: 'https://api.openai.com/v1',
      api_key_encrypted: ''
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe('Missing API key');
  });

  test('blocks POST /api/agent/request when api_url is missing', async () => {
    llmClientStub.config = {
      provider: 'ollama',
      model: 'llama3'
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe('Missing API URL');
  });

  test('blocks POST /api/agent/request when model is missing', async () => {
    llmClientStub.config = {
      provider: 'ollama',
      api_url: 'http://localhost:11434'
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body.reason).toBe('Missing model');
  });

  test('blocks POST /api/agent/request when encrypted key exists but decryption fails', async () => {
    llmClientStub.config = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      api_url: 'https://api.openai.com/v1',
      api_key_encrypted: 'encrypted'
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'LLM is not configured',
      configured: true,
      ready: false,
      reason: 'Failed to decrypt API key'
    });
  });

  test('allows POST /api/agent/request when provider does not require an API key', async () => {
    llmClientStub.config = {
      provider: 'ollama',
      model: 'llama3',
      api_url: 'http://localhost:11434'
    };
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    // The route itself is a stub in this test file, so it will fall through to 404.
    expect(response.status).toBe(404);
  });

  test('allows POST /api/agent/request when llm is ready', async () => {
    llmClientStub.config = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      api_url: 'https://api.openai.com/v1',
      api_key_encrypted: 'encrypted'
    };
    llmClientStub.apiKey = 'decrypted';

    const response = await request(app)
      .post('/api/agent/request')
      .send({ projectId: 1, prompt: 'hi' });

    // The route itself is a stub in this test file, so it will fall through to 404.
    expect(response.status).toBe(404);
  });

  test('blocks POST /api/goals when llm is not configured', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/goals')
      .send({ projectId: 1, prompt: 'do it' });

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
  });

  test('bypasses LLM gate for non-POST /api/goals requests', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app).get('/api/goals');

    expect(response.status).toBe(404);
  });

  test('bypasses LLM gate for POST /api/goals endpoints that are not goal creation', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/goals/status')
      .send({ projectId: 1 });

    expect(response.status).toBe(404);
  });

  test('bypasses LLM gate for non-request /api/agent endpoints', async () => {
    llmClientStub.config = null;
    llmClientStub.apiKey = null;

    const response = await request(app)
      .post('/api/agent/ping')
      .send({});

    expect(response.status).toBe(404);
  });

  test('invalid JSON payloads trigger 400 handler', async () => {
    const response = await request(app)
      .post('/api/llm')
      .set('Content-Type', 'application/json')
      .send('{"bad json"');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Invalid JSON format'
    });
  });

  test('unknown routes fall through to 404 handler', async () => {
    const response = await request(app).get('/not-found-path');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: 'Route not found',
      path: '/not-found-path'
    });
  });

  test('unexpected errors fall back to 500 handler', async () => {
    routerStub.mockImplementationOnce((req, res, next) => next(new Error('explode')));

    const response = await request(app).get('/api/llm');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: 'Internal server error',
      message: 'Something went wrong'
    });
  });

  test('development environment surfaces original error message', async () => {
    routerStub.mockImplementationOnce((req, res, next) => next(new Error('explode')));
    process.env.NODE_ENV = 'development';

    const response = await request(app).get('/api/llm');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: 'Internal server error',
      message: 'explode'
    });

    process.env.NODE_ENV = 'test';
  });

  test('startServer initializes dependencies and listens', async () => {
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    const serverInstance = await startServer();

    expect(initializeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(llmClientStub.initialize).toHaveBeenCalledTimes(1);
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(httpServerStub.listen).toHaveBeenCalledWith('5050', expect.any(Function));
    expect(serverInstance).toBe(httpServerStub);
  });

  test('startServer attaches socket server when enabled and server supports events', async () => {
    process.env.ENABLE_SOCKET_IO = 'true';
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    httpServerStub.on.mockImplementation(() => httpServerStub);

    const instance = await startServer();

    expect(instance).toBe(httpServerStub);
    expect(attachSocketServerMock).toHaveBeenCalledWith(httpServerStub);
    expect(app.get('io')).toEqual({ connected: true });
  });

  test('startServer does not attach socket server when disabled via env var', async () => {
    process.env.ENABLE_SOCKET_IO = 'false';
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    await startServer();

    expect(attachSocketServerMock).not.toHaveBeenCalled();
    expect(app.get('io')).toBeUndefined();
  });

  test('startServer skips socket attach when server.on is not a function at socket-check time', async () => {
    process.env.ENABLE_SOCKET_IO = 'true';
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    createServerMock.mockImplementationOnce(() => {
      let onPropertyReads = 0;
      const server = {
        close: vi.fn(),
        listen: vi.fn((port, cb) => {
          cb?.();
          return server;
        }),
        get on() {
          onPropertyReads += 1;
          if (onPropertyReads === 1) {
            return vi.fn(() => server);
          }
          return null;
        }
      };
      return server;
    });

    await startServer();

    expect(attachSocketServerMock).not.toHaveBeenCalled();
    expect(app.get('io')).toBeUndefined();
  });

  test('startServer exits when port is already in use (EADDRINUSE)', async () => {
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    let errorHandler;
    httpServerStub.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        errorHandler = handler;
      }
      return httpServerStub;
    });

    await startServer();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(typeof errorHandler).toBe('function');
    expect(() => errorHandler({ code: 'EADDRINUSE' })).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('startServer exits when server emits a generic startup error', async () => {
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    let errorHandler;
    httpServerStub.on.mockImplementation((event, handler) => {
      if (event === 'error') {
        errorHandler = handler;
      }
      return httpServerStub;
    });

    await startServer();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(typeof errorHandler).toBe('function');
    expect(() => errorHandler({ code: 'EACCES', message: 'nope' })).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('startServer exits process when initialization fails', async () => {
    initializeDatabaseMock.mockRejectedValueOnce(new Error('boom'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });

    await expect(startServer()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  test('startServer uses default port when env variable missing', async () => {
    cleanupSignalHandlers();
    vi.resetModules();
    await loadServerModule({ port: undefined });
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    delete process.env.PORT;
    const instance = await startServer();

    expect(Number(httpServerStub.listen.mock.calls[0][0])).toBe(5000);
    expect(instance).toBe(httpServerStub);
  });

  test('SIGINT handler logs message and exits cleanly', async () => {
    const sigintHandler = getTrackedHandler('SIGINT');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    sigintHandler();

    expect(logSpy).toHaveBeenCalledWith('\n🛑 Shutting down server...');
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('SIGTERM handler logs termination and exits', async () => {
    const sigtermHandler = getTrackedHandler('SIGTERM');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    sigtermHandler();

    expect(logSpy).toHaveBeenCalledWith('\n🛑 Server terminated');
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe('auto-start behavior', () => {
  afterEach(() => {
    cleanupSignalHandlers();
    vi.doUnmock('express');
    vi.resetModules();
  });

  test('automatically starts when NODE_ENV is not test', async () => {
    vi.resetModules();
    initializeDatabaseMock.mockResolvedValue();
    llmClientStub.initialize.mockResolvedValue();

    httpServerStub.listen.mockReset();
    httpServerStub.listen.mockImplementation((port, cb) => {
      cb?.();
      return httpServerStub;
    });

    let expressGetMock;
    vi.doMock('express', () => {
      const appStub = {
        use: vi.fn(),
        get: vi.fn(),
        set: vi.fn(),
        listen: vi.fn()
      };
      expressGetMock = appStub.get;
      const expressFn = () => appStub;
      expressFn.json = () => (req, res, next) => next();
      expressFn.urlencoded = () => (req, res, next) => next();
      return { __esModule: true, default: expressFn };
    });

    process.env.NODE_ENV = 'production';
    delete process.env.PORT;
    delete process.env.ENABLE_AUTOPILOT_RESUMPTION;

    await import('../server.js');
    trackSignalHandlers();

    await new Promise(resolve => setImmediate(resolve));

    expect(initializeDatabaseMock).toHaveBeenCalled();
    expect(llmClientStub.initialize).toHaveBeenCalled();
    expect(Number(httpServerStub.listen.mock.calls[0][0])).toBe(5000);
    expect(expressGetMock).toHaveBeenCalledWith('/api/health', expect.any(Function));
  });

  test('auto-start logs failures and exits when startup rejects', async () => {
    vi.resetModules();
    initializeDatabaseMock.mockRejectedValueOnce(new Error('db down'));
    const exitSpy = vi.spyOn(process, 'exit')
      .mockImplementationOnce(() => {
        throw new Error('exit');
      })
      .mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('express', () => {
      const appStub = {
        use: vi.fn(),
        get: vi.fn(),
        listen: vi.fn()
      };
      const expressFn = () => appStub;
      expressFn.json = () => (req, res, next) => next();
      expressFn.urlencoded = () => (req, res, next) => next();
      return { __esModule: true, default: expressFn };
    });

    process.env.NODE_ENV = 'production';
    delete process.env.PORT;

    await import('../server.js');
    trackSignalHandlers();
    await new Promise(resolve => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith('❌ Failed to start server:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledTimes(2);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
