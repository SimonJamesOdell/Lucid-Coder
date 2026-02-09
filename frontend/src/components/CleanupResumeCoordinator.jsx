/* c8 ignore file */
import React, { useEffect, useMemo, useRef } from 'react';
import { useAppState } from '../context/AppStateContext';
import { isJobFinal } from './test-tab/helpers.jsx';
import { consumeCleanupResumeRequest, peekCleanupResumeRequest } from '../utils/cleanupResume';

const parseIsoDate = (value) => {
  if (!value) {
    return NaN;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
};

const pickLatestJobByType = (jobs, type) => {
  const candidates = Array.isArray(jobs) ? jobs.filter((job) => job?.type === type && job?.createdAt) : [];
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
};

const computeHasBackend = ({ currentProject, projectProcesses }) => {
  const backendCapability = projectProcesses?.capabilities?.backend?.exists;
  if (backendCapability === false) {
    return false;
  }
  const projectBackend = currentProject?.backend;
  if (projectBackend === null) {
    return false;
  }
  if (typeof projectBackend?.exists === 'boolean') {
    return projectBackend.exists;
  }
  return true;
};

const CleanupResumeCoordinator = () => {
  const { currentProject, getJobsForProject, testRunIntent, projectProcesses, jobState } = useAppState();
  const projectId = currentProject?.id;
  const jobsByProject = jobState?.jobsByProject;

  const hasBackend = useMemo(
    () => computeHasBackend({ currentProject, projectProcesses }),
    [currentProject, projectProcesses]
  );

  const lastHandledTokenRef = useRef(null);

  useEffect(() => {
    if (!projectId || typeof window === 'undefined') {
      return;
    }

    const pending = peekCleanupResumeRequest();
    if (!pending?.token) {
      lastHandledTokenRef.current = null;
      return;
    }

    if (lastHandledTokenRef.current === pending.token) {
      return;
    }

    const requestedAtMs = parseIsoDate(pending.requestedAt);
    const intentUpdatedAtMs = parseIsoDate(testRunIntent?.updatedAt);

    // Require an automation-run test completion that occurred after the cleanup requested the fix.
    if (testRunIntent?.source !== 'automation') {
      return;
    }
    if (Number.isFinite(requestedAtMs) && Number.isFinite(intentUpdatedAtMs) && intentUpdatedAtMs < requestedAtMs) {
      return;
    }

    const jobs = getJobsForProject(projectId);
    const latestFrontend = pickLatestJobByType(jobs, 'frontend:test');
    const latestBackend = pickLatestJobByType(jobs, 'backend:test');

    const shouldCheckBackend = Boolean(pending.includeBackend && hasBackend);

    const frontendReady = latestFrontend && isJobFinal(latestFrontend) && latestFrontend.status === 'succeeded';
    const backendReady = !shouldCheckBackend
      ? true
      : Boolean(latestBackend && isJobFinal(latestBackend) && latestBackend.status === 'succeeded');

    if (!frontendReady || !backendReady) {
      return;
    }

    const frontendCreatedAtMs = parseIsoDate(latestFrontend?.createdAt);
    const backendCreatedAtMs = parseIsoDate(latestBackend?.createdAt);

    // Avoid triggering off historical successful jobs by ensuring the passing jobs were created after the request.
    if (Number.isFinite(requestedAtMs) && Number.isFinite(frontendCreatedAtMs) && frontendCreatedAtMs < requestedAtMs) {
      return;
    }
    if (shouldCheckBackend && Number.isFinite(requestedAtMs) && Number.isFinite(backendCreatedAtMs) && backendCreatedAtMs < requestedAtMs) {
      return;
    }

    lastHandledTokenRef.current = pending.token;
    const consumed = consumeCleanupResumeRequest();
    if (!consumed) {
      return;
    }

    window.dispatchEvent(new CustomEvent('lucidcoder:open-cleanup-tool', { detail: { source: 'automation' } }));
    window.dispatchEvent(new CustomEvent('lucidcoder:cleanup-tool:resume', { detail: consumed }));
  }, [getJobsForProject, hasBackend, jobsByProject, projectId, testRunIntent?.source, testRunIntent?.updatedAt]);

  return null;
};

export default CleanupResumeCoordinator;
