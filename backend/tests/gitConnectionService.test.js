import { describe, test, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { testGitConnection } from '../services/gitConnectionService.js';

vi.mock('axios', () => ({
  default: {
    get: vi.fn()
  }
}));

const mockedAxios = axios;

beforeEach(() => {
  mockedAxios.get.mockReset();
});

describe('gitConnectionService', () => {
  test('rejects unsupported providers', async () => {
    await expect(testGitConnection({ provider: 'bitbucket', token: 'token' }))
      .rejects.toMatchObject({ message: 'Unsupported git provider', provider: 'bitbucket' });
  });

  test('requires a token for GitHub', async () => {
    await expect(testGitConnection({ provider: 'github', token: '   ' }))
      .rejects.toMatchObject({ message: 'Personal access token is required to test connection', provider: 'github' });
  });

  test('requires a token for GitLab', async () => {
    await expect(testGitConnection({ provider: 'gitlab', token: '' }))
      .rejects.toMatchObject({ message: 'Personal access token is required to test connection', provider: 'gitlab' });
  });

  test('returns account metadata for GitHub', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { id: 7, login: 'octo', name: 'Octo Cat' } });

    const result = await testGitConnection({ provider: 'github', token: 'token' });

    expect(result).toMatchObject({
      provider: 'github',
      account: { id: 7, login: 'octo', name: 'Octo Cat' },
      message: 'Connected to GitHub'
    });
  });

  test('returns empty name when GitHub data lacks name', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { id: 11, login: 'octo' } });

    const result = await testGitConnection({ provider: 'github', token: 'token' });

    expect(result).toMatchObject({
      provider: 'github',
      account: { id: 11, login: 'octo', name: '' },
      message: 'Connected to GitHub'
    });
  });

  test('defaults provider to GitHub when missing', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { id: 9, login: 'hub', name: 'Hub Cat' } });

    const result = await testGitConnection({ token: 'token' });

    expect(result).toMatchObject({
      provider: 'github',
      account: { id: 9, login: 'hub', name: 'Hub Cat' },
      message: 'Connected to GitHub'
    });
  });

  test('maps response errors from GitHub', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 401, data: { message: 'Bad credentials' } }
    });

    await expect(testGitConnection({ provider: 'github', token: 'bad' }))
      .rejects.toMatchObject({
        message: 'Bad credentials',
        statusCode: 401,
        provider: 'github',
        details: { message: 'Bad credentials' }
      });
  });

  test('maps response errors with error_description', async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { status: 401, data: { error_description: 'bad token' } }
    });

    await expect(testGitConnection({ provider: 'github', token: 'bad' }))
      .rejects.toMatchObject({
        message: 'bad token',
        statusCode: 401,
        provider: 'github',
        details: { error_description: 'bad token' }
      });
  });

    test('maps response errors with missing status and message', async () => {
      mockedAxios.get.mockRejectedValueOnce({
        response: { data: {} }
      });

      await expect(testGitConnection({ provider: 'github', token: 'bad' }))
        .rejects
        .toMatchObject({
          message: 'GitHub connection failed',
          statusCode: 400,
          provider: 'github',
          details: {}
        });
    });

    test('maps response errors with null details to fallback message', async () => {
      mockedAxios.get.mockRejectedValueOnce({
        response: { status: 403, data: null }
      });

      await expect(testGitConnection({ provider: 'github', token: 'bad' }))
        .rejects
        .toMatchObject({
          message: 'GitHub connection failed',
          statusCode: 403,
          provider: 'github',
          details: null
        });
    });

  test('maps request errors from GitLab', async () => {
    mockedAxios.get.mockRejectedValueOnce({ request: {} });

    await expect(testGitConnection({ provider: 'gitlab', token: 'bad' }))
      .rejects.toMatchObject({
        message: 'No response from provider API',
        statusCode: 504,
        provider: 'gitlab'
      });
  });

    test('returns account metadata for GitLab', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 3, username: 'gl', name: 'Git Lab' } });

      const result = await testGitConnection({ provider: 'gitlab', token: 'token' });

      expect(result).toMatchObject({
        provider: 'gitlab',
        account: { id: 3, login: 'gl', name: 'Git Lab' },
        message: 'Connected to GitLab'
      });
    });

    test('returns empty name when GitLab data lacks name', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { id: 4, username: 'gl' } });

      const result = await testGitConnection({ provider: 'gitlab', token: 'token' });

      expect(result).toMatchObject({
        provider: 'gitlab',
        account: { id: 4, login: 'gl', name: '' },
        message: 'Connected to GitLab'
      });
    });

  test('maps message-only errors', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('boom'));

    await expect(testGitConnection({ provider: 'github', token: 'bad' }))
      .rejects.toMatchObject({
        message: 'boom',
        statusCode: 500,
        provider: 'github'
      });
  });

  test('maps object errors without response or request to fallback', async () => {
    mockedAxios.get.mockRejectedValueOnce({});

    await expect(testGitConnection({ provider: 'github', token: 'bad' }))
      .rejects.toMatchObject({
        message: 'GitHub connection failed',
        statusCode: 500,
        provider: 'github',
        details: null
      });
  });

    test('maps non-object errors to fallback response', async () => {
      mockedAxios.get.mockRejectedValueOnce('boom');

      await expect(testGitConnection({ provider: 'github', token: 'bad' }))
        .rejects
        .toMatchObject({
          message: 'GitHub connection failed',
          statusCode: 500,
          provider: 'github',
          details: null
        });
    });
});