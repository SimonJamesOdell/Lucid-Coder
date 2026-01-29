import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProcessesTab, {
  normalizeStatus,
  formatTimestamp,
  resolvePortValue,
  deriveDisplayStatus,
  computeProcessSnapshot,
  ProcessColumn
} from '../components/ProcessesTab';

const mockProject = { id: 42, name: 'Demo Project' };

const buildProcessInfo = (overrides = {}) => ({
  projectId: mockProject.id,
  fetchedAt: new Date().toISOString(),
  processes: {
    frontend: {
      pid: 1111,
      status: 'running',
      port: 5173,
      lastHeartbeat: '2025-11-29T10:00:00.000Z',
      logs: [
        { stream: 'stdout', message: 'Frontend ready', timestamp: '2025-11-29T10:00:00.000Z' }
      ],
      ...overrides.processes?.frontend
    },
    backend: {
      pid: 2222,
      status: 'running',
      port: 6500,
      lastHeartbeat: '2025-11-29T10:00:05.000Z',
      logs: [
        { stream: 'stdout', message: 'Backend ready', timestamp: '2025-11-29T10:00:05.000Z' }
      ],
      ...overrides.processes?.backend
    }
  },
  ports: {
    active: { frontend: 5173, backend: 6500 },
    stored: { frontend: 5173, backend: 6500 },
    preferred: { frontend: 5173, backend: 3000 },
    ...overrides.ports
  }
});

const renderProcessesTab = (props = {}) => {
  const defaultProps = {
    project: mockProject,
    processInfo: buildProcessInfo(),
    onRefreshStatus: vi.fn().mockResolvedValue(null),
    onRestartProject: vi.fn().mockResolvedValue(null),
    onStopProject: vi.fn().mockResolvedValue(null)
  };
  const mergedProps = { ...defaultProps, ...props };
  render(<ProcessesTab {...mergedProps} />);
  return mergedProps;
};

describe('ProcessesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders empty state when no project is selected', () => {
    render(<ProcessesTab project={null} processInfo={null} />);
    expect(screen.getByTestId('processes-tab-empty')).toBeInTheDocument();
  });

  test('shows process metadata and logs for both frontend and backend', () => {
    renderProcessesTab();

    const frontendColumn = screen.getByTestId('process-column-frontend');
    expect(
      within(frontendColumn).getByRole('heading', { name: /frontend/i })
    ).toBeInTheDocument();
    expect(within(frontendColumn).getByText('1111')).toBeInTheDocument();
    const frontendPortLabel = within(frontendColumn).getByText('Port');
    expect(frontendPortLabel.nextElementSibling).toHaveTextContent('5173');

    const frontendLogs = screen.getByTestId('process-logs-frontend');
    expect(within(frontendLogs).getByText(/frontend ready/i)).toBeInTheDocument();

    const backendColumn = screen.getByTestId('process-column-backend');
    expect(within(backendColumn).getByText('2222')).toBeInTheDocument();
    const backendPortLabel = within(backendColumn).getByText('Port');
    expect(backendPortLabel.nextElementSibling).toHaveTextContent('6500');

    const backendLogs = screen.getByTestId('process-logs-backend');
    expect(within(backendLogs).getByText(/backend ready/i)).toBeInTheDocument();
  });

  test('renders placeholder data when process info is missing', () => {
    renderProcessesTab({ processInfo: null });

    const frontendColumn = screen.getByTestId('process-column-frontend');
    expect(frontendColumn).toBeInTheDocument();
    const pidLabel = within(frontendColumn).getByText('PID');
    expect(pidLabel.nextElementSibling).toHaveTextContent('—');
    expect(within(screen.getByTestId('process-logs-frontend')).getByText('No output captured yet.')).toBeInTheDocument();
  });

  test('uses the start label when a process is idle', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: { status: 'idle' }
      }
    });

    renderProcessesTab({ processInfo });

    const restartButton = screen.getByTestId('process-restart-frontend');
    expect(restartButton).toHaveTextContent('Start project');

    const stopButton = screen.getByTestId('process-stop-frontend');
    expect(stopButton).toBeDisabled();
  });

  test('promotes starting status to running when the process has activity', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: {
          status: 'starting',
          port: null,
          lastHeartbeat: null,
          logs: [{ stream: 'stdout', message: 'Booted', timestamp: '2025-11-29T10:00:12.000Z' }]
        }
      }
    });

    renderProcessesTab({ processInfo });

    const frontendColumn = screen.getByTestId('process-column-frontend');
    expect(within(frontendColumn).queryByText(/starting/i)).toBeNull();
    const runningBadges = within(frontendColumn).getAllByText(/running/i);
    expect(runningBadges.length).toBeGreaterThan(0);
  });

  test('treats starting processes with only heartbeat data as running', () => {
    const processInfo = buildProcessInfo({
      processes: {
        frontend: {
          status: 'starting',
          port: null,
          logs: [],
          lastHeartbeat: '2025-11-29T10:05:00.000Z'
        }
      }
    });

    renderProcessesTab({ processInfo });

    const frontendColumn = screen.getByTestId('process-column-frontend');
    expect(within(frontendColumn).getAllByText(/running/i).length).toBeGreaterThan(0);
  });

  test('shows log-empty placeholder when no output exists', () => {
    const processInfo = buildProcessInfo({
      processes: {
        backend: {
          logs: []
        }
      }
    });

    renderProcessesTab({ processInfo });

    const backendLogs = screen.getByTestId('process-logs-backend');
    expect(within(backendLogs).getByText('No output captured yet.')).toBeInTheDocument();
  });

  test('log timestamps fall back to friendly labels for missing or invalid values', () => {
    const processInfo = buildProcessInfo({
      processes: {
        backend: {
          logs: [
            { stream: 'stdout', message: 'Fresh log', timestamp: null },
            { stream: 'stderr', message: 'Odd log', timestamp: 'not-a-date' }
          ]
        }
      }
    });

    renderProcessesTab({ processInfo });

    const backendLogs = screen.getByTestId('process-logs-backend');
    const timestamps = within(backendLogs).getAllByText(/Just now|Recently/);
    expect(timestamps).toHaveLength(2);
    expect(timestamps.map((node) => node.textContent)).toEqual(['Just now', 'Recently']);
  });

  test('invokes refresh handler with current project id', async () => {
    const user = userEvent.setup();
    const onRefreshStatus = vi.fn().mockResolvedValue(null);
    renderProcessesTab({ onRefreshStatus });

    const frontendButton = screen.getByTestId('process-refresh-frontend');
    const backendButton = screen.getByTestId('process-refresh-backend');

    await user.click(frontendButton);
    await user.click(backendButton);

    expect(onRefreshStatus).toHaveBeenCalledTimes(2);
    expect(onRefreshStatus).toHaveBeenNthCalledWith(1, mockProject.id);
    expect(onRefreshStatus).toHaveBeenNthCalledWith(2, mockProject.id);

    await waitFor(() => expect(frontendButton).not.toBeDisabled());
    await waitFor(() => expect(backendButton).not.toBeDisabled());
  });

  test('invokes restart handler and clears busy state after completion', async () => {
    const user = userEvent.setup();
    const onRestartProject = vi.fn().mockResolvedValue(null);
    renderProcessesTab({ onRestartProject });

    const button = screen.getByTestId('process-restart-backend');
    await user.click(button);

    expect(onRestartProject).toHaveBeenCalledWith(mockProject.id, 'backend');
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  test('invokes stop handler for a single target and keeps other stop button enabled', async () => {
    const user = userEvent.setup();
    let resolveStop;
    const onStopProject = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveStop = resolve;
      })
    );

    renderProcessesTab({ onStopProject });

    const frontendStopButton = screen.getByTestId('process-stop-frontend');
    const backendStopButton = screen.getByTestId('process-stop-backend');

    await user.click(frontendStopButton);

    expect(onStopProject).toHaveBeenCalledTimes(1);
    expect(onStopProject).toHaveBeenCalledWith(mockProject.id, 'frontend');

    expect(frontendStopButton).toBeDisabled();
    expect(backendStopButton).not.toBeDisabled();

    resolveStop();
    await waitFor(() => expect(frontendStopButton).not.toBeDisabled());
    await waitFor(() => expect(backendStopButton).not.toBeDisabled());
  });

  test('invokes stop handler for the backend target', async () => {
    const user = userEvent.setup();
    const onStopProject = vi.fn().mockResolvedValue(null);
    renderProcessesTab({ onStopProject });

    const backendStopButton = screen.getByTestId('process-stop-backend');
    await user.click(backendStopButton);

    expect(onStopProject).toHaveBeenCalledTimes(1);
    expect(onStopProject).toHaveBeenCalledWith(mockProject.id, 'backend');
  });

  test('keeps refresh actions independent per column', async () => {
    const user = userEvent.setup();
    let resolveRefresh;
    const onRefreshStatus = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    renderProcessesTab({ onRefreshStatus });

    const frontendButton = screen.getByTestId('process-refresh-frontend');
    const backendButton = screen.getByTestId('process-refresh-backend');

    await user.click(frontendButton);

    expect(frontendButton).toBeDisabled();
    expect(backendButton).not.toBeDisabled();

    resolveRefresh();
    await waitFor(() => expect(frontendButton).not.toBeDisabled());
  });

  test('keeps restart actions independent per column', async () => {
    const user = userEvent.setup();
    let resolveRestart;
    const onRestartProject = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        resolveRestart = resolve;
      })
    );
    renderProcessesTab({ onRestartProject });

    const backendButton = screen.getByTestId('process-restart-backend');
    const frontendButton = screen.getByTestId('process-restart-frontend');

    await user.click(backendButton);

    expect(backendButton).toBeDisabled();
    expect(frontendButton).not.toBeDisabled();

    resolveRestart();
    await waitFor(() => expect(backendButton).not.toBeDisabled());
  });

  test('refresh action guard prevents requests when project id is missing', async () => {
    const user = userEvent.setup();
    const onRefreshStatus = vi.fn();
    renderProcessesTab({
      project: { id: null, name: 'No ID Project' },
      onRefreshStatus
    });

    const refreshButton = screen.getByTestId('process-refresh-frontend');
    await user.click(refreshButton);

    expect(onRefreshStatus).not.toHaveBeenCalled();
  });

  test('restart action guard prevents requests when project id is missing', async () => {
    const user = userEvent.setup();
    const onRestartProject = vi.fn();
    renderProcessesTab({
      project: { id: null, name: 'No ID Project' },
      onRestartProject
    });

    const restartButton = screen.getByTestId('process-restart-backend');
    await user.click(restartButton);

    expect(onRestartProject).not.toHaveBeenCalled();
  });

  test('stop action guard prevents requests when project id is missing', async () => {
    const user = userEvent.setup();
    const onStopProject = vi.fn();
    renderProcessesTab({
      project: { id: null, name: 'No ID Project' },
      onStopProject
    });

    const stopButton = screen.getByTestId('process-stop-frontend');
    expect(stopButton).toBeDisabled();
    await user.click(stopButton);

    expect(onStopProject).not.toHaveBeenCalled();
  });

  test('refresh guard bails when handler is missing', async () => {
    const user = userEvent.setup();
    renderProcessesTab({ onRefreshStatus: null });

    const refreshButton = screen.getByTestId('process-refresh-frontend');
    await user.click(refreshButton);

    expect(refreshButton).toBeEnabled();
  });

  test('restart guard bails when handler is missing', async () => {
    const user = userEvent.setup();
    renderProcessesTab({ onRestartProject: null });

    const restartButton = screen.getByTestId('process-restart-frontend');
    await user.click(restartButton);

    expect(restartButton).toBeEnabled();
  });

  test('stop guard disables when handler is missing', () => {
    renderProcessesTab({ onStopProject: null });
    expect(screen.getByTestId('process-stop-frontend')).toBeDisabled();
    expect(screen.getByTestId('process-stop-backend')).toBeDisabled();
  });
});

describe('ProcessColumn component', () => {
  test('falls back to label-derived column keys and preferred ports when key is missing', () => {
    const onRefresh = vi.fn();
    const onRestart = vi.fn();
    const onStop = vi.fn();

    render(
      <ProcessColumn
        label="Docs"
        process={{ status: 'idle', logs: [] }}
        ports={{ preferred: { docs: 8800 } }}
        onRefresh={onRefresh}
        onRestart={onRestart}
        onStop={onStop}
        isRefreshing={false}
        isRestarting={false}
        isStopping={false}
      />
    );

    expect(screen.getByTestId('process-column-docs')).toBeInTheDocument();
    expect(screen.getByTestId('process-refresh-docs')).toBeInTheDocument();
    const portLabel = within(screen.getByTestId('process-column-docs')).getByText('Port');
    expect(portLabel.nextElementSibling).toHaveTextContent('8800');
  });

  test('renders logs with timestamps for active processes', () => {
    render(
      <ProcessColumn
        label="Workers"
        process={{ status: 'running', logs: [{ message: 'Boot complete', timestamp: '2025-11-29T11:00:00Z' }] }}
        ports={{ active: { workers: 9900 } }}
        onRefresh={vi.fn()}
        onRestart={vi.fn()}
        onStop={vi.fn()}
        isRefreshing={false}
        isRestarting={false}
        isStopping={false}
      />
    );

    const logList = screen.getByTestId('process-logs-workers');
    expect(within(logList).getByText('Boot complete')).toBeInTheDocument();
    const timestamp = logList.querySelector('.log-timestamp');
    expect(timestamp).not.toBeNull();
  });
});

describe('process helper utils', () => {
  test('normalizeStatus defaults to idle', () => {
    expect(normalizeStatus()).toBe('idle');
    expect(normalizeStatus('running')).toBe('running');
  });

  test('formatTimestamp handles invalid dates gracefully', () => {
    expect(formatTimestamp()).toBe('Just now');
    expect(formatTimestamp('not-a-date')).toBe('Recently');
  });

  test('resolvePortValue walks through available bundles', () => {
    const ports = {
      active: { frontend: 5173 },
      stored: { frontend: 5174 },
      preferred: { frontend: 3000 }
    };
    expect(resolvePortValue(ports, 'frontend')).toBe(5173);
    expect(resolvePortValue(null, 'frontend')).toBeNull();
  });

  test('resolvePortValue falls back to stored values when active ports are missing', () => {
    const ports = {
      stored: { frontend: 6200 },
      preferred: { frontend: 7200 }
    };
    expect(resolvePortValue(ports, 'frontend')).toBe(6200);
  });

  test('resolvePortValue falls back to preferred values when no stored ports exist', () => {
    const ports = {
      preferred: { frontend: 7300 }
    };
    expect(resolvePortValue(ports, 'frontend')).toBe(7300);
  });

  test('resolvePortValue returns null when no port data is available', () => {
    const ports = { active: {}, stored: {}, preferred: {} };
    expect(resolvePortValue(ports, 'frontend')).toBeNull();
  });

  test('deriveDisplayStatus promotes starting with activity', () => {
    const base = { status: 'starting' };
    expect(deriveDisplayStatus(base)).toBe('starting');
    expect(deriveDisplayStatus({ ...base, port: 5173 })).toBe('running');
    expect(deriveDisplayStatus({ ...base, lastHeartbeat: '2025-01-01T00:00:00Z' })).toBe('running');
  });

  test('computeProcessSnapshot returns data only when ids align', () => {
    const info = buildProcessInfo();
    const snapshot = computeProcessSnapshot(mockProject.id, info);
    expect(snapshot.processes.frontend).toEqual(expect.any(Object));
    expect(snapshot.ports).toEqual(expect.any(Object));

    const emptySnapshot = computeProcessSnapshot('other-project', info);
    expect(emptySnapshot.processes.frontend).toBeNull();
    expect(emptySnapshot.ports).toBeNull();
  });

  test('computeProcessSnapshot handles missing process info', () => {
    const snapshot = computeProcessSnapshot(mockProject.id, null);
    expect(snapshot.processes.frontend).toBeNull();
    expect(snapshot.ports).toBeNull();
  });

  test('computeProcessSnapshot handles missing project ids', () => {
    const info = buildProcessInfo();
    const snapshot = computeProcessSnapshot(null, info);
    expect(snapshot.processes.backend).toBeNull();
    expect(snapshot.ports).toBeNull();
  });

  test('computeProcessSnapshot fills nulls for missing processes even when ids match', () => {
    const info = {
      projectId: mockProject.id,
      processes: {},
      ports: undefined
    };
    const snapshot = computeProcessSnapshot(mockProject.id, info);
    expect(snapshot.processes.frontend).toBeNull();
    expect(snapshot.processes.backend).toBeNull();
    expect(snapshot.ports).toBeNull();
  });
});
