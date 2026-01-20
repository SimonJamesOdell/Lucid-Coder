import React, { useCallback } from 'react';

const renderTreeConnector = (level, isLastChild) => {
  if (level === 0) {
    return null;
  }

  return (
    <span className="tree-connector">
      {isLastChild ? '└─' : '├─'}
    </span>
  );
};

const FileTreeView = ({
  items,
  expandedFolders,
  activeFilePath,
  stagedPathSet,
  onToggleFolder,
  onOpenContextMenu,
  onSelectFile
}) => {
  const renderFileTree = useCallback((nodes, level = 0) =>
    nodes.map((item, index) => {
      const itemPath = item.path;
      const isExpanded = expandedFolders.has(itemPath);
      const isLastChild = index === nodes.length - 1;
      const fragmentKey = `${item.path}-${level}-${index}`;
      const isStaged = item.type !== 'folder' && stagedPathSet.has(item.path);

      if (item.type === 'folder') {
        return (
          <React.Fragment key={fragmentKey}>
            <div
              className={`folder-item level-${level}`}
              onClick={() => onToggleFolder(itemPath)}
              onContextMenu={(event) => onOpenContextMenu(event, item)}
              style={{ paddingLeft: `${level * 0.75 + 0.5}rem` }}
            >
              {renderTreeConnector(level, isLastChild)}
              <span className="folder-icon">{isExpanded ? '📂' : '📁'}</span>
              <span className="folder-name">{item.name}</span>
            </div>
            {item.children && isExpanded && renderFileTree(item.children, level + 1)}
          </React.Fragment>
        );
      }

      return (
        <React.Fragment key={fragmentKey}>
          <div
            className={`file-item level-${level} ${activeFilePath === item.path ? 'selected' : ''}`}
            data-testid={`file-item-${item.path}`}
            onClick={() => onSelectFile(item)}
            onContextMenu={(event) => onOpenContextMenu(event, item)}
            style={{ paddingLeft: `${level * 0.75 + 0.5}rem` }}
          >
            {renderTreeConnector(level, isLastChild)}
            <span className="file-icon">📄</span>
            <span className="file-name">{item.name}</span>
            {isStaged && (
              <button
                type="button"
                className="staged-diff-button"
                data-testid={`staged-diff-button-${item.path}`}
                aria-label={`View staged diff for ${item.name}`}
                title="Staged — click to view diff"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectFile(item, { source: 'explorer-diff' });
                }}
              >
                <svg
                  className="staged-diff-icon"
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  focusable="false"
                >
                  <rect x="2.25" y="3" width="5.25" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <rect x="8.5" y="3" width="5.25" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M7.9 6.2 L9.2 8 L7.9 9.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </React.Fragment>
      );
    }),
    [activeFilePath, expandedFolders, onOpenContextMenu, onSelectFile, onToggleFolder, stagedPathSet]
  );

  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return renderFileTree(items, 0);
};

export default FileTreeView;
