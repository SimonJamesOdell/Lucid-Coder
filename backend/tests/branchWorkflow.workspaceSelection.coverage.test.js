import { describe, expect, it } from 'vitest';

import { selectWorkspacesForScope } from '../services/branchWorkflow/testsApi/workspaceSelection.js';

describe('branchWorkflow testsApi: workspaceSelection (coverage)', () => {
  it('treats non-array workspaces as empty', () => {
    const selected = selectWorkspacesForScope({
      workspaces: null,
      workspaceScope: 'changed',
      changedPaths: ['frontend/src/App.jsx']
    });

    expect(selected).toEqual([]);
  });

  it('treats non-array changedPaths as empty (so changed-scope does not filter)', () => {
    const workspaces = [
      { name: 'frontend', cwd: '/tmp/frontend', kind: 'node' },
      { name: 'backend', cwd: '/tmp/backend', kind: 'node' }
    ];

    const selected = selectWorkspacesForScope({
      workspaces,
      workspaceScope: 'changed',
      changedPaths: null
    });

    expect(selected).toEqual(workspaces);
  });

  it('defaults to scope=all when workspaceScope is not a string', () => {
    const workspaces = [{ name: 'frontend' }, { name: 'backend' }];

    const selected = selectWorkspacesForScope({
      workspaces,
      workspaceScope: null,
      changedPaths: ['frontend/src/App.jsx']
    });

    expect(selected).toEqual(workspaces);
  });
});
