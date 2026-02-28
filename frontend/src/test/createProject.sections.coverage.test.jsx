import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CreateProjectProgressPanel from '../components/create-project/CreateProjectProgressPanel.jsx';
import ProjectSourceSection from '../components/create-project/ProjectSourceSection.jsx';

describe('create-project section coverage', () => {
  test('CreateProjectProgressPanel renders no-missing-entries messaging when only tracked files exist', () => {
    render(
      <CreateProjectProgressPanel
        progress={{ completion: 50, status: 'running', statusMessage: 'Working…', steps: [] }}
        processes={null}
        gitIgnoreSuggestion={{ entries: [], trackedFiles: ['package-lock.json'], samplePaths: [] }}
        gitIgnoreStatus={{ state: 'idle', error: '' }}
        onApplyGitIgnore={vi.fn()}
        onSkipGitIgnore={vi.fn()}
        onContinueAfterGitIgnore={vi.fn()}
      />
    );

    expect(screen.getByText(/no new \.gitignore entries will be added\./i)).toBeInTheDocument();
  });

  test('CreateProjectProgressPanel renders append message when missing gitignore entries exist', () => {
    render(
      <CreateProjectProgressPanel
        progress={{ completion: 50, status: 'running', statusMessage: 'Working…', steps: [] }}
        processes={null}
        gitIgnoreSuggestion={{ entries: ['node_modules/'], trackedFiles: [], samplePaths: [] }}
        gitIgnoreStatus={{ state: 'idle', error: '' }}
        onApplyGitIgnore={vi.fn()}
        onSkipGitIgnore={vi.fn()}
        onContinueAfterGitIgnore={vi.fn()}
      />
    );

    expect(screen.getByText(/append 1 missing entry to \.gitignore\./i)).toBeInTheDocument();
  });

  test('CreateProjectProgressPanel renders plural append message for multiple missing entries', () => {
    render(
      <CreateProjectProgressPanel
        progress={{ completion: 50, status: 'running', statusMessage: 'Working…', steps: [] }}
        processes={null}
        gitIgnoreSuggestion={{ entries: ['node_modules/', 'dist/'], trackedFiles: [], samplePaths: [] }}
        gitIgnoreStatus={{ state: 'idle', error: '' }}
        onApplyGitIgnore={vi.fn()}
        onSkipGitIgnore={vi.fn()}
        onContinueAfterGitIgnore={vi.fn()}
      />
    );

    expect(screen.getByText(/append 2 missing entries to \.gitignore\./i)).toBeInTheDocument();
  });

  test('ProjectSourceSection onChange updates source and clears errors', () => {
    const setProjectSource = vi.fn();
    const setCreateError = vi.fn();

    render(
      <ProjectSourceSection
        projectSource="template"
        setProjectSource={setProjectSource}
        setCreateError={setCreateError}
        createLoading={false}
      />
    );

    const gitRadio = screen.getByRole('radio', { name: /Clone from Git/i });
    fireEvent.click(gitRadio);

    expect(setProjectSource).toHaveBeenCalledWith('git');
    expect(setCreateError).toHaveBeenCalledWith('');
  });

  test('ProjectSourceSection template option triggers onChange when switching from another source', () => {
    const setProjectSource = vi.fn();
    const setCreateError = vi.fn();

    render(
      <ProjectSourceSection
        projectSource="new"
        setProjectSource={setProjectSource}
        setCreateError={setCreateError}
        createLoading={false}
      />
    );

    fireEvent.click(screen.getByRole('radio', { name: /Lucid Coder Default Template/i }));

    expect(setProjectSource).toHaveBeenCalledWith('template');
    expect(setCreateError).toHaveBeenCalledWith('');
  });
});
