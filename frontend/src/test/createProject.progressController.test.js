import { describe, expect, test, vi } from 'vitest';
import { createProgressController } from '../components/create-project/progressController';

const createRef = (value = null) => ({ current: value });

describe('create-project progressController', () => {
  test('startProgressStream skips polling setup when progress key is empty', () => {
    const axios = { get: vi.fn() };
    const refs = {
      progressStreamRef: createRef(null),
      progressSocketRef: createRef(null),
      progressPollRef: createRef(null),
      progressPollTimeoutRef: createRef(null),
      pollSuppressedRef: createRef(false),
      pollSuppressionTimeoutRef: createRef(null),
      lastProgressUpdateAtRef: createRef(0)
    };

    const controller = createProgressController({
      axios,
      io: () => { throw new Error('socket unavailable'); },
      normalizeServerProgress: (payload) => payload,
      POLL_SUPPRESSION_WINDOW_MS: 500,
      ...refs,
      setProgress: vi.fn(),
      setCreateError: vi.fn(),
      setCreateLoading: vi.fn(),
      setProcesses: vi.fn(),
      setProgressKey: vi.fn()
    });

    controller.startProgressStream('');

    expect(refs.progressPollTimeoutRef.current).toBeNull();
    expect(refs.progressPollRef.current).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
