import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import GitSettingsModal from '../components/GitSettingsModal.jsx';

const baseSettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  defaultBranch: 'main'
};

describe('GitSettingsModal', () => {
  const onClose = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not render when closed', () => {
    render(
      <GitSettingsModal
        isOpen={false}
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
      />
    );

    expect(screen.queryByTestId('git-settings-modal')).toBeNull();
  });

  test('handles null settings with defaults', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={null}
      />
    );

    const branchInput = screen.getByTestId('git-default-branch');
    expect(branchInput.value).toBe('main');
  });

  test('shows global scope info by default', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="global"
      />
    );

    expect(screen.getByRole('heading', { name: /git settings/i })).toBeInTheDocument();
    expect(screen.getByText(/Cloud-connected projects auto-push merges to the remote repo\./i)).toBeInTheDocument();
    expect(screen.getByTestId('git-scope-badge').textContent).toMatch(/Global Default/i);
  });

  test('shows project scope label when provided', () => {
    render(
      <GitSettingsModal
        isOpen
        scope="project"
        projectName="LSML"
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
      />
    );

    const scopeBadge = screen.getByTestId('git-scope-badge').textContent;
    expect(scopeBadge).toContain('Project');
    expect(scopeBadge).toContain('LSML');
    expect(screen.getByText(/Overrides just for LSML/)).toBeInTheDocument();
  });

  test('falls back to generic project labels when name missing', () => {
    render(
      <GitSettingsModal
        isOpen
        scope="project"
        projectName=""
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
      />
    );

    const scopeBadge = screen.getByTestId('git-scope-badge').textContent;
    expect(scopeBadge).toContain('Project');
    expect(scopeBadge).toContain('Current Project');
    expect(screen.getByText(/Overrides just for this project\./i)).toBeInTheDocument();
  });

  test('switches to cloud workflow and exposes provider fields', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="project"
        projectName="LSML"
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    expect(screen.getByTestId('git-workflow-cloud')).toBeChecked();

    const providerSelect = await screen.findByTestId('git-provider-select', undefined, { timeout: 5000 });
    expect(providerSelect).toBeInTheDocument();
    await user.selectOptions(providerSelect, 'gitlab');
    await user.type(screen.getByTestId('git-remote-url'), 'https://gitlab.com/demo/repo.git');
    await user.type(screen.getByTestId('git-token'), 'secret');

    fireEvent.submit(screen.getByTestId('git-settings-form'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/demo/repo.git',
        token: 'secret',
        defaultBranch: 'main'
      })
    );
  });

  test('defaults provider to GitHub when switching cloud without prior value', async () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, provider: '' }}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    const providerSelect = await screen.findByTestId('git-provider-select');
    expect(providerSelect).toHaveValue('github');
  });

  test('test connection uses account name fallback and default success copy', async () => {
    const onTestConnection = vi.fn().mockResolvedValue({ account: { name: 'Octo' } });
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="global"
        onTestConnection={onTestConnection}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    await user.click(screen.getByTestId('git-test-connection'));

    expect(await screen.findByTestId('git-test-connection-status')).toHaveTextContent('Connected as Octo');
  });

  test('test connection falls back to default error message', async () => {
    const onTestConnection = vi.fn().mockRejectedValue({});
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="global"
        onTestConnection={onTestConnection}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    await user.click(screen.getByTestId('git-test-connection'));

    expect(await screen.findByTestId('git-test-connection-status')).toHaveTextContent('Connection failed');
  });

  test('renders connection summary and metadata from status', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
        connectionStatus={{
          provider: 'github',
          account: { name: 'Octo' },
          message: 'Connected',
          testedAt: '2026-01-01T00:00:00.000Z'
        }}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    expect(screen.getByTestId('git-connection-summary')).toHaveTextContent('Connected as Octo');
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
  });

  test('renders connection summary without account name', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
        connectionStatus={{
          provider: 'github',
          account: null,
          message: 'Connected',
          testedAt: ''
        }}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    expect(screen.getByTestId('git-connection-summary')).toHaveTextContent('Connected');
  });

  test('does not show expiry warning when token is far in the future', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, tokenExpiresAt: '2099-01-01' }}
        scope="global"
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    expect(screen.queryByTestId('git-token-expiry-warning')).toBeNull();
  });

  test('shows last tested metadata after successful test', async () => {
    const onTestConnection = vi.fn().mockResolvedValue({ message: 'Connected' });
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="global"
        connectionStatus={{ provider: 'github', testedAt: '2026-01-01T00:00:00.000Z' }}
        onTestConnection={onTestConnection}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    await user.click(screen.getByTestId('git-test-connection'));

    expect(await screen.findByTestId('git-test-connection-meta')).toBeInTheDocument();
  });

  test('close and cancel buttons invoke onClose without submitting', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="project"
        projectName="LSML"
      />
    );

    await user.click(screen.getByTestId('git-close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    onClose.mockClear();

    await user.click(screen.getByTestId('git-cancel-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('backdrop click closes the modal', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="project"
        projectName="LSML"
      />
    );

    await user.click(screen.getByTestId('git-settings-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('PAT help modal can be opened and closed', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="global"
      />
    );

    await user.click(screen.getByTestId('git-workflow-cloud'));
    await user.click(screen.getByTestId('git-pat-help'));

    expect(screen.getByTestId('modal-content')).toBeInTheDocument();

    await user.click(screen.getByTestId('modal-close'));
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
  });

  test('allows switching back to local workflow', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
        scope="project"
        projectName="LSML"
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    const remoteUrl = await screen.findByTestId('git-remote-url');
    await user.type(remoteUrl, 'https://example.com/repo.git');
    fireEvent.click(screen.getByTestId('git-workflow-local'));
    expect(screen.queryByTestId('git-provider-select')).toBeNull();

    fireEvent.change(screen.getByTestId('git-default-branch'), { target: { value: 'release' } });
    fireEvent.submit(screen.getByTestId('git-settings-form'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'local',
        defaultBranch: 'release'
      })
    );
  });

  test('shows PAT help dialog from global settings', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    await user.click(screen.getByTestId('git-pat-help'));

    expect(screen.getByText('Personal access tokens')).toBeInTheDocument();
    expect(screen.getByText(/GitHub personal access token/i)).toBeInTheDocument();
  });

  test('shows persisted connection status on reopen', async () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
        connectionStatus={{
          provider: 'github',
          account: { login: 'octo' },
          message: 'Connected to GitHub',
          testedAt: '2026-01-01T10:00:00.000Z'
        }}
      />
    );

    expect(screen.getByTestId('git-connection-summary')).toHaveTextContent('Connected to GitHub as octo');
    expect(screen.getByTestId('git-connection-edit')).toBeInTheDocument();
  });

  test('shows expiry warning when token is near expiration', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const expiry = future.toISOString().slice(0, 10);

    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud', tokenExpiresAt: expiry }}
        scope="global"
      />
    );

    expect(screen.getByTestId('git-token-expiry-warning')).toHaveTextContent('expires in');
  });

  test('shows connection form after clicking change connection', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
        connectionStatus={{
          provider: 'github',
          account: { login: 'octo' },
          message: 'Connected to GitHub',
          testedAt: '2026-01-01T10:00:00.000Z'
        }}
      />
    );

    await user.click(screen.getByTestId('git-connection-edit'));

    expect(screen.getByTestId('git-provider-select')).toBeInTheDocument();
  });

  test('test connection button calls handler and shows status', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockResolvedValue({
      provider: 'github',
      account: { login: 'octo' },
      message: 'Connected to GitHub'
    });

    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        onTestConnection={onTestConnection}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    await user.click(screen.getByTestId('git-test-connection'));

    expect(onTestConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', token: '' })
    );
    expect(await screen.findByTestId('git-test-connection-status')).toHaveTextContent('Connected to GitHub as octo');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('test connection is a no-op without a handler', async () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    expect(screen.queryByTestId('git-test-connection')).toBeNull();
    expect(screen.queryByTestId('git-test-connection-status')).toBeNull();
  });

  test('test connection message falls back to account name when login is missing', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockResolvedValue({
      provider: 'github',
      account: { name: 'Octo Name' },
      message: 'Connected'
    });

    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        onTestConnection={onTestConnection}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    await user.click(screen.getByTestId('git-test-connection'));

    expect(await screen.findByTestId('git-test-connection-status')).toHaveTextContent('Connected as Octo Name');
  });

  test('shows expiry warnings for invalid, expired, and near-expiry tokens', async () => {
    const expired = new Date();
    expired.setDate(expired.getDate() - 1);
    const near = new Date();
    near.setDate(near.getDate() + 1);

    const { rerender } = render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud', tokenExpiresAt: 'not-a-date' }}
        scope="global"
      />
    );

    expect(screen.getByTestId('git-token-expiry-warning')).toHaveTextContent('Token expiry date is invalid');

    rerender(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud', tokenExpiresAt: expired.toISOString().slice(0, 10) }}
        scope="global"
      />
    );

    expect(screen.getByTestId('git-token-expiry-warning')).toHaveTextContent('expired');

    rerender(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ ...baseSettings, workflow: 'cloud', tokenExpiresAt: near.toISOString().slice(0, 10) }}
        scope="global"
      />
    );

    expect(screen.getByTestId('git-token-expiry-warning')).toHaveTextContent('expires in 1 day');
  });

  test('test connection shows error status when request fails', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockRejectedValue(new Error('No access'));

    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        onTestConnection={onTestConnection}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    await user.click(screen.getByTestId('git-test-connection'));

    const status = await screen.findByTestId('git-test-connection-status');
    expect(status).toHaveTextContent('No access');
  });

  test('auto-saves token after successful global test when token is provided', async () => {
    const user = userEvent.setup();
    const onTestConnection = vi.fn().mockResolvedValue({
      provider: 'github',
      account: { login: 'octo' },
      message: 'Connected to GitHub'
    });

    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        onTestConnection={onTestConnection}
        settings={{ ...baseSettings, workflow: 'cloud' }}
        scope="global"
      />
    );

    await user.type(screen.getByTestId('git-token'), 'secret');
    await user.click(screen.getByTestId('git-test-connection'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'github',
        token: 'secret'
      }),
      { keepOpen: true }
    );
  });
});
