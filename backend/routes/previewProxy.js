import httpProxy from 'http-proxy';
import { getProject } from '../database.js';
import {
  getProjectPortHints,
  getRunningProcessEntry,
  getStoredProjectPorts,
  storeRunningProcesses
} from './projects/processManager.js';

const COOKIE_NAME = 'lucidcoder_preview_project';
const PREVIEW_ROUTE_PREFIX = '/preview/';

const BAD_FRONTEND_PORT_TTL_MS = 5_000;
const badFrontendPortsByProject = new Map();

const isProxyConnectionFailure = (error) => {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOTFOUND'
  ) {
    return true;
  }

  const message = typeof error?.message === 'string' ? error.message : '';
  return /(ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND)/i.test(message);
};

const rememberBadFrontendPort = (projectId, port) => {
  const numericProjectId = projectId;
  const numericPort = Number(port);
  if (!numericProjectId || !Number.isInteger(numericPort) || numericPort <= 0) {
    return;
  }

  badFrontendPortsByProject.set(numericProjectId, {
    port: numericPort,
    until: Date.now() + BAD_FRONTEND_PORT_TTL_MS
  });
};

const isFrontendPortRememberedBad = (projectId, port) => {
  const entry = badFrontendPortsByProject.get(projectId);
  if (!entry) {
    return false;
  }

  if (typeof entry.until !== 'number' || entry.until <= Date.now()) {
    badFrontendPortsByProject.delete(projectId);
    return false;
  }

  return entry.port === port;
};

const normalizeCookieValue = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
};

const parseCookieHeader = (headerValue) => {
  const header = typeof headerValue === 'string' ? headerValue : '';
  if (!header) {
    return {};
  }

  const cookies = {};
  header.split(';').forEach((pair) => {
    const [rawKey, ...rest] = pair.split('=');
    const key = normalizeCookieValue(rawKey);
    if (!key) {
      return;
    }

    const value = normalizeCookieValue(rest.join('='));
    if (!value) {
      return;
    }

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });

  return cookies;
};

const parsePreviewPath = (url = '') => {
  const rawUrl = typeof url === 'string' ? url : '';
  if (!rawUrl.startsWith(PREVIEW_ROUTE_PREFIX)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, 'http://localhost');
  } catch {
    return null;
  }

  const pathname = parsed.pathname || '';
  if (!pathname.startsWith(PREVIEW_ROUTE_PREFIX)) {
    return null;
  }

  const remainder = pathname.slice(PREVIEW_ROUTE_PREFIX.length);
  const [projectIdSegment, ...restSegments] = remainder.split('/');
  const projectId = normalizeCookieValue(projectIdSegment);
  if (!projectId) {
    return null;
  }

  const restPath = restSegments.join('/');
  const normalizedPath = `/${restPath}`.replace(/^\/+/, '/');
  const forwardPath = `${normalizedPath}${parsed.search || ''}`;

  return {
    projectId,
    forwardPath
  };
};

const isLikelyPreviewDevAssetPath = (url = '') => {
  const rawUrl = typeof url === 'string' ? url : '';
  if (!rawUrl) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, 'http://localhost');
  } catch {
    return false;
  }

  const pathname = parsed.pathname || '';
  return (
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/@react-refresh') ||
    pathname.startsWith('/@id/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/')
  );
};

const isLikelyViteHmrWebSocketRequest = (req) => {
  const upgrade = typeof req?.headers?.upgrade === 'string' ? req.headers.upgrade.toLowerCase() : '';
  if (upgrade !== 'websocket') {
    return false;
  }

  const proto = typeof req?.headers?.['sec-websocket-protocol'] === 'string'
    ? req.headers['sec-websocket-protocol']
    : '';
  if (proto.toLowerCase().includes('vite-hmr')) {
    return true;
  }

  // Fallback: some environments may omit the protocol but include a token.
  const url = typeof req?.url === 'string' ? req.url : '';
  return /[?&]token=/.test(url);
};

const getProjectIdFromRequest = (req) => {
  const parsed = parsePreviewPath(req.url);
  if (parsed?.projectId) {
    return {
      source: 'path',
      projectId: parsed.projectId,
      forwardPath: parsed.forwardPath
    };
  }

  const dest = typeof req?.headers?.['sec-fetch-dest'] === 'string'
    ? req.headers['sec-fetch-dest'].toLowerCase()
    : '';
  const referer = typeof req?.headers?.referer === 'string' ? req.headers.referer : '';
  // Cookie-based routing is only safe when the request is clearly preview-origin.
  // - iframe navigations set Sec-Fetch-Dest: iframe
  // - subresource loads typically carry a Referer pointing at /preview/:id...
  // - some dev-server module requests may omit Referer (varies by browser + sandbox),
  //   but can be identified by their well-known dev asset paths.
  const shouldAllowCookieRouting =
    dest === 'iframe' ||
    referer.includes('/preview/') ||
    isLikelyPreviewDevAssetPath(req.url) ||
    isLikelyViteHmrWebSocketRequest(req);
  if (!shouldAllowCookieRouting) {
    return null;
  }

  const cookies = parseCookieHeader(req.headers?.cookie);
  const cookieProject = normalizeCookieValue(cookies[COOKIE_NAME]);
  if (cookieProject) {
    return {
      source: 'cookie',
      projectId: cookieProject,
      forwardPath: req.url
    };
  }

  return null;
};

const buildSetCookieHeader = (projectId) => {
  const value = encodeURIComponent(String(projectId));
  // Not HttpOnly: harmless, but lets us debug easier.
  return `${COOKIE_NAME}=${value}; Path=/; SameSite=Lax`;
};

const buildPreviewBridgeScript = ({ previewPrefix }) => {
  const safePrefix = typeof previewPrefix === 'string' ? previewPrefix : '';

  return `\n<script>\n(function(){\n  try {\n    var prefix = ${JSON.stringify(safePrefix)};\n\n    var lastHref = '';\n    var post = function(){\n      var href = window.location && window.location.href ? String(window.location.href) : '';\n      if (!href || href === lastHref) return;\n      lastHref = href;\n      try {\n        window.parent && window.parent.postMessage({\n          type: 'LUCIDCODER_PREVIEW_NAV',\n          href: href,\n          prefix: prefix\n        }, '*');\n      } catch (e) {\n        // ignore\n      }\n    };\n\n    var wrapHistory = function(method){\n      var original = window.history && window.history[method];\n      if (!original) return;\n      window.history[method] = function(){\n        var result = original.apply(this, arguments);\n        post();\n        return result;\n      };\n    };\n\n    wrapHistory('pushState');\n    wrapHistory('replaceState');\n    window.addEventListener('popstate', post);\n    window.addEventListener('hashchange', post);\n\n    // Fall back: poll for safety (covers frameworks that bypass history wrappers).\n    window.setInterval(post, 500);\n\n    post();\n  } catch (e) {\n    // ignore\n  }\n})();\n</script>\n`;
};

const injectPreviewBridge = (html, { previewPrefix }) => {
  if (typeof html !== 'string' || !html) {
    return html;
  }

  const script = buildPreviewBridgeScript({ previewPrefix });

  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen && headOpen.index != null) {
    const insertAt = headOpen.index + headOpen[0].length;
    return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
  }

  return `${script}${html}`;
};

const shouldBypassPreviewProxy = (url = '') => {
  const pathname = typeof url === 'string' ? url : '';
  return (
    pathname.startsWith('/api') ||
    pathname.startsWith('/socket.io') ||
    pathname.startsWith('/coverage')
  );
};

const resolveFrontendPort = async (projectId) => {
  const { processes, state } = getRunningProcessEntry(projectId);
  const portCandidate = processes?.frontend?.port;
  const numericPort = Number(portCandidate);
  if (
    state === 'running' &&
    Number.isInteger(numericPort) &&
    numericPort > 0 &&
    !isFrontendPortRememberedBad(projectId, numericPort)
  ) {
    return numericPort;
  }

  const project = await getProject(projectId);
  if (!project) {
    return null;
  }

  const storedPorts = getStoredProjectPorts(project);
  if (Number.isInteger(storedPorts?.frontend) && storedPorts.frontend > 0) {
    return storedPorts.frontend;
  }

  const portHints = getProjectPortHints(project);
  if (Number.isInteger(portHints?.frontend) && portHints.frontend > 0) {
    return portHints.frontend;
  }

  return null;
};

const resolvePreviewTargetHost = (req) => {
  const rawOverride = typeof process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST === 'string'
    ? process.env.LUCIDCODER_PREVIEW_UPSTREAM_HOST
    : '';
  const override = rawOverride.trim();
  if (override) {
    return override === '0.0.0.0' ? 'localhost' : override;
  }

  // Default: target the same host the client used to reach the backend.
  // This makes previews work automatically whether LucidCoder is accessed via
  // localhost or via a LAN IP / hostname.
  const forwardedHost = typeof req?.headers?.['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host']
    : '';
  const hostHeader = forwardedHost || (typeof req?.headers?.host === 'string' ? req.headers.host : '');
  const hostValue = String(hostHeader).split(',')[0].trim();
  if (!hostValue) {
    return 'localhost';
  }

  // host may include port; IPv6 may be in [::1]:5000 form.
  const ipv6Match = hostValue.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6Match) {
    const ipv6Host = ipv6Match[1]?.trim();
    return ipv6Host || 'localhost';
  }

  const hostname = hostValue.replace(/:\d+$/, '').trim();
  if (!hostname || hostname === '0.0.0.0') {
    return 'localhost';
  }
  return hostname;
};

export const createPreviewProxy = ({ logger = console } = {}) => {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true
  });

  proxy.on('error', (error, req, res) => {
    const message = error?.message || 'Proxy error';
    if (logger?.warn) {
      logger.warn('[preview-proxy] error', message, { url: req?.url });
    }

    const context = req?.__lucidcoderPreviewProxy;
    const contextProjectId = context?.projectId;
    if (contextProjectId && isProxyConnectionFailure(error)) {
      if (context?.port) {
        rememberBadFrontendPort(contextProjectId, context.port);
      }

      const { processes } = getRunningProcessEntry(contextProjectId);
      if (processes?.frontend) {
        const nextProcesses = { ...processes, frontend: null };
        const nextState = processes?.backend ? 'running' : 'stopped';
        storeRunningProcesses(contextProjectId, nextProcesses, nextState, { exposeSnapshot: true });
      }
    }

    const acceptHeader = typeof req?.headers?.accept === 'string' ? req.headers.accept : '';
    const wantsHtml = acceptHeader.toLowerCase().includes('text/html');

    const htmlBody =
      '<!doctype html>' +
      '<html><head><meta charset="utf-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
      '<title>Preview proxy error</title>' +
      '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto}code{background:#f3f3f3;padding:2px 6px;border-radius:6px}p{line-height:1.4}</style>' +
      '</head><body>' +
      '<h1>Preview proxy error</h1>' +
      '<p>The preview server may still be starting or the preview port may be unavailable.</p>' +
        '<p>Retrying automatically...</p>' +
      '<p><code>' +
      String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</code></p>' +
      '<script>setTimeout(function(){try{location.reload();}catch(e){}},900);</script>' +
      '</body></html>';

    const textBody = 'Preview proxy error';

    if (res && typeof res.writeHead === 'function') {
      if (!res.headersSent) {
        res.writeHead(502, {
          'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain',
          'Cache-Control': 'no-store'
        });
      }

      if (typeof res.end === 'function') {
        res.end(wantsHtml ? htmlBody : textBody);
      }
      return;
    }

    // Websocket upgrade errors provide a raw socket instead of an HTTP response.
    if (res && typeof res.destroy === 'function') {
      try {
        res.destroy();
      } catch {
        // ignore
      }
      return;
    }

    if (res && typeof res.end === 'function') {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  });

  proxy.on('proxyRes', (proxyRes, req, res) => {
    const context = req.__lucidcoderPreviewProxy;
    if (!context) {
      return;
    }

    const headers = { ...proxyRes.headers };
    const contentType = String(headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');

    if (!isHtml) {
      if (!res.headersSent) {
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode || 200, headers);
      }
      proxyRes.pipe(res);
      return;
    }

    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const html = bodyBuffer.toString('utf8');
      const injected = injectPreviewBridge(html, { previewPrefix: context.previewPrefix });
      const payload = Buffer.from(injected, 'utf8');

      delete headers['content-length'];
      headers['content-length'] = String(payload.length);

      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 200, headers);
      }

      res.end(payload);
    });
  });

  const proxyWebRequest = async (req, res, { projectId, forwardPath, setCookie }) => {
    const port = await resolveFrontendPort(projectId);
    if (!port) {
      res.status(409).send(
        '<!doctype html><html><head><meta charset="utf-8"/><title>Preview unavailable</title></head>' +
        '<body><h1>Preview unavailable</h1><p>The project preview is not running.</p></body></html>'
      );
      return;
    }

    const targetHost = resolvePreviewTargetHost(req);
    const target = `http://${targetHost}:${port}`;

    if (setCookie) {
      res.setHeader('Set-Cookie', buildSetCookieHeader(projectId));
    }

    const originalUrl = req.url;
    req.__lucidcoderPreviewProxy = {
      previewPrefix: `${PREVIEW_ROUTE_PREFIX}${projectId}`.replace(/\/+$/, ''),
      projectId,
      port
    };

    try {
      req.url = forwardPath;
      proxy.web(req, res, { target, selfHandleResponse: true });
    } finally {
      req.url = originalUrl;
    }
  };

  const middleware = async (req, res, next) => {
    try {
      if (shouldBypassPreviewProxy(req.url)) {
        next();
        return;
      }

      const info = getProjectIdFromRequest(req);
      if (!info?.projectId) {
        next();
        return;
      }

      await proxyWebRequest(req, res, {
        projectId: info.projectId,
        forwardPath: info.forwardPath,
        setCookie: info.source === 'path'
      });
    } catch (error) {
      next(error);
    }
  };

  const registerUpgradeHandler = (server) => {
    const on = server?.on;
    if (typeof on !== 'function') {
      return;
    }

    on.call(server, 'upgrade', (req, socket, head) => {
      if (shouldBypassPreviewProxy(req.url)) {
        return;
      }

      const info = getProjectIdFromRequest(req);
      if (!info?.projectId) {
        return;
      }

      Promise.resolve(resolveFrontendPort(info.projectId))
        .then((port) => {
          if (!port) {
            return;
          }

          const targetHost = resolvePreviewTargetHost(req);
          const target = `http://${targetHost}:${port}`;
          const originalUrl = req.url;
          try {
            req.url = info.forwardPath;
            proxy.ws(req, socket, head, { target });
          } catch {
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          } finally {
            req.url = originalUrl;
          }
        })
        .catch(() => {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        });
    });
  };

  return {
    proxy,
    middleware,
    registerUpgradeHandler
  };
};

export const attachPreviewProxy = ({ app, server, logger = console } = {}) => {
  if (!app || typeof app.use !== 'function') {
    throw new Error('attachPreviewProxy requires an express app');
  }

  const instance = createPreviewProxy({ logger });
  app.use(instance.middleware);
  instance.registerUpgradeHandler(server);
  return instance.proxy;
};

export const __testOnly = {
  COOKIE_NAME,
  PREVIEW_ROUTE_PREFIX,
  parseCookieHeader,
  parsePreviewPath,
  isLikelyPreviewDevAssetPath,
  isLikelyViteHmrWebSocketRequest,
  getProjectIdFromRequest,
  buildSetCookieHeader,
  buildPreviewBridgeScript,
  injectPreviewBridge,
  shouldBypassPreviewProxy,
  resolvePreviewTargetHost,
  resolveFrontendPort
};
