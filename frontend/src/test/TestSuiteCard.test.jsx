import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TestSuiteCard from '../components/test-tab/TestSuiteCard.jsx';

describe('TestSuiteCard', () => {
  const baseConfig = {
    type: 'frontend:test',
    label: 'Frontend Tests',
    description: 'Exercises the UI bundle'
  };

  it('renders the empty state and triggers a run when requested', async () => {
    const onRun = vi.fn();
    const user = userEvent.setup();

    render(
      <TestSuiteCard
        config={baseConfig}
        project={{ id: 'proj-123' }}
        onRun={onRun}
        onCancel={vi.fn()}
      />
    );

    expect(
      screen.getByText('No runs yet. Kick off the first frontend tests.')
    ).toBeInTheDocument();

    const runButton = screen.getByTestId('run-frontend:test');
    expect(runButton).toBeEnabled();

    await user.click(runButton);
    expect(onRun).toHaveBeenCalledWith('frontend:test');
  });

  it('shows job details for an active run and allows canceling', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    const activeJob = {
      status: 'running',
      command: 'npm',
      args: ['run', 'test'],
      cwd: '/workspace/app',
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:01.500Z',
      logs: [
        {
          timestamp: '1',
          message: 'PASS sample suite'
        }
      ]
    };

    render(
      <TestSuiteCard
        config={baseConfig}
        job={activeJob}
        project={{ id: 'proj-123' }}
        onRun={vi.fn()}
        onCancel={onCancel}
      />
    );

    expect(screen.getByTestId('job-status-frontend:test')).toHaveTextContent('Running');
    expect(screen.getByTestId('job-command-frontend:test')).toHaveTextContent('npm run test');
    expect(screen.getByText('/workspace/app')).toBeInTheDocument();
    expect(screen.getByText('1.5s')).toBeInTheDocument();
    expect(screen.getByTestId('job-logs-frontend:test')).toHaveTextContent('PASS sample suite');

    const runButton = screen.getByTestId('run-frontend:test');
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveTextContent('Running');

    const cancelButton = screen.getByTestId('cancel-frontend:test');
    expect(cancelButton).toBeInTheDocument();

    await user.click(cancelButton);
    expect(onCancel).toHaveBeenCalledWith(activeJob);
  });

  it('falls back to an empty args segment when job args are missing', () => {
    const jobWithoutArgs = {
      status: 'succeeded',
      command: 'npm',
      cwd: '/workspace/app',
      logs: [],
      startedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:01.000Z'
    };

    render(
      <TestSuiteCard
        config={baseConfig}
        job={jobWithoutArgs}
        project={{ id: 'proj-123' }}
        onRun={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByTestId('job-command-frontend:test').textContent).toBe('npm ');
  });
});
