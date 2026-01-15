import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { resolveWorkingBranchSnapshot, shouldSkipAutomationTests } from '../components/chatPanelCssOnly';

vi.mock('axios', () => ({
  default: {
    get: vi.fn()
  }
}));

describe('chatPanelCssOnly helpers', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  describe('resolveWorkingBranchSnapshot', () => {
    it('returns null when no project id is provided', async () => {
      const result = await resolveWorkingBranchSnapshot({
        projectId: null,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBeNull();
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('returns null when the API provides no working branches', async () => {
      const syncBranchOverview = vi.fn();
      const overview = { workingBranches: [] };
      axios.get.mockResolvedValue({ data: overview });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 123,
        workingBranches: {},
        syncBranchOverview
      });

      expect(result).toBeNull();
      expect(axios.get).toHaveBeenCalledWith('/api/projects/123/branches');
      expect(syncBranchOverview).toHaveBeenCalledWith(123, overview);
    });

    it('returns the first working branch when current is main', async () => {
      const workingBranches = [
        { name: 'feature/alpha', stagedFiles: [] },
        { name: 'feature/bravo', stagedFiles: [] }
      ];

      axios.get.mockResolvedValue({
        data: {
          current: 'main',
          workingBranches
        }
      });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 123,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toEqual(workingBranches[0]);
    });

    it('returns null when the overview fetch fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      axios.get.mockRejectedValue(new Error('network down'));

      const result = await resolveWorkingBranchSnapshot({
        projectId: 123,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to refresh branch overview before css-only check',
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });

    it('returns branch data stored in workingBranches without refetching', async () => {
      const cachedBranch = { name: 'feature/cached', stagedFiles: [] };

      const result = await resolveWorkingBranchSnapshot({
        projectId: 123,
        workingBranches: { 123: cachedBranch },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(cachedBranch);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('gracefully handles responses without a data payload', async () => {
      axios.get.mockResolvedValue({ data: null });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 123,
        workingBranches: {},
        syncBranchOverview: undefined
      });

      expect(result).toBeNull();
      expect(axios.get).toHaveBeenCalledWith('/api/projects/123/branches');
    });

    it('returns the branch that matches the current pointer when available', async () => {
      const workingBranches = [
        { name: 'feature/alpha', stagedFiles: [] },
        { name: 'feature/bravo', stagedFiles: [] }
      ];

      axios.get.mockResolvedValue({
        data: {
          current: 'feature/bravo',
          workingBranches
        }
      });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 456,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toEqual(workingBranches[1]);
    });

    it('falls back to the first working branch when the current pointer is missing', async () => {
      const workingBranches = [
        { name: 'feature/alpha', stagedFiles: [] },
        { name: 'feature/bravo', stagedFiles: [] }
      ];

      axios.get.mockResolvedValue({
        data: {
          current: 'feature/unknown',
          workingBranches
        }
      });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 789,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toEqual(workingBranches[0]);
    });

    it('returns null when the branch list only contains falsy entries', async () => {
      axios.get.mockResolvedValue({
        data: {
          workingBranches: [null]
        }
      });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 321,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBeNull();
    });

    it('returns null when the current pointer resolves to a falsy entry', async () => {
      axios.get.mockResolvedValue({
        data: {
          current: 'feature/missing',
          workingBranches: [null]
        }
      });

      const result = await resolveWorkingBranchSnapshot({
        projectId: 654,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBeNull();
    });
  });

  describe('shouldSkipAutomationTests', () => {
    it('returns false when no project is selected', async () => {
      const result = await shouldSkipAutomationTests({
        currentProject: null,
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('returns false when branch snapshot lacks a name', async () => {
      axios.get.mockResolvedValue({
        data: {
          workingBranches: [
            {
              stagedFiles: [{ path: 'src/styles/app.css' }]
            }
          ]
        }
      });

      const result = await shouldSkipAutomationTests({
        currentProject: { id: 123 },
        workingBranches: {},
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('returns false when there are no staged files', async () => {
      const result = await shouldSkipAutomationTests({
        currentProject: { id: 123 },
        workingBranches: {
          123: {
            name: 'feature/no-files',
            stagedFiles: []
          }
        },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('returns false when staged files include non-CSS paths', async () => {
      const result = await shouldSkipAutomationTests({
        currentProject: { id: 555 },
        workingBranches: {
          555: {
            name: 'feature/mixed',
            stagedFiles: [{ path: 'src/App.jsx' }, { path: 'src/styles/app.css' }]
          }
        },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('returns false when the stagedFiles field is missing', async () => {
      const result = await shouldSkipAutomationTests({
        currentProject: { id: 777 },
        workingBranches: {
          777: {
            name: 'feature/no-field'
          }
        },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
    });

    it('returns true when the css-only endpoint confirms the change', async () => {
      axios.get.mockResolvedValue({ data: { isCssOnly: true } });

      const result = await shouldSkipAutomationTests({
        currentProject: { id: 888 },
        workingBranches: {
          888: {
            name: 'feature/css-only',
            stagedFiles: [{ path: 'src/styles/theme.css' }]
          }
        },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(true);
      expect(axios.get).toHaveBeenCalledWith(
        '/api/projects/888/branches/feature%2Fcss-only/css-only'
      );
    });

    it('returns false when the css-only endpoint request fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      axios.get.mockRejectedValue(new Error('css probe failed'));

      const result = await shouldSkipAutomationTests({
        currentProject: { id: 999 },
        workingBranches: {
          999: {
            name: 'feature/css-error',
            stagedFiles: [{ path: 'src/styles/globals.css' }]
          }
        },
        syncBranchOverview: vi.fn()
      });

      expect(result).toBe(false);
      expect(axios.get).toHaveBeenCalledWith(
        '/api/projects/999/branches/feature%2Fcss-error/css-only'
      );
      warnSpy.mockRestore();
    });
  });
});
