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
  defaultBranch: 'main',
  autoPush: false,
  useCommitTemplate: false,
  commitTemplate: ''
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

  test('shows global scope info by default', () => {
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
      />
    );

    expect(screen.getByRole('heading', { name: /git settings/i })).toBeInTheDocument();
    expect(screen.getByText(/Control how Lucid Coder manages/i)).toBeInTheDocument();
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
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    expect(screen.getByTestId('git-workflow-cloud')).toBeChecked();

    const providerSelect = await screen.findByTestId('git-provider-select', undefined, { timeout: 5000 });
    expect(providerSelect).toBeInTheDocument();
    await user.selectOptions(providerSelect, 'gitlab');
    await user.type(screen.getByTestId('git-remote-url'), 'https://gitlab.com/demo/repo.git');
    await user.type(screen.getByTestId('git-username'), 'octo');
    await user.type(screen.getByTestId('git-token'), 'secret');

    fireEvent.click(screen.getByTestId('git-commit-template-toggle'));
    const commitTemplate = await screen.findByTestId('git-commit-template', undefined, { timeout: 5000 });
    await user.type(commitTemplate, 'feat: change summary');

    fireEvent.click(screen.getByTestId('git-auto-push'));

    fireEvent.submit(screen.getByTestId('git-settings-form'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/demo/repo.git',
        username: 'octo',
        token: 'secret',
        autoPush: true,
        useCommitTemplate: true,
        commitTemplate: 'feat: change summary'
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

  test('close and cancel buttons invoke onClose without submitting', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
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
      />
    );

    await user.click(screen.getByTestId('git-settings-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('allows switching back to local workflow', async () => {
    const user = userEvent.setup();
    render(
      <GitSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={baseSettings}
      />
    );

    fireEvent.click(screen.getByTestId('git-workflow-cloud'));
    const remoteUrl = await screen.findByTestId('git-remote-url');
    await user.type(remoteUrl, 'https://example.com/repo.git');
    await user.type(screen.getByTestId('git-username'), 'demo-user');

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
});
