import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import CleanUpToolModal from '../components/CleanUpToolModal.jsx';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal();
  const actualDefault = actual?.default || {};

  return {
    ...actual,
    default: {
      ...actualDefault,
      delete: vi.fn()
    }
  };
});

vi.mock('../utils/goalsApi', () => ({
  agentCleanupStream: vi.fn(),
}));

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

import { agentCleanupStream } from '../utils/goalsApi';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';

describe('CleanUpToolModal', () => {
  beforeEach(() => {
    agentCleanupStream.mockReset();
    axios.delete.mockReset();
    window.sessionStorage.clear();
    useAppState.mockReturnValue({
      currentProject: { id: 123, name: 'Demo' },
      isLLMConfigured: true
    });
  });

  it('starts a cleanup stream and switches to the progress view', async () => {
    const user = userEvent.setup();
    agentCleanupStream.mockImplementation(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Preparing…' });
      onDone?.({ status: 'complete', branchName: 'feature/cleanup-test', iterations: 1 });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(agentCleanupStream).toHaveBeenCalledTimes(1);
    const payload = agentCleanupStream.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({
        projectId: 123,
        prompt: expect.stringContaining('dead code')
      })
    );

    expect(screen.getByTestId('tool-cleanup-progress')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Preparing');
    expect(screen.getByTestId('tool-cleanup-keep-branch')).toBeInTheDocument();
  });

  it('disables start when no project is selected', () => {
    useAppState.mockReturnValue({ currentProject: null, isLLMConfigured: true });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.getByTestId('tool-cleanup-start')).toBeDisabled();
  });

  it('does not show the Project/LLM/Coverage info panel', () => {
    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.queryByTestId('tool-cleanup-meta')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Project$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^LLM$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Coverage gate$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/100% lines\/statements\/functions\/branches/i)).not.toBeInTheDocument();
  });

  it('does not show the cleanup instructions disclosure panel', () => {
    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.queryByText(/show cleanup instructions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Requirements:/i)).not.toBeInTheDocument();
  });

  it('does not prefix streamed test log output with stdout/stderr markers', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onEvent, onDone }) => {
      onEvent?.('tests-log', { stream: 'stdout', label: 'Vitest', message: 'stdout | hello\nworld' });
      onDone?.({ status: 'complete', branchName: 'feature/cleanup-test', iterations: 1 });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    const log = screen.getByTestId('tool-cleanup-progress-log');
    expect(log).toHaveTextContent('hello');
    expect(log).toHaveTextContent('world');
    expect(log).not.toHaveTextContent('stdout |');
    expect(log).not.toHaveTextContent('stderr |');
  });

  it('offers branch cleanup choices when cancel is clicked during progress', async () => {
    const user = userEvent.setup();

    let capturedSignal;
    agentCleanupStream.mockImplementation(({ signal, onEvent }) =>
      new Promise((resolve) => {
        capturedSignal = signal;
        onEvent?.('status', { text: 'Creating working branch feature/cleanup-999…' });
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener?.('abort', () => resolve());
      })
    );

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    expect(screen.getByTestId('tool-cleanup-progress')).toBeInTheDocument();

    await user.click(screen.getByTestId('tool-cleanup-cancel'));

    expect(screen.getByText('Cleanup cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-progress-text')).toHaveTextContent('Do you want to discard the working branch');

    expect(screen.getByTestId('tool-cleanup-delete-branch')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-delete-branch')).toHaveTextContent('Discard branch');
    expect(screen.getByTestId('tool-cleanup-keep-branch')).toBeInTheDocument();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('does not offer to keep the cleanup branch when baseline failed and the branch was deleted', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    agentCleanupStream.mockImplementation(async ({ onEvent, onDone }) => {
      onEvent?.('tests', { phase: 'baseline', run: 'failed' });
      onDone?.({
        status: 'refused',
        reason: 'baseline-failed',
        branchName: 'feature/cleanup-123',
        branchDeleted: true
      });
    });

    render(<CleanUpToolModal isOpen={true} onClose={onClose} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(screen.getByTestId('tool-cleanup-refused-banner')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-fix-tests')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-cleanup-keep-branch')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('tool-cleanup-fix-tests'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lucidcoder:autofix-tests',
        detail: expect.objectContaining({
          origin: 'user',
          prompt: expect.stringContaining('Fix the failing baseline tests/coverage')
        })
      })
    );
  });

  it('deletes the cleanup branch when delete branch is clicked after cancellation', async () => {
    const user = userEvent.setup();
    axios.delete.mockResolvedValue({ data: { success: true } });

    agentCleanupStream.mockImplementation(({ signal, onEvent }) =>
      new Promise((resolve) => {
        onEvent?.('status', { text: 'Creating working branch feature/cleanup-123…' });
        signal?.addEventListener?.('abort', () => resolve());
      })
    );

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-cancel'));

    await user.click(screen.getByTestId('tool-cleanup-delete-branch'));

    expect(axios.delete).toHaveBeenCalledWith(
      '/api/projects/123/branches/feature%2Fcleanup-123',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
      })
    );
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Deleted branch feature/cleanup-123');
  });

  it('closes when keep branch is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'failed', branchName: 'feature/cleanup-x', message: 'nope', canDeleteBranch: true });
    });

    render(<CleanUpToolModal isOpen={true} onClose={onClose} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    await user.click(screen.getByTestId('tool-cleanup-keep-branch'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the progress log pinned to bottom while cleanup output streams', async () => {
    const user = userEvent.setup();

    let capturedOnEvent;
    let resolveStream;

    agentCleanupStream.mockImplementation(({ onEvent }) => new Promise((resolve) => {
      capturedOnEvent = onEvent;
      resolveStream = resolve;
    }));

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    const log = screen.getByTestId('tool-cleanup-progress-log');
    let scrollHeight = 1000;

    Object.defineProperty(log, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true
    });
    Object.defineProperty(log, 'clientHeight', {
      value: 100,
      configurable: true
    });

    log.scrollTop = 900;

    capturedOnEvent?.('status', { text: 'Line 1' });
    await waitFor(() => expect(log.scrollTop).toBe(1000));

    scrollHeight = 1250;
    capturedOnEvent?.('status', { text: 'Line 2' });
    await waitFor(() => expect(log.scrollTop).toBe(1250));

    resolveStream?.();
  });

  it('pauses cleanup log auto-scroll when user scrolls up and resumes via scroll-to-latest button', async () => {
    const user = userEvent.setup();

    let capturedOnEvent;
    let resolveStream;

    agentCleanupStream.mockImplementation(({ onEvent }) => new Promise((resolve) => {
      capturedOnEvent = onEvent;
      resolveStream = resolve;
    }));

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    const log = screen.getByTestId('tool-cleanup-progress-log');
    let scrollHeight = 1000;

    Object.defineProperty(log, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true
    });
    Object.defineProperty(log, 'clientHeight', {
      value: 100,
      configurable: true
    });

    log.scrollTop = 900;
    capturedOnEvent?.('status', { text: 'Line 1' });
    await waitFor(() => expect(log.scrollTop).toBe(1000));

    log.scrollTop = 0;
    fireEvent.scroll(log);

    expect(await screen.findByTestId('tool-cleanup-scroll-latest')).toBeInTheDocument();

    scrollHeight = 1400;
    capturedOnEvent?.('status', { text: 'Line 2' });
    await waitFor(() => expect(log.scrollTop).toBe(0));

    await user.click(screen.getByTestId('tool-cleanup-scroll-latest'));
    expect(log.scrollTop).toBe(1400);

    resolveStream?.();
  });

  it('logs edit/tests job events and handles onError callback', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onEvent, onError }) => {
      onEvent?.('status', { text: 'Creating working branch feature/cleanup-abc…' });
      onEvent?.('edit', { writes: 2, summary: 'Removed dead code' });
      onEvent?.('tests', {
        phase: 'baseline',
        run: 'failed',
        workspaceRuns: [
          { workspace: 'frontend', status: 'failed' },
          { workspace: 'backend', status: 'succeeded' }
        ]
      });
      onEvent?.('tests-job', { displayName: 'Frontend coverage', cwd: 'frontend' });
      onEvent?.('tests-job-done', { phase: 'frontend', status: 'failed' });
      onError?.('Baseline failed');
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    const log = screen.getByTestId('tool-cleanup-progress-log');
    expect(log).toHaveTextContent('Creating working branch feature/cleanup-abc');
    expect(log).toHaveTextContent('Edit: wrote 2 file(s) (Removed dead code)');
    expect(log).toHaveTextContent('Tests: baseline → failed');
    expect(log).toHaveTextContent('Failed workspaces: frontend');
    expect(log).toHaveTextContent('Starting: Frontend coverage (frontend)');
    expect(log).toHaveTextContent('Finished: frontend → failed');

    expect(screen.getByTestId('tool-cleanup-error')).toHaveTextContent('Baseline failed');
    expect(screen.getByTestId('tool-cleanup-delete-branch')).toBeEnabled();
  });

  it('queues resume payload while closed and runs it when opened', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'complete', branchName: 'feature/from-resume', iterations: 1 });
    });

    const view = render(<CleanUpToolModal isOpen={false} onClose={() => {}} />);

    // Wait for the resume listener effect to attach.
    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: {
          token: 'resume-1',
          includeFrontend: false,
          includeBackend: true,
          pruneRedundantTests: false
        }
      })
    );

    view.rerender(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await waitFor(() => expect(agentCleanupStream).toHaveBeenCalledTimes(1));
    expect(agentCleanupStream.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        includeFrontend: false,
        includeBackend: true,
        pruneRedundantTests: false
      })
    );

    // Ignore resume events without a token.
    window.dispatchEvent(new CustomEvent('lucidcoder:cleanup-tool:resume', { detail: { token: '   ' } }));

    await user.click(screen.getByTestId('tool-cleanup-keep-branch'));
  });

  it('ignores stale run errors after a newer run starts', async () => {
    const user = userEvent.setup();

    let rejectFirst;
    agentCleanupStream
      .mockImplementationOnce(
        () => new Promise((_, reject) => {
          rejectFirst = reject;
        })
      )
      .mockImplementationOnce(async ({ onDone }) => {
        onDone?.({ status: 'complete' });
      });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-stale', includeFrontend: true, includeBackend: true }
      })
    );

    await waitFor(() => expect(agentCleanupStream).toHaveBeenCalledTimes(2));

    rejectFirst?.(new Error('boom'));

    await waitFor(() => {
      expect(screen.queryByTestId('tool-cleanup-error')).not.toBeInTheDocument();
    });
  });

  it('ignores stale onDone callbacks from earlier runs', async () => {
    const user = userEvent.setup();

    let firstOnDone;
    let resolveSecond;

    agentCleanupStream
      .mockImplementationOnce(({ onDone }) => {
        firstOnDone = onDone;
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-ondone-stale', includeFrontend: true, includeBackend: true }
      })
    );

    await waitFor(() => expect(agentCleanupStream).toHaveBeenCalledTimes(2));

    firstOnDone?.({ status: 'complete' });

    expect(screen.getByTestId('tool-cleanup-progress-text')).toHaveTextContent('Live output');

    resolveSecond?.();
  });

  it('ignores stale onError callbacks from earlier runs', async () => {
    const user = userEvent.setup();

    let firstOnError;
    let resolveSecond;

    agentCleanupStream
      .mockImplementationOnce(({ onError }) => {
        firstOnError = onError;
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-onerror-stale', includeFrontend: true, includeBackend: true }
      })
    );

    await waitFor(() => expect(agentCleanupStream).toHaveBeenCalledTimes(2));

    firstOnError?.('Boom');

    expect(screen.queryByTestId('tool-cleanup-error')).not.toBeInTheDocument();

    resolveSecond?.();
  });

  it('does not attach resume listeners when window event APIs are missing', async () => {
    const originalAdd = window.addEventListener;
    const originalRemove = window.removeEventListener;

    try {
      window.addEventListener = undefined;
      window.removeEventListener = undefined;

      render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:cleanup-tool:resume', {
          detail: { token: 'resume-missing-listener' }
        })
      );

      expect(agentCleanupStream).not.toHaveBeenCalled();
    } finally {
      window.addEventListener = originalAdd;
      window.removeEventListener = originalRemove;
    }
  });

  it('updates scope + prune options via checkboxes and uses them in the cleanup prompt', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ prompt, includeFrontend, includeBackend, pruneRedundantTests, onDone }) => {
      expect(includeFrontend).toBe(true);
      expect(includeBackend).toBe(false);
      expect(pruneRedundantTests).toBe(false);

      expect(prompt).toContain('Clean up this project’s frontend');
      expect(prompt).toContain('Keep existing tests unless they become invalid due to code removal.');

      onDone?.({ status: 'complete' });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    // Uncheck Backend
    const scopeControls = screen.getByTestId('tool-cleanup-controls');
    const [frontendCheckbox, backendCheckbox, pruneCheckbox] = scopeControls.querySelectorAll('input[type="checkbox"]');
    expect(frontendCheckbox).toBeTruthy();
    expect(backendCheckbox).toBeTruthy();
    expect(pruneCheckbox).toBeTruthy();

    await user.click(backendCheckbox);
    await user.click(pruneCheckbox);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    expect(agentCleanupStream).toHaveBeenCalledTimes(1);

    // With no branch name available, keep button should use the generic label.
    expect(await screen.findByTestId('tool-cleanup-keep-branch')).toHaveTextContent('Keep branch');
  });

  it('shows the correct start hint when scope is empty and includes "codebase" in the prompt header', async () => {
    const user = userEvent.setup();

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    const scopeControls = screen.getByTestId('tool-cleanup-controls');
    const [frontendCheckbox, backendCheckbox] = scopeControls.querySelectorAll('input[type="checkbox"]');

    await user.click(frontendCheckbox);
    await user.click(backendCheckbox);

    expect(screen.getByTestId('tool-cleanup-start')).toBeDisabled();
    expect(screen.getByTestId('tool-cleanup-hint')).toHaveTextContent('Select at least one scope');

    // Even without starting, the intro text should reflect the prune state.
    expect(screen.getByText(/Updates\/removes tests/i)).toBeInTheDocument();
  });

  it('shows the LLM warning and hint when LLM is not configured', () => {
    useAppState.mockReturnValue({
      currentProject: { id: 123, name: 'Demo' },
      isLLMConfigured: false
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.getByTestId('tool-cleanup-warning')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-hint')).toHaveTextContent('Configure an LLM provider');
    expect(screen.getByTestId('tool-cleanup-start')).toBeDisabled();
  });

  it('shows an inline error if a resume event tries to start with no scopes selected', async () => {
    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-noscope', includeFrontend: false, includeBackend: false }
      })
    );

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Select at least one scope');
  });

  it('shows an inline error when a resume event starts without a project', async () => {
    useAppState.mockReturnValue({ currentProject: null, isLLMConfigured: true });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-no-project', includeFrontend: true, includeBackend: true }
      })
    );

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Select a project');
  });

  it('shows an inline error when a resume event starts without an LLM configured', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 123, name: 'Demo' }, isLLMConfigured: false });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-no-llm', includeFrontend: true, includeBackend: true }
      })
    );

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Configure an LLM provider');
  });

  it('ignores stale onEvent callbacks from earlier runs', async () => {
    const user = userEvent.setup();

    let firstOnEvent;
    let resolveSecond;

    agentCleanupStream
      .mockImplementationOnce(({ onEvent }) => {
        firstOnEvent = onEvent;
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    window.dispatchEvent(
      new CustomEvent('lucidcoder:cleanup-tool:resume', {
        detail: { token: 'resume-stale-event', includeFrontend: true, includeBackend: true }
      })
    );

    await waitFor(() => expect(agentCleanupStream).toHaveBeenCalledTimes(2));

    firstOnEvent?.('status', { text: 'Stale update' });

    expect(screen.getByTestId('tool-cleanup-progress-log')).not.toHaveTextContent('Stale update');

    resolveSecond?.();
  });

  it('ignores empty status and tests-log messages', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onEvent }) => {
      onEvent?.('status', { text: '   ' });
      onEvent?.('tests-log', { message: '   ' });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Waiting for cleanup updates');
  });

  it('handles cleanup stream events with missing fields', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: { value: 'branch' } });
      onEvent?.('status', {});
      onEvent?.('status', { text: null });
      onEvent?.('edit', {});
      onEvent?.('tests', {});
      onEvent?.('tests', {
        run: 'failed',
        workspaceRuns: [
          { status: 'failed', workspace: 'frontend' },
          { status: 'failed', displayName: 'Backend' },
          { status: 'failed' }
        ]
      });
      onEvent?.('tests-job', {});
      onEvent?.('tests-job', { displayName: 'Frontend tests', cwd: 'frontend' });
      onEvent?.('tests-job-done', {});
      onEvent?.('tests-log', { message: 42 });
      onDone?.('done');
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    const log = screen.getByTestId('tool-cleanup-progress-log');
    expect(log).toHaveTextContent('Edit: wrote 0 file(s)');
    expect(log).toHaveTextContent('Tests: run → unknown');
    expect(log).toHaveTextContent('Failed workspaces: frontend, Backend, unknown');
    expect(log).toHaveTextContent('Starting: tests job');
    expect(log).toHaveTextContent('Finished: tests → done');
  });

  it('logs deleted branch without a name when baseline cleanup deletes the branch', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'refused', reason: 'baseline-failed', branchDeleted: true });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Deleted branch');
  });

  it('uses default error messages when cleanup fails without details', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementationOnce(async ({ onDone }) => {
      onDone?.({ status: 'failed' });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Cleanup failed');
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Error: Cleanup failed');
  });

  it('uses default error messages when onError provides no message', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementationOnce(async ({ onError }) => {
      onError?.();
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Cleanup failed');
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Error: Cleanup failed');
  });

  it('uses the fallback error message when cleanup start throws without a message', async () => {
    const user = userEvent.setup();

    agentCleanupStream.mockImplementationOnce(async () => {
      throw {};
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Failed to start Clean Up.');
  });

  it('ignores resume events with invalid detail payloads', async () => {
    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await new Promise((r) => setTimeout(r, 0));

    window.dispatchEvent(new CustomEvent('lucidcoder:cleanup-tool:resume', { detail: 'nope' }));
    window.dispatchEvent(new CustomEvent('lucidcoder:cleanup-tool:resume', { detail: { token: 123 } }));

    expect(agentCleanupStream).not.toHaveBeenCalled();
  });

  it('builds autofix childPrompts when frontend scope is disabled', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'refused', reason: 'baseline-failed', branchName: 'feature/cleanup-789', branchDeleted: false });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    const scopeControls = screen.getByTestId('tool-cleanup-controls');
    const [frontendCheckbox] = scopeControls.querySelectorAll('input[type="checkbox"]');
    await user.click(frontendCheckbox);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-fix-tests'));

    const autofixEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event?.type === 'lucidcoder:autofix-tests');

    expect(autofixEvent?.detail?.childPrompts).toEqual([
      'Fix failing backend tests/coverage to reach 100% gates.'
    ]);
  });

  it('uses delete error messages when the response body is missing', async () => {
    const user = userEvent.setup();
    axios.delete.mockRejectedValueOnce(new Error('Denied'));

    agentCleanupStream.mockImplementationOnce(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Creating working branch feature/delete-msg…' });
      onDone?.({ status: 'failed', message: 'nope' });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-delete-branch'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Denied');
  });

  it('falls back to the default delete error message when no details are present', async () => {
    const user = userEvent.setup();
    axios.delete.mockRejectedValueOnce({});

    agentCleanupStream.mockImplementationOnce(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Creating working branch feature/delete-default…' });
      onDone?.({ status: 'failed', message: 'nope' });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-delete-branch'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Failed to delete branch');
  });

  it('covers more completion variants: cancelled, refused without branch deletion, and thrown errors', async () => {
    const user = userEvent.setup();

    // 1) cancelled
    agentCleanupStream.mockImplementationOnce(async ({ onDone }) => {
      onDone?.({ status: 'cancelled' });
    });

    const view = render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));
    expect(await screen.findByText('Cleanup cancelled')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Cancelled.');

    // 2) refused baseline-failed but branch was not deleted
    agentCleanupStream.mockImplementationOnce(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Creating working branch feature/refused-1…' });
      onDone?.({ status: 'refused', reason: 'baseline-failed', branchDeleted: false });
    });

    view.rerender(<CleanUpToolModal isOpen={false} onClose={() => {}} />);
    view.rerender(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(screen.getByTestId('tool-cleanup-refused-banner')).toBeInTheDocument();
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Cleanup refused to start.');
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Baseline tests/coverage failed.');

    // 3) thrown AbortError should be ignored
    agentCleanupStream.mockImplementationOnce(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    view.rerender(<CleanUpToolModal isOpen={false} onClose={() => {}} />);
    view.rerender(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(screen.queryByTestId('tool-cleanup-error')).not.toBeInTheDocument();

    // 4) other thrown errors should surface
    agentCleanupStream.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    view.rerender(<CleanUpToolModal isOpen={false} onClose={() => {}} />);
    view.rerender(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('boom');
  });

  it('handles delete-branch edge cases: main branch no-op, inflight label, and delete error handling', async () => {
    const user = userEvent.setup();

    const view = render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    // main branch should early-return (no API call)
    agentCleanupStream.mockImplementationOnce(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Creating working branch main…' });
      onDone?.({ status: 'failed', message: 'nope' });
    });
    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-delete-branch'));
    expect(axios.delete).not.toHaveBeenCalled();

    // delete with inflight UI + error
    let rejectDelete;
    axios.delete.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectDelete = reject;
      })
    );

    agentCleanupStream.mockImplementationOnce(async ({ onEvent, onDone }) => {
      onEvent?.('status', { text: 'Creating working branch feature/delete-err…' });
      onDone?.({ status: 'failed', message: 'still nope' });
    });

    // Close/reopen to reset state.
    view.rerender(<CleanUpToolModal isOpen={false} onClose={() => {}} />);
    view.rerender(<CleanUpToolModal isOpen={true} onClose={() => {}} />);
    await user.click(screen.getByTestId('tool-cleanup-start'));

    const deleteButton = await screen.findByTestId('tool-cleanup-delete-branch');
    await user.click(deleteButton);
    expect(deleteButton).toHaveTextContent('Deleting…');
    expect(deleteButton).toBeDisabled();

    rejectDelete?.({ response: { data: { error: 'Denied' } } });

    expect(await screen.findByTestId('tool-cleanup-error')).toHaveTextContent('Denied');
    expect(screen.getByTestId('tool-cleanup-progress-log')).toHaveTextContent('Error: Denied');
  });

  it('builds the autofix event childPrompts based on selected scopes', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    // Disable backend in the UI, then hit a baseline refusal.
    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'refused', reason: 'baseline-failed', branchName: 'feature/cleanup-123', branchDeleted: false });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    const scopeControls = screen.getByTestId('tool-cleanup-controls');
    const [, backendCheckbox] = scopeControls.querySelectorAll('input[type="checkbox"]');
    await user.click(backendCheckbox);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-fix-tests'));

    const autofixEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event?.type === 'lucidcoder:autofix-tests');

    expect(autofixEvent?.detail?.childPrompts).toEqual([
      'Fix failing frontend tests/coverage to reach 100% gates.'
    ]);
  });

  it('builds the autofix event childPrompts when both scopes are enabled', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    agentCleanupStream.mockImplementation(async ({ onDone }) => {
      onDone?.({ status: 'refused', reason: 'baseline-failed', branchName: 'feature/cleanup-456', branchDeleted: false });
    });

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-start'));
    await user.click(screen.getByTestId('tool-cleanup-fix-tests'));

    const autofixEvent = dispatchSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event?.type === 'lucidcoder:autofix-tests');

    expect(autofixEvent?.detail?.childPrompts).toEqual([
      'Fix failing frontend tests/coverage to reach 100% gates.',
      'Fix failing backend tests/coverage to reach 100% gates.'
    ]);
  });
});
