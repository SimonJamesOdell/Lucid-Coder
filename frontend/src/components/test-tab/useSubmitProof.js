import { useCallback, useEffect, useRef } from 'react';
import axios from 'axios';

const buildProofUrl = (projectId, branchName) => (
  `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/tests/proof`
);

export const useSubmitProof = ({
  projectId,
  activeBranchName,
  activeWorkingBranch,
  jobsByType,
  syncBranchOverview,
  testRunIntent,
  allTestsCompleted
}) => {
  const lastRecordedProofKeyRef = useRef(null);
  const normalizedJobsByType = jobsByType && typeof jobsByType === 'object' ? jobsByType : {};

  const collectProofJobs = useCallback(() => {
    const entries = Object.entries(normalizedJobsByType);
    return entries
      .filter(([type, job]) => type.endsWith(':test') && job)
      .map(([, job]) => job);
  }, [normalizedJobsByType]);

  const submitProofIfNeeded = useCallback(async ({ onBeforeSubmit } = {}) => {
    if (!projectId || !activeBranchName) {
      return false;
    }

    if (activeWorkingBranch?.status === 'ready-for-merge') {
      return false;
    }

    const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';

    const frontendJob = normalizedJobsByType['frontend:test'];
    const backendJob = normalizedJobsByType['backend:test'];
    const proofJobs = collectProofJobs();

    if (!proofJobs.length) {
      return false;
    }

    const hasIncompleteProofJob = proofJobs.some((job) => job?.status !== 'succeeded');
    if (hasIncompleteProofJob) {
      return false;
    }

    const jobIds = proofJobs.map((job) => job?.id).filter(Boolean);
    if (jobIds.length === 0) {
      return false;
    }

    const proofKey = jobIds.join('|');
    if (lastRecordedProofKeyRef.current === proofKey) {
      return false;
    }

    onBeforeSubmit?.();

    const proofUrl = buildProofUrl(projectId, activeBranchName);
    const response = await axios.post(proofUrl, {
      jobIds,
      frontendJobId: frontendJob?.id || null,
      backendJobId: backendJob?.id || null,
      source: lastRunSource
    });

    if (response?.data?.overview && typeof syncBranchOverview === 'function') {
      syncBranchOverview(projectId, response.data.overview);
    }

    lastRecordedProofKeyRef.current = proofKey;
    return true;
  }, [
    projectId,
    activeBranchName,
    activeWorkingBranch?.status,
    normalizedJobsByType,
    collectProofJobs,
    syncBranchOverview,
    testRunIntent
  ]);

  useEffect(() => {
    if (!allTestsCompleted) {
      lastRecordedProofKeyRef.current = null;
    }
  }, [allTestsCompleted, projectId, activeBranchName]);

  useEffect(() => {
    lastRecordedProofKeyRef.current = null;
  }, [projectId, activeBranchName]);

  return submitProofIfNeeded;
};
