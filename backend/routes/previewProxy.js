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

const getProjectIdFromRequest = (req) => {
  const parsed = parsePreviewPath(req.url);
  if (parsed?.projectId) {
    return {
      source: 'path',
      projectId: parsed.projectId,
      forwardPath: parsed.forwardPath
    };
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

  return `\n<script>\n(function(){\n  try {\n    var prefix = ${JSON.stringify(safePrefix)};\n    if (prefix && window.location && window.location.pathname && window.location.pathname.indexOf(prefix) === 0) {\n      var stripped = window.location.pathname.slice(prefix.length) || '/';\n      if (stripped.charAt(0) !== '/') stripped = '/' + stripped;\n      var nextUrl = stripped + (window.location.search || '') + (window.location.hash || '');\n      try {\n        window.history.replaceState(window.history.state, document.title, nextUrl);\n      } catch (e) {\n        // ignore\n      }\n    }\n\n    var lastHref = '';\n    var post = function(){\n      var href = window.location && window.location.href ? String(window.location.href) : '';\n      if (!href || href === lastHref) return;\n      lastHref = href;\n      try {\n        window.parent && window.parent.postMessage({\n          type: 'LUCIDCODER_PREVIEW_NAV',\n          href: href\n        }, '*');\n      } catch (e) {\n        // ignore\n      }\n    };\n\n    var wrapHistory = function(method){\n      var original = window.history && window.history[method];\n      if (!original) return;\n      window.history[method] = function(){\n        var result = original.apply(this, arguments);\n        post();\n        return result;\n      };\n    };\n\n    wrapHistory('pushState');\n    wrapHistory('replaceState');\n    window.addEventListener('popstate', post);\n    window.addEventListener('hashchange', post);\n\n    // Fall back: poll for safety (covers frameworks that bypass history wrappers).
    window.setInterval(post, 300);\n\n    post();\n  } catch (e) {\n    // ignore\n  }\n})();\n</script>\n`;
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
  if (state === 'running' && Number.isInteger(numericPort) && numericPort > 0) {
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
    if (contextProjectId && /ECONNREFUSED/i.test(message)) {
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

    const target = `http://127.0.0.1:${port}`;

    if (setCookie) {
      res.setHeader('Set-Cookie', buildSetCookieHeader(projectId));
    }

    const originalUrl = req.url;
    req.__lucidcoderPreviewProxy = {
      previewPrefix: `${PREVIEW_ROUTE_PREFIX}${projectId}`.replace(/\/+$/, ''),
      projectId
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

          const target = `http://127.0.0.1:${port}`;
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
  getProjectIdFromRequest,
  buildSetCookieHeader,
  buildPreviewBridgeScript,
  injectPreviewBridge,
  shouldBypassPreviewProxy,
  resolveFrontendPort
};
