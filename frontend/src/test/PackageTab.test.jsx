import React from 'react';
import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PackageTab, {
  resolveActionProjectId,
  resolveWorkspaceManifestPaths,
  __testWorkspaces,
  __packageTabTestHooks
} from '../components/PackageTab';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const buildFetchResponse = (content) => ({
  ok: true,
  json: async () => ({ success: true, content: JSON.stringify(content) })
});

const buildFilesTreeResponse = (files) => ({
  ok: true,
  json: async () => ({ success: true, files })
});

const buildPackageManifestTree = (manifestPaths = ['frontend/package.json', 'backend/package.json']) => {
  return manifestPaths.map((manifestPath) => {
    const normalized = String(manifestPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || !normalized.endsWith('package.json')) {
      return null;
    }

    const segments = normalized.split('/');
    const name = segments[segments.length - 1];
    return {
      name,
      type: 'file',
      path: normalized,
      language: 'json'
    };
  }).filter(Boolean);
};

const createAppState = (overrides = {}) => ({
  startAutomationJob: vi.fn().mockResolvedValue({}),
  cancelAutomationJob: vi.fn().mockResolvedValue({}),
  getJobsForProject: vi.fn().mockReturnValue([]),
  ...overrides
});

const setupFetchMock = ({
  frontend = { name: 'frontend-app', dependencies: {}, devDependencies: {} },
  backend = { name: 'backend-app', dependencies: {}, devDependencies: {} },
  root = { name: 'root-app', dependencies: {}, devDependencies: {} },
  manifestPaths = ['frontend/package.json', 'backend/package.json'],
  frontendResponse,
  backendResponse,
  rootResponse
} = {}) => {
  fetch.mockReset();
  fetch.mockImplementation((url) => {
    if (/\/api\/projects\/\d+\/files$/.test(String(url))) {
      return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(manifestPaths)));
    }
    if (url.includes('frontend/package.json')) {
      if (typeof frontendResponse === 'function') {
        return frontendResponse();
      }
      return Promise.resolve(buildFetchResponse(frontend));
    }
    if (url.includes('backend/package.json')) {
      if (typeof backendResponse === 'function') {
        return backendResponse();
      }
      return Promise.resolve(buildFetchResponse(backend));
    }
    if (url.includes('/files/package.json')) {
      if (typeof rootResponse === 'function') {
        return rootResponse();
      }
      return Promise.resolve(buildFetchResponse(root));
    }
    return Promise.resolve({
      ok: false,
      json: async () => ({ success: false })
    });
  });
  return fetch;
};

const getReactOnClick = (element) => {
  const reactKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  return reactKey ? element[reactKey]?.onClick : undefined;
};

describe('PackageTab', () => {
  const frontendManifest = {
    name: 'frontend-app',
    dependencies: { react: '^18.2.0' },
    devDependencies: { vitest: '^1.0.0' }
  };
  const backendManifest = {
    name: 'backend-app',
    dependencies: { express: '^4.18.0' },
    devDependencies: {}
  };
  let fetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = setupFetchMock({ frontend: frontendManifest, backend: backendManifest });
  });

  const getWorkspacePanel = async (workspaceKey) => {
    return screen.findByTestId(`package-workspace-panel-${workspaceKey}`);
  };

  const openAddPackageForm = async (workspaceKey, user) => {
    const panel = await getWorkspacePanel(workspaceKey);
    const openButton = within(panel).getByTestId(`package-add-open-${workspaceKey}`);
    await waitFor(() => expect(openButton).toBeEnabled());
    await user.click(openButton);
    return screen.findByTestId(`package-form-${workspaceKey}`);
  };

  test('renders dependency information for each workspace', async () => {
    useAppState.mockReturnValue(createAppState());
    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    expect(screen.getByText('react')).toBeInTheDocument();

    await user.click(screen.getByTestId('package-workspace-tab-backend'));
    await waitFor(() => expect(screen.getByTestId('package-list-backend-dependencies')).toBeInTheDocument());
    expect(screen.getByText('express')).toBeInTheDocument();
  });

  test('falls back to root package.json when workspace manifests are missing', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      if (/\/api\/projects\/\d+\/files$/.test(String(url))) {
        return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(['package.json'])));
      }
      if (String(url).includes('/files/package.json')) {
        return Promise.resolve(buildFetchResponse({
          name: 'root-layout-app',
          dependencies: { react: '^18.2.0' },
          devDependencies: {}
        }));
      }
      return Promise.resolve({
        ok: false,
        json: async () => ({ success: false, error: 'Not found' })
      });
    });

    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);

    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    expect(screen.getByText('react')).toBeInTheDocument();
  });

  test('hides workspace selectors when frontend and backend resolve to one manifest', async () => {
    useAppState.mockReturnValue(createAppState());
    setupFetchMock({
      manifestPaths: ['package.json'],
      root: {
        name: 'root-layout-app',
        dependencies: { react: '^18.2.0' },
        devDependencies: { vitest: '^1.0.0' }
      }
    });

    render(<PackageTab project={{ id: 421, name: 'Unified Layout' }} />);

    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    expect(screen.queryByTestId('package-workspace-tab-frontend')).toBeNull();
    expect(screen.queryByTestId('package-workspace-tab-backend')).toBeNull();
  });

  test('handles missing workspaces by falling back safely (branch coverage)', () => {
    useAppState.mockReturnValue(createAppState());

    const original = __testWorkspaces.slice();
    try {
      __testWorkspaces.length = 0;

      render(<PackageTab project={{ id: 909, name: 'No Workspaces' }} />);

      expect(screen.getByTestId('package-tab')).toBeInTheDocument();
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      expect(screen.queryByRole('heading', { name: 'Frontend' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Backend' })).toBeNull();
    } finally {
      __testWorkspaces.length = 0;
      __testWorkspaces.push(...original);
    }
  });

  test('manifest helper hooks normalize and score candidate paths defensively', () => {
    expect(__packageTabTestHooks.normalizeManifestPath('\\frontend\\package.json')).toBe('frontend/package.json');
    expect(__packageTabTestHooks.isUnifiedManifestLayout({ frontend: 'package.json', backend: 'package.json' })).toBe(true);
    expect(__packageTabTestHooks.isUnifiedManifestLayout({ frontend: 'package.json', backend: '' })).toBe(false);

    const score = __packageTabTestHooks.scoreManifestPathForWorkspace('not-a-manifest.txt', 'frontend');
    expect(score).toBe(Number.NEGATIVE_INFINITY);

    const unknownWorkspaceScore = __packageTabTestHooks.scoreManifestPathForWorkspace('custom/package.json', 'unknown-workspace');
    expect(Number.isFinite(unknownWorkspaceScore)).toBe(true);

    const candidates = __packageTabTestHooks.getManifestPathCandidates('frontend', { frontend: 'frontend/package.json' }, '/frontend/package.json');
    expect(candidates).toEqual(['frontend/package.json', 'package.json']);

    const fromManifestPaths = __packageTabTestHooks.getManifestPathCandidates('frontend', { frontend: 'frontend/package.json' }, undefined);
    expect(fromManifestPaths).toEqual(['frontend/package.json', 'package.json']);

    const fallbackCandidates = __packageTabTestHooks.getManifestPathCandidates('backend', null, null);
    expect(fallbackCandidates).toEqual(['backend/package.json', 'package.json']);
  });

  test('resolveWorkspaceManifestPaths handles non-array and nested tree inputs', () => {
    expect(resolveWorkspaceManifestPaths(null)).toEqual({
      frontend: 'frontend/package.json',
      backend: 'backend/package.json'
    });

    const resolved = resolveWorkspaceManifestPaths([
      null,
      {
        type: 'folder',
        path: 'frontend',
        children: [
          { type: 'file', path: '/frontend/package.json' },
          { type: 'file', path: 'notes.txt' }
        ]
      }
    ]);

    expect(resolved.frontend).toBe('frontend/package.json');
    expect(resolved.backend).toBe('frontend/package.json');
  });

  test('falls back to root manifest when workspace manifest is missing before final candidate', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      const value = String(url);
      if (/\/api\/projects\/\d+\/files$/.test(value)) {
        return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(['frontend/package.json'])));
      }
      if (value.includes('frontend/package.json')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ success: false, error: 'Not found' })
        });
      }
      if (value.includes('/files/package.json')) {
        return Promise.resolve(buildFetchResponse({
          name: 'root-layout-app',
          dependencies: { react: '^18.2.0' },
          devDependencies: {}
        }));
      }
      return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
    });

    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);
    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    expect(screen.getByText('react')).toBeInTheDocument();
  });

  test('shows load error when all manifest candidates fail and parsed result stays empty', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      const value = String(url);
      if (/\/api\/projects\/\d+\/files$/.test(value)) {
        return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(['frontend/package.json'])));
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Not found' })
      });
    });

    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);

    const panel = await screen.findByTestId('package-workspace-panel-frontend');
    await waitFor(() => {
      expect(within(panel).getByText('Not found')).toBeInTheDocument();
    });
  });

  test('falls back to defaults when manifest discovery payload is malformed', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      const value = String(url);
      if (/\/api\/projects\/\d+\/files$/.test(value)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, files: null })
        });
      }
      if (value.includes('frontend/package.json')) {
        return Promise.resolve(buildFetchResponse(frontendManifest));
      }
      if (value.includes('backend/package.json')) {
        return Promise.resolve(buildFetchResponse(backendManifest));
      }
      return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
    });

    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);
    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    expect(screen.getByText('react')).toBeInTheDocument();
  });

  test('skips discovery and render loading when project id is missing', async () => {
    useAppState.mockReturnValue(createAppState());

    render(<PackageTab project={{ id: null, name: 'No Project' }} />);

    await waitFor(() => {
      expect(screen.getByTestId('package-workspace-panel-frontend')).toBeInTheDocument();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('continues to root candidate when first manifest fetch throws not found before last candidate', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      const value = String(url);
      if (/\/api\/projects\/\d+\/files$/.test(value)) {
        return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(['frontend/package.json'])));
      }
      if (value.includes('frontend/package.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => {
            throw new Error('Not found');
          }
        });
      }
      if (value.includes('/files/package.json')) {
        return Promise.resolve(buildFetchResponse({
          name: 'root-fallback-app',
          dependencies: { react: '^18.2.0' },
          devDependencies: {}
        }));
      }
      return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
    });

    render(<PackageTab project={{ id: 77, name: 'Fallback project' }} />);

    await waitFor(() => {
      expect(screen.getByText('react')).toBeInTheDocument();
    });
  });

  test('handles invalid manifest JSON objects by setting workspace error state', async () => {
    useAppState.mockReturnValue(createAppState());
    fetch.mockReset();
    fetch.mockImplementation((url) => {
      const value = String(url);
      if (/\/api\/projects\/\d+\/files$/.test(value)) {
        return Promise.resolve(buildFilesTreeResponse(buildPackageManifestTree(['frontend/package.json', 'backend/package.json'])));
      }
      if (value.includes('frontend/package.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, content: '[]' })
        });
      }
      if (value.includes('backend/package.json')) {
        return Promise.resolve(buildFetchResponse(backendManifest));
      }
      return Promise.resolve({ ok: false, json: async () => ({ success: false }) });
    });

    render(<PackageTab project={{ id: 88, name: 'Bad manifest' }} />);

    const panel = await screen.findByTestId('package-workspace-panel-frontend');
    await waitFor(() => {
      expect(within(panel).getByText('Manifest is not a valid JSON object')).toBeInTheDocument();
    });
  });

  test('starts add-package job with provided metadata', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 99, name: 'Packages' }} />);
    const user = userEvent.setup();

    const frontendForm = await openAddPackageForm('frontend', user);
    const nameInput = within(frontendForm).getByPlaceholderText('e.g. react');
    const versionInput = within(frontendForm).getByPlaceholderText('latest');

    await user.clear(nameInput);
    await user.type(nameInput, 'zustand');
    await user.clear(versionInput);
    await user.type(versionInput, '4.0.0');
    const devCheckbox = within(frontendForm).getByLabelText('Dev dependency');
    fireEvent.click(devCheckbox);
    await waitFor(() => expect(devCheckbox).toBeChecked());
    await user.click(within(frontendForm).getByRole('button', { name: 'Add package' }));

    expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:add-package', {
      projectId: 99,
      payload: {
        packageName: 'zustand',
        version: '4.0.0',
        dev: true
      }
    });
  });

  test('opens and closes the add package modal', async () => {
    useAppState.mockReturnValue(createAppState());
    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);

    const user = userEvent.setup();
    const panel = await getWorkspacePanel('frontend');
    const openButton = within(panel).getByTestId('package-add-open-frontend');
    await waitFor(() => expect(openButton).toBeEnabled());

    await user.click(openButton);
    expect(await screen.findByTestId('package-add-modal-frontend')).toBeInTheDocument();

    await user.click(screen.getByTestId('package-add-cancel-frontend'));
    await waitFor(() => {
      expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
    });
  });

  test('focuses add-package name input without requestAnimationFrame and closes on Escape', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    const originalRaf = window.requestAnimationFrame;
    // Force the fallback focusInput() branch.
    // eslint-disable-next-line no-undef
    window.requestAnimationFrame = undefined;

    try {
      render(<PackageTab project={{ id: 123, name: 'Packages' }} />);
      const user = userEvent.setup();

      const form = await openAddPackageForm('frontend', user);
      const nameInput = within(form).getByPlaceholderText('e.g. react');

      await waitFor(() => {
        expect(document.activeElement).toBe(nameInput);
        expect(document.body.style.overflow).toBe('hidden');
      });

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
        expect(document.body.style.overflow).toBe('unset');
      });
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  test('closes add-package modal on backdrop click when not busy', async () => {
    useAppState.mockReturnValue(createAppState());
    render(<PackageTab project={{ id: 456, name: 'Packages' }} />);
    const user = userEvent.setup();

    await openAddPackageForm('frontend', user);
    const backdrop = await screen.findByTestId('package-add-modal-frontend');

    fireEvent.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
    });
  });

  test('closes add-package modal after a successful add-package job', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 777, name: 'Packages' }} />);
    const user = userEvent.setup();

    const form = await openAddPackageForm('frontend', user);
    const nameInput = within(form).getByPlaceholderText('e.g. react');
    await user.type(nameInput, 'left-pad');

    await user.click(within(form).getByRole('button', { name: 'Add package' }));

    await waitFor(() => {
      expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
    });

    const reopenedForm = await openAddPackageForm('frontend', user);
    expect(within(reopenedForm).getByPlaceholderText('e.g. react')).toHaveValue('');
    expect(within(reopenedForm).getByPlaceholderText('latest')).toHaveValue('');
  });

  test('does not reopen add-package modal when it is closed mid-flight (covers modal workspaceKey update else branch)', async () => {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });

    const context = createAppState({
      startAutomationJob: vi.fn().mockReturnValue(deferred.promise)
    });
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 888, name: 'Packages' }} />);
    const user = userEvent.setup();

    const form = await openAddPackageForm('frontend', user);
    const nameInput = within(form).getByPlaceholderText('e.g. react');
    await user.type(nameInput, 'mid-flight');

    await user.click(within(form).getByRole('button', { name: 'Add package' }));

    // Switching tabs closes the modal via the activeWorkspaceKey effect.
    await user.click(screen.getByTestId('package-workspace-tab-backend'));

    await waitFor(() => {
      expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
    });

    await act(async () => {
      deferred.resolve({});
      await Promise.resolve();
    });

    // Modal should remain closed after the job settles.
    expect(screen.queryByTestId('package-add-modal-frontend')).toBeNull();
  });

  test('removing a dependency queues remove-package job', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 77, name: 'Packages' }} />);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('package-entry-frontend-dependencies-react')).toBeInTheDocument());

    const removeButtons = screen.getAllByText('Remove');
    await user.click(removeButtons[0]);

    expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:remove-package', {
      projectId: 77,
      payload: {
        packageName: 'react',
        dev: false
      }
    });
  });

  test('refetches manifests when a package job succeeds', async () => {
    const jobs = [
      { id: 'job-1', type: 'frontend:add-package', status: 'succeeded' }
    ];
    const context = createAppState({ getJobsForProject: vi.fn().mockReturnValue(jobs) });
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 7, name: 'Packages' }} />);

    await waitFor(() => {
      const frontendCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('frontend/package.json'));
      expect(frontendCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('backend package jobs also refetch manifests when they finish', async () => {
    const jobs = [
      { id: 'job-2', type: 'backend:remove-package', status: 'succeeded' }
    ];
    const context = createAppState({ getJobsForProject: vi.fn().mockReturnValue(jobs) });
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 8, name: 'Packages' }} />);

    await waitFor(() => {
      const backendCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('backend/package.json'));
      expect(backendCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('shows validation error when package name is missing', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 91, name: 'Packages' }} />);

    const frontendForm = await openAddPackageForm('frontend', user);
    await user.click(within(frontendForm).getByRole('button', { name: 'Add package' }));

    expect(context.startAutomationJob).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a package name before adding it.');
  });

  test('displays install failures as global errors', async () => {
    const installError = new Error('Install failed');
    const context = createAppState({ startAutomationJob: vi.fn().mockRejectedValue(installError) });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 12, name: 'Packages' }} />);

    const frontendPanel = await getWorkspacePanel('frontend');
    const installButton = within(frontendPanel).getByRole('button', { name: 'Install dependencies' });
    await waitFor(() => expect(installButton).toBeEnabled());
    await user.click(installButton);

    await waitFor(() => expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:install', { projectId: 12 }));
    expect(screen.getByRole('alert')).toHaveTextContent('Install failed');
  });

  test('install action triggers automation job when project context is available', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 14, name: 'Packages' }} />);

    const frontendPanel = await getWorkspacePanel('frontend');
    const installButton = within(frontendPanel).getByRole('button', { name: 'Install dependencies' });
    await waitFor(() => expect(installButton).toBeEnabled());
    await user.click(installButton);

    await waitFor(() => expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:install', { projectId: 14 }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('install action uses fallback error copy when automation error lacks message', async () => {
    const context = createAppState({ startAutomationJob: vi.fn().mockRejectedValue({}) });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 13, name: 'Packages' }} />);

    const frontendPanel = await getWorkspacePanel('frontend');
    const installButton = within(frontendPanel).getByRole('button', { name: 'Install dependencies' });
    await waitFor(() => expect(installButton).toBeEnabled());
    await user.click(installButton);

    await waitFor(() => expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:install', { projectId: 13 }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to start install job');
  });

  test('renders workspace errors when manifest fetch fails', async () => {
    fetchMock = setupFetchMock({
      frontend: frontendManifest,
      backendResponse: () => Promise.resolve({
        ok: false,
        json: async () => ({ success: false, error: 'Backend offline' })
      })
    });
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 5, name: 'Packages' }} />);

    await user.click(screen.getByTestId('package-workspace-tab-backend'));
    const errorMessage = await screen.findByTestId('package-error-backend');
    expect(errorMessage).toHaveTextContent('Backend offline');
  });

  test('falls back to generic manifest error when fetch rejects without message', async () => {
    fetchMock = setupFetchMock({
      frontendResponse: () => Promise.reject({})
    });
    useAppState.mockReturnValue(createAppState());

    render(<PackageTab project={{ id: 15, name: 'Packages' }} />);

    const errorMessage = await screen.findByTestId('package-error-frontend');
    expect(errorMessage).toHaveTextContent('Failed to load manifest');
  });

  test('renders empty dependency groups when manifest lacks dependency objects', async () => {
    fetchMock = setupFetchMock({
      frontend: frontendManifest,
      backend: { name: 'backend-app' }
    });
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 55, name: 'Packages' }} />);

    await user.click(screen.getByTestId('package-workspace-tab-backend'));
    await screen.findByTestId('package-empty-backend-dependencies');

    expect(screen.getByTestId('package-empty-backend-dependencies')).toHaveTextContent('No dependencies defined');
    expect(screen.getByTestId('package-empty-backend-devDependencies')).toHaveTextContent('No dev dependencies defined');
  });

  test('treats manifest as loaded even when name is missing', async () => {
    fetchMock = setupFetchMock({
      backend: { name: '', version: '2.5.0', dependencies: {}, devDependencies: {} }
    });
    useAppState.mockReturnValue(createAppState());
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 56, name: 'Packages' }} />);

    await user.click(screen.getByTestId('package-workspace-tab-backend'));
    const backendPanel = await getWorkspacePanel('backend');
    const addOpenButton = within(backendPanel).getByTestId('package-add-open-backend');
    await waitFor(() => expect(addOpenButton).toBeEnabled());
    expect(within(backendPanel).getByTestId('package-empty-backend-dependencies')).toBeInTheDocument();
  });

  test('refresh button reloads manifests for a workspace', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 63, name: 'Packages' }} />);

    await user.click(screen.getByTestId('package-workspace-tab-backend'));

    const backendPanel = await getWorkspacePanel('backend');
    const refreshButton = within(backendPanel).getByRole('button', { name: 'Refresh' });

    await user.click(refreshButton);

    await waitFor(() => {
      const backendCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('backend/package.json'));
      expect(backendCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('shows job running label while workspace automation is active', async () => {
    const jobs = [{ id: 'job-running', type: 'frontend:add-package', status: 'running' }];
    const context = createAppState({ getJobsForProject: vi.fn().mockReturnValue(jobs) });
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 64, name: 'Packages' }} />);

    const busyButton = await screen.findByRole('button', { name: 'Job running…' });
    expect(busyButton).toBeDisabled();
  });

  test('shows missing manifest message and skips fetch when project is undefined', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={null} />);

    const frontendPanel = await getWorkspacePanel('frontend');
    expect(within(frontendPanel).getByTestId('package-missing-frontend')).toHaveTextContent('package.json not found');

    const refreshButton = within(frontendPanel).getByRole('button', { name: 'Refresh' });
    await user.click(refreshButton);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('resolveActionProjectId preserves overrides including null', () => {
    expect(resolveActionProjectId('proj-1', 'override')).toBe('override');
    expect(resolveActionProjectId('proj-1', null)).toBeNull();
  });

  test('resolveActionProjectId falls back to projectId when override is undefined', () => {
    expect(resolveActionProjectId('proj-2', undefined)).toBe('proj-2');
  });

  test('install action ignores clicks when project is missing', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 111, name: 'Packages' }} forceProjectId={null} />);

    const frontendPanel = await getWorkspacePanel('frontend');
    const installButton = within(frontendPanel).getByRole('button', { name: 'Install dependencies' });
    const handler = getReactOnClick(installButton);
    expect(handler).toBeInstanceOf(Function);

    await act(async () => {
      await handler();
    });

    expect(context.startAutomationJob).not.toHaveBeenCalled();
  });

  test('add package action exits early when project context is missing', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 222, name: 'Packages' }} forceProjectId={null} />);

    const user = userEvent.setup();
    const frontendForm = await openAddPackageForm('frontend', user);
    const addButton = within(frontendForm).getByRole('button', { name: 'Add package' });
    const handler = getReactOnClick(addButton);
    expect(handler).toBeInstanceOf(Function);

    await act(async () => {
      await handler();
    });

    expect(context.startAutomationJob).not.toHaveBeenCalled();
  });

  test('remove package action does nothing without a project id', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 333, name: 'Packages' }} forceProjectId={null} />);

    const dependencyEntry = await screen.findByTestId('package-entry-frontend-dependencies-react');
    const removeButton = within(dependencyEntry).getByRole('button', { name: 'Remove' });
    const handler = getReactOnClick(removeButton);
    expect(handler).toBeInstanceOf(Function);

    await act(async () => {
      await handler();
    });

    expect(context.startAutomationJob).not.toHaveBeenCalled();
  });

  test('shows error when manifest response lacks string content', async () => {
    fetchMock = setupFetchMock({
      frontendResponse: () => Promise.resolve({
        ok: true,
        json: async () => ({ success: true, content: { invalid: true } })
      }),
      backend: backendManifest
    });
    useAppState.mockReturnValue(createAppState());

    render(<PackageTab project={{ id: 81, name: 'Broken' }} />);

    const errorMessage = await screen.findByTestId('package-error-frontend');
    expect(errorMessage).toHaveTextContent('Failed to load package manifest');
  });

  test('shows error when manifest parses to a non-object value', async () => {
    fetchMock = setupFetchMock({
      frontendResponse: () => Promise.resolve({
        ok: true,
        json: async () => ({ success: true, content: JSON.stringify(['react']) })
      }),
      backend: backendManifest
    });
    useAppState.mockReturnValue(createAppState());

    render(<PackageTab project={{ id: 82, name: 'Broken' }} />);

    const errorMessage = await screen.findByTestId('package-error-frontend');
    expect(errorMessage).toHaveTextContent('Manifest is not a valid JSON object');
  });

  test('add package surfaces automation failures and preserves draft input', async () => {
    const startAutomationJob = vi.fn().mockRejectedValue(new Error('Add failed'));
    const context = createAppState({ startAutomationJob });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 101, name: 'Packages' }} />);

    const frontendForm = await openAddPackageForm('frontend', user);
    const nameInput = within(frontendForm).getByPlaceholderText('e.g. react');
    await user.clear(nameInput);
    await user.type(nameInput, 'lint-staged');

    await user.click(within(frontendForm).getByRole('button', { name: 'Add package' }));

    await waitFor(() => expect(startAutomationJob).toHaveBeenCalledWith('frontend:add-package', expect.any(Object)));
    expect(screen.getByRole('alert')).toHaveTextContent('Add failed');
    expect(nameInput).toHaveValue('lint-staged');
  });

  test('add package uses fallback error copy when automation error lacks message', async () => {
    const startAutomationJob = vi.fn((type) => {
      if (type.endsWith(':add-package')) {
        return Promise.reject({});
      }
      return Promise.resolve({});
    });
    const context = createAppState({ startAutomationJob });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 102, name: 'Packages' }} />);

    const frontendForm = await openAddPackageForm('frontend', user);
    const nameInput = within(frontendForm).getByPlaceholderText('e.g. react');
    await user.clear(nameInput);
    await user.type(nameInput, 'storybook');

    await user.click(within(frontendForm).getByRole('button', { name: 'Add package' }));

    await waitFor(() => expect(startAutomationJob).toHaveBeenCalledWith('frontend:add-package', expect.any(Object)));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to add package');
    expect(nameInput).toHaveValue('storybook');
  });

  test('remove package surfaces automation failures', async () => {
    const startAutomationJob = vi.fn((type) => {
      if (type.endsWith(':remove-package')) {
        return Promise.reject(new Error('Remove failed'));
      }
      return Promise.resolve({});
    });
    const context = createAppState({ startAutomationJob });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 202, name: 'Packages' }} />);

    const frontendDependencies = await screen.findByTestId('package-list-frontend-dependencies');
    const removeButtons = within(frontendDependencies).getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);

    await waitFor(() => expect(startAutomationJob).toHaveBeenCalledWith('frontend:remove-package', expect.any(Object)));
    expect(screen.getByRole('alert')).toHaveTextContent('Remove failed');
  });

  test('remove package uses fallback error copy when automation error lacks message', async () => {
    const startAutomationJob = vi.fn((type) => {
      if (type.endsWith(':remove-package')) {
        return Promise.reject({});
      }
      return Promise.resolve({});
    });
    const context = createAppState({ startAutomationJob });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 203, name: 'Packages' }} />);

    const frontendDependencies = await screen.findByTestId('package-list-frontend-dependencies');
    const removeButtons = within(frontendDependencies).getAllByRole('button', { name: 'Remove' });
    await user.click(removeButtons[0]);

    await waitFor(() => expect(startAutomationJob).toHaveBeenCalledWith('frontend:remove-package', expect.any(Object)));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to remove package');
  });

  test('refresh ignores clicks while the workspace is already loading', async () => {
    let resolveBackend;
    fetchMock = setupFetchMock({
      frontend: frontendManifest,
      backendResponse: () => new Promise((resolve) => {
        resolveBackend = () => resolve(buildFetchResponse(backendManifest));
      })
    });
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 303, name: 'Packages' }} />);

    await user.click(screen.getByTestId('package-workspace-tab-backend'));

    const backendPanel = await getWorkspacePanel('backend');
    const loadingRefreshButton = within(backendPanel).getByRole('button', { name: 'Refreshing…' });

    const initialBackendCalls = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('backend/package.json')).length;
    const handler = getReactOnClick(loadingRefreshButton);
    expect(handler).toBeInstanceOf(Function);

    await act(async () => {
      handler();
    });

    const backendCallsAfterClick = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('backend/package.json')).length;
    expect(backendCallsAfterClick).toBe(initialBackendCalls);

    await act(async () => {
      resolveBackend();
    });

    await waitFor(() => within(backendPanel).getByRole('button', { name: 'Refresh' }));
  });

  test('does not register fetchManifest hook when __testHooks is missing', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const originalHooks = PackageTab.__testHooks;
    PackageTab.__testHooks = undefined;

    try {
      render(<PackageTab project={{ id: 505, name: 'Packages' }} />);
      await screen.findByTestId('package-tab');
      expect(PackageTab.__testHooks).toBeUndefined();
    } finally {
      PackageTab.__testHooks = originalHooks;
    }
  });

  test('cleanup skips resetting hooks when container disappears before unmount', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const originalHooks = PackageTab.__testHooks;

    const { unmount } = render(<PackageTab project={{ id: 606, name: 'Packages' }} />);

    await waitFor(() => {
      expect(typeof PackageTab.__testHooks.fetchManifest).toBe('function');
    });

    PackageTab.__testHooks = undefined;

    await act(async () => {
      unmount();
    });

    expect(PackageTab.__testHooks).toBeUndefined();
    PackageTab.__testHooks = originalHooks;
  });

  test('fetch manifest hook ignores unknown workspace keys', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 404, name: 'Packages' }} />);

    await waitFor(() => {
      expect(typeof PackageTab.__testHooks.fetchManifest).toBe('function');
    });

    const initialBackendCalls = fetchMock.mock.calls.length;

    await act(async () => {
      await PackageTab.__testHooks.fetchManifest('docs');
    });

    expect(fetchMock.mock.calls.length).toBe(initialBackendCalls);
  });
});
