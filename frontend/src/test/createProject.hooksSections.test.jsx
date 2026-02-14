import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ProjectDetailsSection from '../components/create-project/ProjectDetailsSection';
import { useGitTechDetection } from '../components/create-project/useGitTechDetection';
import { useSetupJobsPolling } from '../components/create-project/useSetupJobsPolling';

function GitDetectionHarness({ params }) {
  useGitTechDetection(params);
  return null;
}

function JobsPollingHarness({ params }) {
  useSetupJobsPolling(params);
  return null;
}

describe('create-project hooks and sections', () => {
  test('ProjectDetailsSection renders key form controls', () => {
    const model = {
      name: 'demo',
      description: '',
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    };

    render(
      <ProjectDetailsSection
        createLoading={false}
        projectSource="new"
        newProject={model}
        setNewProject={vi.fn()}
        createError=""
        setCreateError={vi.fn()}
        frontendLanguages={['javascript']}
        backendLanguages={['javascript']}
        getFrontendFrameworks={() => ['react']}
        getBackendFrameworks={() => ['express']}
        onFrontendLanguageChange={vi.fn()}
        onFrontendFrameworkChange={vi.fn()}
        onBackendLanguageChange={vi.fn()}
        onBackendFrameworkChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Frontend Language *')).toBeInTheDocument();
  });

  test('useGitTechDetection triggers detect call and onDetected', async () => {
    const onDetected = vi.fn();
    const setGitTechStatus = vi.fn();
    const post = vi.fn().mockResolvedValue({ data: { success: true, frontend: {}, backend: {} } });

    render(
      <GitDetectionHarness
        params={{
          setupStep: 'details',
          projectSource: 'git',
          gitRemoteUrl: 'https://example.com/repo.git',
          gitConnectionMode: 'custom',
          gitProvider: 'github',
          gitSettingsProvider: 'github',
          gitToken: 'token',
          gitTechKeyRef: { current: '' },
          setGitTechStatus,
          axios: { post },
          onDetected
        }}
      />
    );

    await waitFor(() => {
      expect(post).toHaveBeenCalled();
      expect(onDetected).toHaveBeenCalled();
    });
  });

  test('useSetupJobsPolling stores jobs and completes when final states reached', async () => {
    const showMain = vi.fn();
    const setSetupState = vi.fn();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, jobs: [{ status: 'succeeded' }] })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <JobsPollingHarness
        params={{
          setupState: { isWaiting: true, projectId: 'proj-1' },
          setSetupState,
          showMain
        }}
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(setSetupState).toHaveBeenCalled();
      expect(showMain).toHaveBeenCalled();
    });
  });
});
