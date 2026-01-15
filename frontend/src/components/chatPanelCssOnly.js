import axios from 'axios';
import { isCssStylesheetPath } from './branch-tab/utils';

export async function resolveWorkingBranchSnapshot({ projectId, workingBranches, syncBranchOverview }) {
  if (!projectId) {
    return null;
  }

  const branchFromState = workingBranches?.[projectId];
  if (branchFromState?.name) {
    return branchFromState;
  }

  try {
    const response = await axios.get(`/api/projects/${projectId}/branches`);
    const overview = response?.data || null;
    if (overview && typeof syncBranchOverview === 'function') {
      syncBranchOverview(projectId, overview);
    }

    const workingBranchList = Array.isArray(overview?.workingBranches) ? overview.workingBranches : [];
    if (!workingBranchList.length) {
      return null;
    }

    const currentName = typeof overview?.current === 'string' ? overview.current.trim() : '';
    if (currentName && currentName !== 'main') {
      return workingBranchList.find((branch) => branch?.name === currentName) || workingBranchList[0] || null;
    }

    return workingBranchList[0] || null;
  } catch (error) {
    console.warn('Failed to refresh branch overview before css-only check', error);
    return null;
  }
}

export async function shouldSkipAutomationTests({ currentProject, workingBranches, syncBranchOverview }) {
  const projectId = currentProject?.id;
  if (!projectId) {
    return false;
  }

  const branchSnapshot = await resolveWorkingBranchSnapshot({ projectId, workingBranches, syncBranchOverview });
  if (!branchSnapshot?.name) {
    return false;
  }

  const stagedFiles = Array.isArray(branchSnapshot.stagedFiles) ? branchSnapshot.stagedFiles : [];
  if (!stagedFiles.length) {
    return false;
  }

  const isCssOnly = stagedFiles.every((file) => isCssStylesheetPath(file?.path));
  if (!isCssOnly) {
    return false;
  }

  try {
    const response = await axios.get(
      `/api/projects/${projectId}/branches/${encodeURIComponent(branchSnapshot.name)}/css-only`
    );
    return Boolean(response?.data?.isCssOnly);
  } catch (error) {
    console.warn('Failed to confirm css-only branch after automation run', error);
    return false;
  }
}
