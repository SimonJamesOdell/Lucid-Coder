import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
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
});
