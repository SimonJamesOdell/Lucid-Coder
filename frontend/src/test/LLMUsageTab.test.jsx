import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LLMUsageTab, { __testHooks } from '../components/LLMUsageTab';

vi.mock('../components/RunsTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-runs-tab" />
}));

const makeResponse = (payload, ok = true, status = 200) => ({
  ok,
  status,
  json: () => Promise.resolve(payload)
});

describe('LLMUsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('shows a friendly error when metrics load fails (non-OK response)', async () => {
    global.fetch.mockResolvedValueOnce(makeResponse({ success: true }, false, 500));

    render(<LLMUsageTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load LLM metrics (500)');
  });

  test('shows API error when payload is not successful', async () => {
    global.fetch.mockResolvedValueOnce(
      makeResponse({ success: false, error: 'Nope (from API)' }, true, 200)
    );

    render(<LLMUsageTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope (from API)');
  });

  test('falls back to default messages when API omits error details', async () => {
    global.fetch.mockResolvedValueOnce(makeResponse({ success: false }, true, 200));

    render(<LLMUsageTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load LLM metrics');
  });

  test('handles successful payloads with missing metrics', async () => {
    global.fetch.mockResolvedValueOnce(makeResponse({ success: true }, true, 200));

    render(<LLMUsageTab />);

    await screen.findByTestId('llm-usage-tab-content');
    expect(screen.getByTestId('llm-usage-copy')).toBeDisabled();
  });

  test('falls back to a default fetch error message when error has no message', async () => {
    global.fetch.mockRejectedValueOnce({});

    render(<LLMUsageTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load LLM metrics');
  });

  test('ignores AbortError when a request is aborted', async () => {
    global.fetch.mockRejectedValueOnce({ name: 'AbortError' });

    render(<LLMUsageTab />);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  test('aborts in-flight requests on refresh and on unmount', async () => {
    const originalAbortController = global.AbortController;

    const instances = [];
    global.AbortController = class MockAbortController {
      constructor() {
        this.signal = {};
        this.abort = vi.fn();
        instances.push(this);
      }
    };

    global.fetch.mockResolvedValue(makeResponse({ success: true, metrics: { counters: {} } }));

    const { unmount } = render(<LLMUsageTab />);
    await screen.findByTestId('llm-usage-tab-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('llm-usage-refresh'));

    expect(instances.length).toBeGreaterThanOrEqual(2);
    expect(instances[0].abort).toHaveBeenCalledTimes(1);

    unmount();
    expect(instances[1].abort).toHaveBeenCalledTimes(1);

    global.AbortController = originalAbortController;
  });

  test('auto-refresh calls fetch on the interval; disabling it stops scheduling', async () => {
    global.fetch.mockResolvedValue(makeResponse({ success: true, metrics: { counters: {} } }));

    const intervalCallbacks = [];
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation((callback) => {
        intervalCallbacks.push(callback);
        return 123;
      });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => {});

    const user = userEvent.setup();
    const { unmount } = render(<LLMUsageTab />);

    await screen.findByTestId('llm-usage-tab-content');
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(intervalCallbacks.some((cb) => typeof cb === 'function')).toBe(true);

    const callsAfterInitialLoad = global.fetch.mock.calls.length;
    await act(async () => {
      for (const cb of intervalCallbacks) {
        cb();
      }
    });
    expect(global.fetch.mock.calls.length).toBeGreaterThan(callsAfterInitialLoad);

    await user.click(screen.getByRole('checkbox', { name: 'Auto-refresh' }));
    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    unmount();
  });

  test('copy JSON uses clipboard when available and shows the copied indicator', async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    if (window.navigator !== navigator) {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
    }
    if (globalThis.navigator && globalThis.navigator !== navigator) {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
    }

    expect(navigator.clipboard.writeText).toBe(writeText);

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } })
        );
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    expect(screen.getByTestId('llm-usage-copy')).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('llm-usage-copy'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('llm-usage-copied')).toBeInTheDocument();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  });

  test('copy JSON falls back to prompt if clipboard fails and ignores prompt errors', async () => {
    const originalClipboard = navigator.clipboard;
    const failingWriteText = vi.fn().mockRejectedValue(new Error('no clipboard'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: failingWriteText }
    });
    if (window.navigator !== navigator) {
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: failingWriteText }
      });
    }
    if (globalThis.navigator && globalThis.navigator !== navigator) {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: failingWriteText }
      });
    }

    window.prompt = global.prompt;
    const promptSpy = vi.spyOn(global, 'prompt').mockImplementationOnce(() => 'ok');

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } })
        );
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);
    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('llm-usage-copy'));
    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });

    promptSpy.mockImplementationOnce(() => {
      throw new Error('prompt blocked');
    });
    fireEvent.click(screen.getByTestId('llm-usage-copy'));

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    promptSpy.mockRestore();
  });

  test('copy JSON swallows prompt exceptions when clipboard is unavailable', async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    window.prompt = global.prompt;
    const promptSpy = vi.spyOn(global, 'prompt').mockImplementationOnce(() => {
      throw new Error('prompt blocked');
    });

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } })
        );
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('llm-usage-copy'));

    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('llm-usage-copied')).toBeNull();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    promptSpy.mockRestore();
  });

  test('copy JSON uses prompt when clipboard is unavailable and marks copied', async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    window.prompt = global.prompt;
    const promptSpy = vi.spyOn(global, 'prompt').mockImplementationOnce(() => 'ok');

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } })
        );
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('llm-usage-copy'));

    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('llm-usage-copied')).toBeInTheDocument();

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    promptSpy.mockRestore();
  });

  test('loads and renders summary counters', async () => {
    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({
            success: true,
            metrics: {
              startedAt: '2026-01-01T00:00:00.000Z',
              now: '2026-01-01T00:00:01.000Z',
              counters: {
                'kind:requested': 10,
                'kind:outbound': 4,
                'kind:dedup_inflight': 3,
                'kind:dedup_recent': 2,
                'phase_type:classification::classify': 6,
                'phase_type:code_edit::decision': 4
              }
            }
          })
        );
      }

      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    expect(await screen.findByTestId('llm-usage-requested')).toHaveTextContent('10');
    expect(screen.getByTestId('llm-usage-outbound')).toHaveTextContent('4');
    expect(screen.queryByTestId('llm-usage-dedup-inflight')).not.toBeInTheDocument();
    expect(screen.queryByTestId('llm-usage-dedup-recent')).not.toBeInTheDocument();

    expect(screen.getByTestId('llm-usage-phase-table')).toBeInTheDocument();
    expect(screen.getByText('classification')).toBeInTheDocument();
    expect(screen.getByText('code_edit')).toBeInTheDocument();
  });

  test('reset posts to reset endpoint and refreshes displayed metrics', async () => {
    const user = userEvent.setup();

    global.fetch.mockImplementation((url, options) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({
            success: true,
            metrics: {
              startedAt: '2026-01-01T00:00:00.000Z',
              now: '2026-01-01T00:00:01.000Z',
              counters: { 'kind:requested': 2, 'kind:outbound': 2 }
            }
          })
        );
      }

      if (url === '/api/llm/request-metrics/reset') {
        expect(options).toEqual(
          expect.objectContaining({
            method: 'POST'
          })
        );

        return Promise.resolve(
          makeResponse({
            success: true,
            metrics: {
              startedAt: '2026-01-01T00:00:02.000Z',
              now: '2026-01-01T00:00:02.000Z',
              counters: {
                'kind:requested': 0,
                'kind:outbound': 0,
                'kind:dedup_inflight': 0,
                'kind:dedup_recent': 0
              }
            }
          })
        );
      }

      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    expect(await screen.findByTestId('llm-usage-requested')).toHaveTextContent('2');

    await user.click(screen.getByTestId('llm-usage-reset'));

    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-requested')).toHaveTextContent('0');
      expect(screen.getByTestId('llm-usage-outbound')).toHaveTextContent('0');
    });
  });

  test('filters phase metrics by text', async () => {
    const user = userEvent.setup();

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({
            success: true,
            metrics: {
              startedAt: '2026-01-01T00:00:00.000Z',
              now: '2026-01-01T00:00:01.000Z',
              counters: {
                'phase_type:classification::classify': 6,
                'phase_type:code_edit::decision': 4
              }
            }
          })
        );
      }

      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    expect(await screen.findByTestId('llm-usage-phase-table')).toBeInTheDocument();
    expect(screen.getByText('classification')).toBeInTheDocument();

    await user.type(screen.getByTestId('llm-usage-filter'), 'code_edit');

    expect(screen.queryByText('classification')).toBeNull();
    expect(screen.getByText('code_edit')).toBeInTheDocument();
  });

  test('handles non-object counters and non-numeric counts defensively', async () => {
    global.fetch.mockResolvedValueOnce(
      makeResponse({
        success: true,
        metrics: {
          startedAt: null,
          now: null,
          counters: 'not-an-object'
        }
      })
    );

    render(<LLMUsageTab />);

    expect(await screen.findByText('Started: —')).toBeInTheDocument();
    expect(screen.getByText('Now: —')).toBeInTheDocument();
    expect(screen.getByTestId('llm-usage-phase-empty')).toBeInTheDocument();
  });

  test('renders unknown phase/requestType and coerces non-finite numbers to 0', async () => {
    global.fetch.mockResolvedValueOnce(
      makeResponse({
        success: true,
        metrics: {
          counters: {
            'kind:requested': 'not-a-number',
            'phase_type:::': 'NaN'
          }
        }
      })
    );

    render(<LLMUsageTab />);

    expect(await screen.findByTestId('llm-usage-requested')).toHaveTextContent('0');
    expect(screen.getAllByText('unknown').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('llm-usage-phase-table')).toBeInTheDocument();
  });

  test('shows reset errors when reset endpoint fails or returns unsuccessful payload', async () => {
    const user = userEvent.setup();

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 2 } } })
        );
      }

      if (url === '/api/llm/request-metrics/reset') {
        return Promise.resolve(makeResponse({ success: true }, false, 503));
      }

      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);
    expect(await screen.findByTestId('llm-usage-requested')).toHaveTextContent('2');

    await user.click(screen.getByTestId('llm-usage-reset'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to reset LLM metrics (503)');

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(
          makeResponse({ success: true, metrics: { counters: { 'kind:requested': 2 } } })
        );
      }
      if (url === '/api/llm/request-metrics/reset') {
        return Promise.resolve(makeResponse({ success: false }, true, 200));
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    await user.click(screen.getByTestId('llm-usage-reset'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to reset LLM metrics');
  });

  test('handles successful reset payloads with missing metrics and default reset error messages', async () => {
    const user = userEvent.setup();

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } }));
      }
      if (url === '/api/llm/request-metrics/reset') {
        return Promise.resolve(makeResponse({ success: true }, true, 200));
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    render(<LLMUsageTab />);

    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).not.toBeDisabled();
    });

    await user.click(screen.getByTestId('llm-usage-reset'));
    await waitFor(() => {
      expect(screen.getByTestId('llm-usage-copy')).toBeDisabled();
    });

    global.fetch.mockImplementation((url) => {
      if (url === '/api/llm/request-metrics') {
        return Promise.resolve(makeResponse({ success: true, metrics: { counters: { 'kind:requested': 1 } } }));
      }
      if (url === '/api/llm/request-metrics/reset') {
        return Promise.reject({});
      }
      return Promise.resolve(makeResponse({ success: true }));
    });

    await user.click(screen.getByTestId('llm-usage-reset'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to reset LLM metrics');
  });

  test('formatMetricsJson uses an empty object when metrics is null', () => {
    expect(__testHooks.formatMetricsJson(null)).toBe(JSON.stringify({}, null, 2));
  });

  test('switches between usage and runs views', async () => {
    global.fetch.mockResolvedValueOnce(
      makeResponse({ success: true, metrics: { counters: {} } })
    );

    const user = userEvent.setup();
    render(<LLMUsageTab project={{ id: 1 }} />);

    const usageTab = screen.getByTestId('llm-usage-tab-usage');
    const runsTab = screen.getByTestId('llm-usage-tab-runs');

    expect(usageTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('LLM Usage')).toBeInTheDocument();

    await user.click(runsTab);

    expect(runsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('mock-runs-tab')).toBeInTheDocument();
    expect(screen.queryByText('LLM Usage')).toBeNull();

    await user.click(usageTab);

    expect(usageTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('LLM Usage')).toBeInTheDocument();
  });
});
