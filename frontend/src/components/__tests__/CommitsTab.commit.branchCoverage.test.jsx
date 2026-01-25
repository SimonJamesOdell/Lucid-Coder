import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { AppStateProvider, __appStateTestHelpers } from '../../context/AppStateContext.jsx';
import CommitsTab from '../CommitsTab.jsx';

// Mock axios to avoid real network calls
vi.mock('axios', () => {
  return {
    default: {
      get: vi.fn(async (url) => {
        // Initial commits fetch
        return { data: { success: true, commits: [], overview: null } };
      }),
      post: vi.fn(async (url, payload) => {
        // Commit endpoint
        if (/\/commit$/.test(url)) {
          return {
            data: {
              success: true,
              overview: {
                branches: [],
                current: 'feature/test',
                workingBranches: []
              }
            }
          };
        }
        return { data: { success: true } };
      })
    }
  };
});

// Mock useCommitComposer to force getCommitMessageForBranch to return a non-string
vi.mock('../branch-tab/useCommitComposer', async () => {
  const actual = await vi.importActual('../branch-tab/useCommitComposer');
  return {
    ...actual,
    useCommitComposer: () => ({
      commitMessageRequest: null,
      commitMessageError: null,
      isLLMConfigured: true,
      // Return a subject to enable canCommit
      getCommitSubjectForBranch: () => 'Update styles',
      getCommitBodyForBranch: () => '',
      // Return non-string to hit the false branch at line ~443
      getCommitMessageForBranch: () => null,
      handleCommitMessageChange: vi.fn(),
      handleCommitMessageAutofill: vi.fn(),
      clearCommitMessageForBranch: vi.fn()
    })
  };
});

describe('CommitsTab commit message branch coverage', () => {
  beforeEach(() => {
    // Reset helpers if needed
  });

  it('handles commit with non-string commit message (covers typeof false branch)', async () => {
    const project = { id: 1, name: 'Test Project' };
    const apiRef = React.createRef();
    const { findByTestId } = render(
      <AppStateProvider>
        <CommitsTab project={project} testApiRef={apiRef} />
      </AppStateProvider>
    );

    // Ensure the provider has a working branch with staged CSS to allow commit
    await act(async () => {
      const applyOverview = __appStateTestHelpers.applyBranchOverview;
      expect(applyOverview).toBeTypeOf('function');
      applyOverview(project.id, {
        branches: [],
        current: 'feature/test',
        workingBranches: [
          {
            name: 'feature/test',
            description: 'branch',
            status: 'active',
            lastTestStatus: 'failed',
            testsRequired: false,
            stagedFiles: [{ path: 'styles.css' }]
          }
        ]
      });
    });

    // Wait for base UI to render
    await findByTestId('commits-tab-panel');

    const axios = (await import('axios')).default;

    // Call commit via test API
    // Wait until the component exposes its test API
    await waitFor(() => {
      expect(apiRef.current).toBeTruthy();
    });

    await act(async () => {
      await apiRef.current.handleCommitStagedChanges();
    });

    // Verify the commit was posted with undefined payload (non-string commit draft)
    const calls = axios.post.mock.calls.filter((c) => /\/commit$/.test(c[0]));
    expect(calls.length).toBeGreaterThan(0);
    const [, payload] = calls[calls.length - 1];
    expect(payload).toBeUndefined();
  });

  it('selects the new head commit after committing and loads its details', async () => {
    const project = { id: 1, name: 'Test Project' };
    const apiRef = React.createRef();

    const { findByTestId } = render(
      <AppStateProvider>
        <CommitsTab project={project} testApiRef={apiRef} />
      </AppStateProvider>
    );

    const axios = (await import('axios')).default;

    axios.get.mockImplementation(async (url) => {
      if (/\/api\/projects\/1\/commits\/abcdef123$/.test(url)) {
        return {
          data: {
            success: true,
            commit: {
              sha: 'abcdef123',
              shortSha: 'abcdef1',
              message: 'Head commit',
              files: []
            }
          }
        };
      }

      if (/\/api\/projects\/1\/commits$/.test(url)) {
        return {
          data: {
            success: true,
            commits: [
              {
                sha: '  abcdef123  ',
                shortSha: 'abcdef1',
                message: 'Head commit',
                author: { name: 'Alice' },
                authoredAt: '2024-01-01T00:00:00.000Z'
              }
            ]
          }
        };
      }

      return { data: { success: true, commits: [], overview: null } };
    });

    await act(async () => {
      const applyOverview = __appStateTestHelpers.applyBranchOverview;
      applyOverview(project.id, {
        branches: [],
        current: 'feature/test',
        workingBranches: [
          {
            name: 'feature/test',
            description: 'branch',
            status: 'active',
            lastTestStatus: 'failed',
            testsRequired: false,
            stagedFiles: [{ path: 'styles.css' }]
          }
        ]
      });
    });

    await findByTestId('commits-tab-panel');

    await waitFor(() => {
      expect(apiRef.current).toBeTruthy();
    });

    await act(async () => {
      await apiRef.current.handleCommitStagedChanges();
    });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith('/api/projects/1/commits/abcdef123');
    });
  });
});
