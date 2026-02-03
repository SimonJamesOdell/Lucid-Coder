import { describe, it, expect, vi } from 'vitest';

import {
  testGitConnection,
  updateGitSettings,
  updatePortSettings
} from '../context/appState/settings.js';

describe('appState/settings negative-network handling', () => {
  it('testGitConnection throws fallback when response is non-JSON', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      }
    }));

    await expect(testGitConnection({ trackedFetch, provider: 'github', token: 'x' }))
      .rejects.toThrow('Failed to test git connection');
  });

  it('testGitConnection throws fallback when trackedFetch rejects with non-Error', async () => {
    const trackedFetch = vi.fn(async () => {
      throw null;
    });

    await expect(testGitConnection({ trackedFetch, provider: 'github', token: 'x' }))
      .rejects.toThrow('Failed to test git connection');
  });

  it('updateGitSettings surfaces the thrown error message when trackedFetch rejects', async () => {
    const trackedFetch = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(updateGitSettings({
      trackedFetch,
      gitSettings: { workflow: 'local', provider: 'github', defaultBranch: 'main' },
      setGitSettings: vi.fn(),
      updates: { workflow: 'cloud' }
    })).rejects.toThrow('network down');
  });

  it('updatePortSettings surfaces the thrown message when trackedFetch rejects with an object', async () => {
    const trackedFetch = vi.fn(async () => {
      throw { message: 'ports offline' };
    });

    await expect(updatePortSettings({
      trackedFetch,
      portSettings: { frontendPortBase: 6100, backendPortBase: 6500 },
      setPortSettings: vi.fn(),
      updates: { frontendPortBase: 6101 },
      currentProjectId: null,
      isProjectStopping: () => false,
      restartProject: vi.fn()
    })).rejects.toThrow('ports offline');
  });

  it('updateGitSettings throws fallback when response is non-JSON', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      }
    }));

    await expect(updateGitSettings({
      trackedFetch,
      gitSettings: { workflow: 'local', provider: 'github', defaultBranch: 'main' },
      setGitSettings: vi.fn(),
      updates: { workflow: 'cloud' }
    })).rejects.toThrow('Failed to save git settings');
  });

  it('updatePortSettings throws fallback when response is non-JSON', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      }
    }));

    await expect(updatePortSettings({
      trackedFetch,
      portSettings: { frontendPortBase: 6100, backendPortBase: 6500 },
      setPortSettings: vi.fn(),
      updates: { frontendPortBase: 6101 },
      currentProjectId: null,
      isProjectStopping: () => false,
      restartProject: vi.fn()
    })).rejects.toThrow('Failed to save port settings');
  });
});
