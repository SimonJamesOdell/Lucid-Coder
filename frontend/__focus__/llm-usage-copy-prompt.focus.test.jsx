import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LLMUsageTab from '../src/components/LLMUsageTab';

const makeResponse = (payload, ok = true, status = 200) => ({
  ok,
  status,
  json: () => Promise.resolve(payload)
});

describe('LLMUsageTab copy fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses prompt when clipboard is unavailable and marks copied', async () => {
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
});
