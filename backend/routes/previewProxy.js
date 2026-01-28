import httpProxy from 'http-proxy';
import { getPortSettings, getProject, updateProjectPorts } from '../database.js';
import {
  buildPortOverrideOptions,
  extractProcessPorts,
  getProjectPortHints,
  getRunningProcessEntry,
  getStoredProjectPorts,
  storeRunningProcesses,
  terminateRunningProcesses
} from './projects/processManager.js';
import { startProject } from '../services/projectScaffolding.js';

const COOKIE_NAME = 'lucidcoder_preview_project';
const PREVIEW_ROUTE_PREFIX = '/preview/';

const BAD_FRONTEND_PORT_TTL_MS = 5_000;
const badFrontendPortsByProject = new Map();

const AUTO_RESTART_FAILURE_WINDOW_MS = 5_000;
const AUTO_RESTART_COOLDOWN_MS = 30_000;
const autoRestartStateByProject = new Map();
const autoRestartInFlightByProject = new Map();

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

const normalizeProjectKey = (projectId) => {
  if (projectId === undefined || projectId === null) {
    return null;
  }

  const raw = String(projectId).trim();
  if (!raw) {
    return null;
  }
  return raw;
};

const shouldAttemptAutoRestart = (projectKey) => {
  const now = Date.now();
  const previous = autoRestartStateByProject.get(projectKey);

  if (!previous || typeof previous.firstFailureAt !== 'number' || now - previous.firstFailureAt > AUTO_RESTART_FAILURE_WINDOW_MS) {
    autoRestartStateByProject.set(projectKey, {
      firstFailureAt: now,
      count: 1,
      lastRestartAt: previous?.lastRestartAt || 0
    });
    return false;
  }

  const count = (previous.count || 0) + 1;
  const lastRestartAt = Number(previous.lastRestartAt) || 0;
  autoRestartStateByProject.set(projectKey, {
    firstFailureAt: previous.firstFailureAt,
    count,
    lastRestartAt
  });

  return count >= 2 && now - lastRestartAt >= AUTO_RESTART_COOLDOWN_MS;
};

const markAutoRestartAttempted = (projectKey) => {
  const now = Date.now();
  const previous = autoRestartStateByProject.get(projectKey);
  autoRestartStateByProject.set(projectKey, {
    firstFailureAt: previous?.firstFailureAt || now,
    count: previous?.count || 0,
    lastRestartAt: now
  });
};

const recordAutoRestartSuccess = async (projectId, processes) => {
  storeRunningProcesses(projectId, processes, 'running', { launchType: 'auto' });
  const nextPorts = extractProcessPorts(processes);
  await updateProjectPorts(projectId, nextPorts);
};

const trackAutoRestartPromise = async (projectKey, restartPromise) => {
  autoRestartInFlightByProject.set(projectKey, restartPromise);
  await restartPromise;
};

const attemptAutoRestart = async (projectId, { logger } = {}) => {
  const projectKey = normalizeProjectKey(projectId);
  if (!projectKey) {
    return;
  }

  const existingRestart = autoRestartInFlightByProject.get(projectKey);
  if (existingRestart) {
    await existingRestart;
    return;
  }

  const restartPromise = (async () => {
    try {
      markAutoRestartAttempted(projectKey);
      const project = await getProject(projectId);
      if (!project?.path) {
        return;
      }

      // Best-effort: restart the project to recover from stuck dev servers.
      await terminateRunningProcesses(projectId, { project, waitForRelease: true, forcePorts: true });

      const portHints = getProjectPortHints(project);
      const portSettings = await getPortSettings();
      const portOverrides = buildPortOverrideOptions(portSettings);
      const startResult = await startProject(project.path, {
        frontendPort: portHints.frontend,
        backendPort: portHints.backend,
        ...portOverrides
      });

      const restartSucceeded = Boolean(startResult && startResult.success);
      if (!restartSucceeded) {
        return;
      }

      await recordAutoRestartSuccess(projectId, startResult.processes);
    } catch (error) {
      if (logger?.warn) {
        logger.warn('[preview-proxy] auto-restart failed', error?.message || error);
      }
    } finally {
      autoRestartInFlightByProject.delete(projectKey);
    }
  })();

  await trackAutoRestartPromise(projectKey, restartPromise);
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

  return `\n<script>\n(function(){\n  try {\n    var prefix = ${JSON.stringify(safePrefix)};\n    var BRIDGE_VERSION = 1;\n\n    var lastHref = '';\n\n    var send = function(type, extra){\n      try {\n        var payload = extra && typeof extra === 'object' ? extra : {};\n        payload.type = type;\n        payload.prefix = prefix;\n        payload.bridgeVersion = BRIDGE_VERSION;\n        window.parent && window.parent.postMessage(payload, '*');\n      } catch (e) {\n        // ignore\n      }\n    };\n\n    var readHref = function(){\n      return window.location && window.location.href ? String(window.location.href) : '';\n    };\n\n    var postNav = function(){\n      var href = readHref();\n      if (!href || href === lastHref) return;\n      lastHref = href;\n      send('LUCIDCODER_PREVIEW_NAV', {\n        href: href,\n        title: (document && typeof document.title === 'string' ? document.title : '')\n      });\n    };\n\n    var postReady = function(){\n      send('LUCIDCODER_PREVIEW_BRIDGE_READY', {\n        href: readHref()\n      });\n    };\n\n    var wrapHistory = function(method){\n      var original = window.history && window.history[method];\n      if (!original) return;\n      window.history[method] = function(){\n        var result = original.apply(this, arguments);\n        postNav();\n        return result;\n      };\n    };\n\n    wrapHistory('pushState');\n    wrapHistory('replaceState');\n    window.addEventListener('popstate', postNav);\n    window.addEventListener('hashchange', postNav);\n\n    window.addEventListener('message', function(event){\n      try {\n        var data = event && event.data;\n        if (!data || typeof data !== 'object') return;\n\n        if (data.type === 'LUCIDCODER_PREVIEW_BRIDGE_PING') {\n          send('LUCIDCODER_PREVIEW_BRIDGE_PONG', { nonce: data.nonce || null });\n          postNav();\n          return;\n        }\n\n        if (data.type === 'LUCIDCODER_PREVIEW_BRIDGE_GET_LOCATION') {\n          postNav();\n        }\n      } catch (e) {\n        // ignore\n      }\n    });\n\n    // Fall back: poll for safety (covers frameworks that bypass history wrappers).\n    window.setInterval(postNav, 500);\n\n    postReady();\n    postNav();\n  } catch (e) {\n    // ignore\n  }\n})();\n</script>\n`;
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
    const isConnectionFailure = Boolean(contextProjectId && isProxyConnectionFailure(error));

    if (isConnectionFailure) {
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
    const fetchDest = typeof req?.headers?.['sec-fetch-dest'] === 'string' ? req.headers['sec-fetch-dest'].toLowerCase() : '';
    const isIframeNavigation = fetchDest === 'iframe';

    if (isConnectionFailure && (wantsHtml || isIframeNavigation)) {
      const projectKey = normalizeProjectKey(contextProjectId);
      if (projectKey && shouldAttemptAutoRestart(projectKey)) {
        void attemptAutoRestart(contextProjectId, { logger });
      }
    }

    const htmlBody =
      '<!doctype html>' +
      '<html><head><meta charset="utf-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
      // Keep title stable so the frontend can detect this placeholder page.
      '<title>Preview proxy error</title>' +
      '<style>' +
      'html,body{height:100%;margin:0;padding:0;}' +
      'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b0f1a;color:#e7eaf1;}' +
      '.preview-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;}' +
      '.preview-loading-card{width:min(520px,100%);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);border-radius:14px;padding:18px 18px 14px 18px;box-shadow:0 10px 30px rgba(0,0,0,0.35);backdrop-filter:blur(10px);}' +
      '.preview-loading-card h3{margin:0 0 12px 0;font-size:18px;letter-spacing:0.2px;}' +
      '.preview-loading-bar{height:10px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,0.12);position:relative;}' +
      '.preview-loading-bar-swoosh{position:absolute;inset:0;width:45%;background:linear-gradient(90deg,rgba(125,155,255,0),rgba(125,155,255,0.85),rgba(125,155,255,0));transform:translateX(-60%);animation:swoosh 1.1s infinite;}' +
      '@keyframes swoosh{0%{transform:translateX(-60%);}100%{transform:translateX(220%);}}' +
      '.hint{margin:12px 0 0 0;opacity:0.9;line-height:1.4;font-size:13px;}' +
      'details{margin-top:12px;opacity:0.9;}' +
      'summary{cursor:pointer;}' +
      'code{display:block;white-space:pre-wrap;word-break:break-word;margin-top:8px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.10);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:12px;}' +
      '</style>' +
      '</head><body>' +
      '<div class="preview-loading">' +
      '<div class="preview-loading-card">' +
      '<h3>Loading preview…</h3>' +
      '<div class="preview-loading-bar" aria-hidden="true"><span class="preview-loading-bar-swoosh"></span></div>' +
      '<p class="hint">Connecting to the preview server. Retrying automatically…</p>' +
      '<details><summary>Details</summary><code>' +
      String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</code></details>' +
      '</div></div>' +
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
            req.__lucidcoderPreviewProxy = {
              previewPrefix: `${PREVIEW_ROUTE_PREFIX}${info.projectId}`.replace(/\/+$/, ''),
              projectId: info.projectId,
              port
            };
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
  normalizeProjectKey,
  shouldAttemptAutoRestart,
  markAutoRestartAttempted,
  attemptAutoRestart,
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
