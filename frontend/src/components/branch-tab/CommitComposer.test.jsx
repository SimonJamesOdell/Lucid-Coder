import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommitComposer from './CommitComposer';

describe('CommitComposer', () => {
  test('calls change handlers and allows committing when enabled', async () => {
    const onSubjectChange = vi.fn();
    const onBodyChange = vi.fn();
    const onCommit = vi.fn();

    render(
      <CommitComposer
        hasSelectedFiles={true}
        commitSubject=""
        commitBody=""
        onSubjectChange={onSubjectChange}
        onBodyChange={onBodyChange}
        onCommit={onCommit}
        canAutofill={false}
        canCommit={true}
        isCommitting={false}
        isGenerating={false}
      />
    );

    const user = userEvent.setup();

    await user.type(screen.getByTestId('branch-commit-subject'), 'feat: hello');
    expect(onSubjectChange).toHaveBeenCalled();

    await user.type(screen.getByTestId('branch-commit-input'), 'Body');
    expect(onBodyChange).toHaveBeenCalled();

    await user.click(screen.getByTestId('branch-commit-submit'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test('renders empty-state heading when no files are selected', () => {
    render(
      <CommitComposer
        hasSelectedFiles={false}
        commitSubject=""
        commitBody=""
        onSubjectChange={vi.fn()}
        onBodyChange={vi.fn()}
        onCommit={vi.fn()}
        canAutofill={false}
        canCommit={false}
        isCommitting={false}
        isGenerating={false}
      />
    );

    expect(screen.getByText('Add staged files to enable commits')).toBeInTheDocument();
  });

  test('shows clear changes button and calls handler', async () => {
    const onClearChanges = vi.fn();
    const user = userEvent.setup();

    render(
      <CommitComposer
        hasSelectedFiles={true}
        commitSubject="feat: x"
        commitBody=""
        onSubjectChange={vi.fn()}
        onBodyChange={vi.fn()}
        onCommit={vi.fn()}
        onClearChanges={onClearChanges}
        canAutofill={false}
        canCommit={true}
        isCommitting={false}
        isGenerating={false}
        isClearing={false}
      />
    );

    await user.click(screen.getByTestId('branch-commit-clear'));
    expect(onClearChanges).toHaveBeenCalledTimes(1);
  });
});
