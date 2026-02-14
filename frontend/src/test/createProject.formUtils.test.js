import { describe, expect, test } from 'vitest';
import {
  deriveRepoName,
  resolveFrontendFrameworkOptions,
  resolveBackendFrameworkOptions,
  applyDetectedTechToProject,
  buildGitSummaryItems
} from '../components/create-project/formUtils';

describe('createProject formUtils', () => {
  test('derives repo names from URL-like values', () => {
    expect(deriveRepoName('https://github.com/acme/repo.git')).toBe('repo');
    expect(deriveRepoName('git@github.com:acme/repo.git')).toBe('repo');
    expect(deriveRepoName('')).toBe('');
  });

  test('resolves framework options with defaults', () => {
    expect(resolveFrontendFrameworkOptions('javascript')).toContain('react');
    expect(resolveFrontendFrameworkOptions('unknown')).toEqual(['react']);
    expect(resolveBackendFrameworkOptions('python')).toContain('flask');
    expect(resolveBackendFrameworkOptions('unknown')).toEqual(['express']);
  });

  test('applies detected tech and builds git summary items', () => {
    const next = applyDetectedTechToProject({
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    }, {
      frontend: { language: 'typescript', framework: 'vue' },
      backend: { language: 'python', framework: 'flask' }
    });

    expect(next.frontend).toEqual({ language: 'typescript', framework: 'vue' });
    expect(next.backend).toEqual({ language: 'python', framework: 'flask' });

    const summary = buildGitSummaryItems({
      gitWorkflowMode: 'custom',
      gitCloudMode: 'connect',
      gitRepoName: '',
      gitRemoteUrl: 'https://github.com/acme/repo.git',
      gitProvider: 'gitlab',
      globalProvider: 'github'
    });

    expect(summary).toEqual([
      { label: 'Repo name', value: 'repo' },
      { label: 'Remote', value: 'https://github.com/acme/repo.git' },
      { label: 'Provider', value: 'gitlab' }
    ]);
  });
});
