import { describe, expect, test, vi } from 'vitest';

vi.mock('../services/codeEditAgent.js', () => ({
  applyCodeChange: vi.fn(async () => ({ steps: [], summary: 'noop' }))
}));

vi.mock('../services/branchWorkflow.js', () => ({
  checkoutBranch: vi.fn(async () => {}),
  commitBranchChanges: vi.fn(async () => {}),
  createWorkingBranch: vi.fn(async () => {}),
  deleteBranchByName: vi.fn(async () => ({ deletedBranch: 'feature/mock' })),
  getBranchHeadSha: vi.fn(async () => 'sha-1'),
  resetBranchToCommit: vi.fn(async () => {}),
  runTestsForBranch: vi.fn(async () => ({ status: 'passed', summary: 'ok' }))
}));

describe('foregroundCleanupRunner deps fallbacks', () => {
  test('uses imported deps when deps are not provided', async () => {
    const { runForegroundCleanup } = await import('../services/foregroundCleanupRunner.js');

    const result = await runForegroundCleanup({
      projectId: 1,
      // Ensure the loop exits immediately without needing real edits.
      options: { maxIterations: 1 }
    });

    expect(result.stoppedBecause).toBe('no-op');
  });
});
