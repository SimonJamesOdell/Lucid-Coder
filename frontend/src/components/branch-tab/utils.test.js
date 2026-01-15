import { describe, test, expect } from 'vitest';
import {
  describeMergeBlocker,
  deriveDisplayStatus,
  formatStatus,
  safeTestId,
  computeStagedSignature,
  canBranchMerge,
  isMeaningfulCommitMessage
} from './utils';

describe('branch tab utils', () => {
  test('describeMergeBlocker explains every blocker scenario', () => {
    expect(describeMergeBlocker(null)).toBe('Tests must pass before merge');

    const stagedBranch = { stagedFiles: [{ path: 'src/App.jsx' }] };
    expect(describeMergeBlocker(stagedBranch)).toBe('Commit staged changes before merging');

    const failedBranch = {
      stagedFiles: [],
      lastTestStatus: 'failed',
      mergeBlockedReason: 'Integration tests failed'
    };
    expect(describeMergeBlocker(failedBranch)).toBe('Integration tests failed');

    const waitingBranch = {
      stagedFiles: [],
      lastTestStatus: 'pending'
    };
    expect(describeMergeBlocker(waitingBranch)).toBe('Run tests before merging');
  });

  test('deriveDisplayStatus reflects live working state overrides', () => {
    const summary = { status: 'ready-for-merge' };
    const working = {
      stagedFiles: [{ path: 'ui.jsx' }],
      lastTestStatus: 'passed'
    };

    expect(deriveDisplayStatus(summary, null)).toBe('ready-for-merge');
    expect(deriveDisplayStatus({ status: 'protected' }, working)).toBe('protected');

    const failingWorking = { stagedFiles: [], lastTestStatus: 'failed' };
    expect(deriveDisplayStatus(summary, failingWorking)).toBe('needs-fix');

    expect(deriveDisplayStatus(summary, working)).toBe('active');

    const waitingWorking = { stagedFiles: [], lastTestStatus: 'pending' };
    expect(deriveDisplayStatus(summary, waitingWorking)).toBe('active');

    const readyWorking = { stagedFiles: [], lastTestStatus: 'passed' };
    expect(deriveDisplayStatus(summary, readyWorking)).toBe('ready-for-merge');
  });

  test('isMeaningfulCommitMessage defers to descriptive commit heuristics', () => {
    expect(isMeaningfulCommitMessage('')).toBe(false);
    expect(isMeaningfulCommitMessage('Fix auth redirect loop by awaiting login status')).toBe(true);
  });

  test('formatStatus maps labels and defaults to Unknown', () => {
    expect(formatStatus('protected')).toBe('Protected');
    expect(formatStatus('does-not-exist')).toBe('Unknown');
  });

  test('safeTestId normalizes arbitrary identifiers', () => {
    expect(safeTestId('Feature/Login')).toBe('feature-login');
    expect(safeTestId('')).toBe('');
  });

  test('computeStagedSignature builds deterministic hash of staged files', () => {
    expect(computeStagedSignature()).toBe('');
    const signature = computeStagedSignature([
      { path: 'src/App.jsx', timestamp: 170000 },
      { path: 'src/utils.js', timestamp: 170100 }
    ]);
    expect(signature).toBe('src/App.jsx::170000|src/utils.js::170100');

    const fallbackSignature = computeStagedSignature([{ path: null }]);
    expect(fallbackSignature).toBe('unknown::');
  });

  test('canBranchMerge enforces status, tests, and staged checks', () => {
    expect(canBranchMerge(null)).toBe(false);
    const readyBranch = {
      status: 'ready-for-merge',
      stagedFiles: [],
      lastTestStatus: 'passed'
    };
    expect(canBranchMerge(readyBranch)).toBe(true);

    const blockedBranch = {
      status: 'ready-for-merge',
      stagedFiles: [{ path: 'app.jsx' }],
      lastTestStatus: 'passed'
    };
    expect(canBranchMerge(blockedBranch)).toBe(false);

    const needsFixBranch = {
      status: 'needs-fix',
      stagedFiles: [],
      lastTestStatus: 'failed'
    };
    expect(canBranchMerge(needsFixBranch)).toBe(false);

    const readyFallbackBranch = {
      status: 'ready',
      stagedFiles: null,
      lastTestStatus: 'passed'
    };
    expect(canBranchMerge(readyFallbackBranch)).toBe(true);
  });
});

describe('merge blocker descriptions', () => {
  test('handles missing staged array and missing merge blocked reason', () => {
    const failingBranch = {
      stagedFiles: null,
      lastTestStatus: 'failed'
    };
    expect(describeMergeBlocker(failingBranch)).toBe('Resolve failing tests before merging');
  });
});

describe('display status fallbacks', () => {
  test('derives status when staged files are not an array', () => {
    const summary = { status: 'ready-for-merge' };
    const working = { stagedFiles: null, lastTestStatus: 'passed' };
    expect(deriveDisplayStatus(summary, working)).toBe('ready-for-merge');
  });
});
