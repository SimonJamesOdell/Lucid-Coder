import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TestTab from '../components/TestTab';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const baseProject = { id: 'proj-1', name: 'Demo Project' };

const buildContext = (overrides = {}) => ({
  startAutomationJob: vi.fn().mockResolvedValue({}),
  cancelAutomationJob: vi.fn().mockResolvedValue({}),
  getJobsForProject: vi.fn().mockReturnValue([]),
  jobState: { isLoading: false, error: null, jobsByProject: {} },
  refreshJobs: vi.fn().mockResolvedValue([]),
  workspaceChanges: {},
  workingBranches: {},
  syncBranchOverview: vi.fn(),
  markTestRunIntent: vi.fn(),
  testRunIntent: { source: 'user', updatedAt: '2024-01-01T00:00:00.000Z' },
  ...overrides
});

const waitForInstanceHooks = async () => {
  await waitFor(() => {
    expect(typeof TestTab.__testHooks.handleRun).toBe('function');
  });
  return TestTab.__testHooks;
};

const enqueueProofSuccess = (payload = { data: { success: true, overview: { workingBranches: [] } } }) => {
  axios.post.mockResolvedValueOnce(payload);
};

describe('TestTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppState.mockReturnValue(buildContext());
  });

  test('renders automation suites for a project', () => {
    render(<TestTab project={baseProject} />);
    expect(screen.getByTestId('test-card-frontend:test')).toBeInTheDocument();
    expect(screen.getByTestId('test-card-backend:test')).toBeInTheDocument();
  });

  test('does not reopen the result modal when the latest jobs are unchanged', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-stable',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-stable',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-stable',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-stable',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-stable',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-stable',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const { rerender } = render(<TestTab project={baseProject} />);

    // First render observed an active job. Rerender with completed jobs should open the modal.
    rerender(<TestTab project={baseProject} />);
    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-close'));
    expect(screen.queryByTestId('modal-content')).toBeNull();

    rerender(<TestTab project={baseProject} />);

    expect(screen.queryByTestId('modal-content')).toBeNull();
  });

  test('result modal key tolerates missing ids and timestamps', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      // First render: running jobs so the tab observes an active run.
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-observe',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-observe',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      // Second render: completed jobs with missing ids/createdAt/completedAt to exercise modalKey fallbacks.
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: '',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: '',
            completedAt
          },
          {
            id: '',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: '',
            completedAt: ''
          }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);

    // Rerender to supply completed jobs and trigger the completion modal.
    view.rerender(<TestTab project={baseProject} />);
    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
  });

  test('uses workspaceChanges stagedFiles when branch stagedFiles is not an array', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/workspace-staged',
        stagedFiles: 'nope'
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-ws', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-ws', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-ws', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-ws', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests passed')).toBeInTheDocument();
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Continue to commit');
  });

  test('treats workspaceChanges stagedFiles as empty when it is not an array', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/nothing-staged',
        stagedFiles: 'nope'
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: 'also-nope'
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-empty2', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-empty2', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-empty2', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-empty2', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Nothing to commit')).toBeInTheDocument();
  });

  test('does not offer commit flow when testRunIntent.source is not a string', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 123, updatedAt: createdAt },
        workingBranches: {
          [baseProject.id]: {
            name: 'feature/non-string-source',
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-src', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-src', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 123, updatedAt: completedAt },
        workingBranches: {
          [baseProject.id]: {
            name: 'feature/non-string-source',
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-src', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-src', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await act(async () => {});
    expect(screen.queryByTestId('modal-content')).toBeNull();
  });

  test('commits immediately when the initial commit attempt succeeds (no proof required)', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();

    enqueueProofSuccess();
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: { workingBranches: [] } } });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/fast-commit',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-fast', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-fast', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-fast', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-fast', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />);
    view.rerender(<TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />);

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/fast-commit')}/tests/proof`;
      const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/fast-commit')}/commit`;
      expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
      expect(axios.post).toHaveBeenNthCalledWith(2, expectedCommitUrl);
      expect(onRequestCommitsTab).toHaveBeenCalled();
    });
  });

  test('shows commit error when proof recording fails', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    axios.post.mockRejectedValueOnce(new Error('Proof crashed'));

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/proof-error',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-proof-error', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt, completedAt },
      { id: 'back-proof-error', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt, completedAt }
    ];

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue(jobs.map((job) => ({ ...job, status: 'running' })))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue(jobs)
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    await within(screen.getByTestId('modal-content')).findByText('Proof crashed');
    expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('shows fallback proof error message when proof failure has no details', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    axios.post.mockRejectedValueOnce({});

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/proof-fallback',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-proof-fallback', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt, completedAt },
      { id: 'back-proof-fallback', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt, completedAt }
    ];

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue(jobs.map((job) => ({ ...job, status: 'running', completedAt: undefined })))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue(jobs)
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const modal = await screen.findByTestId('modal-content');
    expect(within(modal).getByText('Failed to record branch test proof')).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('submitProofIfNeeded returns false when branch is already ready for merge', async () => {
    const now = new Date().toISOString();
    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/already-ready',
        status: 'ready-for-merge',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-ready', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now },
      { id: 'back-ready', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now }
    ];

    useAppState.mockReturnValue(buildContext({
      testRunIntent: { source: 'automation', updatedAt: now },
      workingBranches,
      getJobsForProject: vi.fn().mockReturnValue(jobs)
    }));

    render(<TestTab project={baseProject} />);

    const hooks = await waitForInstanceHooks();
    const recorded = await hooks.submitProofIfNeeded();
    expect(recorded).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('submitProofIfNeeded returns false when no working branch is selected', async () => {
    const now = new Date().toISOString();
    const jobs = [
      { id: 'front-missing', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now },
      { id: 'back-missing', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now }
    ];

    useAppState.mockReturnValue(buildContext({
      testRunIntent: { source: 'automation', updatedAt: now },
      workingBranches: {},
      getJobsForProject: vi.fn().mockReturnValue(jobs)
    }));

    render(<TestTab project={baseProject} />);
    const hooks = await waitForInstanceHooks();

    expect(await hooks.submitProofIfNeeded()).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('submitProofIfNeeded ignores non-automation test sources', async () => {
    const now = new Date().toISOString();
    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/non-automation',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-manual', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now },
      { id: 'back-manual', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now }
    ];

    useAppState.mockReturnValue(buildContext({
      testRunIntent: { source: 'user', updatedAt: now },
      workingBranches,
      getJobsForProject: vi.fn().mockReturnValue(jobs)
    }));

    render(<TestTab project={baseProject} />);
    const hooks = await waitForInstanceHooks();

    expect(await hooks.submitProofIfNeeded()).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('submitProofIfNeeded requires both test suites to succeed', async () => {
    const now = new Date().toISOString();
    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/needs-success',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-pass', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now },
      { id: 'back-fail', type: 'backend:test', status: 'failed', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now }
    ];

    useAppState.mockReturnValue(buildContext({
      testRunIntent: { source: 'automation', updatedAt: now },
      workingBranches,
      getJobsForProject: vi.fn().mockReturnValue(jobs)
    }));

    render(<TestTab project={baseProject} />);
    const hooks = await waitForInstanceHooks();

    expect(await hooks.submitProofIfNeeded()).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('submitProofIfNeeded skips duplicate proofs for the same job ids', async () => {
    const now = new Date().toISOString();
    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/unique-proof',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const jobs = [
      { id: 'front-proof', type: 'frontend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now },
      { id: 'back-proof', type: 'backend:test', status: 'succeeded', command: 'npm', args: ['run', 'test'], cwd: '/tmp/project', logs: [], createdAt: now, completedAt: now }
    ];

    axios.post.mockResolvedValue({ data: { overview: { workingBranches: [] } } });

    useAppState.mockReturnValue(buildContext({
      testRunIntent: { source: 'automation', updatedAt: now },
      workingBranches,
      getJobsForProject: vi.fn().mockReturnValue(jobs)
    }));

    render(<TestTab project={baseProject} />);
    const hooks = await waitForInstanceHooks();

    await expect(hooks.submitProofIfNeeded()).resolves.toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const secondAttempt = await hooks.submitProofIfNeeded();
    expect(secondAttempt).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('commit error modal falls back when error has no message or response', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    enqueueProofSuccess();
    axios.post.mockRejectedValueOnce({});

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/commit-error-shape',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-err', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-err', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-err', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-err', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await screen.findByTestId('modal-content');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    const modal = screen.getByTestId('modal-content');
    expect(within(modal).getByText('Commit failed')).toBeInTheDocument();
    expect(within(modal).getByText('Failed to commit staged changes')).toBeInTheDocument();
  });

  test('commit error modal prefers response.data.error when available', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    enqueueProofSuccess();
    axios.post.mockRejectedValueOnce({
      response: { data: { error: 'Backend says no' } },
      message: 'Generic failure'
    });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/commit-error-response',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-err2', type: 'frontend:test', status: 'running', logs: [], createdAt },
          { id: 'back-err2', type: 'backend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-err2', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
          { id: 'back-err2', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await screen.findByTestId('modal-content');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const modal = await screen.findByTestId('modal-content');
    expect(within(modal).getByText('Commit failed')).toBeInTheDocument();
    expect(within(modal).getByText('Backend says no')).toBeInTheDocument();
  });

  test('commits staged changes when continuing after tests pass', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();
    const syncBranchOverview = vi.fn();

    enqueueProofSuccess();
    axios.post
      .mockResolvedValueOnce({ data: { success: true, overview: { workingBranches: [] } } });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/test-commit',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        syncBranchOverview,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        syncBranchOverview,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/test-commit')}/commit`;
    const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/test-commit')}/tests/proof`;

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
      expect(axios.post).toHaveBeenNthCalledWith(2, expectedCommitUrl);
      expect(syncBranchOverview).toHaveBeenCalledWith(baseProject.id, expect.any(Object));
      expect(onRequestCommitsTab).toHaveBeenCalled();
    });
  });

  test('surfaces proof submission errors before attempting a commit', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();
    const proofError = {
      response: { data: { error: 'Proof endpoint exploded' } },
      message: 'HTTP 500'
    };

    axios.post.mockRejectedValueOnce(proofError);

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/proof-error',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/proof-error')}/tests/proof`;

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(proofUrl, expect.objectContaining({
        jobIds: ['front-done', 'back-done'],
        frontendJobId: 'front-done',
        backendJobId: 'back-done',
        source: 'automation'
      }));
    });

    const modal = await screen.findByTestId('modal-content');
    expect(within(modal).getByText('Commit failed')).toBeInTheDocument();
    expect(within(modal).getByText('Proof endpoint exploded')).toBeInTheDocument();
    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('commits staged changes when commit gate says to resolve failing tests (covers needsProof branches)', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();

    axios.post
      .mockRejectedValueOnce({ message: 'Resolve failing tests' });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/test-commit-2',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            type: 'frontend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          },
          {
            type: 'backend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');
    const hooks = await waitForInstanceHooks();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/test-commit-2')}/commit`;

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(expectedCommitUrl);
    });

    await waitFor(() => {
      const modal = screen.getByTestId('modal-content');
      expect(within(modal).getByText('Tests required before commit')).toBeInTheDocument();
      expect(within(modal).getByText('Run backend tests again before committing this branch so the server can record a passing proof.')).toBeInTheDocument();
    });
    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('shows a commit failure modal when commit gate error does not require proof', async () => {
    axios.post.mockReset();
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();

    enqueueProofSuccess();
    axios.post.mockRejectedValueOnce({ message: 'Nothing to commit.' });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/test-commit-no-proof',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');
    const hooks = await waitForInstanceHooks();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/test-commit-no-proof')}/commit`;
    const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/test-commit-no-proof')}/tests/proof`;

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
      expect(axios.post).toHaveBeenNthCalledWith(2, expectedCommitUrl);
    });

    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('falls back to a default commit error message when the thrown value has no message', async () => {
    axios.post.mockReset();
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();

    enqueueProofSuccess();
    axios.post.mockRejectedValueOnce({});

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/test-commit-default-error',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('surfaces commit-blocked guidance when the server requests a proof run', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    enqueueProofSuccess();
    axios.post
      .mockRejectedValueOnce({ response: { data: { error: 'Run tests to prove this branch before committing.' } } });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/prove-fail',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await screen.findByTestId('modal-content');
    const hooks = await waitForInstanceHooks();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/prove-fail')}/tests/proof`;
    const commitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/prove-fail')}/commit`;

    await waitFor(() => {
      const modal = screen.getByTestId('modal-content');
      expect(within(modal).getByText('Tests required before commit')).toBeInTheDocument();
      expect(within(modal).getByText('Run backend tests again before committing this branch so the server can record a passing proof.')).toBeInTheDocument();
    });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
    expect(axios.post).toHaveBeenNthCalledWith(2, commitUrl);
  });

  test('auto-fix plan extracts failing test ids and dedupes prompts for automation runs', async () => {
    window.__lucidcoderAutofixHalted = false;
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-failed',
            type: 'frontend:test',
            status: 'failed',
            createdAt,
            completedAt,
            logs: [
              { timestamp: 't1', message: 'FAIL  src/test/Foo.test.jsx > Foo > does something\n' },
              { timestamp: 't2', message: 'FAIL  src/test/Foo.test.jsx > Foo > does something\n' }
            ]
          },
          {
            id: 'back-failed',
            type: 'backend:test',
            status: 'failed',
            createdAt,
            completedAt,
            logs: [{ timestamp: 't3', message: 'Some failure without a FAIL line' }]
          }
        ])
      }));

    const view = render(<TestTab project={baseProject} />);
    view.rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalled();
    });

    const autofixEvent = dispatchSpy.mock.calls
      .map((call) => call[0])
      .find((evt) => evt?.type === 'lucidcoder:autofix-tests');

    expect(autofixEvent).toBeTruthy();
    expect(autofixEvent.detail.origin).toBe('automation');
    expect(autofixEvent.detail.prompt).toBe('Fix failing tests');
    expect(autofixEvent.detail.childPrompts).toEqual(
      expect.arrayContaining([
        'Fix failing test: src/test/Foo.test.jsx > Foo > does something',
        'Fix failing backend tests'
      ])
    );
    expect(autofixEvent.detail.failureContext).toBeTruthy();
    expect(Array.isArray(autofixEvent.detail.failureContext.jobs)).toBe(true);
    const frontendSummary = autofixEvent.detail.failureContext.jobs.find((job) => job.label === 'Frontend tests');
    expect(frontendSummary).toBeTruthy();
    expect(frontendSummary.testFailures).toEqual(['src/test/Foo.test.jsx > Foo > does something']);
    expect(frontendSummary.recentLogs.some((line) => line.includes('FAIL  src/test/Foo.test.jsx'))).toBe(true);
  });

  test('autofix max-attempt override hooks accept finite and non-finite values', async () => {
    render(<TestTab project={baseProject} />);
    const hooks = await waitForInstanceHooks();

    expect(typeof hooks.setAutofixMaxAttemptsOverride).toBe('function');
    expect(typeof hooks.resetAutofixMaxAttemptsOverride).toBe('function');

    hooks.setAutofixMaxAttemptsOverride(2);
    hooks.setAutofixMaxAttemptsOverride(Number.POSITIVE_INFINITY);
    hooks.resetAutofixMaxAttemptsOverride();
  });

  test('surfaces proof guidance without re-running tests when commit gate flags past failures', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();
    const syncBranchOverview = vi.fn();

    enqueueProofSuccess();
    axios.post
      .mockRejectedValueOnce({ response: { data: { error: 'Resolve failing tests and run tests again before committing.' } } });

    const workingBranches = {
      [baseProject.id]: {
        name: 'feature/reprove-commit',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [baseProject.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    useAppState
      .mockReturnValueOnce(buildContext({
        workingBranches,
        workspaceChanges,
        syncBranchOverview,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-running',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-running',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        syncBranchOverview,
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-done',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          },
          {
            id: 'back-done',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt,
            completedAt
          }
        ])
      }));

    const view = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/reprove-commit')}/tests/proof`;
    const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/reprove-commit')}/commit`;
    await waitFor(() => {
      expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
      expect(axios.post).toHaveBeenNthCalledWith(2, expectedCommitUrl);
    });

    const modal = await screen.findByTestId('modal-content');
    expect(within(modal).getByText('Tests required before commit')).toBeInTheDocument();
    expect(within(modal).getByText('Run backend tests again before committing this branch so the server can record a passing proof.')).toBeInTheDocument();
    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('renders empty state when no project and clears actions', async () => {
    const registerTestActions = vi.fn();
    render(<TestTab registerTestActions={registerTestActions} />);

    expect(screen.getByTestId('test-tab-empty')).toBeInTheDocument();
    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(null);
    });
  });

  test('registers toolbar actions with last fetched timestamp when available', async () => {
    const registerTestActions = vi.fn();
    const lastFetchedAt = 1700000000123;

    useAppState.mockReturnValue(
      buildContext({
        jobState: {
          isLoading: false,
          error: null,
          jobsByProject: {
            [String(baseProject.id)]: { lastFetchedAt }
          }
        }
      })
    );

    render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(
        expect.objectContaining({
          lastFetchedAt,
          refreshDisabled: false,
          cancelDisabled: true,
          isRefreshing: false,
          onRefresh: expect.any(Function),
          onCancelActiveRuns: expect.any(Function)
        })
      );
    });
  });

  test('starts automation jobs when run buttons are clicked', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});
    useAppState.mockReturnValue(buildContext({ startAutomationJob }));
    const user = userEvent.setup();

    render(<TestTab project={baseProject} />);
    await user.click(screen.getByTestId('run-frontend:test'));
    expect(startAutomationJob).toHaveBeenCalledWith('frontend:test', expect.objectContaining({ projectId: baseProject.id }));

    await user.click(screen.getByTestId('run-backend:test'));
    expect(startAutomationJob).toHaveBeenCalledWith('backend:test', expect.objectContaining({ projectId: baseProject.id }));
  });

  test('shows logs and cancel control for running jobs', async () => {
    const cancelAutomationJob = vi.fn().mockResolvedValue({});
    const getJobsForProject = vi.fn().mockReturnValue([
      {
        id: 'job-1',
        type: 'frontend:test',
        status: 'running',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: [{ stream: 'stdout', message: 'Running tests…', timestamp: '2024-01-01T00:00:00.000Z' }]
      }
    ]);
    useAppState.mockReturnValue(buildContext({ getJobsForProject, cancelAutomationJob }));

    const user = userEvent.setup();
    render(<TestTab project={baseProject} />);

    expect(screen.getByText('Running tests…')).toBeInTheDocument();
    await user.click(screen.getByTestId('cancel-frontend:test'));
    expect(cancelAutomationJob).toHaveBeenCalledWith('job-1', expect.any(Object));
  });

  test('job commands render gracefully when args are missing', () => {
    const getJobsForProject = vi.fn().mockReturnValue([
      {
        id: 'job-args',
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        cwd: '/tmp/project',
        logs: [{ stream: 'stdout', message: 'done', timestamp: '2024-01-01T00:00:00.000Z' }]
      }
    ]);
    useAppState.mockReturnValue(buildContext({ getJobsForProject }));

    render(<TestTab project={baseProject} />);

    const command = screen.getByTestId('job-command-frontend:test');
    expect(command).toHaveTextContent(/^npm\s*$/);
  });

  test('registers refresh handler with parent actions', async () => {
    const refreshJobs = vi.fn().mockResolvedValue([]);
    const registerTestActions = vi.fn();
    useAppState.mockReturnValue(buildContext({ refreshJobs }));

    render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(expect.objectContaining({ onRefresh: expect.any(Function) }));
    });

    const refreshPayload = registerTestActions.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.onRefresh);
    expect(refreshPayload).toBeTruthy();

    await refreshPayload.onRefresh();
    expect(refreshJobs).toHaveBeenCalledWith(baseProject.id);
  });

  test('registers cancel handler for active tests', async () => {
    const cancelAutomationJob = vi.fn().mockResolvedValue({});
    const getJobsForProject = vi.fn().mockReturnValue([
      {
        id: 'job-99',
        type: 'frontend:test',
        status: 'running',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: []
      }
    ]);
    const registerTestActions = vi.fn();
    useAppState.mockReturnValue(buildContext({ cancelAutomationJob, getJobsForProject }));

    render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(expect.objectContaining({ onCancelActiveRuns: expect.any(Function) }));
    });

    const cancelPayload = registerTestActions.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.onCancelActiveRuns);
    expect(cancelPayload).toBeTruthy();

    await cancelPayload.onCancelActiveRuns();
    expect(cancelAutomationJob).toHaveBeenCalledWith('job-99', expect.any(Object));
  });

  test('displays error banner from context state', () => {
    useAppState.mockReturnValue(buildContext({ jobState: { isLoading: false, error: 'boom', jobsByProject: {} } }));

    render(<TestTab project={baseProject} />);
    expect(screen.getByTestId('test-error-banner')).toHaveTextContent('boom');
  });

  test('cleans up registered actions when unmounted', async () => {
    const registerTestActions = vi.fn();
    const { unmount } = render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(expect.objectContaining({ onRefresh: expect.any(Function) }));
    });

    unmount();
    expect(registerTestActions).toHaveBeenCalledWith(null);
  });

  test('surfacing refresh errors through registered handler', async () => {
    const refreshJobs = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const registerTestActions = vi.fn();
    useAppState.mockReturnValue(buildContext({ refreshJobs }));

    render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(expect.objectContaining({ onRefresh: expect.any(Function) }));
    });

    const refreshPayload = registerTestActions.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.onRefresh);

    await act(async () => {
      await refreshPayload.onRefresh();
    });

    expect(await screen.findByTestId('test-error-banner')).toHaveTextContent('refresh failed');
  });

  test('cancel handler ignores requests when nothing is running', async () => {
    const cancelAutomationJob = vi.fn();
    const registerTestActions = vi.fn();
    useAppState.mockReturnValue(buildContext({ cancelAutomationJob }));

    render(<TestTab project={baseProject} registerTestActions={registerTestActions} />);

    await waitFor(() => {
      expect(registerTestActions).toHaveBeenCalledWith(expect.objectContaining({ onCancelActiveRuns: expect.any(Function) }));
    });

    const cancelPayload = registerTestActions.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.onCancelActiveRuns);

    await cancelPayload.onCancelActiveRuns();
    expect(cancelAutomationJob).not.toHaveBeenCalled();
  });

  test('shows placeholder log message when no log entries exist', () => {
    const getJobsForProject = vi.fn().mockReturnValue([
      {
        id: 'job-2',
        type: 'frontend:test',
        status: 'running',
        command: 'npm',
        args: ['run', 'lint'],
        cwd: '/tmp/project',
        logs: []
      }
    ]);
    useAppState.mockReturnValue(buildContext({ getJobsForProject }));

    render(<TestTab project={baseProject} />);
    expect(screen.getByTestId('test-job-empty-logs')).toBeInTheDocument();
  });

  test('renders duration labels and highlighted log tokens', () => {
    const getJobsForProject = vi.fn().mockReturnValue([
      {
        id: 'job-3',
        type: 'frontend:test',
        status: 'succeeded',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:00:05.000Z',
        logs: [
          {
            stream: 'stdout',
            message: '✓ 12 tests passed in 5s',
            timestamp: '2024-01-01T00:00:05.000Z'
          }
        ]
      }
    ]);
    useAppState.mockReturnValue(buildContext({ getJobsForProject }));

    const { container } = render(<TestTab project={baseProject} />);
    expect(screen.getByText('5.0s')).toBeInTheDocument();

    const passHighlights = container.querySelectorAll('.log-highlight.pass');
    const durationHighlights = container.querySelectorAll('.log-highlight.duration');
    expect(passHighlights.length).toBeGreaterThan(0);
    expect(durationHighlights.length).toBeGreaterThan(0);
  });

  test('does not show a completion modal immediately for already-completed historical jobs', async () => {
    useAppState.mockReturnValue(buildContext({
      getJobsForProject: vi.fn().mockReturnValue([
        {
          id: 'front-historical',
          type: 'frontend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          createdAt: '2024-01-01T00:00:00.000Z',
          completedAt: '2024-01-01T00:00:05.000Z',
          logs: []
        },
        {
          id: 'back-historical',
          type: 'backend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          createdAt: '2024-01-01T00:00:00.000Z',
          completedAt: '2024-01-01T00:00:06.000Z',
          logs: []
        }
      ])
    }));

    render(<TestTab project={baseProject} />);

    // Modal should not open just because old jobs exist.
    expect(screen.queryByTestId('modal-content')).toBeNull();
    expect(screen.queryByText('Tests passed')).toBeNull();
  });

  test('shows a success modal when both test suites complete successfully and staged files exist, then allows continuing to commit', async () => {
    const onRequestCommitsTab = vi.fn();

    enqueueProofSuccess();
    axios.post
      .mockResolvedValueOnce({ data: { success: true, overview: { workingBranches: [] } } });

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-1',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-1',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: '2024-01-01T00:00:01.000Z' },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-1',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-1',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ]),
        workspaceChanges: {
          'proj-1': {
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
          }
        },
        workingBranches: {
          'proj-1': {
            name: 'feature/commit-me',
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
          }
        }
      }));

    const { rerender } = render(
      <TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />
    );

    rerender(<TestTab project={baseProject} onRequestCommitsTab={onRequestCommitsTab} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests passed')).toBeInTheDocument();
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Continue to commit');
    expect(screen.getByTestId('modal-close')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      const proofUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/commit-me')}/tests/proof`;
      const expectedCommitUrl = `/api/projects/${baseProject.id}/branches/${encodeURIComponent('feature/commit-me')}/commit`;
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post).toHaveBeenNthCalledWith(1, proofUrl, expect.any(Object));
      expect(axios.post).toHaveBeenNthCalledWith(2, expectedCommitUrl);
      expect(onRequestCommitsTab).toHaveBeenCalled();
    });
  });

  test('continue-to-commit modal ignores backdrop clicks', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const runningContext = buildContext({
      getJobsForProject: vi.fn().mockReturnValue([
        {
          id: 'front-backdrop',
          type: 'frontend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt
        },
        {
          id: 'back-backdrop',
          type: 'backend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt
        }
      ])
    });

    const successContext = buildContext({
      testRunIntent: { source: 'automation', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        {
          id: 'front-backdrop',
          type: 'frontend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt,
          completedAt
        },
        {
          id: 'back-backdrop',
          type: 'backend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt,
          completedAt
        }
      ]),
      workspaceChanges: {
        [baseProject.id]: {
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
        }
      },
      workingBranches: {
        [baseProject.id]: {
          name: 'feature/block-dismissal',
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
        }
      }
    });

    useAppState.mockReturnValue(successContext).mockReturnValueOnce(runningContext);

    const view = render(<TestTab project={baseProject} />);
    await act(async () => {});
    view.rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();

    const backdrop = screen.getByTestId('modal-backdrop');
    fireEvent.click(backdrop, { target: backdrop, currentTarget: backdrop });

    expect(screen.getByTestId('modal-content')).toBeInTheDocument();
  });

  test('offers a way to reopen the commit prompt after closing it', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const runningReopenContext = buildContext({
      getJobsForProject: vi.fn().mockReturnValue([
        {
          id: 'front-reopen',
          type: 'frontend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt
        },
        {
          id: 'back-reopen',
          type: 'backend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt
        }
      ])
    });

    const successReopenContext = buildContext({
      testRunIntent: { source: 'automation', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        {
          id: 'front-reopen',
          type: 'frontend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt,
          completedAt
        },
        {
          id: 'back-reopen',
          type: 'backend:test',
          status: 'succeeded',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: [],
          createdAt,
          completedAt
        }
      ]),
      workspaceChanges: {
        [baseProject.id]: {
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
        }
      },
      workingBranches: {
        [baseProject.id]: {
          name: 'feature/reopen-modal',
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
        }
      }
    });

    useAppState.mockReturnValue(successReopenContext).mockReturnValueOnce(runningReopenContext);

    const view = render(<TestTab project={baseProject} />);
    await act(async () => {});
    view.rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('modal-content')).toBeNull();
    });

    const reopenButton = await screen.findByTestId('commit-ready-button');
    expect(reopenButton).toBeInTheDocument();

    await user.click(reopenButton);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
  });

  test('shows an informational modal with no confirm button when tests pass but there are no staged changes', async () => {
    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-empty',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-empty',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: '2024-01-01T00:00:01.000Z' },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-empty',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-empty',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ]),
        workspaceChanges: {
          'proj-1': {
            stagedFiles: []
          }
        },
        workingBranches: {
          'proj-1': {
            name: 'feature/nothing-to-commit',
            stagedFiles: []
          }
        }
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Nothing to commit')).toBeInTheDocument();
    expect(screen.getByText(/no staged changes/i)).toBeInTheDocument();
    expect(screen.queryByTestId('modal-confirm')).toBeNull();
  });

  test('does not show a commit modal or attempt committing after a manual (user) test run', async () => {
    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-user',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-user',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'user', updatedAt: '2024-01-01T00:00:01.000Z' },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-user',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-user',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ]),
        workspaceChanges: {
          'proj-1': {
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
          }
        },
        workingBranches: {
          'proj-1': {
            name: 'feature/manual',
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }]
          }
        }
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(screen.queryByTestId('modal-content')).toBeNull();
      expect(screen.queryByText('Continue to commit')).toBeNull();
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('shows a failure modal when any suite fails and dispatches a run event on Fix with AI', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-2',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-2',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-2',
            type: 'frontend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', message: '✗ 1 test failed', timestamp: '2024-01-01T00:00:00.000Z' }]
          },
          {
            id: 'back-2',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }));

    const { rerender } = render(
      <TestTab project={baseProject} />
    );

    rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests failed')).toBeInTheDocument();
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Fix with AI');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    expect(dispatchSpy).toHaveBeenCalled();
    const eventArg = dispatchSpy.mock.calls.at(-1)?.[0];
    expect(eventArg?.type).toBe('lucidcoder:autofix-tests');
    expect(eventArg?.detail?.prompt).toBe('Fix failing tests');
    expect(Array.isArray(eventArg?.detail?.childPrompts)).toBe(true);
    expect(eventArg?.detail?.childPrompts.length).toBeGreaterThan(0);
  });

  test('does not show a failure modal when a suite is cancelled', async () => {
    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-cancel-1',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          },
          {
            id: 'back-cancel-1',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: []
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-cancel-1',
            type: 'frontend:test',
            status: 'cancelled',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            completedAt: '2024-01-01T00:00:01.000Z'
          },
          {
            id: 'back-cancel-1',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            completedAt: '2024-01-01T00:00:01.000Z'
          }
        ])
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(screen.queryByTestId('modal-content')).toBeNull();
    });
  });

  test('Fix with AI dispatch includes child prompts even when logs are missing', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-generic',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: new Date(Date.now() + 50).toISOString()
          },
          {
            id: 'back-generic',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: new Date(Date.now() + 50).toISOString()
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-generic',
            type: 'frontend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: undefined
          },
          {
            id: 'back-generic',
            type: 'backend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', timestamp: '2024-01-01T00:00:00.000Z' }]
          }
        ])
      }));

    const { rerender } = render(
      <TestTab project={{ id: 'proj-1' }} />
    );

    rerender(<TestTab project={{ id: 'proj-1' }} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests failed')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    expect(dispatchSpy).toHaveBeenCalled();
    const eventArg = dispatchSpy.mock.calls.at(-1)?.[0];
    expect(eventArg?.type).toBe('lucidcoder:autofix-tests');
    expect(eventArg?.detail?.prompt).toBe('Fix failing tests');
    expect(Array.isArray(eventArg?.detail?.childPrompts)).toBe(true);
    expect(eventArg?.detail?.childPrompts.length).toBeGreaterThan(0);
  });

  test('auto-starts an AI fix loop when automation-triggered tests fail', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: createdAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-auto-1',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-auto-1',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-auto-1',
            type: 'frontend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', message: '✗ 1 test failed' }],
            createdAt,
            completedAt
          },
          {
            id: 'back-auto-1',
            type: 'backend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', message: '✗ 2 tests failed' }],
            createdAt,
            completedAt
          }
        ])
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalled();
    });

    const eventArg = dispatchSpy.mock.calls.find(([evt]) => evt?.type === 'lucidcoder:autofix-tests')?.[0];
    expect(eventArg?.detail?.origin).toBe('automation');
    expect(eventArg?.detail?.prompt).toBe('Fix failing tests');
    expect(Array.isArray(eventArg?.detail?.childPrompts)).toBe(true);
    expect(eventArg?.detail?.childPrompts.length).toBeGreaterThan(0);

    // Auto-fix loop should not open the failure modal immediately.
    expect(screen.queryByTestId('modal-content')).toBeNull();
  });

  test('keeps retrying indefinitely when automation-triggered tests keep failing (until user halts)', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const buildJobPair = ({ suffix, running, createdAt, completedAt }) => {
      const front = {
        id: `front-auto-${suffix}`,
        type: 'frontend:test',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: running ? [] : [{ stream: 'stderr', message: `✗ front ${suffix}` }],
        createdAt
      };
      const back = {
        id: `back-auto-${suffix}`,
        type: 'backend:test',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: running ? [] : [{ stream: 'stderr', message: `✗ back ${suffix}` }],
        createdAt
      };

      if (running) {
        front.status = 'running';
        back.status = 'running';
      } else {
        front.status = 'failed';
        back.status = 'failed';
        front.completedAt = completedAt;
        back.completedAt = completedAt;
      }

      return [front, back];
    };

    const t1 = new Date(Date.now() + 50).toISOString();
    const t2 = new Date(Date.now() + 100).toISOString();
    const t3 = new Date(Date.now() + 150).toISOString();
    const t4 = new Date(Date.now() + 200).toISOString();
    const t5 = new Date(Date.now() + 250).toISOString();
    const t6 = new Date(Date.now() + 300).toISOString();
    const t7 = new Date(Date.now() + 350).toISOString();
    const t8 = new Date(Date.now() + 400).toISOString();

    useAppState
      // Failure cycle 1 (attempt becomes 1)
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t1 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 1, running: true, createdAt: t1 }))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t2 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 1, running: false, createdAt: t1, completedAt: t2 }))
      }))
      // Failure cycle 2 (attempt becomes 2)
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t3 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 2, running: true, createdAt: t3 }))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t4 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 2, running: false, createdAt: t3, completedAt: t4 }))
      }))
      // Failure cycle 3 (attempt becomes 3)
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t5 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 3, running: true, createdAt: t5 }))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t6 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 3, running: false, createdAt: t5, completedAt: t6 }))
      }))
      // Failure cycle 4 triggers give-up modal
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t7 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 4, running: true, createdAt: t7 }))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t8 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 4, running: false, createdAt: t7, completedAt: t8 }))
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />); // cycle1 complete
    rerender(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />); // cycle2 complete
    rerender(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />); // cycle3 complete
    rerender(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />); // cycle4 complete (still retrying)

    await waitFor(() => {
      const autofixEvents = dispatchSpy.mock.calls
        .map(([evt]) => evt)
        .filter((evt) => evt?.type === 'lucidcoder:autofix-tests');
      expect(autofixEvents.length).toBeGreaterThanOrEqual(4);
    });

    // Auto-fix loop should keep going and avoid opening the failure modal.
    expect(screen.queryByTestId('modal-content')).toBeNull();
  });

  test('shows a give-up modal when a finite autofix attempt cap is reached', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    TestTab.__testHooks.setAutofixMaxAttemptsOverride(1);

    try {
      const buildJobPair = ({ suffix, running, createdAt, completedAt }) => {
        const front = {
          id: `front-cap-${suffix}`,
          type: 'frontend:test',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: running ? [] : [{ stream: 'stderr', message: `✗ front ${suffix}` }],
          createdAt
        };
        const back = {
          id: `back-cap-${suffix}`,
          type: 'backend:test',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: running ? [] : [{ stream: 'stderr', message: `✗ back ${suffix}` }],
          createdAt
        };

        if (running) {
          front.status = 'running';
          back.status = 'running';
        } else {
          front.status = 'failed';
          back.status = 'failed';
          front.completedAt = completedAt;
          back.completedAt = completedAt;
        }

        return [front, back];
      };

      const t1 = new Date(Date.now() + 50).toISOString();
      const t2 = new Date(Date.now() + 100).toISOString();
      const t3 = new Date(Date.now() + 150).toISOString();
      const t4 = new Date(Date.now() + 200).toISOString();

      useAppState
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: t1 },
          getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 1, running: true, createdAt: t1 }))
        }))
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: t2 },
          getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 1, running: false, createdAt: t1, completedAt: t2 }))
        }))
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: t3 },
          getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 2, running: true, createdAt: t3 }))
        }))
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: t4 },
          getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 2, running: false, createdAt: t3, completedAt: t4 }))
        }));

      const { rerender } = render(<TestTab project={baseProject} />);
      rerender(<TestTab project={baseProject} />); // failure cycle 1 triggers auto-fix

      await waitFor(() => {
        const autofixEvents = dispatchSpy.mock.calls
          .map(([evt]) => evt)
          .filter((evt) => evt?.type === 'lucidcoder:autofix-tests');
        expect(autofixEvents.length).toBeGreaterThanOrEqual(1);
      });

      rerender(<TestTab project={baseProject} />);
      rerender(<TestTab project={baseProject} />); // failure cycle 2 hits max-attempt cap

      expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
      expect(screen.getByText('Tests failed')).toBeInTheDocument();
      expect(screen.getByText(/Auto-fix tried 1 times but tests are still failing\./)).toBeInTheDocument();
    } finally {
      TestTab.__testHooks.resetAutofixMaxAttemptsOverride();
    }
  });

  test('falls back to manual fix modal when auto-fix is halted after it has started', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const buildJobPair = ({ suffix, createdAt, completedAt }) => ([
      {
        id: `front-mid-halt-${suffix}`,
        type: 'frontend:test',
        status: 'failed',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: [{ stream: 'stderr', message: `✗ front ${suffix}` }],
        createdAt,
        completedAt
      },
      {
        id: `back-mid-halt-${suffix}`,
        type: 'backend:test',
        status: 'failed',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/project',
        logs: [{ stream: 'stderr', message: `✗ back ${suffix}` }],
        createdAt,
        completedAt
      }
    ]);

    const t1 = new Date(Date.now() + 50).toISOString();
    const t2 = new Date(Date.now() + 100).toISOString();
    const t3 = new Date(Date.now() + 150).toISOString();
    const t4 = new Date(Date.now() + 200).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t1 },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-mid-halt-1',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: t1
          },
          {
            id: 'back-mid-halt-1',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: t1
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t2 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 1, createdAt: t1, completedAt: t2 }))
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: t4 },
        getJobsForProject: vi.fn().mockReturnValue(buildJobPair({ suffix: 2, createdAt: t3, completedAt: t4 }))
      }));

    window.__lucidcoderAutofixHalted = false;
    try {
      const { rerender } = render(<TestTab project={baseProject} />);
      rerender(<TestTab project={baseProject} />); // first failure starts auto-fix

      await waitFor(() => {
        const autofixEvents = dispatchSpy.mock.calls
          .map(([evt]) => evt)
          .filter((evt) => evt?.type === 'lucidcoder:autofix-tests');
        expect(autofixEvents.length).toBe(1);
      });

      window.__lucidcoderAutofixHalted = true;
      rerender(<TestTab project={baseProject} />); // second failure should fall back to manual modal

      expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
      expect(screen.getByText('Tests failed')).toBeInTheDocument();
      expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Fix with AI');

      const autofixEvents = dispatchSpy.mock.calls
        .map(([evt]) => evt)
        .filter((evt) => evt?.type === 'lucidcoder:autofix-tests');
      expect(autofixEvents.length).toBe(1);
    } finally {
      window.__lucidcoderAutofixHalted = false;
    }
  });

  test('halts automation-triggered auto-fix when the global halt flag is set', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    window.__lucidcoderAutofixHalted = true;

    try {
      const createdAt = new Date(Date.now() + 50).toISOString();
      const completedAt = new Date(Date.now() + 100).toISOString();

      useAppState
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: createdAt },
          getJobsForProject: vi.fn().mockReturnValue([
            {
              id: 'front-halt',
              type: 'frontend:test',
              status: 'running',
              command: 'npm',
              args: ['run', 'test'],
              cwd: '/tmp/project',
              logs: [],
              createdAt
            },
            {
              id: 'back-halt',
              type: 'backend:test',
              status: 'running',
              command: 'npm',
              args: ['run', 'test'],
              cwd: '/tmp/project',
              logs: [],
              createdAt
            }
          ])
        }))
        .mockReturnValueOnce(buildContext({
          testRunIntent: { source: 'automation', updatedAt: completedAt },
          getJobsForProject: vi.fn().mockReturnValue([
            {
              id: 'front-halt',
              type: 'frontend:test',
              status: 'failed',
              command: 'npm',
              args: ['run', 'test'],
              cwd: '/tmp/project',
              logs: [{ stream: 'stderr', message: '✗ 1 test failed' }],
              createdAt,
              completedAt
            },
            {
              id: 'back-halt',
              type: 'backend:test',
              status: 'failed',
              command: 'npm',
              args: ['run', 'test'],
              cwd: '/tmp/project',
              logs: [{ stream: 'stderr', message: '✗ 2 tests failed' }],
              createdAt,
              completedAt
            }
          ])
        }));

      const { rerender } = render(<TestTab project={baseProject} />);
      rerender(<TestTab project={baseProject} />);

      // Should NOT auto-dispatch auto-fix when halted.
      const autofixEvents = dispatchSpy.mock.calls
        .map(([evt]) => evt)
        .filter((evt) => evt?.type === 'lucidcoder:autofix-tests');
      expect(autofixEvents.length).toBe(0);

      // Falls back to the manual "Fix with AI" modal.
      expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
      expect(screen.getByText('Tests failed')).toBeInTheDocument();
      expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Fix with AI');
    } finally {
      window.__lucidcoderAutofixHalted = false;
    }
  });

  test('falls back to an unknown run source when testRunIntent.source is not a string', async () => {
    useAppState
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: null, updatedAt: '2024-01-01T00:00:00.000Z' },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-unknown',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: new Date(Date.now() + 50).toISOString()
          },
          {
            id: 'back-unknown',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt: new Date(Date.now() + 50).toISOString()
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: null, updatedAt: '2024-01-01T00:00:01.000Z' },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-unknown',
            type: 'frontend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', message: '✗ 1 test failed' }]
          },
          {
            id: 'back-unknown',
            type: 'backend:test',
            status: 'failed',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [{ stream: 'stderr', message: '✗ 1 test failed' }]
          }
        ])
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests failed')).toBeInTheDocument();
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Fix with AI');
  });

  describe('Helper exports', () => {
    test('statusLabel falls back to Idle and supports passthrough text', () => {
      expect(TestTab.__testHooks.statusLabel()).toBe('Idle');
      expect(TestTab.__testHooks.statusLabel('weird')).toBe('weird');
    });

    test('statusLabel maps common statuses', () => {
      expect(TestTab.__testHooks.statusLabel('queued')).toBe('Queued');
      expect(TestTab.__testHooks.statusLabel('starting')).toBe('Starting');
      expect(TestTab.__testHooks.statusLabel('pending')).toBe('Pending');
      expect(TestTab.__testHooks.statusLabel('running')).toBe('Running');
      expect(TestTab.__testHooks.statusLabel('succeeded')).toBe('Passed');
      expect(TestTab.__testHooks.statusLabel('failed')).toBe('Failed');
      expect(TestTab.__testHooks.statusLabel('cancelled')).toBe('Cancelled');
    });

    test('classifyLogToken returns null for unrecognized tokens', () => {
      expect(TestTab.__testHooks.classifyLogToken('skipped')).toBeNull();
    });

    test('formatDurationSeconds handles empty, invalid, and completed jobs', () => {
      expect(TestTab.__testHooks.formatDurationSeconds({})).toBeNull();
      expect(TestTab.__testHooks.formatDurationSeconds({ startedAt: 'not-a-date' })).toBeNull();
      expect(
        TestTab.__testHooks.formatDurationSeconds({
          startedAt: '2024-01-01T00:00:00.000Z',
          completedAt: '2024-01-01T00:00:02.500Z'
        })
      ).toBe('2.5s');
    });

    test('formatLogMessage strips ANSI characters and highlights tokens', () => {
      const log = '\u001b[31m✗ 2 tests failed in 10s';
      render(<div data-testid="log-output">{TestTab.__testHooks.formatLogMessage(log)}</div>);
      const container = screen.getByTestId('log-output');
      expect(container.querySelectorAll('.log-highlight.fail').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.log-highlight.duration').length).toBeGreaterThan(0);
    });

    test('formatLogMessage returns raw value when log is empty', () => {
      expect(TestTab.__testHooks.formatLogMessage()).toBe('');
    });

    test('formatLogMessage preserves trailing text after highlighted tokens', () => {
      render(
        <div data-testid="log-tail">
          {TestTab.__testHooks.formatLogMessage('✓ Tests completed successfully')}
        </div>
      );
      expect(screen.getByTestId('log-tail').textContent).toBe('✓ Tests completed successfully');
    });

    test('formatLogMessage pushes raw segments when classifier override suppresses tokens', () => {
      try {
        TestTab.__testHooks.setClassifyLogTokenOverride(() => null);

        render(
          <div data-testid="neutral-log">
            {TestTab.__testHooks.formatLogMessage('✓ 1 test passed in 5s')}
          </div>
        );

        const neutralLog = screen.getByTestId('neutral-log');
        expect(neutralLog.querySelectorAll('.log-highlight').length).toBe(0);
        expect(neutralLog.textContent).toBe('✓ 1 test passed in 5s');
      } finally {
        TestTab.__testHooks.resetClassifyLogTokenOverride();
      }
    });

    test('setClassifyLogTokenOverride ignores non-function inputs', () => {
      try {
        TestTab.__testHooks.setClassifyLogTokenOverride(() => 'custom');
        expect(TestTab.__testHooks.classifyLogToken('any')).toBe('custom');

        TestTab.__testHooks.setClassifyLogTokenOverride('not-a-function');
        expect(TestTab.__testHooks.classifyLogToken('✓')).toBe('pass');
      } finally {
        TestTab.__testHooks.resetClassifyLogTokenOverride();
      }
    });
  });

  test('result modal modalKey falls back to completedAt when createdAt is missing', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    useAppState
      .mockReturnValueOnce(buildContext({
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-key',
            type: 'frontend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          },
          {
            id: 'back-key',
            type: 'backend:test',
            status: 'running',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            createdAt
          }
        ])
      }))
      .mockReturnValueOnce(buildContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        getJobsForProject: vi.fn().mockReturnValue([
          {
            id: 'front-key',
            type: 'frontend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            completedAt
          },
          {
            id: 'back-key',
            type: 'backend:test',
            status: 'succeeded',
            command: 'npm',
            args: ['run', 'test'],
            cwd: '/tmp/project',
            logs: [],
            completedAt
          }
        ]),
        workspaceChanges: {
          'proj-1': {
            stagedFiles: [{ path: 'src/key.js', timestamp: 'now' }]
          }
        },
        workingBranches: {
          'proj-1': {
            name: 'feature/key-fallback',
            stagedFiles: [{ path: 'src/key.js', timestamp: 'now' }]
          }
        }
      }));

    const { rerender } = render(<TestTab project={baseProject} />);
    rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Tests passed')).toBeInTheDocument();
  });

  describe('Instance hooks', () => {
    test('getActiveJobs exposes current active job list', async () => {
      const getJobsForProject = vi.fn().mockReturnValue([
        {
          id: 'job-active',
          type: 'frontend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: []
        }
      ]);
      useAppState.mockReturnValue(buildContext({ getJobsForProject }));

      render(<TestTab project={baseProject} />);
      const hooks = await waitForInstanceHooks();

      const activeJobs = hooks.getActiveJobs();
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs[0].id).toBe('job-active');
    });

    test('handleCancel exits early when no job is provided', async () => {
      const cancelAutomationJob = vi.fn();
      useAppState.mockReturnValue(buildContext({ cancelAutomationJob }));
      render(<TestTab project={baseProject} />);

      const hooks = await waitForInstanceHooks();
      await act(async () => {
        await hooks.handleCancel();
      });

      expect(cancelAutomationJob).not.toHaveBeenCalled();
    });

    test('handleCancel captures cancellation errors locally', async () => {
      const cancelAutomationJob = vi.fn().mockRejectedValue(new Error('cancel boom'));
      const getJobsForProject = vi.fn().mockReturnValue([
        {
          id: 'job-err',
          type: 'frontend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: []
        }
      ]);
      useAppState.mockReturnValue(buildContext({ cancelAutomationJob, getJobsForProject }));

      render(<TestTab project={baseProject} />);
      const hooks = await waitForInstanceHooks();

      await act(async () => {
        await hooks.handleCancel({ id: 'job-err' });
      });

      expect(hooks.getLocalError()).toBe('cancel boom');
      expect(await screen.findByTestId('test-error-banner')).toHaveTextContent('cancel boom');
    });

    test('getResultModalState reflects the latest modal snapshot', async () => {
      useAppState.mockReturnValue(buildContext());
      render(<TestTab project={baseProject} />);

      const hooks = await waitForInstanceHooks();
      const modalState = hooks.getResultModalState();

      expect(modalState).toMatchObject({
        title: '',
        message: '',
        variant: 'default',
        isOpen: false,
        isProcessing: false
      });
    });

    test('handleRun surfaces automation start failures', async () => {
      const startAutomationJob = vi.fn().mockRejectedValue(new Error('start boom'));
      useAppState.mockReturnValue(buildContext({ startAutomationJob }));

      render(<TestTab project={baseProject} />);
      const hooks = await waitForInstanceHooks();

      await act(async () => {
        await hooks.handleRun('frontend:test');
      });

      expect(hooks.getLocalError()).toBe('start boom');
      expect(await screen.findByTestId('test-error-banner')).toHaveTextContent('start boom');
    });

    test('handleCancelActiveRuns reports failures when canceling multiple jobs', async () => {
      const cancelAutomationJob = vi.fn().mockRejectedValue(new Error('bulk cancel failed'));
      const getJobsForProject = vi.fn().mockReturnValue([
        {
          id: 'job-bulk',
          type: 'frontend:test',
          status: 'running',
          command: 'npm',
          args: ['run', 'test'],
          cwd: '/tmp/project',
          logs: []
        }
      ]);
      useAppState.mockReturnValue(buildContext({ cancelAutomationJob, getJobsForProject }));

      render(<TestTab project={baseProject} registerTestActions={vi.fn()} />);
      const hooks = await waitForInstanceHooks();

      await act(async () => {
        await hooks.handleCancelActiveRuns();
      });

      expect(hooks.getLocalError()).toBe('bulk cancel failed');
      expect(await screen.findByTestId('test-error-banner')).toHaveTextContent('bulk cancel failed');
    });
  });

  describe('Test hook guards', () => {
    test('skips hook wiring when hooks container is missing', async () => {
      const originalHooks = TestTab.__testHooks;
      TestTab.__testHooks = undefined;

      render(<TestTab project={baseProject} />);

      await waitFor(() => {
        expect(TestTab.__testHooks).toBeUndefined();
      });

      TestTab.__testHooks = originalHooks || {};
    });

    test('cleanup guard exits when hooks container disappears before unmount', async () => {
      const originalHooks = TestTab.__testHooks;
      const tempHooks = {};
      TestTab.__testHooks = tempHooks;

      const { unmount } = render(<TestTab project={baseProject} />);

      await waitFor(() => {
        expect(typeof tempHooks.handleRun).toBe('function');
      });

      TestTab.__testHooks = undefined;

      expect(() => {
        unmount();
      }).not.toThrow();

      expect(typeof tempHooks.handleRun).toBe('function');

      TestTab.__testHooks = originalHooks || {};
    });

    test('cleanup resets hook references when container persists', async () => {
      const originalHooks = TestTab.__testHooks;
      const tempHooks = {};
      TestTab.__testHooks = tempHooks;

      const { unmount } = render(<TestTab project={baseProject} />);

      await waitFor(() => {
        expect(typeof tempHooks.handleRun).toBe('function');
        expect(typeof tempHooks.handleCancel).toBe('function');
      });

      unmount();

      expect(tempHooks.handleRun).toBeUndefined();
      expect(tempHooks.handleCancel).toBeUndefined();

      TestTab.__testHooks = originalHooks || {};
    });
  });
});
