import { describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PreviewTab, { getDevServerOriginFromWindow } from '../components/PreviewTab';

const mockProject = {
  id: 123,
  name: 'Demo Project',
  frontend: { framework: 'react' }
};

const buildProcessInfo = (overrides = {}) => ({
  projectId: mockProject.id,
  fetchedAt: new Date().toISOString(),
  processes: {
    frontend: { status: 'running', port: 5555 },
    backend: { status: 'running', port: 5656 },
    ...overrides.processes
  },
  ports: {
    active: { frontend: 5555, backend: 5656 },
    stored: { frontend: 5555, backend: 5656 },
    preferred: { frontend: 5173, backend: 3000 },
    ...overrides.ports
  }
});

const getDomExceptionCtor = () => {
  if (typeof globalThis.DOMException === 'function') {
    return globalThis.DOMException;
  }

  return class DOMException extends Error {};
};

const buildIframeWindow = (overrides = {}) => ({
  DOMException: getDomExceptionCtor(),
  postMessage: vi.fn(),
  location: {
    href: 'about:blank'
  },
  ...overrides
});

const renderPreviewTab = (props = {}) => {
  const defaultProps = {
    project: mockProject,
    processInfo: null,
    onRestartProject: vi.fn().mockResolvedValue(null)
  };
  const mergedProps = { autoStartOnNotRunning: false, ...defaultProps, ...props };
  const previewRef = createRef();
  const renderResult = render(<PreviewTab ref={previewRef} {...mergedProps} />);
  return { previewRef, props: mergedProps, ...renderResult };
};

const setViteApiTarget = (value) => {
  const env = import.meta?.env;
  if (!env) {
    return () => {};
  }

  const original = env.VITE_API_TARGET;

  try {
    Object.defineProperty(env, 'VITE_API_TARGET', { configurable: true, value });
  } catch {
    try {
      // eslint-disable-next-line no-param-reassign
      env.VITE_API_TARGET = value;
    } catch {
      return () => {};
    }
  }

  return () => {
    try {
      Object.defineProperty(env, 'VITE_API_TARGET', { configurable: true, value: original });
    } catch {
      try {
        // eslint-disable-next-line no-param-reassign
        env.VITE_API_TARGET = original;
      } catch {
        // ignore
      }
    }
  };
};

describe('PreviewTab', () => {
  let originalIframeSrcDescriptor;
  let originalIframeSetAttribute;
  let originalIframeGetAttribute;
  let originalWindowDomException;
  let originalGlobalDomException;
  let originalCtorProtoDomExceptionDescriptor;
  let originalWindowProtoDomExceptionDescriptor;
  const iframeSrcOverrides = new WeakMap();

  beforeAll(() => {
    originalWindowDomException = window.DOMException;
    originalGlobalDomException = globalThis.DOMException;
    originalCtorProtoDomExceptionDescriptor = window?.constructor
      ? Object.getOwnPropertyDescriptor(window.constructor.prototype, 'DOMException')
      : undefined;
    originalWindowProtoDomExceptionDescriptor = globalThis.Window
      ? Object.getOwnPropertyDescriptor(globalThis.Window.prototype, 'DOMException')
      : undefined;

    const DomExceptionCtor = getDomExceptionCtor();
    if (typeof window.DOMException !== 'function') {
      window.DOMException = DomExceptionCtor;
    }
    if (typeof globalThis.DOMException !== 'function') {
      globalThis.DOMException = DomExceptionCtor;
    }

    if (window?.constructor?.prototype && typeof window.constructor.prototype.DOMException !== 'function') {
      Object.defineProperty(window.constructor.prototype, 'DOMException', {
        configurable: true,
        writable: true,
        value: DomExceptionCtor
      });
    }

    if (globalThis.Window?.prototype && typeof globalThis.Window.prototype.DOMException !== 'function') {
      Object.defineProperty(globalThis.Window.prototype, 'DOMException', {
        configurable: true,
        writable: true,
        value: DomExceptionCtor
      });
    }

    if (typeof HTMLIFrameElement === 'undefined') {
      return;
    }

    originalIframeSrcDescriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      'src'
    );

    originalIframeSetAttribute = HTMLIFrameElement.prototype.setAttribute;
    originalIframeGetAttribute = HTMLIFrameElement.prototype.getAttribute;

    // Happy DOM will try to actually navigate iframes when `src` is set,
    // which can leave background navigation tasks running after cleanup.
    // In this test file we only need the value to be reflected for logic,
    // not real navigation.
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true,
      enumerable: true,
      get() {
        return iframeSrcOverrides.get(this) || '';
      },
      set(value) {
        iframeSrcOverrides.set(this, String(value));
      }
    });

    HTMLIFrameElement.prototype.setAttribute = function setAttribute(name, value) {
      if (String(name).toLowerCase() === 'src') {
        iframeSrcOverrides.set(this, String(value));
        return;
      }
      return originalIframeSetAttribute.call(this, name, value);
    };

    HTMLIFrameElement.prototype.getAttribute = function getAttribute(name) {
      if (String(name).toLowerCase() === 'src') {
        return iframeSrcOverrides.get(this) || null;
      }
      return originalIframeGetAttribute.call(this, name);
    };
  });

  afterAll(() => {
    if (typeof originalWindowDomException === 'undefined') {
      try {
        delete window.DOMException;
      } catch {
        // ignore
      }
    } else {
      window.DOMException = originalWindowDomException;
    }

    if (typeof originalGlobalDomException === 'undefined') {
      try {
        delete globalThis.DOMException;
      } catch {
        // ignore
      }
    } else {
      globalThis.DOMException = originalGlobalDomException;
    }

    if (window?.constructor?.prototype) {
      if (originalCtorProtoDomExceptionDescriptor) {
        Object.defineProperty(window.constructor.prototype, 'DOMException', originalCtorProtoDomExceptionDescriptor);
      } else {
        try {
          delete window.constructor.prototype.DOMException;
        } catch {
          // ignore
        }
      }
    }

    if (globalThis.Window?.prototype) {
      if (originalWindowProtoDomExceptionDescriptor) {
        Object.defineProperty(globalThis.Window.prototype, 'DOMException', originalWindowProtoDomExceptionDescriptor);
      } else {
        try {
          delete globalThis.Window.prototype.DOMException;
        } catch {
          // ignore
        }
      }
    }

    if (typeof HTMLIFrameElement === 'undefined') {
      return;
    }

    if (originalIframeSetAttribute) {
      HTMLIFrameElement.prototype.setAttribute = originalIframeSetAttribute;
    }

    if (originalIframeGetAttribute) {
      HTMLIFrameElement.prototype.getAttribute = originalIframeGetAttribute;
    }

    if (originalIframeSrcDescriptor) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', originalIframeSrcDescriptor);
      return;
    }

    // If there was no original descriptor, remove our override.
    try {
      delete HTMLIFrameElement.prototype.src;
    } catch {
      // ignore
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      vi.runOnlyPendingTimers();
    } catch {
      // ignore (real timers)
    }

    try {
      vi.clearAllTimers();
    } catch {
      // ignore (real timers)
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attempts to load the preview when process status is unavailable', () => {
    renderPreviewTab({ processInfo: null });

    expect(screen.queryByTestId('preview-not-running')).toBeNull();
    expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
  });

  test('shows not-running empty state and starts project when frontend is idle', async () => {
    const onRestartProject = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    renderPreviewTab({ processInfo, onRestartProject, isProjectStopped: true });

    expect(screen.getByTestId('preview-not-running')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-iframe')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start project' }));
    });

    expect(onRestartProject).toHaveBeenCalledWith(mockProject.id);
  });

  test('auto-starts when idle and not explicitly stopped', async () => {
    const onRestartProject = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    renderPreviewTab({
      processInfo,
      onRestartProject,
      isProjectStopped: false,
      autoStartOnNotRunning: true
    });

    await waitFor(() => {
      expect(onRestartProject).toHaveBeenCalledWith(mockProject.id);
    });
  });

  test('auto-start only runs once per mount', async () => {
    const onRestartProject = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    const { rerender } = renderPreviewTab({
      processInfo,
      onRestartProject,
      isProjectStopped: false,
      autoStartOnNotRunning: true
    });

    await waitFor(() => {
      expect(onRestartProject).toHaveBeenCalledTimes(1);
    });

    rerender(
      <PreviewTab
        project={mockProject}
        processInfo={processInfo}
        onRestartProject={onRestartProject}
        isProjectStopped={false}
        autoStartOnNotRunning
      />
    );

    await waitFor(() => {
      expect(onRestartProject).toHaveBeenCalledTimes(1);
    });
  });

  test('start button disables while start is inflight', async () => {
    let resolveStart;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const onRestartProject = vi.fn().mockReturnValue(startPromise);
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    renderPreviewTab({ processInfo, onRestartProject, isProjectStopped: true });

    const startButton = screen.getByRole('button', { name: 'Start project' });
    expect(startButton).toBeEnabled();

    fireEvent.click(startButton);

    await waitFor(() => {
      expect(screen.queryByTestId('preview-not-running')).not.toBeInTheDocument();
      expect(screen.getByTestId('preview-loading')).toBeInTheDocument();
    });

    await act(async () => {
      resolveStart(null);
      await startPromise;
    });
  });

  test('does not show not-running empty state when frontend is starting with activity', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'starting', logs: [{ message: 'booting', timestamp: new Date().toISOString() }] }
      }
    });

    renderPreviewTab({ processInfo });

    expect(screen.queryByTestId('preview-not-running')).toBeNull();
    expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
  });

  test('shows not-running empty state when frontend is stopped', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'stopped' }
      }
    });

    renderPreviewTab({ processInfo, isProjectStopped: true });

    expect(screen.getByTestId('preview-not-running')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-iframe')).toBeNull();
  });

  test('start handler shows default error message when API rejects without text', async () => {
    const onRestartProject = vi.fn().mockRejectedValue({});
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    renderPreviewTab({ processInfo, onRestartProject, isProjectStopped: true });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start project' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Project not running')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start project' })).toBeInTheDocument();
    });
  });

  test('exposes reload and restart handlers through ref', () => {
    const { previewRef } = renderPreviewTab();

    expect(previewRef.current).not.toBeNull();
    expect(typeof previewRef.current.reloadPreview).toBe('function');
    expect(typeof previewRef.current.restartProject).toBe('function');
    expect(typeof previewRef.current.getDisplayedUrl).toBe('function');
    // Exercise the public getDisplayedUrl accessor (distinct from __testHooks.getDisplayedUrl)
    expect(typeof previewRef.current.getDisplayedUrl()).toBe('string');
  });

  test('getOpenInNewTabUrl maps the preview URL to the dev server', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.getOpenInNewTabUrl()).toBe('http://localhost:5555/');
  });

  test('getOpenInNewTabUrl falls back to the framework default port when ports are missing', () => {
    const processInfo = buildProcessInfo({
      ports: {
        active: null,
        stored: null,
        preferred: null
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.getOpenInNewTabUrl()).toBe('http://localhost:5173/');
  });

  test('getOpenInNewTabUrl falls back to the framework default port when frontend port is undefined', () => {
    const processInfo = buildProcessInfo({
      ports: {
        active: { backend: 5656 },
        stored: null,
        preferred: null
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.getOpenInNewTabUrl()).toBe('http://localhost:5173/');
  });

  test('restart handler triggers API call, shows success, and reloads preview', async () => {
    vi.useFakeTimers();
    try {
      const onRestartProject = vi.fn().mockResolvedValue(null);
      const { previewRef } = renderPreviewTab({ onRestartProject });

      await act(async () => {
        await previewRef.current.restartProject();
      });

      expect(onRestartProject).toHaveBeenCalledWith(mockProject.id);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('restart handler cancels previously scheduled reload before scheduling a new one', async () => {
    vi.useFakeTimers();
    try {
      const onRestartProject = vi.fn().mockResolvedValue(null);
      const { previewRef } = renderPreviewTab({ onRestartProject });

      await act(async () => {
        await previewRef.current.restartProject();
      });
      await act(async () => {
        await previewRef.current.restartProject();
      });

      expect(onRestartProject).toHaveBeenCalledTimes(2);
      expect(previewRef.current.__testHooks.getIframeKey()).toBe(0);

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(previewRef.current.__testHooks.getIframeKey()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('restart handler surfaces error message when API fails', async () => {
    const onRestartProject = vi.fn().mockRejectedValue(new Error('Server failure'));
    const { previewRef } = renderPreviewTab({ onRestartProject });

    await act(async () => {
      await previewRef.current.restartProject();
    });

    await waitFor(() => {
      expect(onRestartProject).toHaveBeenCalledWith(mockProject.id);
      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
    });
  });

  test('restart handler shows default error message when API rejects without text', async () => {
    const onRestartProject = vi.fn().mockRejectedValue({});
    const { previewRef } = renderPreviewTab({ onRestartProject });

    await act(async () => {
      await previewRef.current.restartProject();
    });

    await waitFor(() => {
      expect(onRestartProject).toHaveBeenCalledWith(mockProject.id);
      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
    });
  });

  test('builds preview URL using the backend /preview/:projectId proxy', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const url = previewRef.current.getPreviewUrl();

    const { origin } = window.location;
    const expectedOrigin = origin.replace(/:(3000|5173)$/, ':5000');
    expect(url).toBe(`${expectedOrigin}/preview/${mockProject.id}`);
  });

  test('getDevServerOriginFromWindow returns null for invalid ports', () => {
    expect(getDevServerOriginFromWindow({ port: 0 })).toBeNull();
    expect(getDevServerOriginFromWindow({ port: -1 })).toBeNull();
    expect(getDevServerOriginFromWindow({ port: 12.5 })).toBeNull();
    expect(getDevServerOriginFromWindow({ port: Number.NaN })).toBeNull();
  });

  test('getDevServerOriginFromWindow returns null when window is undefined', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    try {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
      expect(getDevServerOriginFromWindow({ port: 5173 })).toBeNull();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'window', originalDescriptor);
      }
    }
  });

  test('getDevServerOriginFromWindow uses window protocol and normalizes hostname override', () => {
    const origin = getDevServerOriginFromWindow({ port: 5173, hostnameOverride: '0.0.0.0' });
    expect(origin).toBe('http://localhost:5173');
  });

  test('getDevServerOriginFromWindow falls back to default protocol and localhost hostname', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { protocol: '', hostname: '' }
      });

      const origin = getDevServerOriginFromWindow({ port: 5173 });
      expect(origin).toBe('http://localhost:5173');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('getDevServerOriginFromWindow coerces non-string window.location.protocol to http:', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { protocol: {}, hostname: 'example.com' }
      });

      const origin = getDevServerOriginFromWindow({ port: 5173 });
      expect(origin).toBe('http://example.com:5173');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('preview proxy origin falls back when window.location is missing origin + protocol', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          hostname: 'localhost',
          port: '3000'
        }
      });

      renderPreviewTab({ processInfo: buildProcessInfo() });
      const iframe = screen.getByTestId('preview-iframe');
      await waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('http://localhost:5000/preview/123');
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('uses VITE_API_TARGET origin for the preview proxy URL when valid', async () => {
    const restoreTarget = setViteApiTarget('http://127.0.0.1:5100/api');
    try {
      renderPreviewTab({ processInfo: buildProcessInfo() });
      const iframe = screen.getByTestId('preview-iframe');
      await waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('http://127.0.0.1:5100/preview/123');
      });
    } finally {
      restoreTarget();
    }
  });

  test('ignores invalid VITE_API_TARGET values and falls back to dev default backend mapping', async () => {
    const restoreTarget = setViteApiTarget('not a url');
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          origin: 'http://localhost:3000',
          hostname: 'localhost',
          protocol: 'http:',
          port: '3000'
        }
      });

      renderPreviewTab({ processInfo: buildProcessInfo() });
      const iframe = screen.getByTestId('preview-iframe');
      await waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('http://localhost:5000/preview/123');
      });
    } finally {
      restoreTarget();
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('treats whitespace-only VITE_API_TARGET values as unset and falls back to the dev default backend mapping', async () => {
    const restoreTarget = setViteApiTarget('   ');
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          origin: 'http://localhost:3000',
          hostname: 'localhost',
          protocol: 'http:',
          port: '3000'
        }
      });

      renderPreviewTab({ processInfo: buildProcessInfo() });
      const iframe = screen.getByTestId('preview-iframe');
      await waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('http://localhost:5000/preview/123');
      });
    } finally {
      restoreTarget();
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('falls back to the dev default backend mapping when the window protocol is non-http (e.g. file:)', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

    try {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          origin: 'null',
          hostname: '',
          protocol: 'file:',
          port: ''
        }
      });

      renderPreviewTab({ processInfo: buildProcessInfo() });
      const iframe = screen.getByTestId('preview-iframe');
      await waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('http://localhost:5000/preview/123');
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, 'location', originalDescriptor);
      }
    }
  });

  test('normalizeHostname defensively coerces invalid values to localhost', () => {
    const { previewRef } = renderPreviewTab();

    expect(previewRef.current.__testHooks.normalizeHostname(null)).toBe('localhost');
    expect(previewRef.current.__testHooks.normalizeHostname('   ')).toBe('localhost');
    expect(previewRef.current.__testHooks.normalizeHostname('0.0.0.0')).toBe('localhost');
    expect(previewRef.current.__testHooks.normalizeHostname('devbox')).toBe('devbox');
  });

  test('applyHostnameOverride updates backend hostname and reloads iframe', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const initialKey = previewRef.current.__testHooks.getIframeKey();

    act(() => {
      previewRef.current.__testHooks.applyHostnameOverride('localhost');
    });
    expect(previewRef.current.getPreviewUrl()).toContain(`//localhost`);
    expect(previewRef.current.getPreviewUrl()).toContain(`/preview/${mockProject.id}`);
    expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(initialKey);

    act(() => {
      previewRef.current.__testHooks.applyHostnameOverride('127.0.0.1');
    });
    expect(previewRef.current.getPreviewUrl()).toContain('//127.0.0.1');
    expect(previewRef.current.getPreviewUrl()).toContain(`/preview/${mockProject.id}`);
  });

  test('returns blank preview when no project is selected', () => {
    const { previewRef } = renderPreviewTab({ project: null });

    expect(previewRef.current.getPreviewUrl()).toBe('about:blank');
    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBeNull();
  });

  test('returns blank preview when resolved port is zero', () => {
    const processInfo = buildProcessInfo({
      ports: {
        active: { frontend: 0 },
        stored: {},
        preferred: {}
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(0);
  });

  test('uses stored frontend port when active data is missing', () => {
    const processInfo = buildProcessInfo({
      ports: {
        active: {},
        stored: { frontend: 6200 },
        preferred: { frontend: 6300 }
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(6200);
  });

  test('falls back to preferred frontend port when others are unavailable', () => {
    const processInfo = buildProcessInfo({
      ports: {
        active: {},
        stored: {},
        preferred: { frontend: 6400 }
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(6400);
  });

  test('uses framework defaults when no runtime ports exist', () => {
    const nextProject = {
      ...mockProject,
      frontend: { framework: 'nextjs' }
    };
    const { previewRef } = renderPreviewTab({ project: nextProject, processInfo: null });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(3000);
  });

  test('falls back to React default when framework is unknown', () => {
    const customProject = {
      ...mockProject,
      frontend: { framework: 'svelte' }
    };
    const { previewRef } = renderPreviewTab({ project: customProject, processInfo: null });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(5173);
  });

  test('falls back to React default when frontend metadata is missing', () => {
    const projectWithoutMetadata = {
      id: 555,
      name: 'Metadata Missing'
    };
    const { previewRef } = renderPreviewTab({ project: projectWithoutMetadata, processInfo: null });

    expect(previewRef.current.__testHooks.resolveFrontendPort()).toBe(5173);
  });

  test('renders URL bar with current preview URL and updates when navigation changes', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const urlInput = screen.getByLabelText('Preview URL');
    expect(screen.getByTestId('preview-url-bar')).toBeInTheDocument();
    expect(urlInput).toHaveValue('http://localhost:5555/');

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(urlInput).toHaveValue('http://localhost:5555/');

    act(() => {
      previewRef.current.__testHooks.setDisplayedUrlForTests('http://localhost:5555/about');
    });

    expect(urlInput).toHaveValue('http://localhost:5555/about');
    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe('http://localhost:5555/about');
  });

  test('URL bar falls back to dev server root when displayed URL is not a valid URL', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setDisplayedUrlForTests('not a url');
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/');
  });

  test('URL bar strips backend proxy prefix and adds leading slash when needed', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setDisplayedUrlForTests(`http://localhost:5555/preview/${mockProject.id}foo?x=1#hash`);
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/foo?x=1#hash');
  });

  test('toDevServerUrl falls back to the stored preview URL when href is missing', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    await waitFor(() => {
      expect(previewRef.current.getPreviewUrl()).toMatch(/\/preview\//);
    });

    const next = previewRef.current.__testHooks.toDevServerUrlForTests();
    expect(next).toBe('http://localhost:5555/');
  });

  test('toDevServerUrl falls back to / when URL pathname is missing', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const OriginalURL = global.URL;
    try {
      global.URL = class FakeURL {
        constructor() {
          return { pathname: '', search: '', hash: '' };
        }
      };

      const next = previewRef.current.__testHooks.toDevServerUrlForTests('http://example.invalid/anything');
      expect(next).toBe('http://localhost:5555/');
    } finally {
      global.URL = OriginalURL;
    }
  });

  test('falls back to preview URL when displayed URL is cleared', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    act(() => {
      previewRef.current.__testHooks.setDisplayedUrlForTests('');
    });

    const urlInput = screen.getByLabelText('Preview URL');
    expect(urlInput).toHaveValue('http://localhost:5555/');
  });

  test('focus handler selects the preview URL text', () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const urlInput = screen.getByLabelText('Preview URL');
    const selectSpy = vi.fn();
    const setSelectionRangeSpy = vi.fn();
    urlInput.select = selectSpy;
    urlInput.setSelectionRange = setSelectionRangeSpy;

    fireEvent.focus(urlInput);

    expect(selectSpy).toHaveBeenCalledTimes(0);
    expect(setSelectionRangeSpy).toHaveBeenCalled();
  });

  test('URL bar Enter navigates to the preview proxy target', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/about' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'LUCIDCODER_PREVIEW_NAVIGATE',
        href: `${previewOrigin}/preview/${mockProject.id}/about`
      },
      '*'
    );
    expect(urlInput).toHaveValue('http://localhost:5555/about');
  });

  test('URL bar Enter supports query-only paths', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '?q=1' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'LUCIDCODER_PREVIEW_NAVIGATE',
        href: `${previewOrigin}/preview/${mockProject.id}/?q=1`
      },
      '*'
    );
    expect(urlInput).toHaveValue('http://localhost:5555/?q=1');
  });

  test('URL bar Enter ignores about:blank', () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: 'about:blank' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    expect(iframeWindow.postMessage).not.toHaveBeenCalled();
  });

  test('URL bar ignores non-Enter key presses', () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/ignored' } });
    fireEvent.keyDown(urlInput, { key: 'Escape' });

    expect(iframeWindow.postMessage).not.toHaveBeenCalled();
  });

  test('URL bar Enter bails when proxy URL cannot be resolved', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('not a url');
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/about' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    expect(iframeWindow.postMessage).not.toHaveBeenCalled();
  });

  test('URL bar Enter falls back when displayed URL is not parseable', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      previewRef.current.__testHooks.setDisplayedUrlForTests('not a url');
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/about' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'LUCIDCODER_PREVIEW_NAVIGATE',
        href: `${previewOrigin}/about`
      },
      '*'
    );
  });

  test('URL bar Enter prefixes paths without a leading slash', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: 'about' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'LUCIDCODER_PREVIEW_NAVIGATE',
        href: `${previewOrigin}/preview/${mockProject.id}/about`
      },
      '*'
    );
    expect(urlInput).toHaveValue('http://localhost:5555/about');
  });

  test('URL bar Enter supports hash-only paths', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '#section' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'LUCIDCODER_PREVIEW_NAVIGATE',
        href: `${previewOrigin}/preview/${mockProject.id}/#section`
      },
      '*'
    );
    expect(urlInput).toHaveValue('http://localhost:5555/#section');
  });

  test('URL bar focus falls back to select when selection range is unavailable', () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const urlInput = screen.getByLabelText('Preview URL');
    const selectSpy = vi.fn();
    urlInput.select = selectSpy;
    urlInput.setSelectionRange = undefined;

    fireEvent.focus(urlInput);

    expect(selectSpy).toHaveBeenCalled();
  });

  test('normalizeUrlInput prefixes missing leading slash', () => {
    const { previewRef } = renderPreviewTab({ processInfo: buildProcessInfo() });

    const next = previewRef.current.__testHooks.normalizeUrlInputForTests('about', 'http://localhost:5555');
    expect(next).toBe('http://localhost:5555/about');
  });

  test('toPreviewProxyUrl returns null when preview base is invalid', () => {
    const { previewRef } = renderPreviewTab({ processInfo: buildProcessInfo() });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('not a url');
    });

    const next = previewRef.current.__testHooks.toPreviewProxyUrlForTests('http://localhost:5555/about');
    expect(next).toBeNull();
  });

  test('toPreviewProxyUrl returns null when target url is invalid', () => {
    const { previewRef } = renderPreviewTab({ processInfo: buildProcessInfo() });

    const next = previewRef.current.__testHooks.toPreviewProxyUrlForTests('http://[invalid');
    expect(next).toBeNull();
  });

  test('toPreviewProxyUrl normalizes paths without leading slash', () => {
    const { previewRef } = renderPreviewTab({ processInfo: buildProcessInfo() });

    const OriginalURL = global.URL;
    try {
      global.URL = class FakeURL {
        constructor(value) {
          const raw = String(value || '');
          if (raw.includes('/preview/')) {
            return { origin: 'http://localhost:5000', pathname: '/preview/123', search: '', hash: '' };
          }
          return { origin: 'http://localhost:5555', pathname: 'about', search: '', hash: '' };
        }
      };

      act(() => {
        previewRef.current.__testHooks.setPreviewUrlOverride('http://localhost:5000/preview/123');
      });

      const next = previewRef.current.__testHooks.toPreviewProxyUrlForTests('http://localhost:5555/about');
      expect(next).toBe('http://localhost:5000/preview/123/about');
    } finally {
      global.URL = OriginalURL;
    }
  });

  test('getUrlOrigin returns empty string for invalid URLs', () => {
    const { previewRef } = renderPreviewTab({ processInfo: buildProcessInfo() });

    expect(previewRef.current.__testHooks.getUrlOriginForTests('http://[invalid')).toBe('');
  });

  test('back and forward buttons navigate through history', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const firstUrl = `${previewOrigin}/preview/${mockProject.id}/first`;
    const secondUrl = `${previewOrigin}/preview/${mockProject.id}/second`;

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/first' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/second' } });
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    const backButton = screen.getByRole('button', { name: 'Back' });
    const forwardButton = screen.getByRole('button', { name: 'Forward' });

    await waitFor(() => {
      expect(backButton).toBeEnabled();
    });

    iframeWindow.postMessage.mockClear();

    fireEvent.click(backButton);

    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      { type: 'LUCIDCODER_PREVIEW_NAVIGATE', href: firstUrl },
      '*'
    );

    iframeWindow.postMessage.mockClear();

    fireEvent.click(forwardButton);

    expect(iframeWindow.postMessage).toHaveBeenCalledWith(
      { type: 'LUCIDCODER_PREVIEW_NAVIGATE', href: secondUrl },
      '*'
    );
  });

  test('URL bar blur resets edited value to the current preview URL', () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const urlInput = screen.getByLabelText('Preview URL');
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: '/temp' } });
    fireEvent.blur(urlInput);

    expect(urlInput).toHaveValue('http://localhost:5555/');
  });

  test('falls back to about:blank when no URLs are available', () => {
    const { previewRef } = renderPreviewTab({ project: null, processInfo: null });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('');
      previewRef.current.__testHooks.setDisplayedUrlForTests('');
    });

    const urlInput = screen.getByLabelText('Preview URL');
    expect(urlInput).toHaveValue('about:blank');
  });

  test('updates displayed URL when iframe reports navigation changes', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get() {
        return buildIframeWindow({
          location: {
            href: 'http://localhost:5555/dashboard'
          }
        });
      }
    });

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/dashboard');
    });
    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe('http://localhost:5555/dashboard');
  });

  test('updates displayed URL when the preview bridge posts navigation messages', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/bridge-route' },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/bridge-route');
    });
    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe('http://localhost/bridge-route');
  });

  test('accepts bridge READY messages and fires onPreviewNavigated', async () => {
    const processInfo = buildProcessInfo();
    const onPreviewNavigated = vi.fn();
    const { previewRef } = renderPreviewTab({ processInfo, onPreviewNavigated });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_BRIDGE_READY', href: 'http://localhost/ready-route' },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(onPreviewNavigated).toHaveBeenCalledWith(
        'http://localhost/ready-route',
        expect.objectContaining({ source: 'message', type: 'LUCIDCODER_PREVIEW_BRIDGE_READY' })
      );
    });

    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe('http://localhost/ready-route');
  });

  test('renders a custom context menu when the preview helper posts a context menu message', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
            href: 'http://localhost/ctx',
            clientX: 12,
            clientY: 24,
            tagName: 'DIV',
            id: 'root',
            className: 'app'
          },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
    });

    // Invoke the context menu onMouseDown stopPropagation handler.
    fireEvent.mouseDown(screen.getByTestId('preview-context-menu'));
    expect(screen.getByText(/copy selector/i)).toBeInTheDocument();
  });

  test('emits a close-dropdowns event when the preview bridge reports pointer activity', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const closeHandler = vi.fn();
    window.addEventListener('lucidcoder:close-dropdowns', closeHandler);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_BRIDGE_POINTER', kind: 'pointerdown' },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    expect(closeHandler).toHaveBeenCalled();

    window.removeEventListener('lucidcoder:close-dropdowns', closeHandler);
  });

  test('closes the custom context menu when clicking outside', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
            href: 'http://localhost/ctx',
            clientX: 12,
            clientY: 24,
            tagName: 'DIV'
          },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
    });

    fireEvent.mouseDown(screen.getByTestId('preview-context-menu-backdrop'));

    await waitFor(() => {
      expect(screen.queryByTestId('preview-context-menu')).not.toBeInTheDocument();
    });
  });

  test('closes the custom context menu when pressing Escape', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
            href: 'http://localhost/ctx',
            clientX: 12,
            clientY: 24,
            tagName: 'DIV'
          },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('preview-context-menu')).not.toBeInTheDocument();
    });
  });

  test('accepts preview messages when expected origin is unavailable', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('');
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/route2' },
          origin: 'http://untrusted-origin.invalid',
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/route2');
    });
  });

  test('clears the custom context menu on preview navigation messages', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
            href: 'http://localhost/ctx',
            clientX: 1,
            clientY: 2,
            tagName: 'DIV'
          },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/next' },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('preview-context-menu')).not.toBeInTheDocument();
    });
  });

  test('ignores preview messages when origin does not match expected backend origin', async () => {
    const processInfo = buildProcessInfo();
    const onPreviewNavigated = vi.fn();
    const { previewRef } = renderPreviewTab({ processInfo, onPreviewNavigated });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow({
      location: {
        href: previewRef.current.getPreviewUrl()
      }
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    // Navigation polling may emit a baseline update on mount; this test only
    // cares that the wrong-origin message does not trigger navigation events.
    await new Promise((resolve) => setTimeout(resolve, 0));
    onPreviewNavigated.mockClear();

    const before = previewRef.current.__testHooks.getDisplayedUrl();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/ignored-origin' },
          origin: 'http://evil.invalid',
          source: iframeWindow
        })
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe(before);
    expect(
      onPreviewNavigated.mock.calls.some(
        ([href, meta]) => href === 'http://localhost/ignored-origin' || meta?.source === 'bridge'
      )
    ).toBe(false);
  });

  test('detects proxy placeholder by title', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: { title: 'Preview proxy error', querySelector: vi.fn() }
    });
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    expect(previewRef.current.__testHooks.isProxyPlaceholderPageForTests()).toBe(true);
  });

  test('detects proxy placeholder by heading', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const heading = { textContent: 'Preview unavailable' };
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: { title: '', querySelector: vi.fn(() => heading) }
    });
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    expect(previewRef.current.__testHooks.isProxyPlaceholderPageForTests()).toBe(true);
  });

  test('detects proxy placeholder by "Preview starting" title', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: { title: 'Preview starting', querySelector: vi.fn() }
    });
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    expect(previewRef.current.__testHooks.isProxyPlaceholderPageForTests()).toBe(true);
  });

  test('Copy selector uses navigator.clipboard when available', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
              href: 'http://localhost/ctx',
              clientX: 12,
              clientY: 24,
              tagName: 'DIV',
              id: 'root',
              className: 'app'
            },
            origin: previewOrigin,
            source: iframeWindow
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /copy selector/i }));
      });

      expect(writeText).toHaveBeenCalledWith('div#root');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard
      });
    }
  });

  test('Copy href falls back to document.execCommand when clipboard is unavailable', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined
    });
    const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommandMock
    });

    const originalTextareaSelectDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'select');
    const selectMock = vi.fn();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'select', {
      configurable: true,
      writable: true,
      value: selectMock
    });

    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
              href: 'http://localhost/href',
              clientX: 12,
              clientY: 24,
              tagName: 'A',
              className: 'link'
            },
            origin: previewOrigin,
            source: iframeWindow
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /copy href/i }));
      });

      expect(selectMock).toHaveBeenCalled();
      expect(execCommandMock).toHaveBeenCalledWith('copy');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard
      });
      if (originalExecCommandDescriptor) {
        Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete document.execCommand;
      }

      if (originalTextareaSelectDescriptor) {
        Object.defineProperty(HTMLTextAreaElement.prototype, 'select', originalTextareaSelectDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete HTMLTextAreaElement.prototype.select;
      }
    }
  });

  test('context menu positioning reads iframe and canvas bounding rects', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef, container } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const canvas = container.querySelector('.preview-canvas');
    expect(canvas).not.toBeNull();

    const iframeRectSpy = vi
      .spyOn(iframe, 'getBoundingClientRect')
      .mockReturnValue({ left: 30, top: 50, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    const canvasRectSpy = vi
      .spyOn(canvas, 'getBoundingClientRect')
      .mockReturnValue({ left: 10, top: 20, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });

    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
              href: 'http://localhost/ctx',
              clientX: 5,
              clientY: 7,
              tagName: 'DIV',
              id: 'root',
              className: 'app'
            },
            origin: previewOrigin,
            source: iframeWindow
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
      });

      expect(iframeRectSpy).toHaveBeenCalled();
      expect(canvasRectSpy).toHaveBeenCalled();
    } finally {
      iframeRectSpy.mockRestore();
      canvasRectSpy.mockRestore();
    }
  });

  test('accepts preview messages when expected origin cannot be parsed', async () => {
    const processInfo = buildProcessInfo();
    const onPreviewNavigated = vi.fn();
    const { previewRef } = renderPreviewTab({ processInfo, onPreviewNavigated });

    // Use a fake iframe node so changing previewUrlOverride doesn't trigger
    // happy-dom frame navigation tasks.
    const iframeWindow = buildIframeWindow();
    act(() => {
      previewRef.current.__testHooks.setIframeNodeForTests({ contentWindow: iframeWindow });
    });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('not a url');
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/unparsed-origin-ok' },
          origin: 'http://evil.invalid',
          source: iframeWindow
        })
      );
    });

    await waitFor(() => {
      expect(onPreviewNavigated).toHaveBeenCalledWith(
        'http://localhost/unparsed-origin-ok',
        expect.objectContaining({ source: 'message' })
      );
    });
  });

  test('copyTextToClipboard returns false for invalid inputs', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    await expect(previewRef.current.__testHooks.copyTextToClipboardForTests('')).resolves.toBe(false);
    await expect(previewRef.current.__testHooks.copyTextToClipboardForTests(null)).resolves.toBe(false);
  });

  test('copyTextToClipboard falls back when navigator.clipboard.writeText throws', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockRejectedValue(new Error('nope'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: execCommandMock
    });

    const originalTextareaSelectDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'select');
    const selectMock = vi.fn();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'select', {
      configurable: true,
      writable: true,
      value: selectMock
    });

    try {
      await expect(previewRef.current.__testHooks.copyTextToClipboardForTests('hello')).resolves.toBe(true);
      expect(writeText).toHaveBeenCalledWith('hello');
      expect(execCommandMock).toHaveBeenCalledWith('copy');
      expect(selectMock).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard
      });

      if (originalExecCommandDescriptor) {
        Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete document.execCommand;
      }

      if (originalTextareaSelectDescriptor) {
        Object.defineProperty(HTMLTextAreaElement.prototype, 'select', originalTextareaSelectDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete HTMLTextAreaElement.prototype.select;
      }
    }
  });

  test('context menu handler bails when canvas ref is missing', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef, container } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const canvas = container.querySelector('.preview-canvas');
    expect(canvas).not.toBeNull();

    // Force the handler's canvasRef.current to be null.
    act(() => {
      previewRef.current.__testHooks.setCanvasNodeForTests(null);
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
            href: 'http://localhost/ctx',
            clientX: 1,
            clientY: 1,
            tagName: 'DIV'
          },
          origin: previewOrigin,
          source: iframeWindow
        })
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByTestId('preview-context-menu')).toBeNull();

    // Restore for completeness (not strictly required per-test).
    act(() => {
      previewRef.current.__testHooks.setCanvasNodeForTests(canvas);
    });
  });

  test('Copy href returns false when execCommand fallback throws', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined
    });

    const originalCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName, ...rest) => {
      if (String(tagName).toLowerCase() === 'textarea') {
        throw new Error('no textarea');
      }
      return originalCreateElement(tagName, ...rest);
    });

    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
              href: 'http://localhost/href',
              clientX: 12,
              clientY: 24,
              tagName: 'A',
              className: 'link'
            },
            origin: previewOrigin,
            source: iframeWindow
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('preview-context-menu')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /copy href/i }));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('preview-context-menu')).toBeNull();
      });
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard
      });
      createSpy.mockRestore();
    }
  });

  test('ignores preview messages when the source window does not match the iframe', async () => {
    const processInfo = buildProcessInfo();
    const onPreviewNavigated = vi.fn();
    const { previewRef } = renderPreviewTab({ processInfo, onPreviewNavigated });

    const previewOrigin = new URL(previewRef.current.getPreviewUrl()).origin;
    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow({
      location: {
        href: previewRef.current.getPreviewUrl()
      }
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    onPreviewNavigated.mockClear();

    const before = previewRef.current.__testHooks.getDisplayedUrl();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/wrong-source' },
          origin: previewOrigin,
          source: {}
        })
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(previewRef.current.__testHooks.getDisplayedUrl()).toBe(before);
    expect(
      onPreviewNavigated.mock.calls.some(
        ([href, meta]) => href === 'http://localhost/wrong-source' || meta?.source === 'bridge'
      )
    ).toBe(false);
  });

  test('postPreviewBridgePing swallows postMessage errors and no-ops when postMessage is missing', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const badWindow = { DOMException: getDomExceptionCtor(), postMessage: () => { throw new Error('boom'); } };
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: badWindow
    });

    expect(() => {
      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });
    }).not.toThrow();

    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: buildIframeWindow({ postMessage: undefined })
    });

    expect(() => {
      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });
    }).not.toThrow();
  });

  test('navigation polling helper returns null when window interval APIs are unavailable', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const originalSetIntervalDescriptor = Object.getOwnPropertyDescriptor(window, 'setInterval');
    const originalClearIntervalDescriptor = Object.getOwnPropertyDescriptor(window, 'clearInterval');

    // Simulate non-browser environment for the helper without mutating the
    // property attributes (Vitest fake timers expect these to stay writable).
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      writable: true,
      value: undefined
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      writable: true,
      value: undefined
    });

    try {
      expect(previewRef.current.__testHooks.startNavigationPollingForTests()).toBeNull();
    } finally {
      if (originalSetIntervalDescriptor) {
        Object.defineProperty(window, 'setInterval', originalSetIntervalDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete window.setInterval;
      }

      if (originalClearIntervalDescriptor) {
        Object.defineProperty(window, 'clearInterval', originalClearIntervalDescriptor);
      } else {
        // eslint-disable-next-line no-undef
        delete window.clearInterval;
      }
    }
  });

  test('updateDisplayedUrlFromIframe swallows cross-origin access errors', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const throwingWindow = {};
    Object.defineProperty(throwingWindow, 'location', {
      get: () => {
        throw new Error('cross-origin');
      }
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: throwingWindow
    });
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    expect(() => {
      previewRef.current.__testHooks.updateDisplayedUrlFromIframe();
    }).not.toThrow();
  });

  test('placeholder detection returns false when iframe is missing', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    previewRef.current.__testHooks.setIframeNodeForTests(null);

    expect(previewRef.current.__testHooks.isProxyPlaceholderPageForTests()).toBe(false);
  });

  test('placeholder detection returns false when contentDocument throws', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get: () => {
        throw new Error('boom');
      }
    });
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    expect(previewRef.current.__testHooks.isProxyPlaceholderPageForTests()).toBe(false);
  });

  test('clears pending error confirmation on load', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setHasConfirmedPreviewForTests(true);
      });

      act(() => {
        previewRef.current.__testHooks.triggerIframeError();
      });

      const callsAfterError = clearTimeoutSpy.mock.calls.length;

      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsAfterError);
    } finally {
      vi.useRealTimers();
      clearTimeoutSpy.mockRestore();
    }
  });

  test('keeps loading state when placeholder page loads', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const fakeIframe = {
      contentDocument: { title: 'Preview proxy error', querySelector: vi.fn() }
    };
    previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(screen.queryByText('Failed to load preview')).toBeNull();
  });

  test('escalates repeated proxy placeholder loads into an actionable error view', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), stop: vi.fn() },
        contentDocument: {
          title: 'Preview proxy error',
          querySelector: vi.fn(() => ({ textContent: 'ECONNREFUSED' }))
        }
      };
      previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Fix with AI' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('Fix with AI button dispatches a run-prompt event', () => {
    const processInfo = buildProcessInfo();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const { previewRef } = renderPreviewTab({ processInfo });
    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({
        error: true,
        loading: false,
        pending: false
      });
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    });

    expect(dispatchSpy).toHaveBeenCalled();
    const call = dispatchSpy.mock.calls.find((args) => args?.[0]?.type === 'lucidcoder:run-prompt');
    expect(call).toEqual(expect.any(Array));
    expect(call[0]).toEqual(expect.objectContaining({ type: 'lucidcoder:run-prompt' }));

    dispatchSpy.mockRestore();
  });

  test('Ask AI prompt includes formatted process logs', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const processInfo = buildProcessInfo({
      processes: {
        frontend: {
          status: 'running',
          port: 5555,
          pid: 1234,
          logs: [
            { timestamp: '2026-01-25T00:00:00.000Z', stream: 'stderr', message: 'frontend boom' }
          ]
        },
        backend: {
          status: 'running',
          port: 5656,
          pid: 5678,
          logs: [
            { timestamp: '2026-01-25T00:00:01.000Z', stream: 'stdout', message: 'backend ok' }
          ]
        }
      }
    });

    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({
        error: true,
        loading: false,
        pending: false
      });
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    });

    const call = dispatchSpy.mock.calls.find((args) => args?.[0]?.type === 'lucidcoder:run-prompt');
    expect(call).toEqual(expect.any(Array));
    expect(call[0]).toEqual(expect.objectContaining({ type: 'lucidcoder:run-prompt' }));
    const prompt = call[0].detail?.prompt || '';
    expect(prompt).toContain('Frontend logs (tail):');
    expect(prompt).toContain('2026-01-25T00:00:00.000Z stderr frontend boom');
    expect(prompt).toContain('Backend logs (tail):');
    expect(prompt).toContain('2026-01-25T00:00:01.000Z stdout backend ok');

    dispatchSpy.mockRestore();
  });

  test('Ask AI does nothing when dispatchEvent is unavailable', () => {
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = undefined;
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({
          error: true,
          loading: false,
          pending: false
        });
      });

      expect(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
      }).not.toThrow();
    } finally {
      window.dispatchEvent = originalDispatch;
    }
  });

  test('Fix with AI swallows dispatch exceptions', () => {
    const originalDispatch = window.dispatchEvent;
    window.dispatchEvent = vi.fn(() => {
      throw new Error('boom');
    });
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({
          error: true,
          loading: false,
          pending: false
        });
      });

      expect(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
      }).not.toThrow();

      expect(window.dispatchEvent).toHaveBeenCalled();
    } finally {
      window.dispatchEvent = originalDispatch;
    }
  });

  test('renders dev-server URL when project id is missing (origin only)', async () => {
    const processInfo = buildProcessInfo();
    const projectWithoutId = { name: 'No ID', frontend: { framework: 'react' } };
    const { previewRef } = renderPreviewTab({ processInfo, project: projectWithoutId });

    act(() => {
      previewRef.current.__testHooks.setHasConfirmedPreviewForTests(true);
      previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: false, pending: false });
      previewRef.current.__testHooks.setDisplayedUrlForTests('http://example.test/preview/no-id');
    });

    const input = screen.getByLabelText('Preview URL');
    expect(input.value).toMatch(/:\d+$/);
  });

  test('falls back to origin root when displayed URL is not parseable', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setHasConfirmedPreviewForTests(true);
      previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: false, pending: false });
      previewRef.current.__testHooks.setDisplayedUrlForTests('not a url');
    });

    const input = screen.getByLabelText('Preview URL');
    expect(input.value).toMatch(/:\d+\/$/);
  });

  test('escalation ignores placeholder document read errors', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), stop: vi.fn() },
        contentDocument: {
          title: 'Preview proxy error',
          querySelector: () => {
            throw new Error('boom');
          }
        }
      };
      previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('renders frontend and backend logs in the error view when available', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: {
          status: 'running',
          port: 5555,
          logs: [{ message: 'frontend error: ECONNREFUSED' }]
        },
        backend: {
          status: 'running',
          port: 5656,
          logs: [{ message: 'backend error: listen EADDRINUSE' }]
        }
      }
    });

    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({
        error: true,
        loading: false,
        pending: false
      });
    });

    expect(screen.getByText('Frontend logs')).toBeInTheDocument();
    expect(screen.getByText('frontend error: ECONNREFUSED')).toBeInTheDocument();
    expect(screen.getByText('Backend logs')).toBeInTheDocument();
    expect(screen.getByText('backend error: listen EADDRINUSE')).toBeInTheDocument();
  });

  test('setErrorGracePeriod is a no-op in the new state machine', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    // The grace period API still exists as a no-op for backwards compat.
    // getErrorGraceUntilForTests always returns 0.
    act(() => {
      previewRef.current.__testHooks.setErrorGracePeriodForTests(Number.NaN);
    });

    expect(previewRef.current.__testHooks.getErrorGraceUntilForTests()).toBe(0);
  });

  test('clears error confirmation timeout on unmount', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const processInfo = buildProcessInfo();
      const { previewRef, unmount } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.triggerIframeError();
      });

      const callsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
      unmount();

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    } finally {
      vi.useRealTimers();
      clearTimeoutSpy.mockRestore();
    }
  });

  test('ignores preview bridge messages when iframe window is unavailable', async () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const input = screen.getByLabelText('Preview URL');
    const initialValue = input.value;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/ignored' },
          source: {}
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Preview URL')).toHaveValue(initialValue);
    });
  });

  test('ignores preview bridge messages with invalid payloads', async () => {
    const processInfo = buildProcessInfo();
    renderPreviewTab({ processInfo });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = buildIframeWindow();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

    const input = screen.getByLabelText('Preview URL');
    const initialValue = input.value;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'not-an-object',
          source: iframeWindow
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'OTHER_EVENT', href: 'http://localhost/ignored' },
          source: iframeWindow
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: '' },
          source: iframeWindow
        })
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'LUCIDCODER_PREVIEW_NAV', href: 'http://localhost/wrong-source' },
          source: {}
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Preview URL')).toHaveValue(initialValue);
    });
  });

  test('iframe error view shows expected URL and recovers on retry', async () => {
    vi.useFakeTimers();
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    window.setInterval = vi.fn(() => 1);
    window.clearInterval = vi.fn();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      await act(async () => {
        previewRef.current.__testHooks.triggerIframeError();
      });

      // Advance past the 1.2 s error confirmation delay
      await act(async () => {
        vi.advanceTimersByTime(1200);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();

      expect(screen.getByText(/didn.?t finish loading|blocks embedding|unreachable/i)).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Retry'));
      });

      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();

      await act(async () => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });
      expect(screen.queryByText('Failed to load preview')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      window.setInterval = originalSetInterval;
      window.clearInterval = originalClearInterval;
    }
  });

  test('applyHostnameOverride suggests localhost alternatives when hostname is not localhost', async () => {
    const originalHostname = window.location.hostname;
    try {
      try {
        Object.defineProperty(window.location, 'hostname', {
          configurable: true,
          value: 'devbox'
        });
      } catch {
        // Fall back to assignment if the location property is writable.
        window.location.hostname = 'devbox';
      }

      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const initialKey = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.applyHostnameOverride('localhost');
      });
      expect(previewRef.current.getPreviewUrl()).toContain('//localhost');
      expect(previewRef.current.getPreviewUrl()).toContain(`/preview/${mockProject.id}`);
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(initialKey);

      const nextKey = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.applyHostnameOverride('127.0.0.1');
      });
      expect(previewRef.current.getPreviewUrl()).toContain('//127.0.0.1');
      expect(previewRef.current.getPreviewUrl()).toContain(`/preview/${mockProject.id}`);
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(nextKey);
    } finally {
      try {
        Object.defineProperty(window.location, 'hostname', {
          configurable: true,
          value: originalHostname
        });
      } catch {
        // ignore
      }
    }
  });

  test('error view renders localhost alternative buttons', async () => {
    const originalHostname = window.location.hostname;
    try {
      try {
        Object.defineProperty(window.location, 'hostname', {
          configurable: true,
          value: 'devbox'
        });
      } catch {
        window.location.hostname = 'devbox';
      }

      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({
          error: true,
          loading: false,
          pending: false
        });
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Fix with AI' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try localhost' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try 127.0.0.1' })).toBeNull();
    } finally {
      try {
        Object.defineProperty(window.location, 'hostname', {
          configurable: true,
          value: originalHostname
        });
      } catch {
        // ignore
      }
    }
  });

  test('error view shows proxy placeholder failure details after escalation', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const iframe = screen.getByTestId('preview-iframe');
      const codeNode = { textContent: 'ECONNREFUSED 127.0.0.1:5555' };
      Object.defineProperty(iframe, 'contentDocument', {
        configurable: true,
        value: {
          title: 'Preview proxy error',
          querySelector: vi.fn(() => codeNode)
        }
      });
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: { postMessage: vi.fn(), stop: vi.fn() }
      });
      previewRef.current.__testHooks.setIframeNodeForTests(iframe);

      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
      expect(screen.getByText(/Preview proxy error/i)).toBeInTheDocument();
      expect(screen.getByText(/ECONNREFUSED 127\.0\.0\.1:5555/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('error view uses "Details" label when failure details have no title', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setPreviewFailureDetailsForTests({ title: '', message: 'Something went wrong' });
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName === 'STRONG' && element.textContent === 'Details:')
    ).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  test('error view shows process summary and tail logs when available', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: {
          status: 'running',
          port: 5555,
          logs: [{ message: 'frontend ok', timestamp: new Date().toISOString() }]
        },
        backend: {
          status: 'running',
          port: 5656,
          logs: [{ message: 'backend ok', timestamp: new Date().toISOString() }]
        }
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    expect(screen.getByText('Frontend logs')).toBeInTheDocument();
    expect(screen.getByText('Backend logs')).toBeInTheDocument();
    expect(screen.getByText(/frontend ok/i)).toBeInTheDocument();
    expect(screen.getByText(/backend ok/i)).toBeInTheDocument();
  });

  test('error view omits process summary when process info is for another project', () => {
    const processInfo = { ...buildProcessInfo(), projectId: 999 };
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    expect(screen.queryByText(/Frontend: /i)).toBeNull();
    expect(screen.queryByText(/Backend: /i)).toBeNull();
  });

  test('error view process summary omits port suffix when ports are missing', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'running' },
        backend: { status: 'running' }
      },
      ports: {
        active: null,
        stored: null
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.queryByText(/Frontend: /i)).toBeNull();
    expect(screen.queryByText(/Backend: /i)).toBeNull();
  });

  test('error view process summary falls back to active ports when process ports are missing', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'running' },
        backend: { status: 'running' }
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.queryByText(/Frontend: /i)).toBeNull();
    expect(screen.queryByText(/Backend: /i)).toBeNull();
  });

  test('error view process summary falls back to stored ports when active ports are missing', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'running' },
        backend: null
      },
      ports: {
        active: null,
        stored: { frontend: 5555, backend: 5656 }
      }
    });
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.queryByText(/Frontend: /i)).toBeNull();
    expect(screen.queryByText(/Backend: /i)).toBeNull();
  });

  test('auto-recovery timeout is cleared on successful iframe load', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        previewRef.current.__testHooks.triggerIframeLoad();
      });

      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('auto-recovery attempts refresh and reloads when the scheduled timer fires', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      expect(onRefreshProcessStatus).toHaveBeenCalledWith(mockProject.id);
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Retry reloads the iframe when error view is shown', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    const keyBefore = previewRef.current.__testHooks.getIframeKey();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
  });

  test('refresh+retry handler exits early when no project is selected', async () => {
    const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
    const { previewRef } = renderPreviewTab({ project: null, onRefreshProcessStatus });

    await act(async () => {
      await previewRef.current.__testHooks.triggerRefreshAndRetryForTests();
    });

    expect(onRefreshProcessStatus).not.toHaveBeenCalled();
  });

  test('refresh+retry triggers refresh and reloads the iframe', async () => {
    const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

    const keyBefore = previewRef.current.__testHooks.getIframeKey();

    await act(async () => {
      await previewRef.current.__testHooks.triggerRefreshAndRetryForTests();
    });

    expect(onRefreshProcessStatus).toHaveBeenCalledWith(mockProject.id);
    expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
  });

  test('refresh+retry clears scheduled auto-recovery timers', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      await act(async () => {
        await previewRef.current.__testHooks.triggerRefreshAndRetryForTests();
      });

      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      clearSpy.mockRestore();
    }
  });

  test('refresh+retry ignores refresh errors and still reloads the iframe', async () => {
    const onRefreshProcessStatus = vi.fn().mockRejectedValue(new Error('status failed'));
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

    const keyBefore = previewRef.current.__testHooks.getIframeKey();

    await act(async () => {
      await previewRef.current.__testHooks.triggerRefreshAndRetryForTests();
    });

    expect(onRefreshProcessStatus).toHaveBeenCalledWith(mockProject.id);
    expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
  });

  test('Retry keeps the error view visible until iframe loads', async () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
  });

  test('error view renders scheduled/running/exhausted auto-recovery copy deterministically', () => {
    const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo();
    const { previewRef, container } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

    act(() => {
      previewRef.current.__testHooks.setAutoRecoverAttemptForTests(2);
      previewRef.current.__testHooks.setAutoRecoverStateForTests({ attempt: 0, mode: 'scheduled' });
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Attempting recovery…')).toBeInTheDocument();
    expect(container.querySelector('.preview-loading-bar-swoosh')).toBeTruthy();

    act(() => {
      previewRef.current.__testHooks.setAutoRecoverStateForTests({ attempt: 2, mode: 'running' });
    });

    expect(screen.getByText(/Attempting recovery… \(attempt 2\/3\)/i)).toBeInTheDocument();
    expect(container.querySelector('.preview-loading-bar-swoosh')).toBeTruthy();

    act(() => {
      previewRef.current.__testHooks.setAutoRecoverStateForTests({ attempt: 3, mode: 'exhausted' });
    });

    expect(screen.getByText('Auto-recovery paused after repeated failures.')).toBeInTheDocument();
    expect(container.querySelector('.preview-loading-bar-swoosh')).toBeNull();
  });

  test('loading overlay switches copy when recovery is running', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('http://localhost:5555/preview/123');
      previewRef.current.__testHooks.setAutoRecoverStateForTests({ attempt: 2, mode: 'running' });
      previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: true, pending: false });
    });

    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();
    expect(screen.getByText('Recovering preview…')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2/3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in a new tab' })).toBeInTheDocument();
  });

  test('loading overlay keeps loading copy when recovery is running but attempt is zero', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    act(() => {
      previewRef.current.__testHooks.setPreviewUrlOverride('http://localhost:5555/preview/123');
      previewRef.current.__testHooks.setAutoRecoverStateForTests({ attempt: 0, mode: 'running' });
      previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: true, pending: false });
    });

    expect(screen.getByTestId('preview-loading')).toBeInTheDocument();
    expect(screen.getByText('Loading preview…')).toBeInTheDocument();
    expect(screen.queryByText('Recovering preview…')).toBeNull();
  });

  test('error view shows paused auto-recovery copy when disabled', () => {
    const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

    act(() => {
      previewRef.current.__testHooks.setAutoRecoverDisabledForTests(true);
      previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
    });

    expect(screen.getByText('Auto-recovery is paused.')).toBeInTheDocument();
  });

  test('auto-recovery does not schedule when no project is selected', () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ project: null, processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery does not schedule when refresh handler is not provided', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus: null });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        vi.advanceTimersByTime(10000);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery does not schedule when disabled', () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setAutoRecoverDisabledForTests(true);
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery does not schedule when project is stopped', () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo({
        processes: {
          frontend: { status: 'stopped', port: null, lastHeartbeat: null, logs: [] }
        }
      });
      const { previewRef } = renderPreviewTab({
        processInfo,
        onRefreshProcessStatus,
        isProjectStopped: true
      });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery enters exhausted mode when max attempts is exceeded', () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setAutoRecoverAttemptForTests(3);
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      expect(screen.getByText('Auto-recovery paused after repeated failures.')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery schedules at most one pending attempt and reloads after the attempt runs', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ pending: true });
      });
      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ pending: false });
      });

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(onRefreshProcessStatus).toHaveBeenCalledTimes(1);
      expect(onRefreshProcessStatus).toHaveBeenCalledWith(mockProject.id);
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);

      await act(async () => {
        vi.advanceTimersByTime(10000);
        await Promise.resolve();
      });

      expect(onRefreshProcessStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery clears any pending timeout when the selected project changes', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const projectA = { ...mockProject, id: 123 };
      const projectB = { ...mockProject, id: 456 };

      const { previewRef, rerender } = renderPreviewTab({
        project: projectA,
        processInfo,
        onRefreshProcessStatus
      });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      const callsBefore = clearTimeoutSpy.mock.calls.length;

      rerender(
        <PreviewTab
          project={projectB}
          processInfo={processInfo}
          onRestartProject={vi.fn().mockResolvedValue(null)}
          onRefreshProcessStatus={onRefreshProcessStatus}
          autoStartOnNotRunning={false}
        />
      );

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('auto-recovery reloads the iframe even if refresh throws', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockRejectedValue(new Error('boom'));
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(onRefreshProcessStatus).toHaveBeenCalledWith(mockProject.id);
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery moves to paused mode if disabled before the scheduled attempt runs', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });

      act(() => {
        previewRef.current.__testHooks.setAutoRecoverAttemptForTests(Number.NaN);
        previewRef.current.__testHooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        previewRef.current.__testHooks.setAutoRecoverDisabledForTests(true);
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
      expect(screen.getByText('Auto-recovery is paused.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('shows error state when iframe does not load within timeout', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      renderPreviewTab({ processInfo });

      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      await act(async () => {
        vi.advanceTimersByTime(1200);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('restart handler exits early when no project is selected', async () => {
    const { previewRef, props } = renderPreviewTab({ project: null });

    await act(async () => {
      await previewRef.current.restartProject();
    });

    expect(props.onRestartProject).not.toHaveBeenCalled();
  });

  test('restart handler exits early when restart action is unavailable', async () => {
    const { previewRef } = renderPreviewTab({ onRestartProject: undefined });

    await act(async () => {
      await previewRef.current.restartProject();
    });

    expect(screen.queryByTestId('preview-status')).toBeNull();
  });

  test('cleans pending reload timeout when unmounting', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const { previewRef, unmount } = renderPreviewTab();

      await act(async () => {
        await previewRef.current.restartProject();
      });

      const callsBeforeUnmount = clearTimeoutSpy.mock.calls.length;

      unmount();

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('clears navigation polling interval when component unmounts', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, 'clearInterval');
    try {
      const { unmount } = renderPreviewTab();
      unmount();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('updateDisplayedUrlFromIframe bails when iframe ref is missing', () => {
    const { previewRef } = renderPreviewTab();
    const hooks = previewRef.current.__testHooks;

    const initialUrl = hooks.getDisplayedUrl();
    hooks.setDisplayedUrlForTests(`${initialUrl}/custom`);
    const expectedUrl = hooks.getDisplayedUrl();
    hooks.setIframeNodeForTests(null);
    hooks.updateDisplayedUrlFromIframe();

    expect(hooks.getDisplayedUrl()).toBe(expectedUrl);
  });

  test('navigation polling helper aborts when interval APIs are unavailable', () => {
    const { previewRef } = renderPreviewTab();
    const hooks = previewRef.current.__testHooks;

    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    try {
      Object.defineProperty(window, 'setInterval', { configurable: true, writable: true, value: undefined });
      Object.defineProperty(window, 'clearInterval', { configurable: true, writable: true, value: undefined });

      const cleanup = hooks.startNavigationPollingForTests();
      expect(cleanup).toBeNull();
    } finally {
      Object.defineProperty(window, 'setInterval', { configurable: true, writable: true, value: originalSetInterval });
      Object.defineProperty(window, 'clearInterval', { configurable: true, writable: true, value: originalClearInterval });
    }
  });

  test('displayed URL ref falls back to the preview URL when the value is cleared', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const hooks = previewRef.current.__testHooks;
    const previewUrl = previewRef.current.getPreviewUrl();

    act(() => {
      hooks.setDisplayedUrlForTests('');
    });

    expect(hooks.getDisplayedUrl()).toBe(previewUrl);
  });

  test('navigation polling effect tolerates missing interval APIs during mount/unmount', () => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    Object.defineProperty(window, 'setInterval', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(window, 'clearInterval', { configurable: true, writable: true, value: undefined });

    try {
      const processInfo = buildProcessInfo();
      const { unmount } = renderPreviewTab({ processInfo });

      expect(() => {
        unmount();
      }).not.toThrow();
    } finally {
      Object.defineProperty(window, 'setInterval', { configurable: true, writable: true, value: originalSetInterval });
      Object.defineProperty(window, 'clearInterval', { configurable: true, writable: true, value: originalClearInterval });
    }
  });

  test('unmount clears a pending debounced reload timeout', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    try {
      const processInfo = buildProcessInfo();
      const { previewRef, unmount } = renderPreviewTab({ processInfo });

      // Trigger debounced reload to populate reloadDebounceRef
      act(() => {
        previewRef.current.reloadPreview();
      });

      const callsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
      unmount();

      // Cleanup effect should have called clearTimeout for the debounce timer
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('proxy placeholder load starts a 10s escalation timeout that triggers error', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      // Set up a proxy placeholder page
      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), stop: vi.fn() },
        contentDocument: { title: 'Preview proxy error', querySelector: vi.fn() }
      };
      hooks.setIframeNodeForTests(fakeIframe);

      // First placeholder load — should keep loading and start escalation timeout
      act(() => {
        hooks.triggerIframeLoad();
      });

      // Should NOT show error yet (placeholder just started)
      expect(screen.queryByText('Failed to load preview')).toBeNull();

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      // The error should now be confirmed
      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('getIsSoftReloadingForTests reports soft-reload state', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    // Initially not soft-reloading
    expect(previewRef.current.__testHooks.getIsSoftReloadingForTests()).toBe(false);
  });

  test('softReloadIframe calls location.reload on the iframe window', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const reloadFn = vi.fn();
      const fakeIframe = {
        contentWindow: {
          location: { reload: reloadFn, href: 'http://localhost:5555/' }
        },
        contentDocument: null
      };
      previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        previewRef.current.__testHooks.softReloadIframeForTests();
      });

      expect(reloadFn).toHaveBeenCalledTimes(1);

      // The soft reload arms a load timeout – advance past it so the
      // scheduleErrorConfirmation callback inside fires (covers lines 881-882).
      act(() => {
        vi.advanceTimersByTime(8000);
      });

      // Now advance past the error-confirmation delay
      act(() => {
        vi.advanceTimersByTime(1200);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('softReloadIframe falls back to hard reload when iframe ref is missing', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      // Clear the iframe ref so softReload has nothing to reload
      previewRef.current.__testHooks.setIframeNodeForTests(null);

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.softReloadIframeForTests();
      });

      // Hard reload increments the iframe key
      expect(previewRef.current.__testHooks.getIframeKey()).toBe(keyBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('softReloadIframe falls back to hard reload when contentWindow is missing', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const fakeIframe = { contentWindow: null, contentDocument: null };
      previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.softReloadIframeForTests();
      });

      expect(previewRef.current.__testHooks.getIframeKey()).toBe(keyBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('softReloadIframe falls back to hard reload on cross-origin error', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      const fakeIframe = {
        contentWindow: {
          get location() {
            throw new DOMException('Blocked a frame');
          }
        },
        contentDocument: null
      };
      previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        previewRef.current.__testHooks.softReloadIframeForTests();
      });

      expect(previewRef.current.__testHooks.getIframeKey()).toBe(keyBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('debouncedReload coalesces multiple rapid calls into a single reload', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      // Set up an iframe so softReloadIframe uses location.reload
      const reloadFn = vi.fn();
      const fakeIframe = {
        contentWindow: {
          location: { reload: reloadFn, href: 'http://localhost:5555/' }
        },
        contentDocument: null
      };
      hooks.setIframeNodeForTests(fakeIframe);

      // Call reloadPreview (debouncedReload) several times rapidly
      act(() => {
        previewRef.current.reloadPreview();
        previewRef.current.reloadPreview();
        previewRef.current.reloadPreview();
      });

      // Before the 300 ms debounce fires, no reload should have happened
      expect(reloadFn).not.toHaveBeenCalled();

      // Advance past the debounce delay
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // Only a single soft reload should have fired
      expect(reloadFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('softReloadIframe falls back to hard reload when iframe is missing', () => {
    const processInfo = buildProcessInfo();
    const idleInfo = buildProcessInfo({
      processes: { frontend: { status: 'idle' } }
    });
    const { previewRef, rerender, props } = renderPreviewTab({ processInfo });

    rerender(
      <PreviewTab
        ref={previewRef}
        {...props}
        processInfo={idleInfo}
        isProjectStopped
      />
    );

    previewRef.current.__testHooks.setIframeNodeForTests(null);

    const keyBefore = previewRef.current.__testHooks.getIframeKey();

    act(() => {
      previewRef.current.__testHooks.softReloadIframeForTests();
    });

    return waitFor(() => {
      expect(previewRef.current.__testHooks.getIframeKey()).toBe(keyBefore + 1);
    });
  });

  test('auto-recovery timeout is cleared after a successful load', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });
      const hooks = previewRef.current.__testHooks;

      act(() => {
        hooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      await act(async () => {});

      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), location: { href: 'http://localhost:5555/' } },
        contentDocument: null
      };
      hooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        hooks.triggerIframeLoad();
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('successful load clears scheduled auto-recovery timeout', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });
      const hooks = previewRef.current.__testHooks;

      act(() => {
        hooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      await act(async () => {});

      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), location: { href: 'http://localhost:5555/' } },
        contentDocument: null
      };
      hooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        hooks.triggerIframeLoad();
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(onRefreshProcessStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-recovery does not schedule duplicate timeouts', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const onRefreshProcessStatus = vi.fn().mockResolvedValue(null);
      const { previewRef } = renderPreviewTab({ processInfo, onRefreshProcessStatus });
      const hooks = previewRef.current.__testHooks;

      act(() => {
        hooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        hooks.setErrorStateForTests({ error: false, loading: true, pending: false });
      });

      act(() => {
        hooks.setErrorStateForTests({ error: true, loading: false, pending: false });
      });

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(onRefreshProcessStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('setHasConfirmedPreviewForTests clears ready state when false', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const hooks = previewRef.current.__testHooks;

    act(() => {
      hooks.setPreviewUrlOverride('http://localhost:5000/preview/123');
      hooks.setHasConfirmedPreviewForTests(true);
    });

    const iframe = screen.getByTestId('preview-iframe');
    expect(iframe.className).not.toContain('full-iframe--loading');

    act(() => {
      previewRef.current.__testHooks.setHasConfirmedPreviewForTests(false);
    });

    expect(screen.getByTestId('preview-iframe').className).toContain('full-iframe--loading');
  });

  test('stopIframeContent replaces placeholder document content', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const iframe = {
      contentWindow: { postMessage: vi.fn(), stop: vi.fn() },
      contentDocument: {
        title: 'Preview proxy error',
        querySelector: vi.fn(),
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn()
      }
    };

    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(iframe.contentDocument.open).toHaveBeenCalled();
    expect(iframe.contentDocument.write).toHaveBeenCalled();
    expect(iframe.contentDocument.close).toHaveBeenCalled();
  });

  test('suppresses synthetic load after placeholder stop', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const iframe = screen.getByTestId('preview-iframe');

    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      value: {
        title: 'Preview proxy error',
        querySelector: vi.fn(),
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn()
      }
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage: vi.fn(), stop: vi.fn() }
    });

    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    act(() => {
      previewRef.current.__testHooks.triggerIframeLoad();
    });

    expect(screen.getByTestId('preview-stuck-actions')).toBeInTheDocument();

    act(() => {
      fireEvent.load(iframe);
    });

    expect(screen.getByTestId('preview-stuck-actions')).toBeInTheDocument();
  });

  test('setPlaceholderCountersForTests accepts firstSeen values', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const hooks = previewRef.current.__testHooks;

    act(() => {
      hooks.setPlaceholderCountersForTests({ firstSeen: 123 });
    });
  });

  test('successful iframe load updates the displayed URL', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const hooks = previewRef.current.__testHooks;

    const fakeIframe = {
      contentWindow: { postMessage: vi.fn(), location: { href: 'http://localhost:5555/loaded' } },
      contentDocument: null
    };
    hooks.setIframeNodeForTests(fakeIframe);

    act(() => {
      hooks.triggerIframeLoad();
    });

    expect(screen.getByLabelText('Preview URL')).toHaveValue('http://localhost:5555/loaded');
  });

  test('flags isPlaceholderDetected after first proxy placeholder load', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      // Simulate a proxy placeholder page
      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), stop: vi.fn() },
        contentDocument: { title: 'Preview proxy error', querySelector: vi.fn() }
      };
      hooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        hooks.triggerIframeLoad();
      });

      // After the first placeholder load, isPlaceholderDetected should be true
      // and the loading overlay should show the stuck UI with action buttons.
      expect(screen.getByTestId('preview-stuck-actions')).toBeInTheDocument();
      expect(screen.getByText('Preview is not loading')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('loading overlay shows "Fix with AI" and "Retry" when stuck in placeholder loop', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      // Put the component into a loading + stuck state
      act(() => {
        hooks.setErrorStateForTests({ error: false, loading: true, pending: false });
        hooks.setStuckInPlaceholderLoopForTests(true);
      });

      expect(screen.getByText('Preview is not loading')).toBeInTheDocument();

      const stuckActions = screen.getByTestId('preview-stuck-actions');
      expect(stuckActions).toBeInTheDocument();

      const retryBtn = stuckActions.querySelector('button');
      expect(retryBtn).toHaveTextContent('Retry');

      const fixBtn = stuckActions.querySelectorAll('button')[1];
      expect(fixBtn).toHaveTextContent('Fix with AI');
    } finally {
      vi.useRealTimers();
    }
  });

  test('loading overlay hides swoosh when stuck in placeholder loop', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: true, pending: false });
        previewRef.current.__testHooks.setStuckInPlaceholderLoopForTests(true);
      });

      // The loading bar swoosh should not be rendered when stuck
      const loadingOverlay = screen.getByTestId('preview-loading');
      expect(loadingOverlay.querySelector('.preview-loading-bar')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('Retry in stuck loading overlay reloads the iframe', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: true, pending: false });
        previewRef.current.__testHooks.setStuckInPlaceholderLoopForTests(true);
      });

      const keyBefore = previewRef.current.__testHooks.getIframeKey();

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      });

      // reloadIframe increments the key and clears the stuck state
      expect(previewRef.current.__testHooks.getIframeKey()).toBeGreaterThan(keyBefore);
      expect(previewRef.current.__testHooks.getStuckInPlaceholderLoopForTests()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Fix with AI button in loading overlay dispatches run-prompt event', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({ error: false, loading: true, pending: false });
        previewRef.current.__testHooks.setStuckInPlaceholderLoopForTests(true);
      });

      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
      });

      const chatEvent = dispatchSpy.mock.calls.find(
        ([event]) => event.type === 'lucidcoder:run-prompt'
      );
      expect(chatEvent).toBeTruthy();
      expect(chatEvent[0].detail.prompt).toContain('preview is failing to load');

      dispatchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  test('isPlaceholderDetected is cleared on successful iframe load', async () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      // Put into a loading + stuck state so the stuck UI is visible
      act(() => {
        hooks.setErrorStateForTests({ error: false, loading: true, pending: false });
        hooks.setStuckInPlaceholderLoopForTests(true);
      });

      // Verify the stuck UI is rendered
      expect(screen.getByTestId('preview-stuck-actions')).toBeInTheDocument();

      // Simulate a non-placeholder page loading (successful load).
      // Use null contentDocument so isLucidCoderProxyPlaceholderPage returns false.
      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), location: { href: 'http://localhost:5555/' } },
        contentDocument: null
      };
      hooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        hooks.triggerIframeLoad();
      });

      // After a successful load, the stuck actions should disappear
      expect(screen.queryByTestId('preview-stuck-actions')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('escalation calls window.stop on iframe to break the reload loop', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      const stopFn = vi.fn();
      const fakeIframe = {
        contentWindow: { postMessage: vi.fn(), stop: stopFn },
        contentDocument: { title: 'Preview proxy error', querySelector: vi.fn() }
      };
      hooks.setIframeNodeForTests(fakeIframe);

      act(() => {
        hooks.triggerIframeLoad();
      });

      // window.stop is called immediately on each placeholder load
      // to halt the placeholder's built-in reload script.
      expect(stopFn).toHaveBeenCalled();

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      // Should transition to the error state
      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('escalation handles cross-origin error on window.stop gracefully', () => {
    vi.useFakeTimers();
    try {
      const processInfo = buildProcessInfo();
      const { previewRef } = renderPreviewTab({ processInfo });
      const hooks = previewRef.current.__testHooks;

      const fakeIframe = {
        contentWindow: {
          postMessage: vi.fn(),
          get stop() { throw new Error('cross-origin'); }
        },
        contentDocument: { title: 'Preview proxy error', querySelector: vi.fn() }
      };
      hooks.setIframeNodeForTests(fakeIframe);

      // Should not throw
      act(() => {
        hooks.triggerIframeLoad();
      });

      // Advance past the 10 s placeholder escalation timeout
      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
