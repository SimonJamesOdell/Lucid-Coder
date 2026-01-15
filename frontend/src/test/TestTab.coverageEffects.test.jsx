import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  testRunIntent: { source: 'automation', updatedAt: '2024-01-01T00:00:00.000Z' },
  ...overrides
});

describe('TestTab coverage effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure these do not leak between tests.
    TestTab.__testHooks.resetAutofixMaxAttemptsOverride?.();
    delete window.__lucidcoderAutofixHalted;
  });

  test('does not open pass/fail modal when either suite is cancelled', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const initial = buildContext({
      testRunIntent: { source: 'automation', updatedAt: createdAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-1', type: 'frontend:test', status: 'running', logs: [], createdAt },
        { id: 'back-1', type: 'backend:test', status: 'running', logs: [], createdAt }
      ])
    });

    const completed = buildContext({
      testRunIntent: { source: 'automation', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-1', type: 'frontend:test', status: 'cancelled', logs: [], createdAt, completedAt },
        { id: 'back-1', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
      ])
    });

    let context = initial;
    useAppState.mockImplementation(() => context);

    const view = render(<TestTab project={baseProject} />);

    context = completed;
    view.rerender(<TestTab project={baseProject} />);

    await act(async () => {});
    expect(screen.queryByTestId('modal-content')).toBeNull();
  });

  test('suppresses completion modal after the user cancels a suite run', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const initial = buildContext({
      testRunIntent: { source: 'user', updatedAt: createdAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-2', type: 'frontend:test', status: 'running', logs: [], createdAt },
        { id: 'back-2', type: 'backend:test', status: 'running', logs: [], createdAt }
      ])
    });

    const completed = buildContext({
      testRunIntent: { source: 'user', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-2', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
        { id: 'back-2', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
      ])
    });

    let context = initial;
    useAppState.mockImplementation(() => context);

    const view = render(<TestTab project={baseProject} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('cancel-frontend:test'));

    context = completed;
    view.rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(screen.queryByTestId('modal-content')).toBeNull();
    });
  });

  test('suppresses completion modal when the backend suite was cancelled', async () => {
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const initial = buildContext({
      testRunIntent: { source: 'user', updatedAt: createdAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-4', type: 'frontend:test', status: 'running', logs: [], createdAt },
        { id: 'back-4', type: 'backend:test', status: 'running', logs: [], createdAt }
      ])
    });

    const completed = buildContext({
      testRunIntent: { source: 'user', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-4', type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt },
        { id: 'back-4', type: 'backend:test', status: 'succeeded', logs: [], createdAt, completedAt }
      ])
    });

    let context = initial;
    useAppState.mockImplementation(() => context);

    const view = render(<TestTab project={baseProject} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('cancel-backend:test'));

    context = completed;
    view.rerender(<TestTab project={baseProject} />);

    await waitFor(() => {
      expect(screen.queryByTestId('modal-content')).toBeNull();
    });
  });

  test('shows a max-attempts modal when auto-fix reaches its limit', async () => {
    TestTab.__testHooks.setAutofixMaxAttemptsOverride?.(0);

    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();

    const initial = buildContext({
      testRunIntent: { source: 'automation', updatedAt: createdAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-3', type: 'frontend:test', status: 'running', logs: [], createdAt },
        { id: 'back-3', type: 'backend:test', status: 'running', logs: [], createdAt }
      ])
    });

    const completed = buildContext({
      testRunIntent: { source: 'automation', updatedAt: completedAt },
      getJobsForProject: vi.fn().mockReturnValue([
        { id: 'front-3', type: 'frontend:test', status: 'failed', logs: [], createdAt, completedAt },
        { id: 'back-3', type: 'backend:test', status: 'failed', logs: [], createdAt, completedAt }
      ])
    });

    let context = initial;
    useAppState.mockImplementation(() => context);

    const view = render(<TestTab project={baseProject} />);

    context = completed;
    view.rerender(<TestTab project={baseProject} />);

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText(/Auto-fix tried 0 times but tests are still failing/i)).toBeInTheDocument();

    TestTab.__testHooks.resetAutofixMaxAttemptsOverride?.();
  });
});
