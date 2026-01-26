import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';

import RunsTab from '../components/RunsTab.jsx';

vi.mock('axios', () => ({
  default: {
    get: vi.fn()
  }
}));

describe('RunsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders empty state when no project is selected', () => {
    render(<RunsTab project={null} />);

    expect(screen.getByTestId('runs-empty')).toBeInTheDocument();
    expect(screen.getByTestId('runs-refresh')).toBeDisabled();
  });

  test('loads runs list and shows run details with events', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 12,
              kind: 'job',
              status: 'completed',
              statusMessage: 'Build Project',
              createdAt: '2026-01-26T00:00:00.000Z',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:01:03.000Z'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 12,
            kind: 'job',
            status: 'completed',
            statusMessage: 'Build Project',
            sessionId: 'job-12',
            startedAt: '2026-01-26T00:00:01.000Z',
            finishedAt: '2026-01-26T00:01:03.000Z'
          },
          events: [
            {
              id: 1,
              timestamp: '2026-01-26T00:00:01.500Z',
              type: 'job:log',
              message: 'Hello from job'
            }
          ]
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    // Cover minute+seconds duration formatting
    expect(screen.getByText('1m 2s')).toBeInTheDocument();

    await user.click(screen.getByTestId('run-row-12'));

    expect(await screen.findByTestId('runs-detail-title')).toHaveTextContent('Build Project');
    expect(await screen.findByTestId('runs-events-list')).toBeInTheDocument();
    expect(screen.getByText('Hello from job')).toBeInTheDocument();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith('/api/projects/123/runs');
      expect(axios.get).toHaveBeenCalledWith(
        '/api/projects/123/runs/12',
        expect.objectContaining({ params: { includeEvents: 1 } })
      );
    });
  });

  test('shows loading state while runs are refreshing', async () => {
    let resolveRuns;
    const runsPromise = new Promise((resolve) => {
      resolveRuns = resolve;
    });

    axios.get.mockReturnValueOnce(runsPromise);

    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(screen.getByTestId('runs-refresh')).toBeDisabled();
    expect(screen.getByTestId('runs-refresh')).toHaveTextContent('Refreshing');

    resolveRuns({ data: { runs: [] } });

    expect(await screen.findByTestId('runs-none')).toBeInTheDocument();
    expect(screen.getByTestId('runs-refresh')).not.toBeDisabled();
  });

  test('renders error and empty list when runs loading fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('Boom'));

    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-error')).toHaveTextContent('Boom');
    expect(screen.getByTestId('runs-none')).toBeInTheDocument();
  });

  test('falls back to default runs load error message when error has no message', async () => {
    axios.get.mockRejectedValueOnce({});

    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-error')).toHaveTextContent('Failed to load runs');
    expect(screen.getByTestId('runs-none')).toBeInTheDocument();
  });

  test('handles malformed runs list payloads by falling back to an empty list', async () => {
    axios.get.mockResolvedValueOnce({ data: { ok: true } });

    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-none')).toBeInTheDocument();
  });

  test('clears selected run when it disappears after refresh', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 1,
              kind: 'job',
              status: 'completed',
              statusMessage: 'First',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:00:02.000Z'
            },
            {
              id: 2,
              kind: 'job',
              status: 'failed',
              statusMessage: 'Second',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:00:03.000Z'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 2,
            kind: 'job',
            status: 'failed',
            statusMessage: 'Second'
          },
          events: []
        }
      })
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 1,
              kind: 'job',
              status: 'completed',
              statusMessage: 'First',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:00:02.000Z'
            }
          ]
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    await user.click(screen.getByTestId('run-row-2'));
    expect(await screen.findByTestId('runs-detail-title')).toHaveTextContent('Second');

    await user.click(screen.getByTestId('runs-refresh'));

    await waitFor(() => {
      expect(screen.queryByTestId('run-row-2')).not.toBeInTheDocument();
    });

    expect(await screen.findByTestId('runs-detail-empty')).toBeInTheDocument();
  });

  test('supports alternate details payloads and formatting fallbacks', async () => {
    const originalToLocaleString = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = () => {
      throw new Error('toLocaleString failed');
    };

    try {
      axios.get
        .mockResolvedValueOnce({
          // list as an array (not wrapped in { runs })
          data: [
            {
              id: 9,
              kind: 'job',
              status: 'cancelled',
              statusMessage: '',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:00:00.000Z'
            },
            {
              id: 8,
              kind: '',
              status: 'running',
              // invalid date should fall back to iso string
              startedAt: 'not-a-date',
              finishedAt: '2026-01-26T00:00:03.000Z'
            }
          ]
        })
        .mockResolvedValueOnce({
          // details are in response.data directly; events come from run.events
          data: {
            id: 9,
            kind: 'job',
            status: 'cancelled',
            statusMessage: 'Cancelled run',
            error: 'Something went wrong',
            startedAt: '2026-01-26T00:00:01.000Z',
            finishedAt: '2026-01-26T00:00:00.000Z',
            events: [
              {
                timestamp: '2026-01-26T00:00:01.500Z',
                type: 'note',
                message: 'Hi'
              },
              {
                timestamp: '2026-01-26T00:00:02.000Z',
                type: ''
              }
            ]
          }
        });

      const user = userEvent.setup();
      render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

      expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

      // Cover statusClass branches via list badges
      expect(screen.getAllByText(/cancelled|running/i).length).toBeGreaterThan(0);

      // Cover invalid date fallback
      expect(screen.getByText('not-a-date')).toBeInTheDocument();

      await user.click(screen.getByTestId('run-row-9'));

      // toLocaleString throws -> formatIso should fall back to raw ISO
      const detail = screen.getByLabelText('Run details');
      expect(await within(detail).findByText('2026-01-26T00:00:01.000Z')).toBeInTheDocument();

      expect(await screen.findByTestId('runs-detail-error')).toHaveTextContent('Something went wrong');
      expect(await screen.findByTestId('runs-events-list')).toBeInTheDocument();
      expect(screen.getByText('Hi')).toBeInTheDocument();

      // duration invalid (end < start) -> should display placeholder in details
      expect(screen.getByText('Duration')).toBeInTheDocument();
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    } finally {
      Date.prototype.toLocaleString = originalToLocaleString;
    }
  });

  test('shows detail loading state and surfaces errors when run detail fetch fails', async () => {
    let rejectDetails;
    const detailPromise = new Promise((_, reject) => {
      rejectDetails = reject;
    });

    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 1,
              kind: 'job',
              status: 'running',
              statusMessage: 'In progress',
              startedAt: '2026-01-26T00:00:01.000Z'
            }
          ]
        }
      })
      .mockReturnValueOnce(detailPromise);

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    await user.click(screen.getByTestId('run-row-1'));

    expect(await screen.findByTestId('runs-detail-loading')).toBeInTheDocument();

    rejectDetails(new Error('Detail exploded'));

    expect(await screen.findByTestId('runs-error')).toHaveTextContent('Detail exploded');
    expect(await screen.findByTestId('runs-detail-missing')).toBeInTheDocument();
  });

  test('falls back to default run detail error message when error has no message', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 101,
              kind: 'job',
              status: 'running',
              statusMessage: 'In progress'
            }
          ]
        }
      })
      .mockRejectedValueOnce({});

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();
    await user.click(screen.getByTestId('run-row-101'));

    expect(await screen.findByTestId('runs-error')).toHaveTextContent('Failed to load run');
    expect(await screen.findByTestId('runs-detail-missing')).toBeInTheDocument();
  });

  test('supports details payload as events array without run object', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 202,
              kind: 'job',
              status: 'completed',
              statusMessage: 'No run object'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          events: [
            {
              id: 1,
              timestamp: '2026-01-26T00:00:01.000Z',
              type: 'note',
              message: 'Event only'
            }
          ]
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();
    await user.click(screen.getByTestId('run-row-202'));

    // response.data is treated as the run object when `data.run` is missing
    expect(await screen.findByTestId('runs-detail-title')).toHaveTextContent('Run');
    expect(await screen.findByTestId('runs-events-list')).toBeInTheDocument();
    expect(screen.getByText('Event only')).toBeInTheDocument();
  });

  test('treats missing run detail payload as run not found', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 303,
              kind: 'job',
              status: 'completed',
              statusMessage: 'Missing details'
            }
          ]
        }
      })
      // No data payload at all -> `run` becomes null
      .mockResolvedValueOnce({});

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();
    await user.click(screen.getByTestId('run-row-303'));

    expect(await screen.findByTestId('runs-detail-missing')).toBeInTheDocument();
  });

  test('falls back to run.events when top-level events are missing', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 33,
              kind: 'job',
              status: 'completed',
              statusMessage: 'Nested events'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 33,
            kind: 'job',
            status: 'completed',
            statusMessage: 'Nested events',
            events: [
              {
                id: 99,
                timestamp: '2026-01-26T00:00:01.500Z',
                type: 'job:log',
                message: 'Nested hello'
              }
            ]
          }
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    await user.click(screen.getByTestId('run-row-33'));
    expect(await screen.findByTestId('runs-events-list')).toBeInTheDocument();
    expect(screen.getByText('Nested hello')).toBeInTheDocument();
  });

  test('defaults unknown statuses to pending class and falls back to empty events', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            {
              id: 7,
              kind: 'job',
              status: 'queued',
              statusMessage: 'Queued run',
              startedAt: '2026-01-26T00:00:01.000Z',
              finishedAt: '2026-01-26T00:00:02.000Z'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 7,
            kind: 'job',
            status: 'queued',
            statusMessage: 'Queued run'
          }
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    const row = screen.getByTestId('run-row-7');
    const statusChip = within(row).getByText('queued');
    expect(statusChip.className).toMatch(/is-pending/);

    await user.click(row);

    expect(await screen.findByTestId('runs-events-empty')).toBeInTheDocument();
  });

  test('renders list and detail fallbacks when run fields are blank', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          runs: [
            // include a null entry to cover optional-chaining/nullish branches
            // in the sort comparator: `b?.id ?? 0` / `a?.id ?? 0`
            null,
            {
              // missing id -> no data-testid on row, but keep label unique to avoid duplicate keys
              kind: 'no-id',
              status: '',
              statusMessage: ''
            },
            {
              id: 5,
              kind: '',
              status: '',
              statusMessage: ''
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          run: {
            id: 5,
            kind: '',
            status: '',
            statusMessage: ''
          },
          events: []
        }
      });

    const user = userEvent.setup();
    render(<RunsTab project={{ id: 123, name: 'Demo' }} />);

    expect(await screen.findByTestId('runs-list')).toBeInTheDocument();

    // Covers the `runId ? ... : undefined` branch for data-testid
    expect(screen.queryByTestId('run-row-null')).not.toBeInTheDocument();
    expect(screen.getAllByText('Run null').length).toBeGreaterThan(0);

    const row = screen.getByTestId('run-row-5');
    // Covers list fallbacks for blank status and kind
    expect(within(row).getByText('pending')).toBeInTheDocument();
    expect(within(row).getByText('run')).toBeInTheDocument();

    await user.click(row);

    const detail = screen.getByLabelText('Run details');
    expect(await within(detail).findByTestId('runs-detail-title')).toHaveTextContent('Run 5');
    expect(within(detail).getByText('pending')).toBeInTheDocument();
    expect(within(detail).getByText('run')).toBeInTheDocument();
  });
});
