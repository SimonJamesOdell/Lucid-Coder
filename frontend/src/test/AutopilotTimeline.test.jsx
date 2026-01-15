import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AutopilotTimeline, { __testHooks } from '../components/AutopilotTimeline.jsx';

describe('AutopilotTimeline', () => {
  test('exposes helpers for defensive branches', () => {
    expect(__testHooks.getStepOrdinal({ plannedSteps: null, prompt: 'A' })).toBeNull();
    expect(__testHooks.getStepOrdinal({ plannedSteps: [], prompt: 'A' })).toBeNull();
    expect(__testHooks.getStepOrdinal({ plannedSteps: ['A'], prompt: '' })).toBeNull();
    expect(__testHooks.getStepOrdinal({ plannedSteps: ['A'], prompt: 'B' })).toBeNull();
    expect(__testHooks.buildPrimaryLabel({ evt: null, plannedSteps: [] })).toBeNull();

    const stepStartEvent = { type: 'step:start', payload: { prompt: 'B' } };
    expect(__testHooks.buildPrimaryLabel({ evt: stepStartEvent, plannedSteps: ['A'] })).toBe(
      'Step started: B'
    );
    expect(__testHooks.buildPrimaryLabel({ evt: stepStartEvent, plannedSteps: ['B'] })).toBe(
      'Step 1/1 started: B'
    );
  });

  test('shows current step and next step from structured events', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { steps: ['Write failing tests', 'Implement change', 'Run passing tests'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 2,
            type: 'step:start',
            message: 'Starting step',
            payload: { prompt: 'Write failing tests', startedAt: 110 },
            meta: null,
            createdAt: 110
          }
        ]}
      />
    );

    expect(await screen.findByText('Step 1/3 started: Write failing tests')).toBeInTheDocument();

    // Expect explicit summary labels (current + next).
    expect(await screen.findByTestId('autopilot-current-step')).toHaveTextContent('Write failing tests');
    expect(await screen.findByTestId('autopilot-next-step')).toHaveTextContent('Implement change');
  });

  test('shows the current goal intent from the most recent plan prompt', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { prompt: 'Build a login form', steps: ['A', 'B'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 2,
            type: 'plan',
            message: 'Plan updated',
            payload: { prompt: 'Actually, make it passwordless', addedPrompts: ['X'] },
            meta: null,
            createdAt: 101
          }
        ]}
      />
    );

    expect(await screen.findByTestId('autopilot-working-goal')).toHaveTextContent(
      'Actually, make it passwordless'
    );
  });

  test('shows a user-readable plan summary from the most recent plan event', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: {
              prompt: 'Build a login form',
              steps: ['Write failing tests', 'Implement change', 'Run passing tests'],
              summary:
                'Plan for: Build a login form\n1. Write failing tests\n2. Implement change\n3. Run passing tests'
            },
            meta: null,
            createdAt: 100
          }
        ]}
      />
    );

    expect(await screen.findByTestId('autopilot-plan-summary')).toHaveTextContent(
      '1. Write failing tests'
    );
  });

  test('shows a readable “what changed” list from edit patch events', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { prompt: 'Feature', steps: ['Step 1'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 2,
            type: 'edit:patch',
            message: 'Applied file edits',
            payload: {
              phase: 'tests',
              prompt: 'Step 1',
              files: [
                { path: 'frontend/src/components/ChatPanel.jsx', chars: 123 },
                { path: 'frontend/src/test/ChatPanel.test.jsx', chars: '15' },
                { path: 'frontend/src/test/WeirdChars.test.jsx', chars: 'abc' }
              ]
            },
            meta: null,
            createdAt: 110
          }
        ]}
      />
    );

    const changed = await screen.findByTestId('autopilot-changed-files');
    expect(changed).toHaveTextContent('What changed');
    expect(changed).toHaveTextContent('frontend/src/components/ChatPanel.jsx');
    expect(changed).toHaveTextContent('frontend/src/test/ChatPanel.test.jsx');
    expect(changed).toHaveTextContent('frontend/src/test/ChatPanel.test.jsx (15 chars)');
    expect(changed).toHaveTextContent('frontend/src/test/WeirdChars.test.jsx');
    expect(changed).not.toHaveTextContent('WeirdChars.test.jsx (');
  });

  test('ignores edit patch file entries with missing or invalid paths', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { prompt: 'Feature', steps: ['Step 1'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 2,
            type: 'edit:patch',
            message: 'Applied file edits',
            payload: {
              files: [
                null,
                {},
                { path: 123, chars: 1 },
                { path: '   ', chars: 2 },
                { path: 'README.md', chars: 3 }
              ]
            },
            meta: null,
            createdAt: 110
          }
        ]}
      />
    );

    const changed = await screen.findByTestId('autopilot-changed-files');
    expect(changed).toHaveTextContent('README.md (3 chars)');
    expect(changed).not.toHaveTextContent('123');
  });

  test('handles edit patch events with missing files arrays', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'edit:patch',
            message: 'Applied file edits',
            payload: { phase: 'tests' },
            meta: null,
            createdAt: 100
          }
        ]}
      />
    );

    expect(await screen.findByTestId('autopilot-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-changed-files')).toBeNull();
  });

  test('shows user-friendly labels for technical event types', () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'edit:patch',
            message: 'Applied file edits',
            payload: { files: [{ path: 'README.md', chars: 10 }] },
            meta: null,
            createdAt: 100
          }
        ]}
      />
    );

    expect(screen.getByText('edit:patch')).toBeInTheDocument();
    expect(screen.getByText('Files updated')).toBeInTheDocument();
  });

  test('renders an empty state when there are no valid events', () => {
    const { rerender } = render(<AutopilotTimeline events={null} />);
    expect(screen.getByText('No events yet.')).toBeInTheDocument();

    rerender(
      <AutopilotTimeline
        events={[
          null,
          123,
          { id: 'not-a-number', type: 'plan' },
          { id: NaN, type: 'plan' }
        ]}
      />
    );
    expect(screen.getByText('No events yet.')).toBeInTheDocument();
  });

  test('derives planned steps from plan updates (addedPrompts) and hides current step when completed', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { steps: ['Initial A', 'Initial B'] },
            meta: null,
            createdAt: 101
          },
          {
            id: 2,
            type: 'plan',
            message: 'Plan updated',
            payload: { addedPrompts: ['  Added 1  ', 123, '', 'Added 2'] },
            meta: null,
            createdAt: 102
          },
          {
            id: 3,
            type: 'step:done',
            message: 'Step done',
            payload: { prompt: 'Initial A' },
            meta: null,
            createdAt: 103
          },
          {
            id: 4,
            type: 'step:done',
            message: 'Step done',
            payload: { prompt: 'Initial B' },
            meta: null,
            createdAt: 104
          },
          {
            id: 5,
            type: 'step:start',
            message: 'Starting step',
            payload: { prompt: 'Added 1' },
            meta: null,
            createdAt: 105
          },
          {
            id: 6,
            type: 'step:done',
            message: 'Step done',
            payload: { prompt: 'Added 1' },
            meta: null,
            createdAt: 106
          }
        ]}
      />
    );

    // Current step is completed, so it should not be shown.
    expect(screen.queryByTestId('autopilot-current-step')).toBeNull();

    // Next step should be the first non-completed planned step (Added 2).
    expect(await screen.findByTestId('autopilot-next-step')).toHaveTextContent('Added 2');
  });

  test('renders details, including safeJson fallback when payload is not serializable', () => {
    const circular = {};
    circular.self = circular;

    render(
      <AutopilotTimeline
        events={[
          {
            id: 2,
            type: 'step:start',
            message: 'Working on it',
            payload: circular,
            meta: { source: 'unit' },
            createdAt: 200
          }
        ]}
      />
    );

    // Message + type show up.
    expect(screen.getByText('step:start')).toBeInTheDocument();
    expect(screen.getByText('Working on it')).toBeInTheDocument();

    // Details should exist and include fallback payload string.
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('payload')).toBeInTheDocument();
    expect(screen.getByText('[unavailable]')).toBeInTheDocument();
    expect(screen.getByText('meta')).toBeInTheDocument();
    expect(screen.getByText(/"source":\s*"unit"/)).toBeInTheDocument();
  });

  test('handles invalid createdAt formatting gracefully (covers formatter catch path)', () => {
    const spy = vi
      .spyOn(Date.prototype, 'toLocaleTimeString')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });

    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'event',
            message: 'hello',
            payload: null,
            meta: null,
            createdAt: 123
          }
        ]}
      />
    );

    // It should still render the event, but omit the time label.
    expect(screen.getByText('event')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();

    spy.mockRestore();
  });

  test('omits time/message when createdAt/message are empty and renders only meta details', () => {
    const { container } = render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'event',
            message: '   ',
            payload: null,
            meta: { source: 'unit' },
            createdAt: 0
          }
        ]}
      />
    );

    expect(screen.getByText('event')).toBeInTheDocument();
    expect(container.querySelector('.autopilot-timeline__event-time')).toBeNull();
    expect(container.querySelector('.autopilot-timeline__event-message')).toBeNull();

    // Details should render (meta present), but payload block should be omitted.
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.queryByText('payload')).toBeNull();
    expect(screen.getByText('meta')).toBeInTheDocument();
  });

  test('hides summary when all planned steps are completed (covers nextStep null return)', () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: 'plan',
            message: 'Plan created',
            payload: { steps: ['A', 'B'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 2,
            type: 'step:done',
            message: 'done',
            payload: { prompt: 'A' },
            meta: null,
            createdAt: 101
          },
          {
            id: 3,
            type: 'step:done',
            message: 'done',
            payload: { prompt: 'B' },
            meta: null,
            createdAt: 102
          }
        ]}
      />
    );

    expect(screen.queryByTestId('autopilot-current-step')).toBeNull();
    expect(screen.queryByTestId('autopilot-next-step')).toBeNull();
    expect(screen.queryByText('No events yet.')).toBeNull();
  });

  test('normalizes missing fields and filters non-string steps/prompts (covers branch defaults)', async () => {
    render(
      <AutopilotTimeline
        events={[
          {
            id: 1,
            type: '   ',
            message: '   ',
            payload: null,
            meta: null,
            createdAt: 'nope'
          },
          {
            id: 2,
            type: 'plan',
            message: 'ok',
            payload: { steps: [123, '  ', 'X'] },
            meta: null,
            createdAt: 100
          },
          {
            id: 3,
            type: 'step:done',
            message: null,
            payload: { prompt: 123 },
            meta: null,
            createdAt: 200
          }
        ]}
      />
    );

    // type/message should normalize to `event` and null.
    expect(screen.getByText('event')).toBeInTheDocument();
    expect(screen.queryByTestId('autopilot-current-step')).toBeNull();

    // Planned steps should include only the trimmed string entry.
    expect(await screen.findByTestId('autopilot-next-step')).toHaveTextContent('X');
  });
});
