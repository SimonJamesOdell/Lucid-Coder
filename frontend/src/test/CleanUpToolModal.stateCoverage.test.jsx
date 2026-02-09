import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockedUseState = null;
let mockedUseRef = null;

vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    useState: (...args) => (mockedUseState ? mockedUseState(actual.useState, ...args) : actual.useState(...args)),
    useRef: (...args) => (mockedUseRef ? mockedUseRef(actual.useRef, ...args) : actual.useRef(...args))
  };
});

vi.mock('../components/ToolModal', () => ({
  default: ({ children }) => <div>{children}</div>
}));

vi.mock('../utils/goalsApi', () => ({
  agentCleanupStream: vi.fn()
}));

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

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

import CleanUpToolModal from '../components/CleanUpToolModal.jsx';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';

describe('CleanUpToolModal state coverage', () => {
  beforeEach(() => {
    mockedUseState = null;
    mockedUseRef = null;
    useAppState.mockReturnValue({
      currentProject: { id: 123, name: 'Demo' },
      isLLMConfigured: true
    });
  });

  it('shows cancelling copy when cancelRequested is true in progress view', () => {
    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 12) {
        return ['progress', vi.fn()];
      }
      if (callIndex === 13) {
        return [true, vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.getByTestId('tool-cleanup-progress-text')).toHaveTextContent('Cancelling');
    expect(screen.getByTestId('tool-cleanup-cancel')).toHaveTextContent('Cancelling');
  });

  it('handles cancel for non-cleanup operations', async () => {
    const user = userEvent.setup();
    const setRunResult = vi.fn();
    const setView = vi.fn();
    const setIsBusy = vi.fn();
    const setCancelRequested = vi.fn();

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 4) {
        return [false, setIsBusy];
      }
      if (callIndex === 7) {
        return [null, setRunResult];
      }
      if (callIndex === 11) {
        return ['fix-tests', vi.fn()];
      }
      if (callIndex === 12) {
        return ['progress', setView];
      }
      if (callIndex === 13) {
        return [false, setCancelRequested];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-cancel'));

    expect(setIsBusy).toHaveBeenCalledWith(false);
    expect(setCancelRequested).toHaveBeenCalledWith(false);
    expect(setRunResult).toHaveBeenCalledWith({ status: 'cancelled', operation: 'fix-tests' });
    expect(setView).toHaveBeenCalledWith('result');
  });

  it('does not dispatch autofix when projectId is missing', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    useAppState.mockReturnValue({ currentProject: null, isLLMConfigured: true });

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 7) {
        return [{ status: 'refused', reason: 'baseline-failed' }, vi.fn()];
      }
      if (callIndex === 11) {
        return ['cleanup', vi.fn()];
      }
      if (callIndex === 12) {
        return ['result', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-fix-tests'));

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('shows the close button when operation is fix-tests', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 11) {
        return ['fix-tests', vi.fn()];
      }
      if (callIndex === 12) {
        return ['result', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={onClose} />);

    await user.click(screen.getByTestId('tool-cleanup-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns early when the progress log ref is missing', () => {
    let refCalls = 0;
    mockedUseRef = (originalUseRef, initial) => {
      refCalls += 1;
      if (refCalls === 3) {
        const ref = {};
        Object.defineProperty(ref, 'current', {
          get: () => null,
          set: () => {}
        });
        return ref;
      }
      return originalUseRef(initial);
    };

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 10) {
        return [true, vi.fn()];
      }
      if (callIndex === 12) {
        return ['progress', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    const log = screen.getByTestId('tool-cleanup-progress-log');
    fireEvent.scroll(log);

    const scrollButton = screen.getByTestId('tool-cleanup-scroll-latest');
    fireEvent.click(scrollButton);
  });

  it('ignores progress log scrolls when view is not progress', () => {
    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 12) {
        return ['result', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    const log = screen.getByTestId('tool-cleanup-progress-log');
    fireEvent.scroll(log);
  });

  it('shows the starting label when busy', () => {
    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      callIndex += 1;
      if (callIndex === 4) {
        return [true, vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    expect(screen.getByTestId('tool-cleanup-start')).toHaveTextContent('Starting');
  });

  it('aborts cleanup when cancelling a non-cleanup operation', async () => {
    const user = userEvent.setup();
    const abortSpy = vi.fn();

    let refCalls = 0;
    mockedUseRef = (originalUseRef, initial) => {
      if (refCalls >= 6) {
        refCalls = 0;
      }
      refCalls += 1;
      if (refCalls === 5) {
        return { current: { abort: abortSpy } };
      }
      return originalUseRef(initial);
    };

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      if (callIndex >= 13) {
        callIndex = 0;
      }
      callIndex += 1;
      if (callIndex === 11) {
        return ['fix-tests', vi.fn()];
      }
      if (callIndex === 12) {
        return ['progress', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-cancel'));

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('handles cleanup cancel when progressLines is not an array', async () => {
    const user = userEvent.setup();

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      if (callIndex >= 13) {
        callIndex = 0;
      }
      callIndex += 1;
      if (callIndex === 6) {
        return [[], (updater) => updater(null)];
      }
      if (callIndex === 11) {
        return ['cleanup', vi.fn()];
      }
      if (callIndex === 12) {
        return ['progress', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-cancel'));
  });

  it('handles delete branch updates when runResult is not an object', async () => {
    const user = userEvent.setup();
    axios.delete.mockResolvedValueOnce({ data: { success: true } });

    let callIndex = 0;
    mockedUseState = (originalUseState, initial) => {
      if (callIndex >= 13) {
        callIndex = 0;
      }
      callIndex += 1;
      if (callIndex === 7) {
        return [{ status: 'failed' }, (updater) => updater(null)];
      }
      if (callIndex === 8) {
        return ['feature/state-delete', vi.fn()];
      }
      if (callIndex === 11) {
        return ['cleanup', vi.fn()];
      }
      if (callIndex === 12) {
        return ['result', vi.fn()];
      }
      return originalUseState(initial);
    };

    render(<CleanUpToolModal isOpen={true} onClose={() => {}} />);

    await user.click(screen.getByTestId('tool-cleanup-delete-branch'));
  });
});
