import axios from 'axios';
import { db_operations } from './database.js';
import { decryptApiKey } from './encryption.js';
import { llmRequestMetrics } from './services/llmRequestMetrics.js';
import { buildActionToolBridgePayload, buildToolBridgePayload, shouldUseActionToolBridgeByDefault } from './llm-client/toolBridge.js';
import { formatPayload, formatPayloadInternal, sanitizePayload } from './llm-client/payload.js';
import { getHeaders, getEndpointURL } from './llm-client/http.js';
import { extractResponse, getErrorMessage } from './llm-client/response.js';

export class LLMClient {
  constructor() {
    this.config = null;
    this.apiKey = null;

    // De-duplicate identical outbound requests to avoid hammering providers.
    // This is especially useful when multiple subsystems ask the same question
    // concurrently (or retry logic replays identical payloads).
    this._dedupInflight = new Map();
    this._dedupRecent = new Map();
    this._dedupWindowMs = Number.parseInt(process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS || '', 10);
    if (!Number.isFinite(this._dedupWindowMs) || this._dedupWindowMs < 0) {
      this._dedupWindowMs = 2500;
    }

    // For deterministic calls (temperature 0), it's safe and cost-effective to cache longer.
    // This captures repeated identical planning/classification calls that happen seconds apart.
    this._dedupWindowMsDeterministic = Number.parseInt(process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC || '', 10);
    if (!Number.isFinite(this._dedupWindowMsDeterministic) || this._dedupWindowMsDeterministic < 0) {
      this._dedupWindowMsDeterministic = 30000;
    }

    this._dedupCacheNonDeterministic =
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC === '1' ||
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC === 'true';

    this._dedupMaxEntries = Number.parseInt(process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES || '', 10);
    if (!Number.isFinite(this._dedupMaxEntries) || this._dedupMaxEntries <= 0) {
      this._dedupMaxEntries = 100;
    }
  }

  _isDeterministicPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const temperature =
      (typeof payload.temperature === 'number' ? payload.temperature : undefined)
      ?? (typeof payload?.generationConfig?.temperature === 'number' ? payload.generationConfig.temperature : undefined)
      ?? (typeof payload?.options?.temperature === 'number' ? payload.options.temperature : undefined);

    return typeof temperature === 'number' && Number.isFinite(temperature) && temperature <= 0;
  }

  _stableStringify(value) {
    const seen = new WeakSet();

    const stringify = (input) => {
      if (input === null || input === undefined) {
        return JSON.stringify(input);
      }
      const type = typeof input;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        return JSON.stringify(input);
      }
      if (type === 'bigint') {
        return JSON.stringify(String(input));
      }
      if (type !== 'object') {
        return JSON.stringify(String(input));
      }

      if (seen.has(input)) {
        return '"[Circular]"';
      }
      seen.add(input);

      if (Array.isArray(input)) {
        return `[${input.map((item) => stringify(item)).join(',')}]`;
      }

      const keys = Object.keys(input)
        .filter((key) => !key.startsWith('__lucidcoder'))
        .sort();
      const entries = keys.map((key) => `${JSON.stringify(key)}:${stringify(input[key])}`);
      return `{${entries.join(',')}}`;
    };

    return stringify(value);
  }

  async _makeDedupedRequest(payload, options, fn) {
    const disableDedup =
      process.env.LUCIDCODER_LLM_DEDUP === '0' ||
      process.env.LUCIDCODER_LLM_DEDUP === 'false' ||
      options?.__lucidcoderDisableDedup === true;
    if (disableDedup) {
      return fn();
    }

    const provider = this.config?.provider || '';
    const model = this.config?.model || '';
    const key = `${provider}/${model}:${this._stableStringify(payload)}`;

    const deterministic = this._isDeterministicPayload(payload);
    const allowRecentCache = deterministic || this._dedupCacheNonDeterministic;
    const windowMs = deterministic ? this._dedupWindowMsDeterministic : this._dedupWindowMs;

    const requestType = options?.__lucidcoderRequestType || 'generate';
    const phase = options?.__lucidcoderPhase || 'unknown';
    const metricsContext = { provider, model, requestType, phase };

    const now = Date.now();
    if (allowRecentCache && windowMs > 0) {
      const recent = this._dedupRecent.get(key);
      if (recent && now - recent.timestamp <= windowMs) {
        llmRequestMetrics.record('dedup_recent', metricsContext);
        // Return a lightweight response-like object compatible with extractResponse.
        return { data: recent.data };
      }
    }

    const inflight = this._dedupInflight.get(key);
    if (inflight) {
      llmRequestMetrics.record('dedup_inflight', metricsContext);
      return inflight;
    }

    const requestPromise = (async () => {
      try {
        const response = await fn();
        if (allowRecentCache && response && typeof response === 'object' && 'data' in response) {
          this._dedupRecent.set(key, { timestamp: Date.now(), data: response.data });
          // Trim cache to avoid unbounded growth.
          if (this._dedupRecent.size > this._dedupMaxEntries) {
            const entries = Array.from(this._dedupRecent.entries());
            entries.sort((a, b) => (a[1]?.timestamp || 0) - (b[1]?.timestamp || 0));
            const toRemove = entries.slice(0, Math.max(0, entries.length - this._dedupMaxEntries));
            toRemove.forEach(([oldKey]) => this._dedupRecent.delete(oldKey));
          }
        }
        return response;
      } finally {
        this._dedupInflight.delete(key);
      }
    })();

    this._dedupInflight.set(key, requestPromise);
    return requestPromise;
  }

  shouldUseActionToolBridgeByDefault(provider) {
    return shouldUseActionToolBridgeByDefault(provider);
  }

  getErrorMessage(error) {
    return getErrorMessage(error);
  }

  buildActionToolBridgePayload(payload) {
    return buildActionToolBridgePayload(payload);
  }

  sanitizePayload(provider, payload) {
    return sanitizePayload(provider, payload);
  }

  buildToolBridgePayload(payload) {
    return buildToolBridgePayload(payload);
  }

  async initialize() {
    try {
      const config = await db_operations.getActiveLLMConfig();
      if (config) {
        this.config = config;
        const requiresApiKey = Boolean(config.requires_api_key);
        this.apiKey = config.api_key_encrypted
          ? decryptApiKey(config.api_key_encrypted, { quiet: true })
          : null;

        if (requiresApiKey && !this.apiKey) {
          if (config.api_key_encrypted) {
            console.warn('⚠️  LLM API key could not be decrypted. Please reconfigure the LLM settings.');
          } else {
            console.warn('⚠️  LLM API key is missing. Please configure an API key.');
          }
          return false;
        }

        console.log(`✅ LLM API initialized: ${config.provider}/${config.model}`);
        return true;
      } else {
        console.log('⚠️  No active LLM configuration found');
        return false;
      }
    } catch (error) {
      console.error('❌ Failed to initialize LLM API:', error);
      return false;
    }
  }

  async testConnection(testConfig = null) {
    const config = testConfig || this.config;
    const apiKey = testConfig?.apiKey || this.apiKey;
    
    if (!config) {
      throw new Error('No LLM configuration available');
    }

    // Handle test config format
    if (testConfig && testConfig.provider) {
      const startTime = Date.now();
      try {
        const result = await this.generateText('Test connection - respond with "OK"', testConfig, { maxTokens: 10, temperature: 0 });
        const responseTime = Date.now() - startTime;
        return {
          success: true,
          responseTime,
          response: result
        };
      } catch (error) {
        const responseTime = Date.now() - startTime;
        return {
          success: false,
          responseTime,
          error: error.message
        };
      }
    }

    console.log(`🧪 Testing connection with config:`, {
      provider: config.provider,
      model: config.model,
      apiUrl: config.api_url,
      hasApiKey: !!apiKey
    });

    const startTime = Date.now();

    try {
      const response = await this.makeAPIRequest(config, apiKey, {
        messages: [{ role: 'user', content: 'Test connection - respond with "OK"' }],
        max_tokens: 10,
        temperature: 0
      });

      const responseTime = Date.now() - startTime;

      console.log(`✅ API request successful in ${responseTime}ms`);

      // Log the request
      if (!testConfig) { // Only log if not a test config
        await db_operations.logAPIRequest({
          provider: config.provider,
          model: config.model,
          requestType: 'test',
          responseTime,
          success: true,
          errorMessage: null
        });
      }

      return {
        success: true,
        model: config.model,
        responseTime,
        response: response.data
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      let errorMessage = 'Unknown error';
      
      if (error.response) {
        // API responded with error status
        errorMessage = error.response.data?.error?.message || 
                     error.response.data?.message || 
                     `HTTP ${error.response.status}: ${error.response.statusText}`;
        
        console.error(`❌ API Error (${error.response.status}):`, error.response.data);
      } else if (error.request) {
        // Request was made but no response received
        errorMessage = 'No response from API server - check URL and network connectivity';
        console.error(`❌ Network Error:`, error.message);
      } else {
        // Something else happened
        errorMessage = error.message;
        console.error(`❌ Request Setup Error:`, error.message);
      }
      
      // Log the failed request
      if (!testConfig) {
        await db_operations.logAPIRequest({
          provider: config.provider,
          model: config.model,
          requestType: 'test',
          responseTime,
          success: false,
          errorMessage
        });
      }

      throw new Error(errorMessage);
    }
  }

  async makeAPIRequest(config, apiKey, payload) {
    const headers = this.getHeaders(config.provider, apiKey);
    const url = this.getEndpointURL(config);
    const requestPayload = this.sanitizePayload(config.provider, this.formatPayload(config.provider, payload, config));

    const timestamp = new Date().toISOString();
    console.log(`🔄 [${timestamp}] Making API request to ${config.provider}`);

    // Do not log request payloads by default (can contain sensitive data, large prompts, etc.).
    // Opt-in by setting LUCIDCODER_LLM_DEBUG=1.
    if (process.env.LUCIDCODER_LLM_DEBUG === '1') {
      console.log(`🔄 [${timestamp}] Request payload:`, JSON.stringify(requestPayload, null, 2));
    }

    const response = await axios({
      method: 'POST',
      url,
      headers,
      data: requestPayload,
      timeout: 30000
    });

    return response;
  }

  getHeaders(provider, apiKey) {
    return getHeaders(provider, apiKey);
  }

  getEndpointURL(config) {
    return getEndpointURL(config);
  }

  // Test-compatible method signature
  formatPayload(provider, model, prompt, options = {}) {
    return formatPayload(provider, model, prompt, options, this.config);
  }

  formatPayloadInternal(provider, payload, config) {
    return formatPayloadInternal(provider, payload, config, this.config);
  }

  async generateResponse(messages, options = {}) {
    if (!this.config) {
      await this.initialize();
    }

    if (!this.config) {
      throw new Error('No LLM configuration available. Please configure an LLM provider first.');
    }

    const startTime = Date.now();

    const requestType = options.__lucidcoderRequestType || 'generate';
    const phase = options.__lucidcoderPhase || 'unknown';
    const disableToolBridgeFallback = options.__lucidcoderDisableToolBridgeFallback === true;
    const metricsContext = {
      provider: this.config.provider,
      model: this.config.model,
      requestType,
      phase
    };
    llmRequestMetrics.record('requested', metricsContext);

    try {
      const basePayload = {
        messages,
        max_tokens: options.max_tokens || 1000,
        temperature: options.temperature || 0.7,
        ...options
      };

      let response;
      const request = async (payload) => this._makeDedupedRequest(
        payload,
        options,
        () => {
          llmRequestMetrics.record('outbound', metricsContext);
          return this.makeAPIRequest(this.config, this.apiKey, payload);
        }
      );
      try {
        const shouldUseDefaultBridge =
          this.shouldUseActionToolBridgeByDefault(this.config.provider) &&
          options.__lucidcoderDisableToolBridge !== true;

        const initialPayload = shouldUseDefaultBridge
          ? this.buildActionToolBridgePayload(basePayload)
          : basePayload;

        try {
          response = await request(initialPayload);
        } catch (primaryError) {
          const primaryText = this.getErrorMessage(primaryError);
          // If the provider rejects tool schemas outright, fall back to a plain request.
          if (
            shouldUseDefaultBridge &&
            (/tools\b/i.test(primaryText) && /(unsupported|not supported|unknown|unrecognized|invalid)/i.test(primaryText))
          ) {
            response = await request(basePayload);
          } else {
            throw primaryError;
          }
        }
      } catch (error) {
        const nestedText = this.getErrorMessage(error);
        if (/tool choice is none, but model called a tool/i.test(nestedText)) {
          // Retry with a minimal tool bridge to accommodate tool-capable models.
          // If that still fails, fall back to the action-tool bridge.
          try {
            response = await request(this.buildToolBridgePayload(basePayload));
          } catch (retryError) {
            const retryText = this.getErrorMessage(retryError);
            if (/tool choice is none, but model called a tool/i.test(retryText)) {
              if (disableToolBridgeFallback) {
                throw retryError;
              }
              response = await request(this.buildActionToolBridgePayload(basePayload));
            } else {
              throw retryError;
            }
          }
        } else if (/failed to parse tool call arguments as json/i.test(nestedText)) {
          if (disableToolBridgeFallback) {
            throw error;
          }
          // Some OpenAI-compatible providers will reject malformed tool-call argument payloads.
          // Fall back to a plain request (no tool schemas) so we can rely on plain text output.
          response = await request(basePayload);
        } else if (
          (/tool call validation failed/i.test(nestedText) && /not in request\.tools/i.test(nestedText)) ||
          (/not in request\.tools/i.test(nestedText) && /attempted to call tool/i.test(nestedText)) ||
          (/request\.tools/i.test(nestedText) && /not in/i.test(nestedText) && /tool/i.test(nestedText))
        ) {
          if (disableToolBridgeFallback) {
            throw error;
          }
          // Retry with a tool bridge so strict providers accept tool-capable responses.
          // Even if the caller disabled tool bridging, this error indicates the provider expects tools
          // for the model's response; use the action-tool bridge so the model's tool calls can be
          // translated into JSON actions.
          response = await request(this.buildActionToolBridgePayload(basePayload));
        } else {
          throw error;
        }
      }

      const responseTime = Date.now() - startTime;

      // Log successful request
      await db_operations.logAPIRequest({
        provider: this.config.provider,
        model: this.config.model,
        requestType: 'generate',
        responseTime,
        success: true,
        errorMessage: null
      });

      return this.extractResponse(this.config.provider, response.data);

    } catch (error) {
      const errorMessage = this.getErrorMessage(error);
      
      // Log failed request
      await db_operations.logAPIRequest({
        provider: this.config.provider,
        model: this.config.model,
        requestType: 'generate',
        responseTime: Date.now() - startTime,
        success: false,
        errorMessage
      });

      throw new Error(`LLM API Error: ${errorMessage}`);
    }
  }

  extractResponse(provider, responseData) {
    return extractResponse(provider, responseData);
  }

  // Test-compatible methods
  async generateText(prompt, config, options = {}) {
    if (!config || !config.provider || !config.model || !config.apiUrl) {
      throw new Error('Invalid configuration: missing required fields');
    }

    const payload = {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 100,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9
    };

    const formattedPayload = this.formatPayloadInternal(config.provider, payload, config);
    const headers = this.getHeaders(config.provider, config.apiKey);
    const url = this.getEndpointURL({ provider: config.provider, api_url: config.apiUrl, model: config.model });

    try {
      const response = await axios.post(url, formattedPayload, { headers });
      return this.extractResponse(config.provider, response.data);
    } catch (error) {
      if (error.response) {
        const errorData = error.response.data;
        const errorMessage = errorData?.error?.message || errorData?.message || errorData?.error || errorData || error.response.statusText || 'Unknown error';
        throw new Error(`HTTP ${error.response.status}: ${errorMessage}`);
      } else if (error.request) {
        throw new Error(`Network error: ${error.message}`);
      } else {
        if (error.code === 'ECONNREFUSED') {
          throw new Error(`Network error: ${error.message}`);
        }
        throw new Error(error.message);
      }
    }
  }

  getEndpoint(provider, apiUrl, model) {
    const config = { provider, api_url: apiUrl, model };
    return this.getEndpointURL(config);
  }
}

// Create singleton instance
export const llmClient = new LLMClient();