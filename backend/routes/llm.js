import express from 'express';
import { db_operations } from '../database.js';
import { encryptApiKey } from '../encryption.js';
import { decryptApiKey } from '../encryption.js';
import { llmClient } from '../llm-client.js';
import { llmRequestMetrics } from '../services/llmRequestMetrics.js';

const router = express.Router();

const PROVIDERS_WITHOUT_API_KEY = new Set(['ollama', 'lmstudio', 'textgen']);

const isProviderWithoutKey = (provider) => PROVIDERS_WITHOUT_API_KEY.has(String(provider || '').toLowerCase());

const summarizeSafeConfig = (config) => ({
  id: config.id,
  provider: config.provider,
  model: config.model,
  api_url: config.api_url,
  requires_api_key: Boolean(config.requires_api_key),
  has_api_key: Boolean(config.api_key_encrypted),
  created_at: config.created_at
});

// Report whether the server has a usable LLM configuration.
// This is a stronger signal than GET /config because it checks for a decryptable
// API key (when required) without ever returning the secret to the browser.
router.get('/status', async (req, res) => {
  try {
    const config = await db_operations.getActiveLLMConfig();
    if (!config) {
      return res.json({
        success: true,
        configured: false,
        ready: false,
        reason: 'No LLM configuration found'
      });
    }

    const providerWithoutKey = isProviderWithoutKey(config.provider);
    const requiresApiKey = !providerWithoutKey;

    const hasApiUrl = typeof config.api_url === 'string' && config.api_url.trim().length > 0;
    const hasModel = typeof config.model === 'string' && config.model.trim().length > 0;

    let apiKeyOk = !requiresApiKey;
    let reason = null;

    if (requiresApiKey) {
      if (!config.api_key_encrypted) {
        apiKeyOk = false;
        reason = 'Missing API key';
      } else {
        const decrypted = decryptApiKey(config.api_key_encrypted);
        apiKeyOk = Boolean(decrypted);
        if (!apiKeyOk) {
          reason = 'Failed to decrypt API key';
        }
      }
    }

    const ready = Boolean(hasApiUrl && hasModel && apiKeyOk);

    return res.json({
      success: true,
      configured: true,
      ready,
      reason: ready ? null : (reason || (!hasApiUrl ? 'Missing API URL' : 'Missing model')),
      config: {
        ...summarizeSafeConfig(config),
        // Override stored flag with server-side rules.
        requires_api_key: requiresApiKey
      }
    });
  } catch (error) {
    console.error('❌ Failed to get LLM status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve LLM status'
    });
  }
});

// Test LLM configuration
router.post('/test', async (req, res) => {
  try {
    const { provider, apiKey, model, apiUrl } = req.body;

    console.log(`🧪 Testing LLM configuration: ${provider}/${model}`, { 
      hasApiKey: !!apiKey, 
      apiUrl,
      apiKeyLength: apiKey?.length 
    });

    if (!provider || !model) {
      return res.status(400).json({
        success: false,
        error: 'Provider and model are required'
      });
    }

    if (!apiUrl) {
      return res.status(400).json({
        success: false,
        error: 'API URL is required'
      });
    }

    const providerWithoutKey = isProviderWithoutKey(provider);
    const requiresApiKey = !providerWithoutKey;
    let effectiveApiKey = apiKey;
    if (requiresApiKey && !effectiveApiKey) {
      // Allow testing with the server-stored key so the UI never needs to
      // display or re-send secrets if the provider hasn't changed.
      const activeConfig = await db_operations.getActiveLLMConfig();
      const sameProvider =
        activeConfig &&
        String(activeConfig.provider || '').toLowerCase() === String(provider).toLowerCase();

      if (sameProvider && activeConfig.api_key_encrypted) {
        effectiveApiKey = decryptApiKey(activeConfig.api_key_encrypted);
      }

      if (!effectiveApiKey) {
        return res.status(400).json({
          success: false,
          error: 'API key is required for this provider'
        });
      }
    }

    // Create test configuration
    const testConfig = {
      provider,
      model,
      api_url: apiUrl,
      requires_api_key: requiresApiKey,
      apiKey: providerWithoutKey ? undefined : effectiveApiKey // Don't encrypt for testing
    };

    // Test the connection
    const result = await llmClient.testConnection(testConfig);

    console.log(`✅ LLM test successful: ${provider}/${model}`, result);

    res.json({
      success: true,
      model: result.model,
      responseTime: result.responseTime,
      message: 'Configuration test successful'
    });

  } catch (error) {
    console.error('❌ LLM test failed:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status
    });
    
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to test configuration'
    });
  }
});

// Save LLM configuration
router.post('/configure', async (req, res) => {
  try {
    const { provider, apiKey, model, apiUrl } = req.body;

    if (!provider || !model || !apiUrl) {
      return res.status(400).json({
        success: false,
        error: 'Provider, model, and API URL are required'
      });
    }

    const providerWithoutKey = isProviderWithoutKey(provider);
    const requiresApiKey = !providerWithoutKey;

    let encryptedApiKey = null;

    if (requiresApiKey) {
      if (apiKey) {
        // Encrypt API key if required
        encryptedApiKey = encryptApiKey(apiKey);
        if (!encryptedApiKey) {
          return res.status(500).json({
            success: false,
            error: 'Failed to encrypt API key. Check server ENCRYPTION_KEY configuration.'
          });
        }
      } else {
        // Keep the existing server-stored key if the provider matches.
        const activeConfig = await db_operations.getActiveLLMConfig();
        const sameProvider =
          activeConfig &&
          String(activeConfig.provider || '').toLowerCase() === String(provider).toLowerCase();

        if (!sameProvider || !activeConfig.api_key_encrypted) {
          return res.status(400).json({
            success: false,
            error: 'API key is required for this provider'
          });
        }

        // Ensure the stored key is decryptable (otherwise the config cannot be ready).
        const decrypted = decryptApiKey(activeConfig.api_key_encrypted);
        if (!decrypted) {
          return res.status(400).json({
            success: false,
            error: 'Stored API key cannot be decrypted. Please enter a new API key.'
          });
        }

        encryptedApiKey = activeConfig.api_key_encrypted;
      }
    }

    // Save configuration to database
    const config = {
      provider,
      model,
      apiUrl,
      apiKeyEncrypted: encryptedApiKey,
      requiresApiKey
    };

    await db_operations.saveLLMConfig(config);

    // Reinitialize the LLM client with new config
    await llmClient.initialize();

    console.log(`✅ LLM configuration saved: ${provider}/${model}`);

    res.json({
      success: true,
      message: 'LLM configuration saved successfully',
      provider,
      model
    });

  } catch (error) {
    console.error('❌ Failed to save LLM configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save configuration'
    });
  }
});

// Get current LLM configuration
router.get('/config', async (req, res) => {
  try {
    const config = await db_operations.getActiveLLMConfig();
    
    if (!config) {
      return res.json({
        success: false,
        message: 'No LLM configuration found'
      });
    }

    // Don't return encrypted API key
    const safeConfig = summarizeSafeConfig(config);

    res.json({
      success: true,
      config: safeConfig
    });

  } catch (error) {
    console.error('❌ Failed to get LLM configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve configuration'
    });
  }
});

// Generate text using configured LLM
router.post('/generate', async (req, res) => {
  try {
    const { messages, max_tokens, temperature, __lucidcoderDisableToolBridge } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Messages array is required'
      });
    }

    // Enforce DB-backed readiness before attempting to call the provider.
    const status = await db_operations.getActiveLLMConfig();
    if (!status) {
      return res.status(503).json({
        success: false,
        error: 'LLM is not configured',
        configured: false,
        ready: false,
        reason: 'No LLM configuration found'
      });
    }

    const providerWithoutKey = isProviderWithoutKey(status.provider);
    const requiresApiKey = !providerWithoutKey;

    const hasApiUrl = typeof status.api_url === 'string' && status.api_url.trim().length > 0;
    const hasModel = typeof status.model === 'string' && status.model.trim().length > 0;
    if (!hasApiUrl || !hasModel) {
      return res.status(503).json({
        success: false,
        error: 'LLM is not configured',
        configured: true,
        ready: false,
        reason: !hasApiUrl ? 'Missing API URL' : 'Missing model'
      });
    }

    if (requiresApiKey) {
      if (!status.api_key_encrypted) {
        return res.status(503).json({
          success: false,
          error: 'LLM is not configured',
          configured: true,
          ready: false,
          reason: 'Missing API key'
        });
      }

      const decrypted = decryptApiKey(status.api_key_encrypted);
      if (!decrypted) {
        return res.status(503).json({
          success: false,
          error: 'LLM is not configured',
          configured: true,
          ready: false,
          reason: 'Failed to decrypt API key'
        });
      }
    }

    console.log('🤖 Generating LLM response...');

    let response;
    if (process.env.NODE_ENV === 'test') {
      // Mock response for tests
      response = 'Test response from mocked LLM';
    } else {
      response = await llmClient.generateResponse(messages, {
        max_tokens: max_tokens || 1000,
        temperature: temperature !== undefined ? temperature : 0.7,
        __lucidcoderDisableToolBridge: __lucidcoderDisableToolBridge !== false,
        __lucidcoderPhase: 'api_generate',
        __lucidcoderRequestType: 'api_generate'
      });
    }

    res.json({
      success: true,
      response,
      model: llmClient.config?.model,
      provider: llmClient.config?.provider
    });

  } catch (error) {
    console.error('❌ LLM generation failed:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'test' ? error.stack : undefined
    });
  }
});

// Get in-memory LLM request metrics (requested/outbound/dedup hits)
router.get('/request-metrics', async (req, res) => {
  res.json({
    success: true,
    metrics: llmRequestMetrics.snapshot()
  });
});

// Reset in-memory LLM request metrics
router.post('/request-metrics/reset', async (req, res) => {
  llmRequestMetrics.reset();
  res.json({
    success: true,
    metrics: llmRequestMetrics.snapshot()
  });
});

// Get API usage logs
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await db_operations.db.all(`
      SELECT * FROM api_logs 
      ORDER BY created_at DESC 
      LIMIT ?
    `, [limit]);

    res.json({
      success: true,
      logs
    });

  } catch (error) {
    console.error('❌ Failed to get API logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve logs'
    });
  }
});

export default router;