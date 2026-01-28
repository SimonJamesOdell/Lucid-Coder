import { describe, test, expect, vi, beforeEach } from 'vitest';
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

describe('PreviewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(screen.getByText(/Failed to start project/i)).toBeInTheDocument();
    });
  });

  test('exposes reload and restart handlers through ref', () => {
    const { previewRef } = renderPreviewTab();

    expect(previewRef.current).not.toBeNull();
    expect(typeof previewRef.current.reloadPreview).toBe('function');
    expect(typeof previewRef.current.restartProject).toBe('function');
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
      expect(screen.getByText(/server failure/i)).toBeInTheDocument();
    });
  });

  test('restart handler shows default error message when API rejects without text', async () => {
    const onRestartProject = vi.fn().mockRejectedValue({});
    const { previewRef } = renderPreviewTab({ onRestartProject });

    await act(async () => {
      await previewRef.current.restartProject();
    });

    await waitFor(() => {
      expect(screen.getByText(/Failed to restart project/i)).toBeInTheDocument();
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
    expect(screen.getByTestId('preview-iframe')).toHaveAttribute('src', 'about:blank');
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
    expect(urlInput).toHaveValue('');

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
    urlInput.select = selectSpy;

    fireEvent.focus(urlInput);

    expect(selectSpy).toHaveBeenCalled();
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
        return {
          location: {
            href: 'http://localhost:5555/dashboard'
          }
        };
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
    const iframeWindow = {};
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
    const iframeWindow = {};
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

  test('ignores preview messages when origin does not match expected backend origin', async () => {
    const processInfo = buildProcessInfo();
    const onPreviewNavigated = vi.fn();
    const { previewRef } = renderPreviewTab({ processInfo, onPreviewNavigated });

    const iframe = screen.getByTestId('preview-iframe');
    const iframeWindow = {};
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: iframeWindow
    });

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
    expect(onPreviewNavigated).not.toHaveBeenCalled();
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
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const fakeIframe = {
      contentDocument: {
        title: 'Preview proxy error',
        querySelector: vi.fn(() => ({ textContent: 'ECONNREFUSED' }))
      }
    };
    previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

    act(() => {
      for (let i = 0; i < 13; i += 1) {
        previewRef.current.__testHooks.triggerIframeLoad();
      }
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask AI to fix' })).toBeInTheDocument();
  });

  test('Ask AI button dispatches a prefill-chat event', () => {
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
      fireEvent.click(screen.getByRole('button', { name: 'Ask AI to fix' }));
    });

    expect(dispatchSpy).toHaveBeenCalled();
    const call = dispatchSpy.mock.calls.find((args) => args?.[0]?.type === 'lucidcoder:prefill-chat');
    expect(call).toEqual(expect.any(Array));
    expect(call[0]).toEqual(expect.objectContaining({ type: 'lucidcoder:prefill-chat' }));

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
      fireEvent.click(screen.getByRole('button', { name: 'Ask AI to fix' }));
    });

    const call = dispatchSpy.mock.calls.find((args) => args?.[0]?.type === 'lucidcoder:prefill-chat');
    expect(call).toEqual(expect.any(Array));
    expect(call[0]).toEqual(expect.objectContaining({ type: 'lucidcoder:prefill-chat' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI to fix' }));
      }).not.toThrow();
    } finally {
      window.dispatchEvent = originalDispatch;
    }
  });

  test('Ask AI swallows dispatch exceptions', () => {
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
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI to fix' }));
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
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });

    const fakeIframe = {
      contentDocument: {
        title: 'Preview proxy error',
        querySelector: () => {
          throw new Error('boom');
        }
      }
    };
    previewRef.current.__testHooks.setIframeNodeForTests(fakeIframe);

    act(() => {
      for (let i = 0; i < 13; i += 1) {
        previewRef.current.__testHooks.triggerIframeLoad();
      }
    });

    expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
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

  test('setErrorGracePeriod handles non-finite values', () => {
    const processInfo = buildProcessInfo();
    const { previewRef } = renderPreviewTab({ processInfo });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5000);

    act(() => {
      previewRef.current.__testHooks.setErrorGracePeriodForTests(Number.NaN);
    });

    expect(previewRef.current.__testHooks.getErrorGraceUntilForTests()).toBe(5000);

    nowSpy.mockRestore();
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
    const iframeWindow = {};
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

      act(() => {
        previewRef.current.__testHooks.setHasConfirmedPreviewForTests(true);
      });

      await act(async () => {
        previewRef.current.__testHooks.triggerIframeError();
      });

      await act(async () => {
        vi.advanceTimersByTime(1200);
      });

      act(() => {
        previewRef.current.__testHooks.setHasConfirmedPreviewForTests(true);
      });

      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();

      expect(screen.getByText(/didn.?t finish loading|blocks embedding|unreachable/i)).toBeInTheDocument();

      const expectedUrl = previewRef.current.getPreviewUrl();
      expect(
        screen.getByText((_, element) => element?.tagName === 'CODE' && element.textContent === expectedUrl)
      ).toBeInTheDocument();

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

      expect(screen.getByRole('button', { name: 'Try localhost' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try 127.0.0.1' })).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try localhost' }));
      });
      expect(previewRef.current.getPreviewUrl()).toContain('//localhost');

      act(() => {
        previewRef.current.__testHooks.setErrorStateForTests({
          error: true,
          loading: false,
          pending: false
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try 127.0.0.1' }));
      });
      expect(previewRef.current.getPreviewUrl()).toContain('//127.0.0.1');
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
    previewRef.current.__testHooks.setIframeNodeForTests(iframe);

    act(() => {
      // Trigger enough placeholder loads to escalate immediately.
      for (let i = 0; i < 13; i += 1) {
        previewRef.current.__testHooks.triggerIframeLoad();
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to load preview')).toBeInTheDocument();
    });

    expect(screen.getByText(/Preview proxy error/i)).toBeInTheDocument();
    expect(screen.getByText(/ECONNREFUSED 127\.0\.0\.1:5555/i)).toBeInTheDocument();
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
});
