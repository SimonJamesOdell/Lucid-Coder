import axios from 'axios';
import { db_operations } from './database.js';
import { decryptApiKey } from './encryption.js';
import { llmRequestMetrics } from './services/llmRequestMetrics.js';

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
    // Only OpenAI-compatible chat/completions providers should receive tool schemas.
    // Other providers (Anthropic/Google/Cohere/Ollama) use different payloads and may reject tool fields.
    const supported = new Set(['openai', 'groq', 'together', 'perplexity', 'mistral', 'custom']);
    return supported.has(String(provider || '').toLowerCase());
  }

  getErrorMessage(error) {
    const data = error?.response?.data;
    const candidates = [
      data?.error?.message,
      data?.error,
      data?.message,
      data?.detail,
      error?.message,
      typeof error === 'string' ? error : null
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    try {
      if (data != null) {
        return JSON.stringify(data);
      }
    } catch {
      // ignore
    }

    return 'Unknown error';
  }

  buildActionToolBridgePayload(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};

    const respondSchema = {
      type: 'object',
      properties: {
        text: { type: 'string' },
        answer: { type: 'string' },
        content: { type: 'string' },
        message: { type: 'string' }
      },
      additionalProperties: true
    };

    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Request reading a project file by relative path.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['path'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'Request listing a project directory by relative path.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['path'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_file',
          description: 'Alias for list_dir. Some models emit list_file when they mean list a folder.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['path'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Request writing a project file by relative path.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['path', 'content'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'list_goals',
          description: 'Request listing persisted goals for the current project.',
          parameters: {
            type: 'object',
            properties: {
              reason: { type: 'string' }
            },
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'answer',
          description: 'Return the final answer as plain text.',
          parameters: {
            type: 'object',
            properties: {
              answer: { type: 'string' }
            },
            required: ['answer'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'json',
          description: 'Alias tool for returning a JSON response payload (as text or object).',
          parameters: {
            type: 'object',
            properties: {
              json: {},
              value: {},
              data: {},
              text: { type: 'string' },
              content: { type: 'string' },
              answer: { type: 'string' }
            },
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'response',
          description: 'Alias for respond_with_text/answer. Return the final response text.',
          parameters: respondSchema
        }
      },
      {
        type: 'function',
        function: {
          name: 'unable',
          description: 'Return an explanation of why the request cannot be completed.',
          parameters: {
            type: 'object',
            properties: {
              explanation: { type: 'string' }
            },
            required: ['explanation'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'respond_with_text',
          description: 'Return the final answer as plain text in the `text` argument.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            },
            required: ['text'],
            additionalProperties: false
          }
        }
      }
    ];

    return {
      ...base,
      __lucidcoderToolBridge: true,
      tools,
      tool_choice: 'auto'
    };
  }

  sanitizePayload(provider, payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const allowToolBridge = Boolean(payload.__lucidcoderToolBridge);

    // We do not use API-level tool/function calling anywhere in this codebase.
    // Some providers/models may attempt to emit tool calls; sending tool fields can
    // cause strict providers to error. Strip these fields defensively.
    const sanitized = { ...payload };

    // Strip internal control flags from outgoing requests.
    // These are used by our app logic only and must never reach the provider.
    for (const key of Object.keys(sanitized)) {
      if (key.startsWith('__lucidcoder')) {
        delete sanitized[key];
      }
    }

    if (!allowToolBridge) {
      delete sanitized.tools;
      delete sanitized.tool_choice;
      delete sanitized.functions;
      delete sanitized.function_call;
      delete sanitized.parallel_tool_calls;
    }

    // Strip tool-calling fields from message history objects.
    // Some OpenAI-compatible providers will reject requests if messages contain tool metadata.
    if (Array.isArray(sanitized.messages)) {
      sanitized.messages = sanitized.messages
        .filter((msg) => msg && typeof msg === 'object')
        .map((msg) => {
          const role = msg.role;
          const content = msg.content;
          const name = msg.name;
          const next = { role, content };
          if (typeof name === 'string' && name.trim()) {
            next.name = name;
          }
          return next;
        });
    }

    // Avoid passing empty response_format objects if callers accidentally forward them.
    if (sanitized.response_format && typeof sanitized.response_format === 'object') {
      const keys = Object.keys(sanitized.response_format);
      if (keys.length === 0) {
        delete sanitized.response_format;
      }
    }

    return sanitized;
  }

  buildToolBridgePayload(payload) {
    const base = payload && typeof payload === 'object' ? payload : {};

    // A minimal tool bridge that allows strict providers to accept tool-capable models.
    // If the model insists on tool-calling, it can call this function with the intended text output.
    const tools = [
      {
        type: 'function',
        function: {
          name: 'respond_with_text',
          description: 'Return the final answer as plain text in the `text` argument.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            },
            required: ['text'],
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'json',
          description: 'Alias tool for returning a JSON response payload (as text or object).',
          parameters: {
            type: 'object',
            properties: {
              json: {},
              value: {},
              data: {},
              text: { type: 'string' },
              content: { type: 'string' },
              answer: { type: 'string' }
            },
            additionalProperties: true
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'response',
          description: 'Alias for respond_with_text. Return response text in `text`/`answer`.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              answer: { type: 'string' },
              content: { type: 'string' },
              message: { type: 'string' }
            },
            additionalProperties: true
          }
        }
      }
    ];

    return {
      ...base,
      __lucidcoderToolBridge: true,
      tools,
      tool_choice: {
        type: 'function',
        function: { name: 'respond_with_text' }
      }
    };
  }

  async initialize() {
    try {
      const config = await db_operations.getActiveLLMConfig();
      if (config) {
        this.config = config;
        this.apiKey = config.api_key_encrypted ? decryptApiKey(config.api_key_encrypted) : null;
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
    const headers = {
      'Content-Type': 'application/json'
    };

    switch (provider) {
      case 'openai':
      case 'groq':
      case 'together':
      case 'perplexity':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      
      case 'anthropic':
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['anthropic-version'] = '2023-06-01';
        break;
      
      case 'google':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      
      case 'cohere':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      
      case 'mistral':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      
      case 'ollama':
      case 'lmstudio':
      case 'textgen':
        // Local providers typically don't need auth headers
        break;
      
      case 'custom':
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        break;
    }

    return headers;
  }

  getEndpointURL(config) {
    const baseUrl = config.api_url;
    
    switch (config.provider) {
      case 'openai':
      case 'groq':
      case 'together':
      case 'perplexity':
      case 'lmstudio':
      case 'textgen':
        return `${baseUrl}/chat/completions`;
      
      case 'anthropic':
        return `${baseUrl}/messages`;
      
      case 'google':
        return `${baseUrl}/models/${config.model}:generateContent`;
      
      case 'cohere':
        return `${baseUrl}/chat`;
      
      case 'mistral':
        return `${baseUrl}/chat/completions`;
      
      case 'ollama':
        return `${baseUrl}/api/chat`;
      
      case 'custom':
        return `${baseUrl}/chat/completions`; // Default to OpenAI-compatible
      
      default:
        return `${baseUrl}/chat/completions`;
    }
  }

  // Test-compatible method signature
  formatPayload(provider, model, prompt, options = {}) {
    if (typeof model === 'object') {
      // Handle case where second param is payload object (current implementation)
      return this.formatPayloadInternal(provider, model, options);
    }
    
    // Handle test case where params are (provider, model, prompt, options)
    const messages = [{ role: 'user', content: prompt }];
    const payload = {
      model: model,
      messages: messages,
      max_tokens: options.maxTokens || 100,
      temperature: options.temperature || 0.7,
      top_p: options.topP || 0.9
    };
    
    return this.formatPayloadInternal(provider, payload, { model });
  }

  formatPayloadInternal(provider, payload, config) {
    const modelToUse = config?.model || payload?.model || this.config?.model;
    
    if (!payload) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    
    const basePayload = {
      model: modelToUse,
      ...payload
    };

    switch (provider) {
      case 'anthropic':
        return {
          model: modelToUse,
          max_tokens: payload.max_tokens || 1000,
          messages: payload.messages,
          temperature: payload.temperature || 0.7,
          top_p: payload.top_p || 0.9
        };
      
      case 'google':
        return {
          contents: payload.messages.map(msg => ({
            parts: [{ text: msg.content }]
          })),
          generationConfig: {
            maxOutputTokens: payload.max_tokens || 1000,
            temperature: payload.temperature || 0.7,
            topP: payload.top_p || 0.9
          }
        };
      
      case 'cohere':
        const lastMessage = payload.messages[payload.messages.length - 1];
        return {
          model: modelToUse,
          message: lastMessage.content,
          max_tokens: payload.max_tokens || 1000,
          temperature: payload.temperature || 0.7,
          p: payload.top_p || 0.9
        };
      
      case 'ollama':
        return {
          model: modelToUse,
          messages: payload.messages,
          stream: false,
          options: {
            temperature: payload.temperature || 0.7,
            num_predict: payload.max_tokens || 1000
          }
        };
      
      default:
        // Check if provider is supported
        const supportedProviders = ['groq', 'openai', 'anthropic', 'google', 'cohere', 'mistral', 'perplexity', 'together', 'ollama', 'lmstudio', 'textgen', 'custom'];
        if (!supportedProviders.includes(provider)) {
          throw new Error(`Unsupported provider: ${provider}`);
        }
        // OpenAI-compatible format (most providers)
        return basePayload;
    }
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
              response = await request(this.buildActionToolBridgePayload(basePayload));
            } else {
              throw retryError;
            }
          }
        } else if (/failed to parse tool call arguments as json/i.test(nestedText)) {
          // Some OpenAI-compatible providers will reject malformed tool-call argument payloads.
          // Fall back to a plain request (no tool schemas) so we can rely on plain text output.
          response = await request(basePayload);
        } else if (
          (/tool call validation failed/i.test(nestedText) && /not in request\.tools/i.test(nestedText)) ||
          (/not in request\.tools/i.test(nestedText) && /attempted to call tool/i.test(nestedText)) ||
          (/request\.tools/i.test(nestedText) && /not in/i.test(nestedText) && /tool/i.test(nestedText))
        ) {
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
    if (!responseData) {
      return JSON.stringify(responseData);
    }

    const coerceMessageText = (message) => {
      if (!message) {
        return '';
      }
      if (typeof message === 'string') {
        return message;
      }
      if (typeof message.content === 'string' && message.content.trim()) {
        return message.content.trim();
      }
      if (Array.isArray(message.content)) {
        const flattened = message.content
          .map((entry) => {
            if (typeof entry === 'string') {
              return entry;
            }
            if (entry && typeof entry.text === 'string') {
              return entry.text;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim();
        if (flattened) {
          return flattened;
        }
      }
      if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
        return message.reasoning.trim();
      }
      if (message.reasoning && typeof message.reasoning === 'object') {
        if (typeof message.reasoning.output_text === 'string' && message.reasoning.output_text.trim()) {
          return message.reasoning.output_text.trim();
        }
        if (Array.isArray(message.reasoning.steps)) {
          const joined = message.reasoning.steps
            .map((step) => (typeof step?.text === 'string' ? step.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();
          if (joined) {
            return joined;
          }
        }
      }
      return '';
    };

    const extractFromChoices = () => {
      const firstChoice = responseData.choices?.[0];
      if (!firstChoice) {
        return '';
      }

      const messageFallbackText = coerceMessageText(firstChoice.message);

      // Tool-bridge response: translate tool/function calls into plain JSON actions.
      const normalizeFirstToolCall = () => {
        const message = firstChoice.message;
        const messageToolCalls = message?.tool_calls;
        if (Array.isArray(messageToolCalls) && messageToolCalls.length > 0) {
          return messageToolCalls[0];
        }

        // OpenAI legacy function_call format.
        const functionCall = message?.function_call;
        if (functionCall && typeof functionCall === 'object') {
          return { function: functionCall };
        }

        // Some providers may place tool_calls on the choice.
        const choiceToolCalls = firstChoice.tool_calls;
        if (Array.isArray(choiceToolCalls) && choiceToolCalls.length > 0) {
          return choiceToolCalls[0];
        }

        return null;
      };

      const firstCall = normalizeFirstToolCall();
      if (firstCall) {
        const rawName = firstCall?.function?.name ?? firstCall?.name;
        const argsRaw = firstCall?.function?.arguments ?? firstCall?.arguments;

        const toolName = typeof rawName === 'string' ? rawName.trim() : '';
        const coerceString = (value) => (typeof value === 'string' ? value : '');

        let parsed = null;
        if (typeof argsRaw === 'string') {
          const trimmedArgs = argsRaw.trim();
          if (trimmedArgs) {
            try {
              parsed = JSON.parse(trimmedArgs);
            } catch {
              // Some providers may return plain text in the arguments field.
              // If we already have message content, prefer it over potentially-garbled tool args.
              if (!messageFallbackText) {
                parsed = { text: argsRaw };
              }
            }
          }
        } else if (argsRaw && typeof argsRaw === 'object') {
          // If we already have message content, prefer it over non-string tool args.
          if (!messageFallbackText) {
            parsed = argsRaw;
          }
        }

        if (parsed) {
          const normalizedToolName = toolName === 'respond_with_json' ? 'json' : toolName;

          if (normalizedToolName === 'json') {
            const text = coerceString(parsed?.text) || coerceString(parsed?.content) || coerceString(parsed?.answer);
            if (text) {
              return text;
            }

            const payload = parsed?.json ?? parsed?.value ?? parsed?.data;
            try {
              return JSON.stringify(payload ?? parsed);
            } catch {
              return String(payload ?? parsed);
            }
          }

          if ((normalizedToolName === 'respond_with_text' || normalizedToolName === 'response') && parsed) {
            const text = coerceString(parsed.text) || coerceString(parsed.answer) || coerceString(parsed.content) || coerceString(parsed.message);
            if (text) {
              return text;
            }
          }

          // Translate API-level tool calls into the plain JSON-action format our agents expect.
          // This keeps strict providers happy without requiring real tool-call execution.
          const actionName = normalizedToolName;
          if (!actionName) {
            return '';
          }
          const path = coerceString(parsed?.path || parsed?.filePath || parsed?.filename);
          const reason = coerceString(parsed?.reason);
          const content = coerceString(parsed?.content || parsed?.text);

          if (actionName === 'read_file') {
            return JSON.stringify({ action: 'read_file', path, reason: reason || undefined });
          }
          if (actionName === 'list_dir' || actionName === 'list_directory') {
            return JSON.stringify({ action: 'list_dir', path, reason: reason || undefined });
          }
          if (actionName === 'list_file') {
            return JSON.stringify({ action: 'list_dir', path, reason: reason || undefined });
          }
          if (actionName === 'write_file') {
            return JSON.stringify({ action: 'write_file', path, content, reason: reason || undefined });
          }
          if (actionName === 'list_goals') {
            return JSON.stringify({ action: 'list_goals', reason: reason || undefined });
          }
          if (actionName === 'answer') {
            const answer = coerceString(parsed?.answer || parsed?.text);
            return JSON.stringify({ action: 'answer', answer });
          }
          if (actionName === 'unable') {
            const explanation = coerceString(parsed?.explanation || parsed?.reason || parsed?.message);
            return JSON.stringify({ action: 'unable', explanation });
          }
        }
      }

      if (messageFallbackText) {
        return messageFallbackText;
      }
      if (typeof firstChoice.text === 'string' && firstChoice.text.trim()) {
        return firstChoice.text.trim();
      }
      return '';
    };
    
    switch (provider) {
      case 'openai':
      case 'groq':
      case 'together':
      case 'perplexity':
      case 'mistral':
      case 'lmstudio':
      case 'textgen':
      case 'custom':
        return extractFromChoices() || JSON.stringify(responseData);
      
      case 'anthropic':
        return responseData.content?.[0]?.text || '';
      
      case 'google':
        return responseData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      case 'cohere':
        return responseData.text || '';
      
      case 'ollama':
        return coerceMessageText(responseData.message) || extractFromChoices() || '';
      
      default:
        const fallback = extractFromChoices();
        if (fallback) {
          return fallback;
        }
        return JSON.stringify(responseData);
    }
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