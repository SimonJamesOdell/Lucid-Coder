import { describe, expect, it } from 'vitest';

import { getChangedSourceFilesForWorkspace } from '../services/branchWorkflow/testsApi/changedFilesForWorkspace.js';

describe('branchWorkflow testsApi: changedFilesForWorkspace (coverage)', () => {
  it('treats non-array changedPaths as empty', () => {
    const result = getChangedSourceFilesForWorkspace({
      changedPaths: null,
      workspaceName: 'backend',
      nodeWorkspaceNames: ['backend']
    });

    expect(result).toEqual([]);
  });

  it('treats non-array nodeWorkspaceNames as empty (no workspace filtering)', () => {
    const result = getChangedSourceFilesForWorkspace({
      changedPaths: ['frontend/src/b.js', 'backend/src/a.js'],
      workspaceName: 'backend',
      nodeWorkspaceNames: null
    });

    // With a single/unknown workspace list, we keep all relevant JS/TS files.
    // Paths under the current workspace are de-prefixed.
    expect(result).toEqual(['frontend/src/b.js', 'src/a.js']);
  });

  it('filters to matching workspace when multiple workspaces exist', () => {
    const result = getChangedSourceFilesForWorkspace({
      changedPaths: ['backend/src/a.js', 'frontend/src/b.js', 'backend\\src\\c.ts'],
      workspaceName: 'backend',
      nodeWorkspaceNames: ['backend', 'frontend']
    });

    expect(result).toEqual(['src/a.js', 'src/c.ts']);
  });
});
