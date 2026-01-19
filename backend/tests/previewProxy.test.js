import { describe, test, expect, vi, beforeEach } from 'vitest';

const getRunningProcessEntryMock = vi.hoisted(() => vi.fn());
vi.mock('../routes/projects/processManager.js', () => ({
  getRunningProcessEntry: getRunningProcessEntryMock
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
    proxyStub.on.mockReset();
    proxyStub.web.mockReset();
    proxyStub.ws.mockReset();
    createProxyServerMock.mockClear();
  });

  test('parsePreviewPath preserves query strings', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');

    const parsed = __testOnly.parsePreviewPath('/preview/12/about?x=1');
    expect(parsed).toEqual({ projectId: '12', forwardPath: '/about?x=1' });
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
  });

  test('shouldBypassPreviewProxy tolerates non-string inputs', async () => {
    const { __testOnly } = await import('../routes/previewProxy.js');
    expect(__testOnly.shouldBypassPreviewProxy(null)).toBe(false);
  });

  test('middleware bypasses /api routes', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/api/health');
    const res = createRes();
    const next = vi.fn();

    instance.middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(proxyStub.web).not.toHaveBeenCalled();
  });

  test('middleware falls through when no preview routing applies', async () => {
    const { createPreviewProxy } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/somewhere');
    const res = createRes();
    const next = vi.fn();

    instance.middleware(req, res, next);

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

    instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxyOptions).toEqual(expect.objectContaining({
      target: 'http://127.0.0.1:5173',
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
      cookie: `${__testOnly.COOKIE_NAME}=99`
    });
    const res = createRes();
    const next = vi.fn();

    instance.middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(proxyStub.web).toHaveBeenCalledTimes(1);
    expect(proxiedUrl).toBe('/about');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  test('middleware returns 409 html when project is not running', async () => {
    getRunningProcessEntryMock.mockReturnValue({
      processes: null,
      state: 'idle'
    });

    const { createPreviewProxy, __testOnly } = await import('../routes/previewProxy.js');
    const instance = createPreviewProxy({ logger: null });

    const req = createReq('/preview/77/', {
      cookie: `${__testOnly.COOKIE_NAME}=77`
    });
    const res = createRes();
    const next = vi.fn();

    instance.middleware(req, res, next);

    expect(proxyStub.web).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Preview unavailable'));
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
    expect(body).toContain('location.reload');
    expect(body).toContain('ECONNREFUSED');
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
      cookie: `${__testOnly.COOKIE_NAME}=12`
    });
    const socket = { destroy: vi.fn() };
    const head = Buffer.from('');

    upgradeHandler(req, socket, head);

    expect(proxyStub.ws).toHaveBeenCalledTimes(1);
    expect(proxyStub.ws.mock.calls[0][3]).toEqual({ target: 'http://127.0.0.1:5173' });
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

    const req = createReq('/ws', { cookie: `${__testOnly.COOKIE_NAME}=12` });
    upgradeHandler(req, { destroy: vi.fn() }, Buffer.from(''));

    expect(proxyStub.ws).not.toHaveBeenCalled();
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

    const req = createReq('/ws', { cookie: `${__testOnly.COOKIE_NAME}=12` });
    const socket = {
      destroy: vi.fn(() => {
        throw new Error('destroy explode');
      })
    };

    expect(() => upgradeHandler(req, socket, Buffer.from(''))).not.toThrow();
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
