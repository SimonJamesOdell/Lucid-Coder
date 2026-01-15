import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { initialJobState, JOB_FINAL_STATES, sortJobsByCreatedAt } from './helpers.js';

export const useJobs = ({
  currentProjectId,
  trackedFetch,
  isTestEnv,
  testHelpers
} = {}) => {
  const [jobState, setJobState] = useState(initialJobState);

  const jobPollsRef = useRef(new Map());
  const jobsSocketRef = useRef(null);
  const jobsSocketConnectedRef = useRef(false);
  const jobStateRef = useRef(jobState);

  jobStateRef.current = jobState;

  const clearJobPolls = useCallback(() => {
    jobPollsRef.current.forEach((controller) => {
      controller.cancelled = true;
      if (controller.timeoutId) {
        clearTimeout(controller.timeoutId);
      }
    });
    jobPollsRef.current.clear();
  }, []);

  useEffect(() => () => {
    clearJobPolls();
  }, [clearJobPolls]);

  const setJobsForProject = useCallback((projectId, jobs = []) => {
    if (!projectId) {
      return;
    }

    setJobState((prev) => ({
      ...prev,
      jobsByProject: {
        ...prev.jobsByProject,
        [String(projectId)]: {
          jobs: sortJobsByCreatedAt(jobs),
          lastFetchedAt: new Date().toISOString()
        }
      },
      isLoading: false,
      error: null
    }));
  }, []);

  const upsertJobForProject = useCallback((projectId, nextJob) => {
    if (!projectId || !nextJob) {
      return;
    }

    setJobState((prev) => {
      const projectKey = String(projectId);
      const projectBucket = prev.jobsByProject[projectKey] || { jobs: [], lastFetchedAt: null };
      const existingIndex = projectBucket.jobs.findIndex((entry) => entry.id === nextJob.id);
      const updatedJobs = [...projectBucket.jobs];

      if (existingIndex >= 0) {
        updatedJobs[existingIndex] = nextJob;
      } else {
        updatedJobs.unshift(nextJob);
      }

      return {
        ...prev,
        jobsByProject: {
          ...prev.jobsByProject,
          [projectKey]: {
            jobs: sortJobsByCreatedAt(updatedJobs),
            lastFetchedAt: new Date().toISOString()
          }
        }
      };
    });
  }, []);

  const appendJobLogForProject = useCallback((projectId, jobId, entry) => {
    if (!projectId || !jobId || !entry) {
      return;
    }

    setJobState((prev) => {
      const projectKey = String(projectId);
      const projectBucket = prev.jobsByProject[projectKey];
      if (!projectBucket || !Array.isArray(projectBucket.jobs) || projectBucket.jobs.length === 0) {
        return prev;
      }

      const existingIndex = projectBucket.jobs.findIndex((job) => job.id === jobId);
      if (existingIndex < 0) {
        return prev;
      }

      const nextJobs = [...projectBucket.jobs];
      const existingJob = nextJobs[existingIndex];
      const logs = Array.isArray(existingJob.logs) ? [...existingJob.logs, entry] : [entry];
      nextJobs[existingIndex] = {
        ...existingJob,
        logs
      };

      return {
        ...prev,
        jobsByProject: {
          ...prev.jobsByProject,
          [projectKey]: {
            jobs: sortJobsByCreatedAt(nextJobs),
            lastFetchedAt: new Date().toISOString()
          }
        }
      };
    });
  }, []);

  const setJobLoading = useCallback((isLoading) => {
    setJobState((prev) => ({
      ...prev,
      isLoading
    }));
  }, []);

  const setJobError = useCallback((message) => {
    setJobState((prev) => ({
      ...prev,
      error: message || null
    }));
  }, []);

  const stopPollingJob = useCallback((projectId, jobId) => {
    const key = `${projectId}:${jobId}`;
    const controller = jobPollsRef.current.get(key);
    if (!controller) {
      return;
    }
    controller.cancelled = true;
    if (controller.timeoutId) {
      clearTimeout(controller.timeoutId);
    }
    jobPollsRef.current.delete(key);
  }, []);

  const pollJobStatus = useCallback((projectId, jobId) => {
    if (!projectId || !jobId) {
      return;
    }

    if (jobsSocketConnectedRef.current) {
      return;
    }

    const key = `${projectId}:${jobId}`;
    if (jobPollsRef.current.has(key)) {
      return;
    }

    const controller = { cancelled: false, timeoutId: null };
    jobPollsRef.current.set(key, controller);

    const poll = async () => {
      if (controller.cancelled) {
        return;
      }

      try {
        const response = await trackedFetch(`/api/projects/${projectId}/jobs/${jobId}`);
        const data = await response.json();

        if (!response.ok || !data.success || !data.job) {
          stopPollingJob(projectId, jobId);
          return;
        }

        upsertJobForProject(projectId, data.job);

        if (JOB_FINAL_STATES.has(data.job.status)) {
          stopPollingJob(projectId, jobId);
          return;
        }

        controller.timeoutId = setTimeout(poll, 2000);
      } catch (error) {
        console.warn('Failed to poll job status', error);
        stopPollingJob(projectId, jobId);
      }
    };

    poll();
  }, [stopPollingJob, trackedFetch, upsertJobForProject]);

  const ensureJobPolling = useCallback((projectId, job) => {
    if (!projectId || !job || JOB_FINAL_STATES.has(job.status)) {
      return;
    }

    if (jobsSocketConnectedRef.current) {
      return;
    }

    pollJobStatus(projectId, job.id);
  }, [pollJobStatus]);

  const shouldUseJobsSocket = typeof window !== 'undefined'
    && (!isTestEnv || Boolean(globalThis.__lucidcoderEnableJobsSocketTests));

  useEffect(() => {
    if (!shouldUseJobsSocket) {
      return;
    }

    const safeDisconnect = (target) => {
      if (target && typeof target.disconnect === 'function') {
        target.disconnect();
      }
    };

    const projectId = currentProjectId;
    safeDisconnect(jobsSocketRef.current);
    jobsSocketRef.current = null;
    jobsSocketConnectedRef.current = false;

    if (!projectId) {
      return;
    }

    const socket = io({
      autoConnect: true,
      reconnection: true,
      transports: ['polling'],
      upgrade: false
    });

    jobsSocketRef.current = socket;

    const join = () => {
      socket.emit('jobs:join', { projectId }, (payload) => {
        if (!payload || payload.error || !payload.ok) {
          return;
        }
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        setJobsForProject(projectId, jobs);
        clearJobPolls();
      });
    };

    socket.on('connect', () => {
      jobsSocketConnectedRef.current = true;
      clearJobPolls();
      join();
    });

    socket.on('disconnect', () => {
      jobsSocketConnectedRef.current = false;

      const snapshot = jobStateRef.current.jobsByProject[String(projectId)]?.jobs || [];
      snapshot.forEach((job) => ensureJobPolling(projectId, job));
    });

    socket.on('connect_error', () => {
      jobsSocketConnectedRef.current = false;

      const snapshot = jobStateRef.current.jobsByProject[String(projectId)]?.jobs || [];
      snapshot.forEach((job) => ensureJobPolling(projectId, job));
    });

    socket.on('jobs:sync', (payload) => {
      if (!payload || payload.error || !payload.ok) {
        return;
      }
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      setJobsForProject(projectId, jobs);
      clearJobPolls();
    });

    socket.on('jobs:job', (payload) => {
      const job = payload?.job;
      if (!job || String(job.projectId) !== String(projectId)) {
        return;
      }
      upsertJobForProject(projectId, job);
    });

    socket.on('jobs:log', (payload) => {
      if (!payload || String(payload.projectId) !== String(projectId)) {
        return;
      }
      if (!payload.jobId || !payload.entry) {
        return;
      }
      appendJobLogForProject(projectId, payload.jobId, payload.entry);
    });

    if (isTestEnv && testHelpers) {
      testHelpers.jobsSocket = socket;
    }

    return () => {
      jobsSocketConnectedRef.current = false;

      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('jobs:sync');
      socket.off('jobs:job');
      socket.off('jobs:log');

      safeDisconnect(socket);

      if (jobsSocketRef.current === socket) {
        jobsSocketRef.current = null;
      }
    };
  }, [
    appendJobLogForProject,
    clearJobPolls,
    currentProjectId,
    ensureJobPolling,
    isTestEnv,
    shouldUseJobsSocket,
    setJobsForProject,
    testHelpers,
    upsertJobForProject
  ]);

  const refreshJobs = useCallback(async (projectId = currentProjectId, { silent = false } = {}) => {
    if (!projectId) {
      return [];
    }

    if (!silent) {
      setJobLoading(true);
      setJobError(null);
    }

    const finalize = () => {
      if (!silent) {
        setJobLoading(false);
      }
    };

    try {
      const response = await trackedFetch(`/api/projects/${projectId}/jobs`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data?.error || 'Failed to load jobs');
      }

      const jobs = data.jobs || [];
      setJobsForProject(projectId, jobs);
      jobs.forEach((job) => ensureJobPolling(projectId, job));

      finalize();
      return jobs;
    } catch (error) {
      setJobError(error.message);

      finalize();
      throw error;
    }
  }, [currentProjectId, ensureJobPolling, setJobsForProject, setJobError, setJobLoading, trackedFetch]);

  const startAutomationJob = useCallback(async (type, {
    projectId = currentProjectId,
    payload = null,
    branchName
  } = {}) => {
    if (!type) {
      throw new Error('Job type is required');
    }

    if (!projectId) {
      throw new Error('Select a project before running automation jobs');
    }

    setJobError(null);

    const requestBody = { type };
    const normalizedPayload = payload && typeof payload === 'object' ? { ...payload } : {};
    const normalizedBranchName = typeof branchName === 'string' ? branchName.trim() : '';
    if (normalizedBranchName) {
      normalizedPayload.branchName = normalizedBranchName;
    }
    if (Object.keys(normalizedPayload).length > 0) {
      requestBody.payload = normalizedPayload;
    }

    try {
      const response = await trackedFetch(`/api/projects/${projectId}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        const message = data?.error || 'Failed to start automation job';
        throw new Error(message);
      }

      if (data.skipped) {
        return {
          skipped: true,
          reason: data.reason || null,
          branch: data.branch || null,
          indicator: data.indicator || null
        };
      }

      if (!data.job) {
        const message = data?.error || 'Failed to start automation job';
        throw new Error(message);
      }

      upsertJobForProject(projectId, data.job);
      if (!JOB_FINAL_STATES.has(data.job.status) && !jobsSocketConnectedRef.current) {
        pollJobStatus(projectId, data.job.id);
      }
      return data.job;
    } catch (error) {
      const message = error?.message || 'Failed to start automation job';
      setJobError(message);
      throw error;
    }
  }, [currentProjectId, pollJobStatus, trackedFetch, upsertJobForProject, setJobError]);

  const cancelAutomationJob = useCallback(async (jobId, { projectId = currentProjectId } = {}) => {
    if (!jobId) {
      throw new Error('Job ID is required to cancel automation');
    }

    if (!projectId) {
      throw new Error('Select a project before cancelling automation jobs');
    }

    const response = await trackedFetch(`/api/projects/${projectId}/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (!response.ok || !data.success || !data.job) {
      const message = data?.error || 'Failed to cancel automation job';
      throw new Error(message);
    }

    upsertJobForProject(projectId, data.job);
    stopPollingJob(projectId, jobId);
    return data.job;
  }, [currentProjectId, stopPollingJob, trackedFetch, upsertJobForProject]);

  const getJobsForProject = useCallback((projectId = currentProjectId) => {
    if (!projectId) {
      return [];
    }
    return jobState.jobsByProject[String(projectId)]?.jobs || [];
  }, [currentProjectId, jobState.jobsByProject]);

  useEffect(() => {
    if (!currentProjectId) {
      return;
    }
    refreshJobs(currentProjectId, { silent: true }).catch(() => {
      // Errors are surfaced via jobState.error; suppress console noise here
    });
  }, [currentProjectId, refreshJobs]);

  const resetJobsState = useCallback(() => {
    clearJobPolls();
    setJobState({ ...initialJobState });
  }, [clearJobPolls]);

  if (isTestEnv && testHelpers) {
    testHelpers.clearJobPolls = clearJobPolls;
    testHelpers.jobPollsRef = jobPollsRef;
    testHelpers.setJobsForProject = setJobsForProject;
    testHelpers.appendJobLogForProject = appendJobLogForProject;
    testHelpers.upsertJobForProject = upsertJobForProject;
    testHelpers.setJobLoading = setJobLoading;
    testHelpers.setJobError = setJobError;
    testHelpers.stopPollingJob = stopPollingJob;
    testHelpers.pollJobStatus = pollJobStatus;
    testHelpers.ensureJobPolling = ensureJobPolling;
  }

  return {
    jobState,
    refreshJobs,
    startAutomationJob,
    cancelAutomationJob,
    getJobsForProject,
    resetJobsState,
    clearJobPolls,
    jobsSocketConnectedRef
  };
};
