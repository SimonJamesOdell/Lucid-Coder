import React from 'react';
import { formatStatus, safeTestId, deriveDisplayStatus } from './utils';

const BranchSidebar = ({
  branchSummaries,
  branchListMode,
  onChangeBranchListMode,
  openBranchCount,
  pastBranchCount,
  sortedBranches,
  workingBranchMap,
  selectedBranchName,
  onSelectBranch
}) => (
  <aside className="branch-list-panel">
    <div className="panel-header">
      <div>
        <p className="panel-eyebrow">Branches</p>
      </div>
      <span className="panel-count">{branchSummaries.length} total</span>
    </div>
    <div className="branch-filter-bar" data-testid="branch-filter-bar">
      <button
        type="button"
        className={`branch-filter-pill${branchListMode === 'open' ? ' selected' : ''}`}
        onClick={() => onChangeBranchListMode?.('open')}
        data-testid="branch-filter-open"
      >
        Open
        <span className="branch-filter-count" aria-label="Open branches count">{openBranchCount ?? 0}</span>
      </button>
      <button
        type="button"
        className={`branch-filter-pill${branchListMode === 'past' ? ' selected' : ''}`}
        onClick={() => onChangeBranchListMode?.('past')}
        data-testid="branch-filter-past"
      >
        Past
        <span className="branch-filter-count" aria-label="Past branches count">{pastBranchCount ?? 0}</span>
      </button>
    </div>
    <div className="branch-list" data-testid="branch-list">
      {sortedBranches.map((branch) => {
        const branchWorking = workingBranchMap.get(branch.name) || null;
        const displayStatus = deriveDisplayStatus(branch, branchWorking);
        const summaryStagedCount = branch.stagedFileCount ?? 0;
        const stagedCount = Array.isArray(branchWorking?.stagedFiles)
          ? (branchWorking.stagedFiles.length || summaryStagedCount)
          : summaryStagedCount;
        const showStagedCount = branch.name !== 'main';
        return (
          <button
            key={branch.name}
            type="button"
            className={`branch-list-item${branch.name === selectedBranchName ? ' selected' : ''}`}
            onClick={() => onSelectBranch(branch.name)}
            data-testid={`branch-list-item-${safeTestId(branch.name)}`}
          >
            <div className="branch-list-primary">
              <span className="branch-name">{branch.name}</span>
              {branch.isCurrent && <span className="status-chip neutral">Current</span>}
              {branch.status === 'merged' && <span className="status-chip success">Merged</span>}
            </div>
            <div className="branch-list-meta">
              <span className={`status-pill status-${displayStatus}`}>{formatStatus(displayStatus)}</span>
              {showStagedCount && (
                <span className="branch-subtext">
                  {stagedCount} staged file{stagedCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </button>
        );
      })}
      {!sortedBranches.length && (
        <div className="branch-empty" data-testid="branch-empty">
          {branchListMode === 'past'
            ? 'No past branches yet.'
            : 'No branches yet. Start coding to create your first working branch.'}
        </div>
      )}
    </div>
  </aside>
);

export default BranchSidebar;
