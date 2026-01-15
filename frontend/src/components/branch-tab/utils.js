import { isDescriptiveCommitMessage } from './commitMessageUtils';

export const statusLabelMap = {
  protected: 'Protected',
  active: 'Active',
  'needs-fix': 'Needs Fix',
  'ready-for-merge': 'Ready to Merge',
  merged: 'Merged'
};

export const formatStatus = (status) => statusLabelMap[status] || 'Unknown';

export const isCssStylesheetPath = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.endsWith('.css');
};

const PASSING_TEST_STATUSES = new Set(['passed', 'skipped']);

export const isPassingTestStatus = (status) => PASSING_TEST_STATUSES.has(status);

export const safeTestId = (value = '') => value.replace(/[^a-z0-9]/gi, '-').toLowerCase();

export const computeStagedSignature = (files) => {
  if (!Array.isArray(files) || files.length === 0) {
    return '';
  }
  return files
    .map((file) => `${file?.path || 'unknown'}::${file?.timestamp || ''}`)
    .join('|');
};

export const canBranchMerge = (branch) => {
  if (!branch) {
    return false;
  }
  const stagedCount = Array.isArray(branch.stagedFiles) ? branch.stagedFiles.length : 0;
  const testsPassed = isPassingTestStatus(branch.lastTestStatus);
  const statusAllowsMerge = branch.status === 'ready-for-merge'
    || branch.status === 'active'
    || branch.status === 'needs-fix'
    || branch.status === 'ready';
  return statusAllowsMerge && stagedCount === 0 && testsPassed;
};

export const describeMergeBlocker = (branch) => {
  if (!branch) {
    return 'Tests must pass before merge';
  }
  const stagedCount = Array.isArray(branch.stagedFiles) ? branch.stagedFiles.length : 0;
  if (stagedCount > 0) {
    return 'Commit staged changes before merging';
  }
  if (branch.lastTestStatus === 'failed') {
    return branch.mergeBlockedReason || 'Resolve failing tests before merging';
  }
  return branch.mergeBlockedReason || 'Run tests before merging';
};

export const deriveDisplayStatus = (summary, working) => {
  const baseStatus = summary?.status || 'active';
  if (!working) {
    return baseStatus;
  }
  if (baseStatus === 'merged' || baseStatus === 'protected') {
    return baseStatus;
  }
  if (working.lastTestStatus === 'failed') {
    return 'needs-fix';
  }
  if (baseStatus === 'ready-for-merge') {
    const stagedCount = Array.isArray(working.stagedFiles) ? working.stagedFiles.length : 0;
    const testsPassed = isPassingTestStatus(working.lastTestStatus);
    if (stagedCount > 0 || !testsPassed) {
      return 'active';
    }
  }
  return baseStatus;
};

export const isMeaningfulCommitMessage = (text = '') => {
  if (!text) {
    return false;
  }
  return isDescriptiveCommitMessage(text);
};
