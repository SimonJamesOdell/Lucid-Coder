import { useEffect } from 'react';

export function useSetupJobsPolling({ setupState, setSetupState, showMain }) {
  useEffect(() => {
    if (!setupState.isWaiting || !setupState.projectId) {
      return;
    }

    let isCancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${setupState.projectId}/jobs`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || 'Failed to load setup jobs');
        }
        if (isCancelled) {
          return;
        }
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const finalStates = new Set(['succeeded', 'failed', 'cancelled']);
        const isComplete = jobs.length > 0 && jobs.every((job) => finalStates.has(job?.status));
        setSetupState((prev) => ({
          ...prev,
          jobs,
          error: ''
        }));
        if (isComplete) {
          setSetupState((prev) => ({
            ...prev,
            isWaiting: false
          }));
          showMain();
        }
      } catch (error) {
        if (!isCancelled) {
          setSetupState((prev) => ({
            ...prev,
            error: error?.message || 'Failed to load setup jobs'
          }));
        }
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [setupState.isWaiting, setupState.projectId, setSetupState, showMain]);
}
