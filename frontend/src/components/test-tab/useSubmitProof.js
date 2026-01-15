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

  const submitProofIfNeeded = useCallback(async ({ onBeforeSubmit } = {}) => {
    if (!projectId || !activeBranchName) {
      return false;
    }

    if (activeWorkingBranch?.status === 'ready-for-merge') {
      return false;
    }

    const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';
    if (lastRunSource !== 'automation') {
      return false;
    }

    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];
    if (frontendJob?.status !== 'succeeded' || backendJob?.status !== 'succeeded') {
      return false;
    }

    const jobIds = [frontendJob?.id, backendJob?.id].filter(Boolean);
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

    if (response.data?.overview && typeof syncBranchOverview === 'function') {
      syncBranchOverview(projectId, response.data.overview);
    }

    lastRecordedProofKeyRef.current = proofKey;
    return true;
  }, [
    projectId,
    activeBranchName,
    activeWorkingBranch?.status,
    jobsByType,
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
