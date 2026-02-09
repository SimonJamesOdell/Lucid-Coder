import { describe, expect, test, vi } from 'vitest';

import { runForegroundCleanup, __testing } from '../services/foregroundCleanupRunner.js';
import { jobEvents } from '../services/jobRunner.js';

const makeDeps = (overrides = {}) => {
  const deps = {
    edit: vi.fn(),
    runTests: vi.fn(),
    createBranch: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    getHeadSha: vi.fn(async () => 'sha-1'),
    resetTo: vi.fn(async () => {}),
    ...overrides
  };

  return deps;
};

describe('foregroundCleanupRunner', () => {
  test('__testing.buildIterationPrompt includes scope and pruning rules', () => {
    const prompt = __testing.buildIterationPrompt({
      basePrompt: '  custom  ',
      includeFrontend: false,
      includeBackend: false,
      pruneRedundantTests: false,
      iteration: 3
    });

    expect(prompt).toContain('(codebase)');
    expect(prompt).toContain('Iteration 3');
    expect(prompt).toContain('Do not delete tests unless they are invalidated by your change.');
    expect(prompt).toContain('custom');
  });

  test('__testing.buildIterationPrompt includes frontend scope and pruning guidance when enabled', () => {
    const prompt = __testing.buildIterationPrompt({
      basePrompt: '',
      includeFrontend: true,
      includeBackend: false,
      pruneRedundantTests: true,
      iteration: 1
    });

    expect(prompt).toContain('(frontend)');
    expect(prompt).toContain('remove/update tests that exist solely');
  });

  test('__testing.createCancelledError attaches code', () => {
    const error = __testing.createCancelledError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CLEANUP_CANCELLED');
  });

  test('__testing.createCancelledError attaches branchName when provided', () => {
    const error = __testing.createCancelledError('feature/cleanup-123');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('CLEANUP_CANCELLED');
    expect(error.branchName).toBe('feature/cleanup-123');
  });

  test('requires projectId', async () => {
    await expect(runForegroundCleanup()).rejects.toThrow('projectId is required');
  });

  test('fails fast when baseline tests/coverage fail', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'failed', summary: 'nope' })),
      deleteBranch: vi.fn(async () => ({ deletedBranch: 'feature/cleanup-test' })),
      edit: vi.fn()
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'refused',
        reason: 'baseline-failed',
        branchName: expect.stringMatching(/^feature\/cleanup-/),
        branchDeleted: true
      })
    );

    expect(deps.edit).not.toHaveBeenCalled();
    expect(deps.deleteBranch).toHaveBeenCalledWith(1, expect.stringMatching(/^feature\/cleanup-/));
  });

  test('reports branchDeleted false when baseline cleanup branch deletion fails', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'failed', summary: 'nope' })),
      deleteBranch: vi.fn(async () => {
        throw new Error('delete failed');
      }),
      edit: vi.fn()
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      deps
    });

    expect(result.status).toBe('refused');
    expect(result.branchDeleted).toBe(false);
  });

  test('emits baseline tests payload with null fallbacks when status/summary are missing', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({})),
      deleteBranch: vi.fn(async () => ({ deletedBranch: 'feature/cleanup-test' })),
      edit: vi.fn()
    });

    const events = [];
    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(result.status).toBe('refused');

    const baselineEvent = events.find((evt) => evt.event === 'tests' && evt.data?.phase === 'baseline');
    expect(baselineEvent.data.run).toBeNull();
    expect(baselineEvent.data.summary).toBeNull();
  });

  test('stops when no safe edits are found (no-op) using default options path', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'ok' })),
      edit: vi.fn(async () => ({ steps: [], summary: 'nothing safe' }))
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      includeFrontend: true,
      includeBackend: true,
      pruneRedundantTests: true,
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'complete',
        branchName: expect.stringMatching(/^feature\/cleanup-/),
        stoppedBecause: 'no-op'
      })
    );
    expect(deps.commit).not.toHaveBeenCalled();
  });

  test('treats baseline/verify status "skipped" as acceptable', async () => {
    const deps = makeDeps({
      runTests: vi
        .fn()
        .mockResolvedValueOnce({ status: 'skipped', summary: 'baseline skipped' })
        .mockResolvedValueOnce({ status: 'skipped', summary: 'verify skipped' }),
      edit: vi.fn(async () => ({ steps: [{ type: 'action', action: 'write_file' }], summary: 'remove' }))
    });

    await expect(
      runForegroundCleanup({
        projectId: 1,
        options: { maxIterations: 1 },
        deps
      })
    ).resolves.toEqual(expect.objectContaining({ stoppedBecause: 'limit' }));

    expect(deps.commit).toHaveBeenCalledTimes(1);
  });

  test('handles edit results with no steps array (counts as no-op)', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'ok' })),
      edit: vi.fn(async () => ({ summary: 'no steps' }))
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      deps
    });

    expect(result.stoppedBecause).toBe('no-op');
  });

  test('commits when edits are verified and stops at iteration limit', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'ok' })),
      edit: vi.fn(async () => ({
        steps: [{ type: 'action', action: 'write_file' }],
        summary: 'removed unused export'
      })),
      getHeadSha: vi
        .fn()
        .mockResolvedValueOnce('sha-1')
        .mockResolvedValueOnce('sha-2')
    });

    const events = [];
    const result = await runForegroundCleanup({
      projectId: 1,
      prompt: 'cleanup',
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        iterations: 1,
        stoppedBecause: 'limit'
      })
    );
    expect(events.some((e) => e.event === 'edit')).toBe(true);
    expect(events.some((e) => e.event === 'tests')).toBe(true);
  });

  test('defaults edit summary to an empty string when missing', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'ok' })),
      edit: vi.fn(async () => ({ steps: [{ type: 'action', action: 'write_file' }] })),
      getHeadSha: vi
        .fn()
        .mockResolvedValueOnce('sha-1')
        .mockResolvedValueOnce('sha-2')
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    const editEvent = events.find((evt) => evt.event === 'edit');
    expect(editEvent.data.summary).toBe('');
  });

  test('streams test job logs via tests-log events when runTests triggers onJobStarted', async () => {
    const deps = makeDeps({
      createBranch: vi.fn(async () => {}),
      checkout: vi.fn(async () => {}),
      getHeadSha: vi.fn(async () => 'sha-1'),
      commit: vi.fn(async () => {}),
      resetTo: vi.fn(async () => {}),
      edit: vi.fn(async () => ({ steps: [], summary: 'noop' })),
      runTests: vi.fn(async (_projectId, _branchName, options) => {
        const job = { id: 'job-1', displayName: 'frontend tests (coverage)', command: 'npm', args: ['run', 'test'], cwd: 'C:/tmp' };
        // Cover baseline jobLabel fallback (`job?.displayName || null`) by starting once without displayName.
        options?.onJobStarted?.({ id: 'job-1' });
        options?.onJobStarted?.(job);
        // Should be ignored (covers jobId mismatch branch in the log subscriber)
        jobEvents.emit('job:log', {
          projectId: 1,
          jobId: 'job-2',
          entry: { stream: 'stdout', message: 'ignore me', timestamp: 't' }
        });
        jobEvents.emit('job:log', {
          projectId: 1,
          jobId: 'job-1',
          entry: { stream: 'stdout', message: 'hello', timestamp: 't' }
        });
        // Cover tests-log fallbacks when job log entry fields are missing.
        jobEvents.emit('job:log', {
          projectId: 1,
          jobId: 'job-1',
          entry: {}
        });
        jobEvents.emit('job:log', {
          projectId: 1,
          jobId: 'job-1'
        });
        // Cover baseline job-done fallbacks for status/exitCode.
        options?.onJobCompleted?.({ id: 'job-1', status: '', exitCode: undefined });
        options?.onJobCompleted?.({ id: 'job-1', status: 'succeeded', exitCode: 0 });
        return { status: 'passed', summary: 'ok', workspaceRuns: [] };
      })
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(events.some((evt) => evt.event === 'tests-job')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-log' && evt.data?.message === 'hello')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-log' && evt.data?.message === '' && evt.data?.stream === 'stdout')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-log' && evt.data?.message === 'ignore me')).toBe(false);
    expect(events.some((evt) => evt.event === 'tests-job-done')).toBe(true);
  });

  test('streams verify job logs and emits verify tests-job events', async () => {
    let callIndex = 0;
    const deps = makeDeps({
      createBranch: vi.fn(async () => {}),
      checkout: vi.fn(async () => {}),
      getHeadSha: vi
        .fn()
        .mockResolvedValueOnce('sha-1')
        .mockResolvedValueOnce('sha-2'),
      commit: vi.fn(async () => {}),
      resetTo: vi.fn(async () => {}),
      edit: vi.fn(async () => ({
        steps: [{ type: 'action', action: 'write_file' }],
        summary: 'remove dead export'
      })),
      runTests: vi.fn(async (_projectId, _branchName, options) => {
        callIndex += 1;
        const phase = callIndex === 1 ? 'baseline' : 'verify';
        const jobId = callIndex === 1 ? 'job-baseline' : 'job-verify';

        if (phase === 'verify') {
          // Cover `job?.id || null` fallback branches for verify job metadata.
          options?.onJobStarted?.({});
        }
        options?.onJobStarted?.({
          id: jobId,
          displayName: `${phase} job`,
          command: 'npm',
          args: ['run', 'test:coverage'],
          cwd: 'C:/tmp'
        });
        jobEvents.emit('job:log', {
          projectId: 1,
          jobId,
          entry: { stream: 'stdout', message: `${phase} log`, timestamp: 't' }
        });
        if (phase === 'verify') {
          // Cover `job?.id || null` / `|| null` / `?? null` fallbacks in the verify job-done payload
          options?.onJobCompleted?.({});
          options?.onJobCompleted?.({ id: jobId, status: '', exitCode: undefined });
        }
        options?.onJobCompleted?.({ id: jobId, status: 'succeeded', exitCode: 0 });
        return { status: 'passed', summary: { ok: true }, workspaceRuns: [] };
      })
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(events.some((evt) => evt.event === 'tests-job' && evt.data?.phase === 'verify')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-log' && evt.data?.phase === 'verify' && evt.data?.message === 'verify log')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-job-done' && evt.data?.phase === 'verify')).toBe(true);
  });

  test('streams verify-fix job logs and covers subscribeToJobLogs jobId falsy path', async () => {
    const runTests = vi.fn();

    const deps = makeDeps({
      createBranch: vi.fn(async () => {}),
      checkout: vi.fn(async () => {}),
      getHeadSha: vi.fn(async () => 'sha-1'),
      commit: vi.fn(async () => {}),
      resetTo: vi.fn(async () => {}),
      edit: vi
        .fn()
        .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'change' })
        .mockResolvedValueOnce({ steps: [], summary: 'fix attempt 1' })
        .mockResolvedValueOnce({ steps: [], summary: 'fix attempt 2' }),
      runTests
    });

    // baseline
    runTests.mockImplementationOnce(async (_projectId, _branchName, options) => {
      options?.onJobStarted?.({ id: null, displayName: 'baseline job' });
      options?.onJobCompleted?.({ id: null, status: 'succeeded', exitCode: 0 });
      return { status: 'passed', summary: { ok: true }, workspaceRuns: [] };
    });

    // verify fails
    runTests.mockImplementationOnce(async (_projectId, _branchName, options) => {
      options?.onJobStarted?.({ id: 'job-verify', displayName: 'verify job' });
      jobEvents.emit('job:log', {
        projectId: 1,
        jobId: 'job-verify',
        entry: { stream: 'stderr', message: 'verify failed', timestamp: 't' }
      });
      options?.onJobCompleted?.({ id: 'job-verify', status: 'failed', exitCode: 1 });
      return { status: 'failed', summary: { reason: 'boom' }, workspaceRuns: [] };
    });

    // verify-fix-1 fails (covers truthy optional job fields)
    runTests.mockImplementationOnce(async (_projectId, _branchName, options) => {
      options?.onJobStarted?.({ id: 'job-fix-1', displayName: 'verify-fix job' });
      jobEvents.emit('job:log', {
        projectId: 1,
        jobId: 'job-fix-1',
        entry: { stream: 'stderr', message: 'fix attempt failed', timestamp: 't' }
      });
      options?.onJobCompleted?.({ id: 'job-fix-1', status: 'failed', exitCode: 1 });
      return { status: 'failed', summary: { ok: false }, workspaceRuns: [] };
    });

    // verify-fix-2 passes (covers falsy optional job fields)
    runTests.mockImplementationOnce(async (_projectId, _branchName, options) => {
      // Deliberately omit optional fields to cover `|| null` and `?? null` fallbacks
      options?.onJobStarted?.({});
      options?.onJobStarted?.({ id: 'job-fix-2' });
      jobEvents.emit('job:log', {
        projectId: 1,
        jobId: 'job-fix-2',
        entry: { stream: 'stdout', message: 'fix ok', timestamp: 't' }
      });
      options?.onJobCompleted?.({});
      options?.onJobCompleted?.({ id: 'job-fix-2', status: '', exitCode: undefined });
      return { status: 'passed', summary: { ok: true }, workspaceRuns: [] };
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1, verificationFixRetries: 2 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(events.some((evt) => evt.event === 'tests-job' && String(evt.data?.phase || '').startsWith('verify-fix-'))).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-log' && evt.data?.message === 'fix ok')).toBe(true);
    expect(events.some((evt) => evt.event === 'tests-job-done' && String(evt.data?.phase || '').startsWith('verify-fix-'))).toBe(true);
  });

  test('emits a verify tests event', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: null })),
      edit: vi.fn(async () => ({
        steps: [{ type: 'action', action: 'write_file' }],
        summary: 'remove'
      }))
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'tests', data: expect.objectContaining({ phase: 'verify' }) })
      ])
    );
  });

  test('attempts fix when verification fails and proceeds when it passes', async () => {
    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'passed', summary: 'baseline ok' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'verify failed' })
      .mockResolvedValueOnce({ status: 'passed', summary: 'fixed' });

    const edit = vi
      .fn()
      .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'remove' })
      .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'fix' });

    const deps = makeDeps({ runTests, edit });

    await expect(
      runForegroundCleanup({
        projectId: 1,
        options: { maxIterations: 1, verificationFixRetries: 1 },
        deps
      })
    ).resolves.toEqual(expect.objectContaining({ stoppedBecause: 'limit' }));

    expect(edit).toHaveBeenCalledTimes(2);
    expect(deps.commit).toHaveBeenCalledTimes(1);
  });

  test('emits verify-fix tests event and treats skipped as a successful fix', async () => {
    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'passed', summary: 'baseline ok' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'verify failed' })
      .mockResolvedValueOnce({ status: 'skipped', summary: 'fixed but skipped' });

    const deps = makeDeps({
      runTests,
      edit: vi
        .fn()
        .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'remove' })
        .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'fix' })
    });

    const events = [];
    await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1, verificationFixRetries: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'tests',
          data: expect.objectContaining({ phase: 'verify-fix-1', run: 'skipped' })
        })
      ])
    );
  });

  test('covers null fallbacks for emitted verification payload fields', async () => {
    const deps = makeDeps({
      runTests: vi
        .fn()
        .mockResolvedValueOnce({ status: 'passed' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      edit: vi
        .fn()
        .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'remove' })
        .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'fix' }),
      getHeadSha: vi.fn(async () => 'sha-good')
    });

    const events = [];
    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1, verificationFixRetries: 1 },
      onEvent: (evt) => events.push(evt),
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        branchName: expect.stringMatching(/^feature\/cleanup-/),
        message: expect.stringMatching(/rolled back/i)
      })
    );

    const verifyEvent = events.find((evt) => evt.event === 'tests' && evt.data?.phase === 'verify');
    expect(verifyEvent.data.run).toBeNull();
    expect(verifyEvent.data.summary).toBeNull();

    const verifyFixEvent = events.find((evt) => evt.event === 'tests' && evt.data?.phase === 'verify-fix-1');
    expect(verifyFixEvent.data.run).toBeNull();
    expect(verifyFixEvent.data.summary).toBeNull();
  });

  test('uses non-pruning fix prompt when pruneRedundantTests is false', async () => {
    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'passed', summary: 'baseline ok' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'verify failed' })
      .mockResolvedValueOnce({ status: 'passed', summary: 'fixed' });

    const edit = vi
      .fn()
      .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'remove' })
      .mockResolvedValueOnce({ steps: [{ type: 'action', action: 'write_file' }], summary: 'fix' });

    const deps = makeDeps({ runTests, edit });

    await runForegroundCleanup({
      projectId: 1,
      pruneRedundantTests: false,
      options: { maxIterations: 1, verificationFixRetries: 1 },
      deps
    });

    const fixCall = edit.mock.calls[1][0];
    expect(fixCall.prompt).toContain('Prefer fixing code/tests without deleting tests.');
  });

  test('rolls back and throws when verification cannot be fixed', async () => {
    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'passed', summary: 'baseline ok' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'verify failed' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'still failing' });

    const deps = makeDeps({
      runTests,
      edit: vi.fn(async () => ({ steps: [{ type: 'action', action: 'write_file' }], summary: 'edit' })),
      getHeadSha: vi.fn(async () => 'sha-good')
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1, verificationFixRetries: 1 },
      deps
    });

    expect(result.status).toBe('failed');
    expect(result.message).toContain('Cleanup iteration failed verification');

    expect(deps.resetTo).toHaveBeenCalledWith(1, expect.any(String), { commitSha: 'sha-good', status: 'active' });
  });

  test('throws without reset when lastGoodSha is falsy', async () => {
    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'passed', summary: 'baseline ok' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'verify failed' })
      .mockResolvedValueOnce({ status: 'failed', summary: 'still failing' });

    const deps = makeDeps({
      runTests,
      edit: vi.fn(async () => ({ steps: [{ type: 'action', action: 'write_file' }], summary: 'edit' })),
      getHeadSha: vi.fn(async () => '')
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1, verificationFixRetries: 1 },
      deps
    });

    expect(result.status).toBe('failed');

    expect(deps.resetTo).not.toHaveBeenCalled();
  });

  test('passes through provided coverage thresholds', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'ok' })),
      edit: vi.fn(async () => ({ steps: [], summary: 'nothing safe' }))
    });

    await runForegroundCleanup({
      projectId: 1,
      options: { coverageThresholds: { lines: 99 } },
      deps
    });

    const runArgs = deps.runTests.mock.calls[0][2];
    expect(runArgs.coverageThresholds.lines).toBe(99);
  });

  test('returns cancelled status when shouldCancel is true', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'baseline ok' })),
      edit: vi.fn(async () => ({ steps: [], summary: 'no-op' }))
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      shouldCancel: () => true,
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        canDeleteBranch: false
      })
    );
  });

  test('returns cancelled status with branchName after branch is created', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'baseline ok' })),
      edit: vi.fn(async () => ({ steps: [], summary: 'no-op' }))
    });

    const cancelSequence = [false, false, true];
    const shouldCancel = () => {
      const next = cancelSequence.length ? cancelSequence.shift() : true;
      return next;
    };

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      shouldCancel,
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        branchName: expect.stringMatching(/^feature\/cleanup-/),
        canDeleteBranch: true
      })
    );
  });

  test('rethrows errors that occur before a branch is created', async () => {
    const deps = makeDeps({
      createBranch: vi.fn(async () => {
        throw new Error('create failed');
      })
    });

    await expect(
      runForegroundCleanup({
        projectId: 1,
        options: { maxIterations: 1 },
        deps
      })
    ).rejects.toThrow('create failed');
  });

  test('defaults failed result message when error message is falsy', async () => {
    const deps = makeDeps({
      runTests: vi.fn(async () => ({ status: 'passed', summary: 'baseline ok' })),
      getHeadSha: vi.fn(async () => {
        throw new Error('');
      })
    });

    const result = await runForegroundCleanup({
      projectId: 1,
      options: { maxIterations: 1 },
      deps
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'failed',
        branchName: expect.stringMatching(/^feature\/cleanup-/),
        message: 'Cleanup failed'
      })
    );
  });
});
