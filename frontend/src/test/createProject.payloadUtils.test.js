import { describe, expect, test } from 'vitest';
import {
  buildBaseProjectData,
  resolveNormalizedGitConfig,
  attachGitConnectionDetails,
  buildConnectExistingProjectGitDetails
} from '../components/create-project/payloadUtils';

describe('create-project payloadUtils', () => {
  test('buildBaseProjectData trims text and keeps selected stack', () => {
    const result = buildBaseProjectData({
      name: '  demo-app  ',
      description: '  my app  ',
      frontend: { language: 'typescript', framework: 'react' },
      backend: { language: 'python', framework: 'fastapi' }
    });

    expect(result).toEqual({
      name: 'demo-app',
      description: 'my app',
      frontend: { language: 'typescript', framework: 'react' },
      backend: { language: 'python', framework: 'fastapi' }
    });
  });

  test('resolveNormalizedGitConfig falls back to global defaults', () => {
    const result = resolveNormalizedGitConfig({
      mode: 'global',
      gitProvider: 'gitlab',
      gitSettings: { provider: 'Bitbucket', defaultBranch: '  ', username: '  simon  ' }
    });

    expect(result).toEqual({
      normalizedProvider: 'bitbucket',
      defaultBranch: 'main',
      username: 'simon'
    });
  });

  test('attachGitConnectionDetails adds token only for custom mode', () => {
    const base = { name: 'proj' };
    const customResult = attachGitConnectionDetails(base, {
      mode: 'custom',
      normalizedProvider: 'gitlab',
      remoteUrl: '  https://example.com/repo.git  ',
      token: '  abc  '
    });

    expect(customResult).toEqual({
      name: 'proj',
      gitRemoteUrl: 'https://example.com/repo.git',
      gitConnectionProvider: 'gitlab',
      gitToken: 'abc'
    });

    const localResult = attachGitConnectionDetails(base, {
      mode: 'local',
      normalizedProvider: 'github',
      remoteUrl: 'ignored',
      token: 'ignored'
    });

    expect(localResult).toBe(base);
  });

  test('buildConnectExistingProjectGitDetails includes optional values correctly', () => {
    const result = buildConnectExistingProjectGitDetails({
      normalizedProvider: 'github',
      defaultBranch: 'main',
      username: '',
      remoteUrl: '  https://example.com/repo.git  ',
      mode: 'custom',
      token: '  top-secret  '
    });

    expect(result).toEqual({
      gitCloudMode: 'connect',
      gitRemoteUrl: 'https://example.com/repo.git',
      gitProvider: 'github',
      gitDefaultBranch: 'main',
      gitToken: 'top-secret'
    });
  });
});
