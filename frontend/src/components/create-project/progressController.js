export function createProgressController({
  axios,
  io,
  normalizeServerProgress,
  POLL_SUPPRESSION_WINDOW_MS,
  progressStreamRef,
  progressSocketRef,
  progressPollRef,
  progressPollTimeoutRef,
  pollSuppressedRef,
  pollSuppressionTimeoutRef,
  lastProgressUpdateAtRef,
  setProgress,
  setCreateError,
  setCreateLoading,
  setProcesses,
  setProgressKey
}) {
  const clearInitialPollTimeout = () => {
    if (progressPollTimeoutRef.current) {
      clearTimeout(progressPollTimeoutRef.current);
      progressPollTimeoutRef.current = null;
    }
  };

  const clearPollSuppression = () => {
    if (pollSuppressionTimeoutRef.current) {
      clearTimeout(pollSuppressionTimeoutRef.current);
      pollSuppressionTimeoutRef.current = null;
    }
    pollSuppressedRef.current = false;
  };

  const closeProgressStream = () => {
    if (progressStreamRef.current) {
      progressStreamRef.current.close();
      progressStreamRef.current = null;
    }

    if (progressSocketRef.current) {
      try {
        progressSocketRef.current.disconnect();
      } catch {
      }
      progressSocketRef.current = null;
    }

    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }

    clearInitialPollTimeout();
    clearPollSuppression();
    lastProgressUpdateAtRef.current = 0;
  };

  const suppressPollingAfterUpdate = () => {
    pollSuppressedRef.current = true;
    if (pollSuppressionTimeoutRef.current) {
      clearTimeout(pollSuppressionTimeoutRef.current);
    }
    pollSuppressionTimeoutRef.current = setTimeout(() => {
      pollSuppressedRef.current = false;
      pollSuppressionTimeoutRef.current = null;
    }, POLL_SUPPRESSION_WINDOW_MS);
  };

  const applyProgressPayload = (payload) => {
    const normalized = normalizeServerProgress(payload);
    const isFailure = normalized?.status === 'failed';
    lastProgressUpdateAtRef.current = Date.now();
    suppressPollingAfterUpdate();
    setProgress(normalized);
    if (isFailure && normalized?.error) {
      setCreateError(normalized.error);
      setCreateLoading(false);
      setProcesses(null);
      setProgressKey(null);
    }
    if (normalized?.status === 'completed' || normalized?.status === 'failed' || normalized?.status === 'awaiting-user') {
      closeProgressStream();
    }
  };

  const startProgressPolling = (key) => {
    if (!key) {
      return;
    }

    const pollOnce = async () => {
      try {
        const response = await axios.get(`/api/projects/progress/${encodeURIComponent(key)}`);
        if (response?.data?.success && response.data.progress) {
          applyProgressPayload(response.data.progress);
        }
      } catch {
      }
    };

    clearInitialPollTimeout();
    progressPollTimeoutRef.current = setTimeout(pollOnce, 250);

    progressPollRef.current = setInterval(() => {
      if (pollSuppressedRef.current) {
        return;
      }

      if (Date.now() - lastProgressUpdateAtRef.current < POLL_SUPPRESSION_WINDOW_MS) {
        return;
      }

      pollOnce();
    }, 1000);
  };

  const handleProgressEvent = (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyProgressPayload(payload);
    } catch {
    }
  };

  const handleProgressSocketPayload = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const candidate = Object.prototype.hasOwnProperty.call(payload, 'progress') ? payload.progress : payload;
    if (!candidate || typeof candidate !== 'object') {
      return;
    }

    const looksLikeProgress =
      Object.prototype.hasOwnProperty.call(candidate, 'steps')
      || Object.prototype.hasOwnProperty.call(candidate, 'completion')
      || Object.prototype.hasOwnProperty.call(candidate, 'status')
      || Object.prototype.hasOwnProperty.call(candidate, 'statusMessage')
      || Object.prototype.hasOwnProperty.call(candidate, 'error');

    if (looksLikeProgress) {
      applyProgressPayload(candidate);
    }
  };

  const startEventSourceProgressStream = (key) => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      return;
    }

    try {
      const stream = new EventSource(`/api/projects/progress/${encodeURIComponent(key)}/stream`);
      if (typeof stream.addEventListener === 'function') {
        stream.addEventListener('progress', handleProgressEvent);
      } else {
        stream.onmessage = handleProgressEvent;
      }
      stream.onerror = () => {
        stream.close();
      };
      progressStreamRef.current = stream;
    } catch {
    }
  };

  const startProgressStream = (key) => {
    closeProgressStream();
    startProgressPolling(key);

    try {
      const socket = io({
        autoConnect: true,
        reconnection: true,
        transports: ['polling'],
        upgrade: false
      });

      progressSocketRef.current = socket;
      let settled = false;

      const fallbackToEventSource = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (progressSocketRef.current === socket) {
          progressSocketRef.current = null;
        }
        try {
          socket.off('connect');
          socket.off('connect_error');
          socket.off('progress:sync');
          socket.off('progress:update');
          socket.disconnect();
        } catch {
        }

        startEventSourceProgressStream(key);
      };

      socket.on('connect', () => {
        socket.emit('progress:join', { progressKey: key }, (response) => {
          if (!response || response.error) {
            fallbackToEventSource();
            return;
          }
          settled = true;
          handleProgressSocketPayload(response);

          if (!response.progress) {
            setTimeout(() => {
              lastProgressUpdateAtRef.current = 0;
            }, 50);
          }
        });
      });

      socket.on('connect_error', () => {
        fallbackToEventSource();
      });

      socket.on('progress:sync', handleProgressSocketPayload);
      socket.on('progress:update', handleProgressSocketPayload);
    } catch {
      startEventSourceProgressStream(key);
    }
  };

  return {
    closeProgressStream,
    applyProgressPayload,
    startProgressStream
  };
}
