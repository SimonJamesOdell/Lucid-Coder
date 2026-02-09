import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import llmRoutes from '../routes/llm.js';
import axios from 'axios';
import { db_operations } from '../database.js';
import { encryptApiKey, decryptApiKey } from '../encryption.js';
import { llmClient } from '../llm-client.js';

vi.mock('../database.js', () => ({
  db_operations: {
    saveLLMConfig: vi.fn(),
    getActiveLLMConfig: vi.fn(),
    db: {
      all: vi.fn()
    }
  }
}));

vi.mock('../encryption.js', () => ({
  encryptApiKey: vi.fn((key) => `encrypted_${key}`),
  decryptApiKey: vi.fn((value) => (value ? 'decrypted' : null))
}));

const mockGenerateResponse = vi.hoisted(() => vi.fn());

vi.mock('../llm-client.js', () => {
  class MockLLMClient {
    constructor() {
      this.generateResponse = mockGenerateResponse;
      this.config = null;
      this.apiKey = null;
    }
  }

  return {
    llmClient: {
      testConnection: vi.fn(),
      initialize: vi.fn(),
      generateResponse: vi.fn(),
      config: { model: 'gpt-4', provider: 'openai' }
    },
    LLMClient: MockLLMClient
  };
});

vi.mock('axios', () => ({
  default: {
    get: vi.fn()
  },
  get: vi.fn()
}));

describe('LLM Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/llm', llmRoutes);
    vi.clearAllMocks();
    axios.get.mockResolvedValue({ data: {} });
    mockGenerateResponse.mockResolvedValue('OK');

    // Avoid mock implementation leakage between tests.
    db_operations.getActiveLLMConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/llm/test', () => {
    it('tests valid LLM configuration', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 245
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        model: 'gpt-4',
        responseTime: 245,
        message: 'Configuration test successful'
      });

      expect(llmClient.testConnection).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        apiKey: 'test-key'
      });
    });

    it('sanitizes API key input before testing', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 200
      });

      await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'sk-test\n\t',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(llmClient.testConnection).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        apiKey: 'sk-test'
      });
    });

    it('handles configuration without API key', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'llama2',
        responseTime: 150
      });

      await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'ollama',
          model: 'llama2',
          apiUrl: 'http://localhost:11434/api'
        })
        .expect(200);

      expect(llmClient.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          requires_api_key: false,
          apiKey: undefined
        })
      );
    });

    it('returns 400 when API key is missing for API-key providers', async () => {
      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(llmClient.testConnection).not.toHaveBeenCalled();
    });

    it('can test using the stored API key when apiKey is omitted', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: 'openai',
        api_key_encrypted: 'encrypted_existing'
      });

      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 120
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(decryptApiKey).toHaveBeenCalledWith('encrypted_existing', { quiet: true });
      expect(llmClient.testConnection).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        apiKey: 'decrypted'
      });
    });

    it('does not use the stored API key when provider differs', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: 'anthropic',
        api_key_encrypted: 'encrypted_existing'
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(llmClient.testConnection).not.toHaveBeenCalled();
    });

    it('does not use the stored API key when active provider is missing', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: null,
        api_key_encrypted: 'encrypted_existing'
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(llmClient.testConnection).not.toHaveBeenCalled();
    });

    it('returns 400 when provider is missing', async () => {
      const response = await request(app)
        .post('/api/llm/test')
        .send({
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Provider and model are required'
      });

      expect(llmClient.testConnection).not.toHaveBeenCalled();
    });

    it('returns 400 when model is missing', async () => {
      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Provider and model are required'
      });
    });

    it('returns 400 when apiUrl is missing', async () => {
      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          model: 'gpt-4'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API URL is required'
      });
    });

    it('handles test connection errors', async () => {
      llmClient.testConnection.mockRejectedValue(new Error('Invalid API key'));

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'invalid-key',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid API key'
      });
    });

    it('handles network errors', async () => {
      const networkError = new Error('Network timeout');
      networkError.response = {
        status: 503,
        data: { error: 'Service unavailable' }
      };
      llmClient.testConnection.mockRejectedValue(networkError);

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it('falls back to default error message when failure message is missing', async () => {
      const silentError = new Error('');
      silentError.message = '';
      llmClient.testConnection.mockRejectedValue(silentError);

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to test configuration'
      });
    });

    it('fails fast when the OpenAI model is unavailable', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 120
      });
      axios.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { error: { message: 'The model `gpt-missing` does not exist or you do not have access to it.' } }
        }
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-missing',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'The model `gpt-missing` does not exist or you do not have access to it.'
      });
      expect(llmClient.testConnection).toHaveBeenCalled();
    });

    it('returns a 404 model lookup message when OpenAI model access lacks details', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 120
      });
      axios.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: {}
        }
      });

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-missing',
          apiUrl: 'https://api.openai.com/v1/'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Model lookup failed (404). Check API URL (https://api.openai.com/v1) and model name (gpt-missing).'
      });
    });

    it('returns a generic model access message when lookup fails without status', async () => {
      llmClient.testConnection.mockResolvedValue({
        model: 'gpt-4',
        responseTime: 120
      });
      axios.get.mockRejectedValueOnce({});

      const response = await request(app)
        .post('/api/llm/test')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-missing',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to verify model access.'
      });
    });
  });

  describe('POST /api/llm/configure', () => {
    it('saves valid LLM configuration', async () => {
      db_operations.saveLLMConfig.mockResolvedValue();
      llmClient.initialize.mockResolvedValue();

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiKey: 'sk-test123',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'LLM configuration saved successfully',
        provider: 'openai',
        model: 'gpt-4'
      });

      expect(encryptApiKey).toHaveBeenCalledWith('sk-test123');
      expect(db_operations.saveLLMConfig).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4',
        apiUrl: 'https://api.openai.com/v1',
        apiKeyEncrypted: 'encrypted_sk-test123',
        requiresApiKey: true
      });
      expect(llmClient.initialize).toHaveBeenCalled();
    });

    it('sanitizes API key input before saving configuration', async () => {
      db_operations.saveLLMConfig.mockResolvedValue();
      llmClient.initialize.mockResolvedValue();

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiKey: 'sk-test\n',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(encryptApiKey).toHaveBeenCalledWith('sk-test');
      expect(db_operations.saveLLMConfig).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4',
        apiUrl: 'https://api.openai.com/v1',
        apiKeyEncrypted: 'encrypted_sk-test',
        requiresApiKey: true
      });
    });

    it('saves configuration without API key', async () => {
      db_operations.saveLLMConfig.mockResolvedValue();
      llmClient.initialize.mockResolvedValue();

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'ollama',
          model: 'llama2',
          apiUrl: 'http://localhost:11434/api'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(encryptApiKey).not.toHaveBeenCalled();
      expect(db_operations.saveLLMConfig).toHaveBeenCalledWith({
        provider: 'ollama',
        model: 'llama2',
        apiUrl: 'http://localhost:11434/api',
        apiKeyEncrypted: null,
        requiresApiKey: false
      });
    });

    it('returns 400 when API key is missing for API-key providers', async () => {
      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('keeps the existing API key when apiKey is omitted and provider matches', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: 'openai',
        api_key_encrypted: 'encrypted_existing'
      });
      db_operations.saveLLMConfig.mockResolvedValue();
      llmClient.initialize.mockResolvedValue();

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4o',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(encryptApiKey).not.toHaveBeenCalled();
      expect(decryptApiKey).toHaveBeenCalledWith('encrypted_existing', { quiet: true });
      expect(db_operations.saveLLMConfig).toHaveBeenCalledWith({
        provider: 'openai',
        model: 'gpt-4o',
        apiUrl: 'https://api.openai.com/v1',
        apiKeyEncrypted: 'encrypted_existing',
        requiresApiKey: true
      });
      expect(llmClient.initialize).toHaveBeenCalled();
    });

    it('does not keep the stored API key when provider differs', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: 'anthropic',
        api_key_encrypted: 'encrypted_existing'
      });

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4o',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('does not keep the stored API key when active provider is missing', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: undefined,
        api_key_encrypted: 'encrypted_existing'
      });

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4o',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'API key is required for this provider'
      });

      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('returns 400 when stored API key cannot be decrypted', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        provider: 'openai',
        api_key_encrypted: 'encrypted_existing'
      });
      decryptApiKey.mockReturnValueOnce(null);

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4o',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Stored API key cannot be decrypted. Please reconfigure.'
      });

      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('returns 500 when API key encryption fails', async () => {
      encryptApiKey.mockReturnValueOnce(null);

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiKey: 'sk-test123',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/failed to encrypt api key/i);
      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('rejects OpenAI models that are unavailable', async () => {
      axios.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { error: { message: 'The model `gpt-missing` does not exist or you do not have access to it.' } }
        }
      });

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiKey: 'sk-test123',
          model: 'gpt-missing',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'The model `gpt-missing` does not exist or you do not have access to it.'
      });
      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
      expect(llmClient.initialize).not.toHaveBeenCalled();
    });

    it('returns 400 when provider is missing', async () => {
      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Provider, model, and API URL are required'
      });

      expect(db_operations.saveLLMConfig).not.toHaveBeenCalled();
    });

    it('returns 400 when model is missing', async () => {
      await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(400);
    });

    it('returns 400 when apiUrl is missing', async () => {
      await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          model: 'gpt-4'
        })
        .expect(400);
    });

    it('handles database errors', async () => {
      db_operations.saveLLMConfig.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/llm/configure')
        .send({
          provider: 'openai',
          apiKey: 'test-key',
          model: 'gpt-4',
          apiUrl: 'https://api.openai.com/v1'
        })
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to save configuration'
      });
    });
  });

  describe('GET /api/llm/request-metrics', () => {
    it('returns in-memory request metrics snapshot', async () => {
      const response = await request(app)
        .get('/api/llm/request-metrics')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeTruthy();
      expect(typeof response.body.metrics.startedAt).toBe('string');
      expect(typeof response.body.metrics.now).toBe('string');
      expect(response.body.metrics.counters).toBeTruthy();
    });
  });

  describe('POST /api/llm/request-metrics/reset', () => {
    it('resets in-memory request metrics', async () => {
      const response = await request(app)
        .post('/api/llm/request-metrics/reset')
        .send({})
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.metrics).toBeTruthy();
      expect(response.body.metrics.counters).toBeTruthy();
    });
  });

  describe('GET /api/llm/config', () => {
    it('returns current LLM configuration', async () => {
      const mockConfig = {
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_key',
        created_at: '2024-01-01T00:00:00Z'
      };

      db_operations.getActiveLLMConfig.mockResolvedValue(mockConfig);

      const response = await request(app)
        .get('/api/llm/config')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        config: {
          id: 1,
          provider: 'openai',
          model: 'gpt-4',
          api_url: 'https://api.openai.com/v1',
          requires_api_key: true,
          has_api_key: true,
          created_at: '2024-01-01T00:00:00Z'
        }
      });

      // Ensure encrypted key is not returned
      expect(response.body.config.api_key_encrypted).toBeUndefined();
    });

    it('returns success false when no configuration exists', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/llm/config')
        .expect(200);

      expect(response.body).toEqual({
        success: false,
        message: 'No LLM configuration found'
      });
    });

    it('indicates when API key is not present', async () => {
      const mockConfig = {
        id: 1,
        provider: 'ollama',
        model: 'llama2',
        api_url: 'http://localhost:11434/api',
        requires_api_key: false,
        api_key_encrypted: null,
        created_at: '2024-01-01T00:00:00Z'
      };

      db_operations.getActiveLLMConfig.mockResolvedValue(mockConfig);

      const response = await request(app)
        .get('/api/llm/config')
        .expect(200);

      expect(response.body.config.has_api_key).toBe(false);
    });

    it('handles database errors', async () => {
      db_operations.getActiveLLMConfig.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/llm/config')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to retrieve configuration'
      });
    });
  });

  describe('GET /api/llm/status', () => {
    it('returns ready=false when no configuration exists', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        configured: false,
        ready: false,
        reason: 'No LLM configuration found'
      });
    });

    it('returns ready=true for local providers without API keys', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'ollama',
        model: 'llama3.2',
        api_url: 'http://localhost:11434',
        requires_api_key: false,
        api_key_encrypted: null,
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(true);
      expect(response.body.config).toMatchObject({
        provider: 'ollama',
        model: 'llama3.2',
        has_api_key: false,
        requires_api_key: false
      });
    });

    it('returns ready=true for API-key providers when stored key decrypts', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4o-mini',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value',
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(true);
      expect(response.body.config).toMatchObject({
        provider: 'openai',
        model: 'gpt-4o-mini',
        has_api_key: true,
        requires_api_key: true
      });
      expect(decryptApiKey).toHaveBeenCalledWith('encrypted_value', { quiet: true });
    });

    it('returns ready=false when an API-key provider is missing an API key', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4o-mini',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: null,
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(false);
      expect(response.body.reason).toMatch(/missing api key/i);
    });

    it('treats a falsy provider as requiring an API key', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: null,
        model: 'gpt-4o-mini',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: null,
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(false);
      expect(response.body.reason).toBe('Missing API key');
    });

    it('returns ready=false when the stored API key cannot be decrypted', async () => {
      decryptApiKey.mockReturnValueOnce(null);

      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4o-mini',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value',
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(false);
      expect(response.body.reason).toMatch(/stored api key cannot be decrypted/i);
    });

    it('returns a missing API URL reason when api_url is blank and no other reason is present', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4o-mini',
        api_url: '   ',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value',
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(false);
      expect(response.body.reason).toBe('Missing API URL');
    });

    it('returns a missing model reason when model is blank and no other reason is present', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: '  ',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value',
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .get('/api/llm/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.configured).toBe(true);
      expect(response.body.ready).toBe(false);
      expect(response.body.reason).toBe('Missing model');
    });

    it('returns 500 when the status lookup throws', async () => {
      db_operations.getActiveLLMConfig.mockRejectedValue(new Error('Database down'));

      const response = await request(app)
        .get('/api/llm/status')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to retrieve LLM status'
      });
    });
  });

  describe('POST /api/llm/generate', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';

      // /generate now enforces DB-backed readiness. Provide a default config for tests.
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value',
        created_at: '2024-01-01T00:00:00Z'
      });
    });

    it('returns 503 when no LLM config exists', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        error: 'LLM is not configured',
        configured: false,
        ready: false,
        reason: 'No LLM configuration found'
      });
    });

    it('returns 503 when the active config is missing api_url', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        api_url: '   ',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value'
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        error: 'LLM is not configured',
        configured: true,
        ready: false,
        reason: 'Missing API URL'
      });
    });

    it('returns 503 when the active config is missing model', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: '   ',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value'
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        error: 'LLM is not configured',
        configured: true,
        ready: false,
        reason: 'Missing model'
      });
    });

    it('returns 503 when api_key_encrypted is missing for API-key providers', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: ''
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        error: 'LLM is not configured',
        configured: true,
        ready: false,
        reason: 'Missing API key'
      });
    });

    it('returns 503 when decrypting the stored API key fails', async () => {
      decryptApiKey.mockReturnValueOnce(null);
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'openai',
        model: 'gpt-4',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        api_key_encrypted: 'encrypted_value'
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(503);

      expect(response.body).toEqual({
        success: false,
        error: 'LLM is not configured',
        configured: true,
        ready: false,
        reason: 'Stored API key cannot be decrypted. Please reconfigure.'
      });
    });

    it('generates response from LLM', async () => {
      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [
            { role: 'user', content: 'Hello' }
          ]
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        response: 'Test response from mocked LLM',
        model: 'gpt-4',
        provider: 'openai'
      });
    });

    it('generates response for local providers without API keys', async () => {
      db_operations.getActiveLLMConfig.mockResolvedValue({
        id: 1,
        provider: 'ollama',
        model: 'llama3.2',
        api_url: 'http://localhost:11434/api',
        requires_api_key: false,
        api_key_encrypted: null,
        created_at: '2024-01-01T00:00:00Z'
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        response: 'Test response from mocked LLM',
        model: 'gpt-4',
        provider: 'openai'
      });
    });

    it('accepts optional parameters', async () => {
      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Test' }],
          max_tokens: 500,
          temperature: 0.5
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('returns 400 when messages is missing', async () => {
      const response = await request(app)
        .post('/api/llm/generate')
        .send({})
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Messages array is required'
      });
    });

    it('returns 400 when messages is not an array', async () => {
      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: 'not an array'
        })
        .expect(400);

      expect(response.body.error).toBe('Messages array is required');
    });

    it('returns 400 when messages array is empty', async () => {
      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: []
        })
        .expect(400);

      expect(response.body.error).toBe('Messages array is required');
    });

    it('calls generateResponse with default options when not in test mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      llmClient.generateResponse.mockResolvedValue('Generated response');

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Test' }]
        })
        .expect(200);

      expect(llmClient.generateResponse).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Test' }],
        expect.objectContaining({
          max_tokens: 1000,
          temperature: 0.7,
          __lucidcoderDisableToolBridge: true,
          __lucidcoderPhase: 'api_generate',
          __lucidcoderRequestType: 'api_generate'
        })
      );
      expect(response.body.response).toBe('Generated response');

      process.env.NODE_ENV = originalEnv;
    });

    it('passes through explicit max_tokens and temperature overrides in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      llmClient.generateResponse.mockResolvedValue('Custom response');

      await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 256,
          temperature: 0.2
        })
        .expect(200);

      expect(llmClient.generateResponse).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Hi' }],
        expect.objectContaining({
          max_tokens: 256,
          temperature: 0.2,
          __lucidcoderDisableToolBridge: true,
          __lucidcoderPhase: 'api_generate',
          __lucidcoderRequestType: 'api_generate'
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('allows enabling tool bridge when explicitly requested', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      llmClient.generateResponse.mockResolvedValue('Tool response');

      await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Use tools' }],
          __lucidcoderDisableToolBridge: false
        })
        .expect(200);

      expect(llmClient.generateResponse).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Use tools' }],
        expect.objectContaining({
          __lucidcoderDisableToolBridge: false,
          __lucidcoderPhase: 'api_generate',
          __lucidcoderRequestType: 'api_generate'
        })
      );

      process.env.NODE_ENV = originalEnv;
    });

    it('handles LLM generation errors', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      llmClient.generateResponse.mockRejectedValue(new Error('Rate limit exceeded'));

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Test' }]
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Rate limit exceeded');

      process.env.NODE_ENV = originalEnv;
    });

    it('includes error stacks in test mode failures', async () => {
      const originalConfig = llmClient.config;
      Object.defineProperty(llmClient, 'config', {
        configurable: true,
        get() {
          throw new Error('Config unavailable');
        }
      });

      const response = await request(app)
        .post('/api/llm/generate')
        .send({
          messages: [{ role: 'user', content: 'Hello' }]
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Config unavailable');
      expect(response.body.details).toContain('Config unavailable');

      Object.defineProperty(llmClient, 'config', {
        configurable: true,
        value: originalConfig,
        writable: true
      });
    });
  });

  describe('GET /api/llm/logs', () => {
    it('returns recent API logs', async () => {
      const mockLogs = [
        { id: 1, endpoint: '/api/llm/generate', created_at: '2024-01-01T10:00:00Z' },
        { id: 2, endpoint: '/api/llm/test', created_at: '2024-01-01T09:00:00Z' }
      ];

      db_operations.db.all.mockResolvedValue(mockLogs);

      const response = await request(app)
        .get('/api/llm/logs')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        logs: mockLogs
      });

      expect(db_operations.db.all).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM api_logs'),
        [50]
      );
    });

    it('accepts custom limit parameter', async () => {
      db_operations.db.all.mockResolvedValue([]);

      await request(app)
        .get('/api/llm/logs?limit=100')
        .expect(200);

      expect(db_operations.db.all).toHaveBeenCalledWith(
        expect.any(String),
        [100]
      );
    });

    it('defaults to 50 logs when limit is not provided', async () => {
      db_operations.db.all.mockResolvedValue([]);

      await request(app)
        .get('/api/llm/logs')
        .expect(200);

      expect(db_operations.db.all).toHaveBeenCalledWith(
        expect.any(String),
        [50]
      );
    });

    it('handles invalid limit parameter', async () => {
      db_operations.db.all.mockResolvedValue([]);

      await request(app)
        .get('/api/llm/logs?limit=invalid')
        .expect(200);

      // Should default to 50 when limit is NaN
      expect(db_operations.db.all).toHaveBeenCalledWith(
        expect.any(String),
        [50]
      );
    });

    it('handles database errors', async () => {
      db_operations.db.all.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/llm/logs')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to retrieve logs'
      });
    });
  });

  describe('LLM route helper hooks', () => {
    it('normalizes helper inputs for missing values', () => {
      const hooks = llmRoutes.__testHooks;

      expect(hooks.normalizeApiUrl()).toBe('');
      expect(hooks.shouldValidateModelAccess()).toBe(false);
      expect(hooks.shouldValidateModelAccess('openai')).toBe(true);
      expect(hooks.buildOpenAiModelUrl('https://api.openai.com/v1', null))
        .toBe('https://api.openai.com/v1/models/');
    });

    it('formats a 404 model access error with a missing API URL label', () => {
      const hooks = llmRoutes.__testHooks;

      const message = hooks.formatModelAccessError({
        response: { status: 404, data: {} }
      }, {
        apiUrl: undefined,
        model: 'gpt-missing'
      });

      expect(message).toBe(
        'Model lookup failed (404). Check API URL (missing) and model name (gpt-missing).'
      );
    });
  });
});
