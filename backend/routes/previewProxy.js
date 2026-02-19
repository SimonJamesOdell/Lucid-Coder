import httpProxy from 'http-proxy';
import path from 'path';
import { readFile } from 'fs/promises';
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

const PREVIEW_PROXY_TIMEOUT_MS = 7_000;
const PROJECT_UPLOADS_PREFIX = '/uploads/';

const UPLOAD_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

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

  // If the preview cookie is present, always proxy the request.
  // This allows SPA navigation to work even if the path escapes the preview prefix.
  const cookies = parseCookieHeader(req.headers?.cookie);
  const cookieProject = normalizeCookieValue(cookies[COOKIE_NAME]);
  if (cookieProject) {
    return {
      source: 'cookie',
      projectId: cookieProject,
      forwardPath: typeof req?.url === 'string' ? req.url : ''
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

  return `
<script>
(function(){
  try {
    var prefix = ${JSON.stringify(safePrefix)};
    var BRIDGE_VERSION = 1;

    var lastHref = '';
    var lastContextMenuAt = 0;

    var send = function(type, extra){
      try {
        var parentWindow = window.parent;
        if (!parentWindow || parentWindow === window) return;

        var payload = extra && typeof extra === 'object' ? extra : {};
        payload.type = type;
        payload.prefix = prefix;
        payload.bridgeVersion = BRIDGE_VERSION;
        parentWindow.postMessage(payload, '*');
      } catch (e) {
        // ignore
      }
    };

    var readHref = function(){
      return window.location && window.location.href ? String(window.location.href) : '';
    };

    var postNav = function(){
      var href = readHref();
      if (!href || href === lastHref) return;
      lastHref = href;
      send('LUCIDCODER_PREVIEW_NAV', {
        href: href,
        title: (document && typeof document.title === 'string' ? document.title : '')
      });
    };

    var postReady = function(){
      send('LUCIDCODER_PREVIEW_BRIDGE_READY', {
        href: readHref()
      });
    };

    var wrapHistory = function(method){
      var original = window.history && window.history[method];
      if (!original) return;
      window.history[method] = function(){
        var result = original.apply(this, arguments);
        postNav();
        return result;
      };
    };

    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', postNav);
    window.addEventListener('hashchange', postNav);

    var navigateToHref = function(href){
      if (!href || typeof href !== 'string') return;

      try {
        var current = readHref();
        if (href === current) return;

        var nextUrl = new URL(href, current || window.location.href);
        var sameOrigin = nextUrl.origin === window.location.origin;

        if (sameOrigin) {
          var nextPath = nextUrl.pathname + (nextUrl.search || '') + (nextUrl.hash || '');
          var currentPath = window.location.pathname + (window.location.search || '') + (window.location.hash || '');

          if (nextPath !== currentPath && window.history && typeof window.history.pushState === 'function') {
            window.history.pushState({}, '', nextPath);
            try {
              window.dispatchEvent(new PopStateEvent('popstate'));
            } catch (e) {
              // ignore
            }
            postNav();
            return;
          }
        }

        window.location.assign(nextUrl.href);
      } catch (e) {
        try {
          window.location.href = String(href);
        } catch (err) {
          // ignore
        }
      }
    };

    window.addEventListener('message', function(event){
      try {
        var data = event && event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'LUCIDCODER_PREVIEW_BRIDGE_PING') {
          send('LUCIDCODER_PREVIEW_BRIDGE_PONG', { nonce: data.nonce || null });
          postNav();
          return;
        }

        if (data.type === 'LUCIDCODER_PREVIEW_BRIDGE_GET_LOCATION') {
          postNav();
          return;
        }

        if (data.type === 'LUCIDCODER_PREVIEW_NAVIGATE') {
          navigateToHref(data.href);
        }
      } catch (e) {
        // ignore
      }
    });

    var emitContextMenu = function(event){
      try {
        if (!event) return;
        if (event.shiftKey) return;

        // If the user opened the preview in a new tab (top-level browsing
        // context), do not interfere with the native context menu (Inspect).
        if (window.parent === window) return;

        var isNativeContextMenuEvent = event.type === 'contextmenu';

        // Always suppress the native browser menu when we see the real
        // 'contextmenu' event.
        if (isNativeContextMenuEvent) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }

        // Some hosts/webviews do not fire 'contextmenu'. Use mousedown as a
        // fallback signal but only for right-click.
        if (event.type === 'mousedown' && typeof event.button === 'number' && event.button !== 2) return;

        var now = Date.now();
        if (now - lastContextMenuAt < 75) return;
        lastContextMenuAt = now;

        // If we used mousedown as the signal, still suppress default behavior.
        if (!isNativeContextMenuEvent) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
        }

        var target = event.target;
        var tagName = target && typeof target.tagName === 'string' ? target.tagName : '';
        var id = target && typeof target.id === 'string' ? target.id : '';
        var className = target && typeof target.className === 'string' ? target.className : '';

        send('LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU', {
          href: readHref(),
          clientX: typeof event.clientX === 'number' ? event.clientX : 0,
          clientY: typeof event.clientY === 'number' ? event.clientY : 0,
          tagName: tagName,
          id: id,
          className: className
        });
      } catch (e) {
        // ignore
      }
    };

    var emitPointerDown = function(event){
      try {
        if (!event) return;

        // If the user opened the preview in a new tab (top-level browsing
        // context), do not emit click signals for the parent UI.
        if (window.parent === window) return;

        if (typeof event.button === 'number' && event.button !== 0) return;

        send('LUCIDCODER_PREVIEW_BRIDGE_POINTER', { kind: 'pointerdown' });
      } catch (e) {
        // ignore
      }
    };

    window.addEventListener('contextmenu', emitContextMenu, true);
    window.addEventListener('mousedown', emitContextMenu, true);
    window.addEventListener('mousedown', emitPointerDown, true);

    send('LUCIDCODER_PREVIEW_HELPER_READY', { href: readHref() });

    // Fall back: poll for safety (covers frameworks that bypass history wrappers).
    window.setInterval(postNav, 500);

    postReady();
    postNav();
  } catch (e) {
    // ignore
  }
})();
</script>
`;
};

const injectPreviewBridge = (html, { previewPrefix } = {}) => {
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

const parseUploadForwardPath = (forwardPath = '') => {
  if (typeof forwardPath !== 'string') {
    return null;
  }

  const pathOnly = forwardPath.split('?')[0] || '';
  if (!pathOnly.startsWith(PROJECT_UPLOADS_PREFIX)) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }

  if (!decoded.startsWith(PROJECT_UPLOADS_PREFIX)) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, '');
  if (!relativePath || /^uploads\/?$/i.test(relativePath)) {
    return null;
  }

  return relativePath;
};

const resolveUploadContentType = (absolutePath) => {
  const ext = path.extname(absolutePath || '').toLowerCase();
  return UPLOAD_CONTENT_TYPES[ext] || 'application/octet-stream';
};

const tryServeProjectUpload = async ({ projectId, forwardPath, res, logger }) => {
  const relativePath = parseUploadForwardPath(forwardPath);
  if (!relativePath) {
    return false;
  }

  const project = await getProject(projectId);
  const projectPath = typeof project?.path === 'string' ? project.path : '';
  if (!projectPath) {
    return false;
  }

  const uploadsRoot = path.resolve(projectPath, 'uploads');
  const absolutePath = path.resolve(projectPath, relativePath);
  const uploadsRootWithSep = `${uploadsRoot}${path.sep}`;
  if (absolutePath !== uploadsRoot && !absolutePath.startsWith(uploadsRootWithSep)) {
    return false;
  }

  try {
    const payload = await readFile(absolutePath);
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': resolveUploadContentType(absolutePath),
        'Cache-Control': 'no-store'
      });
    }
    res.end(payload);
    return true;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
      return false;
    }

    if (logger?.warn) {
      logger.warn('[preview-proxy] failed to serve project upload', {
        projectId,
        path: relativePath,
        error: error?.message || error
      });
    }
    return false;
  }
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

  // Default: target localhost unless the request already came from localhost.
  // This keeps LAN access working even when dev servers bind only to loopback.
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

  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return hostname;
  }

  return 'localhost';
};

export const createPreviewProxy = ({ logger = console } = {}) => {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true,
    // Fail fast when the upstream dev server hangs (prevents iframe from waiting
    // forever and causing a "preview didn’t finish loading" zombie state).
    proxyTimeout: PREVIEW_PROXY_TIMEOUT_MS,
    timeout: PREVIEW_PROXY_TIMEOUT_MS
  });

  proxy.on('error', (error, req, res) => {
    const message = error?.message || 'Proxy error';
    if (logger?.warn) {
      logger.warn('[preview-proxy] error', message, { url: req?.url });
    }

    const context = req?.__lucidcoderPreviewProxy;
    const contextProjectId = context?.projectId;
    const isConnectionFailure = Boolean(contextProjectId && isProxyConnectionFailure(error));
    const runningEntry = contextProjectId ? getRunningProcessEntry(contextProjectId) : null;
    const runningProcesses = runningEntry?.processes || null;
    const isFrontendStarting = Boolean(
      isConnectionFailure &&
      runningEntry &&
      (runningEntry.state !== 'running' || !runningProcesses?.frontend)
    );

    if (isConnectionFailure) {
      if (context?.port) {
        rememberBadFrontendPort(contextProjectId, context.port);
      }

      if (runningProcesses?.frontend) {
        const nextProcesses = { ...runningProcesses, frontend: null };
        const nextState = runningProcesses?.backend ? 'running' : 'stopped';
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

    // The page is intentionally invisible – the frontend's own loading overlay
    // handles all user-facing feedback.  We keep the <title> so the frontend
    // can detect this placeholder, and the reload script so the iframe retries.
    const htmlBody =
      '<!doctype html>' +
      '<html><head><meta charset="utf-8" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
      // Keep title stable so the frontend can detect this placeholder page.
      `<title>${isFrontendStarting ? 'Preview starting' : 'Preview proxy error'}</title>` +
      '<style>' +
      'html,body{height:100%;margin:0;padding:0;background:transparent;}' +
      '</style>' +
      '</head><body aria-busy="true">' +
      '<script>' +
      'setTimeout(function(){location.reload();},900);' +
      '</script>' +
      '</body></html>';

    const textBody = isFrontendStarting ? 'Preview is starting' : 'Preview proxy error';

    if (res && typeof res.writeHead === 'function') {
      if (!res.headersSent) {
        const statusCode = isFrontendStarting ? 503 : 502;
        res.writeHead(statusCode, {
          'Content-Type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain',
          'Cache-Control': 'no-store',
          ...(isFrontendStarting ? { 'Retry-After': '1' } : {})
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

    // Some apps set CSP headers that block inline scripts, which would prevent
    // the injected bridge/helper from running. Since this HTML is only used
    // inside the LucidCoder preview iframe, we strip CSP for these responses.
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (
        lower === 'content-security-policy' ||
        lower === 'content-security-policy-report-only' ||
        lower === 'x-content-security-policy' ||
        lower === 'x-webkit-csp'
      ) {
        delete headers[key];
      }
    }

    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const html = bodyBuffer.toString('utf8');
      const injected = injectPreviewBridge(html, {
        previewPrefix: context.previewPrefix
      });
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
        '<!doctype html><html><head><meta charset="utf-8"/><title>Preview unavailable</title>' +
        '<style>html,body{margin:0;padding:0;background:transparent;}</style></head>' +
        '<body></body></html>'
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

      const servedProjectUpload = await tryServeProjectUpload({
        projectId: info.projectId,
        forwardPath: info.forwardPath,
        res,
        logger
      });
      if (servedProjectUpload) {
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
  parseUploadForwardPath,
  resolveUploadContentType,
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
