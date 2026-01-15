import React from 'react';
import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PackageTab, { resolveActionProjectId } from '../components/PackageTab';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const buildFetchResponse = (content) => ({
  ok: true,
  json: async () => ({ success: true, content: JSON.stringify(content) })
});

const createAppState = (overrides = {}) => ({
  startAutomationJob: vi.fn().mockResolvedValue({}),
  cancelAutomationJob: vi.fn().mockResolvedValue({}),
  getJobsForProject: vi.fn().mockReturnValue([]),
  ...overrides
});

const setupFetchMock = ({
  frontend = { name: 'frontend-app', dependencies: {}, devDependencies: {} },
  backend = { name: 'backend-app', dependencies: {}, devDependencies: {} },
  frontendResponse,
  backendResponse
} = {}) => {
  const mock = vi.fn((url) => {
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
    return Promise.resolve({
      ok: false,
      json: async () => ({ success: false })
    });
  });
  global.fetch = mock;
  return mock;
};

const getReactOnClick = (element) => {
  const reactKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  return reactKey ? element[reactKey]?.onClick : undefined;
};

describe('PackageTab', () => {
  const originalFetch = global.fetch;
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

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('renders dependency information for each workspace', async () => {
    useAppState.mockReturnValue(createAppState());
    render(<PackageTab project={{ id: 42, name: 'Demo' }} />);

    await waitFor(() => expect(screen.getByTestId('package-list-frontend-dependencies')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('package-list-backend-dependencies')).toBeInTheDocument());

    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('express')).toBeInTheDocument();
  });

  test('starts add-package job with provided metadata', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);

    render(<PackageTab project={{ id: 99, name: 'Packages' }} />);
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('package-form-frontend')).toBeInTheDocument());

    const frontendForm = screen.getByTestId('package-form-frontend');
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

    const frontendForm = await screen.findByTestId('package-form-frontend');
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

    const frontendSection = await screen.findByRole('heading', { name: 'Frontend' });
    const installButton = within(frontendSection.closest('section')).getByRole('button', { name: 'Install dependencies' });
    await user.click(installButton);

    await waitFor(() => expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:install', { projectId: 12 }));
    expect(screen.getByRole('alert')).toHaveTextContent('Install failed');
  });

  test('install action triggers automation job when project context is available', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 14, name: 'Packages' }} />);

    const frontendHeading = await screen.findByRole('heading', { name: 'Frontend' });
    const frontendSection = frontendHeading.closest('section');
    const installButton = within(frontendSection).getByRole('button', { name: 'Install dependencies' });
    await user.click(installButton);

    await waitFor(() => expect(context.startAutomationJob).toHaveBeenCalledWith('frontend:install', { projectId: 14 }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('install action uses fallback error copy when automation error lacks message', async () => {
    const context = createAppState({ startAutomationJob: vi.fn().mockRejectedValue({}) });
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 13, name: 'Packages' }} />);

    const frontendHeading = await screen.findByRole('heading', { name: 'Frontend' });
    const frontendSection = frontendHeading.closest('section');
    const installButton = within(frontendSection).getByRole('button', { name: 'Install dependencies' });
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

    render(<PackageTab project={{ id: 5, name: 'Packages' }} />);

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

    render(<PackageTab project={{ id: 55, name: 'Packages' }} />);

    await screen.findByTestId('package-form-backend');

    expect(screen.getByTestId('package-empty-backend-dependencies')).toHaveTextContent('No dependencies defined');
    expect(screen.getByTestId('package-empty-backend-devDependencies')).toHaveTextContent('No dev dependencies defined');
  });

  test('renders fallback manifest metadata when name is missing but version exists', async () => {
    fetchMock = setupFetchMock({
      backend: { name: '', version: '2.5.0', dependencies: {}, devDependencies: {} }
    });
    useAppState.mockReturnValue(createAppState());

    render(<PackageTab project={{ id: 56, name: 'Packages' }} />);

    const backendHeading = await screen.findByRole('heading', { name: 'Backend' });
    const backendSection = backendHeading.closest('section');
    expect(within(backendSection).getByText('Unnamed workspace · v2.5.0')).toBeInTheDocument();
  });

  test('refresh button reloads manifests for a workspace', async () => {
    const context = createAppState();
    useAppState.mockReturnValue(context);
    const user = userEvent.setup();

    render(<PackageTab project={{ id: 63, name: 'Packages' }} />);

    const backendHeading = await screen.findByRole('heading', { name: 'Backend' });
    const backendSection = backendHeading.closest('section');
    const refreshButton = within(backendSection).getByRole('button', { name: 'Refresh' });

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

    const frontendHeading = screen.getByRole('heading', { name: 'Frontend' });
    const frontendSection = frontendHeading.closest('section');
    expect(within(frontendSection).getByTestId('package-missing-frontend')).toHaveTextContent('package.json not found');

    const refreshButton = within(frontendSection).getByRole('button', { name: 'Refresh' });
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

    const frontendHeading = await screen.findByRole('heading', { name: 'Frontend' });
    const frontendSection = frontendHeading.closest('section');
    const installButton = within(frontendSection).getByRole('button', { name: 'Install dependencies' });
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

    const frontendForm = await screen.findByTestId('package-form-frontend');
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

    const frontendForm = await screen.findByTestId('package-form-frontend');
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

    const frontendForm = await screen.findByTestId('package-form-frontend');
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

    render(<PackageTab project={{ id: 303, name: 'Packages' }} />);

    const backendHeading = await screen.findByRole('heading', { name: 'Backend' });
    const backendSection = backendHeading.closest('section');
    const loadingRefreshButton = within(backendSection).getByRole('button', { name: 'Refreshing…' });

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

    await waitFor(() => within(backendSection).getByRole('button', { name: 'Refresh' }));
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
