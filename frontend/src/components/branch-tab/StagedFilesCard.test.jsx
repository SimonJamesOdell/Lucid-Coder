import React from 'react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StagedFilesCard from './StagedFilesCard';

const baseProps = {
  selectedFiles: [],
  hasSelectedFiles: false,
  onOpenFile: vi.fn(),
  onClearFile: vi.fn(),
  onClearAll: vi.fn(),
  isStoppingProject: false,
  isCurrentBranch: true
};

const renderCard = (overrideProps = {}) => render(<StagedFilesCard {...baseProps} {...overrideProps} />);

describe('StagedFilesCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('shows contextual empty state messaging', () => {
    const view = renderCard({ selectedFiles: [], hasSelectedFiles: false, isCurrentBranch: true });
    expect(screen.getByTestId('branch-no-files')).toHaveTextContent('Save a file');

    view.rerender(
      <StagedFilesCard
        {...baseProps}
        selectedFiles={[]}
        hasSelectedFiles={false}
        isCurrentBranch={false}
      />
    );
    expect(screen.getByTestId('branch-no-files')).toHaveTextContent('No staged files on this branch yet.');
  });

  test('renders staged entries with metadata and handlers', async () => {
    const onOpenFile = vi.fn();
    const onClearFile = vi.fn();
    const onClearAll = vi.fn();
    const user = userEvent.setup();

    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('10:00 AM');

    const selectedFiles = [
      { path: 'src/App.jsx', source: 'ai', timestamp: '2024-01-01T00:00:00.000Z' },
      { path: 'src/index.js', source: 'editor', timestamp: 'not-a-date' },
      { path: 'README.md', source: 'editor', timestamp: null }
    ];

    renderCard({
      selectedFiles,
      hasSelectedFiles: true,
      onOpenFile,
      onClearFile,
      onClearAll,
      isCurrentBranch: true
    });

    const list = screen.getByTestId('branch-file-list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('AI Assistant')).toBeInTheDocument();
    expect(within(list).getAllByText('Editor Save')).toHaveLength(2);
    expect(within(list).getByText('10:00 AM')).toBeInTheDocument();
    expect(within(list).getByText('Recently')).toBeInTheDocument();
    expect(within(list).getByText('Just now')).toBeInTheDocument();

    await user.click(screen.getByTestId('branch-file-src-app-jsx'));
    expect(onOpenFile).toHaveBeenCalledWith('src/App.jsx');

    await user.click(screen.getByTestId('branch-file-clear-src-app-jsx'));
    expect(onClearFile).toHaveBeenCalledWith('src/App.jsx');

    await user.click(screen.getByTestId('clear-staged-inline'));
    expect(onClearAll).toHaveBeenCalled();
  });

  test('disables clearing controls while project is stopping', () => {
    const selectedFiles = [{ path: 'src/App.jsx', source: 'ai', timestamp: null }];

    renderCard({
      selectedFiles,
      hasSelectedFiles: true,
      isStoppingProject: true
    });

    expect(screen.getByTestId('clear-staged-inline')).toBeDisabled();
    expect(screen.getByTestId('branch-file-clear-src-app-jsx')).toBeDisabled();
  });
});
