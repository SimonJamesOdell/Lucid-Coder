import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FileTreeView from './FileTreeView';

describe('FileTreeView', () => {
  it('returns null when items are empty', () => {
    const { container } = render(
      <FileTreeView
        items={[]}
        expandedFolders={new Set()}
        activeFilePath=""
        stagedPathSet={new Set()}
        onToggleFolder={() => {}}
        onOpenContextMenu={() => {}}
        onSelectFile={() => {}}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('returns null when items are not an array', () => {
    const { container } = render(
      <FileTreeView
        items={null}
        expandedFolders={new Set()}
        activeFilePath=""
        stagedPathSet={new Set()}
        onToggleFolder={() => {}}
        onOpenContextMenu={() => {}}
        onSelectFile={() => {}}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('invokes folder selection and toggle handlers when a folder is clicked', async () => {
    const user = userEvent.setup();
    const onSelectFolder = vi.fn();
    const onToggleFolder = vi.fn();

    render(
      <FileTreeView
        items={[{ name: 'src', path: '/src', type: 'folder', isLoading: false, children: null }]}
        expandedFolders={new Set()}
        activeFilePath=""
        selectedFolderPath="/src"
        stagedPathSet={new Set()}
        onToggleFolder={onToggleFolder}
        onOpenContextMenu={() => {}}
        onSelectFile={() => {}}
        onSelectFolder={onSelectFolder}
      />
    );

    const folderNode = screen.getByText('src');
    await user.click(folderNode);

    expect(onSelectFolder).toHaveBeenCalledWith(expect.objectContaining({ path: '/src' }));
    expect(onToggleFolder).toHaveBeenCalledWith('/src');
    expect(folderNode.closest('.folder-item')).toHaveClass('selected');
  });

  it('renders a loading placeholder when a folder is expanded and loading', () => {
    render(
      <FileTreeView
        items={[{ name: 'src', path: '/src', type: 'folder', isLoading: true, children: null }]}
        expandedFolders={new Set(['/src'])}
        activeFilePath=""
        selectedFolderPath={null}
        stagedPathSet={new Set()}
        onToggleFolder={() => {}}
        onOpenContextMenu={() => {}}
        onSelectFile={() => {}}
        onSelectFolder={() => {}}
      />
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
