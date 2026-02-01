import React, { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';
import './GettingStarted.css';

const PROVIDERS = [
  {
    id: 'groq',
    name: 'Groq',
    description: 'Fast inference with Llama models',
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.2-90b-text-preview', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'openai/gpt-oss-120b'],
    apiUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models from OpenAI',
    models: ['gpt-4o', 'gpt-4', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-3.5-turbo'],
    apiUrl: 'https://api.openai.com/v1',
    requiresApiKey: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models from Anthropic',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
    apiUrl: 'https://api.anthropic.com/v1',
    requiresApiKey: true
  },
  {
    id: 'google',
    name: 'Google AI',
    description: 'Gemini models from Google',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-pro'],
    apiUrl: 'https://generativelanguage.googleapis.com/v1',
    requiresApiKey: true
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: 'Command models from Cohere',
    models: ['command-r-plus', 'command-r', 'command-light'],
    apiUrl: 'https://api.cohere.ai/v1',
    requiresApiKey: true
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral models',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-7b'],
    apiUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    description: 'Perplexity AI models',
    models: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online', 'llama-3.1-sonar-large-128k-chat'],
    apiUrl: 'https://api.perplexity.ai',
    requiresApiKey: true
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Various open-source models',
    models: ['meta-llama/Llama-3-70b-chat-hf', 'meta-llama/Llama-3-8b-chat-hf', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO'],
    apiUrl: 'https://api.together.xyz/v1',
    requiresApiKey: true
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    description: 'Local inference with Ollama',
    models: ['llama3.2', 'llama3.1', 'codellama', 'mistral', 'phi3', 'qwen2.5'],
    apiUrl: 'http://localhost:11434',
    requiresApiKey: false
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    description: 'Local inference with LM Studio',
    models: ['local-model'],
    apiUrl: 'http://localhost:1234/v1',
    requiresApiKey: false
  },
  {
    id: 'textgen',
    name: 'Text Generation WebUI (Local)',
    description: 'Local inference with oobabooga',
    models: ['local-model'],
    apiUrl: 'http://localhost:5000/v1',
    requiresApiKey: false
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    description: 'Configure your own inference endpoint',
    models: ['custom'],
    apiUrl: '',
    requiresApiKey: true
  }
];

const getProviderById = (providerId) => PROVIDERS.find((provider) => provider.id === providerId) || null;

const normalizeProviderId = (providerId) => (getProviderById(providerId) ? providerId : 'groq');

const deriveModelState = (providerId, modelName, apiUrl) => {
  if (providerId === 'custom') {
    return {
      selectedModel: '',
      customModel: modelName || '',
      useCustomModel: true,
      customEndpoint: apiUrl || ''
    };
  }

  const provider = getProviderById(providerId);
  const isKnownModel = Boolean(modelName && provider?.models?.includes(modelName));

  if (isKnownModel) {
    return {
      selectedModel: modelName,
      customModel: '',
      useCustomModel: false,
      customEndpoint: ''
    };
  }

  return {
    selectedModel: '',
    customModel: modelName || '',
    useCustomModel: Boolean(modelName),
    customEndpoint: ''
  };
};

const formatCheckedAt = (value) => {
  if (!value) {
    return 'just now';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'just now';
  }
  return date.toLocaleString();
};

const GettingStarted = ({ allowConfigured = false, onConfigured = null }) => {
  const {
    isLLMConfigured,
    configureLLM,
    llmConfig,
    llmStatus,
    refreshLLMStatus
  } = useAppState();
  const [showConfigForm, setShowConfigForm] = useState(!llmStatus?.ready);
  const initialProvider = normalizeProviderId(llmConfig?.provider);
  const initialModelState = deriveModelState(initialProvider, llmConfig?.model, llmConfig?.apiUrl);
  const [selectedProvider, setSelectedProvider] = useState(initialProvider);
  const [selectedModel, setSelectedModel] = useState(initialModelState.selectedModel);
  const [customModel, setCustomModel] = useState(initialModelState.customModel);
  const [customEndpoint, setCustomEndpoint] = useState(initialModelState.customEndpoint);
  const [useCustomModel, setUseCustomModel] = useState(initialModelState.useCustomModel);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!llmConfig) {
      setSelectedProvider('groq');
      setSelectedModel('');
      setCustomModel('');
      setCustomEndpoint('');
      setUseCustomModel(false);
      return;
    }

    const providerId = normalizeProviderId(llmConfig.provider);
    const modelState = deriveModelState(providerId, llmConfig.model, llmConfig.apiUrl);
    setSelectedProvider(providerId);
    setSelectedModel(modelState.selectedModel);
    setCustomModel(modelState.customModel);
    setCustomEndpoint(modelState.customEndpoint);
    setUseCustomModel(modelState.useCustomModel);
  }, [llmConfig]);

  useEffect(() => {
    if (llmStatus?.ready) {
      setShowConfigForm(false);
      return;
    }
    setShowConfigForm(true);
  }, [llmStatus?.ready]);

  useEffect(() => {
    if (!allowConfigured || typeof refreshLLMStatus !== 'function') {
      return;
    }
    refreshLLMStatus({ suppressLoading: true });
  }, [allowConfigured, refreshLLMStatus]);

  const currentProvider = getProviderById(selectedProvider) || getProviderById('groq');
  const isCustomModelInput = useCustomModel || selectedProvider === 'custom';
  const currentModel = isCustomModelInput
    ? customModel
    : (selectedModel || currentProvider?.models?.[0] || '');
  const currentEndpoint = selectedProvider === 'custom' ? customEndpoint : currentProvider?.apiUrl;

  const hasStoredApiKeyForProvider = Boolean(
    currentProvider?.requiresApiKey &&
    llmConfig?.hasApiKey &&
    normalizeProviderId(llmConfig?.provider) === selectedProvider
  );

  const handleTestAndSave = useCallback(async () => {
    if (currentProvider?.requiresApiKey && !hasStoredApiKeyForProvider && !apiKey.trim()) {
      setError('Please enter an API key');
      return;
    }
    
    if (selectedProvider === 'custom' && !customEndpoint.trim()) {
      setError('Please enter a custom API endpoint');
      return;
    }

    if (useCustomModel && !customModel.trim()) {
      setError('Please enter a custom model name');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const payload = {
        provider: selectedProvider,
        apiKey: currentProvider?.requiresApiKey ? (apiKey.trim() || undefined) : '',
        model: currentModel,
        apiUrl: currentEndpoint
      };

      const testResponse = await axios.post('/api/llm/test', payload);
      if (!testResponse.data?.success) {
        throw new Error(testResponse.data?.error || 'Configuration test failed');
      }
      setTestResult(testResponse.data);

      const saveResponse = await axios.post('/api/llm/configure', payload);

      if (saveResponse.data?.success) {
        await configureLLM({
          provider: selectedProvider,
          model: currentModel,
          apiUrl: currentEndpoint,
          configured: true
        });
        if (typeof refreshLLMStatus === 'function') {
          await refreshLLMStatus({ suppressLoading: true });
        }
        setTestResult((prev) => ({
          ...testResponse.data,
          saved: true
        }));
        if (typeof onConfigured === 'function') {
          onConfigured();
        }
        // The panel will disappear as isLLMConfigured becomes true
      } else {
        throw new Error(saveResponse.data?.error || 'Failed to save configuration');
      }
    } catch (err) {
      const errorMessage = err.response?.data?.error || err.message || 'Failed to test and save configuration';
      setError(errorMessage);
      setTestResult({ success: false, error: errorMessage });
    } finally {
      setIsLoading(false);
    }
  }, [currentProvider, hasStoredApiKeyForProvider, apiKey, selectedProvider, customEndpoint, useCustomModel, customModel, currentModel, currentEndpoint, configureLLM, onConfigured]);

  useEffect(() => {
    if (!GettingStarted.__testHooks) {
      return;
    }

    const hooks = GettingStarted.__testHooks;
    hooks.handleTestAndSave = handleTestAndSave;
    hooks.setSelectedProvider = setSelectedProvider;
    hooks.setCustomEndpoint = setCustomEndpoint;
    hooks.setUseCustomModel = setUseCustomModel;
    hooks.setCustomModel = setCustomModel;
    hooks.setApiKey = setApiKey;
    hooks.getError = () => error;
    hooks.overrideProviderModels = (providerId, models = []) => {
      const provider = getProviderById(providerId);
      if (!provider) {
        return;
      }
      provider.models = Array.isArray(models) ? [...models] : models;
    };
    hooks.getProviderModels = (providerId) => getProviderById(providerId)?.models;

    return () => {
      if (!GettingStarted.__testHooks) {
        return;
      }
      hooks.handleTestAndSave = undefined;
      hooks.setSelectedProvider = undefined;
      hooks.setCustomEndpoint = undefined;
      hooks.setUseCustomModel = undefined;
      hooks.setCustomModel = undefined;
      hooks.setApiKey = undefined;
      hooks.getError = undefined;
      hooks.overrideProviderModels = undefined;
      hooks.getProviderModels = undefined;
    };
  }, [handleTestAndSave, error]);

  // Don't show the panel if LLM is already configured
  if (isLLMConfigured && !allowConfigured) {
    return null;
  }

  const showConfiguredBanner = Boolean(llmStatus?.ready);
  const checkedAtLabel = formatCheckedAt(llmStatus?.checkedAt);

  return (
    <div className="getting-started-panel">
      {showConfiguredBanner && (
        <div className="llm-configured-banner" data-testid="llm-configured-banner">
          <div className="llm-configured-title">✅ LLM configured</div>
          <div className="llm-configured-time" data-testid="llm-configured-time">
            Last checked: {checkedAtLabel}
          </div>
          {!showConfigForm && (
            <button
              type="button"
              className="llm-configured-action"
              onClick={() => setShowConfigForm(true)}
            >
              Change configuration
            </button>
          )}
        </div>
      )}
      {showConfigForm && (
      <div className="config-form">
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="provider-select">Provider</label>
            <select
              id="provider-select"
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                setSelectedModel('');
                setCustomModel('');
                setUseCustomModel(false);
                setCustomEndpoint('');
              }}
              className="form-select"
            >
              {PROVIDERS.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="model-select">Model</label>
            {useCustomModel || selectedProvider === 'custom' ? (
              <input
                id="model-select"
                type="text"
                placeholder="Enter model name"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                className="form-input"
              />
            ) : (
              <select
                id="model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="form-select"
              >
                {currentProvider?.models.map(model => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {selectedProvider !== 'custom' && (
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={useCustomModel}
                onChange={(e) => {
                  setUseCustomModel(e.target.checked);
                  if (!e.target.checked) {
                    setCustomModel('');
                  }
                }}
              />
              Use custom model name
            </label>
          </div>
        )}

        {selectedProvider === 'custom' && (
          <div className="form-group">
            <label htmlFor="endpoint-input">API Endpoint</label>
            <input
              id="endpoint-input"
              type="text"
              placeholder="https://your-api-endpoint.com/v1"
              value={customEndpoint}
              onChange={(e) => setCustomEndpoint(e.target.value)}
              className="form-input"
            />
            <small className="form-help">
              Enter the complete API endpoint URL for your custom provider
            </small>
          </div>
        )}

        {currentProvider?.requiresApiKey && (
          <div className="form-group">
            <label htmlFor="api-key-input">API Key</label>
            <div className="input-wrapper">
              <input
                id="api-key-input"
                type={showApiKey ? 'text' : 'password'}
                placeholder={`Enter your ${currentProvider?.name} API key`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="form-input api-key-input"
                autoComplete="new-password"
                data-form-type="other"
                spellCheck="false"
              />
              <button
                type="button"
                className="toggle-visibility-btn"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? 'Hide API key' : 'Show API key'}
              >
                {showApiKey ? '👁️' : '👁️‍🗨️'}
              </button>
            </div>
            <small className="form-help">
              {hasStoredApiKeyForProvider
                ? 'An API key is already stored in the local database (hidden). Leave this blank to keep it, or enter a new key to replace it.'
                : 'Your API key will be stored encrypted in the local database.'}
            </small>
          </div>
        )}

        {!currentProvider?.requiresApiKey && (
          <div className="info-message">
            <span>ℹ️ No API key required for local inference</span>
          </div>
        )}

        {error && (
          <div className="error-message">
            ⚠️ {error}
          </div>
        )}

        {testResult && (
          <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
            {testResult.success ? (
              <>
                ✅ {testResult.saved ? 'Configuration saved successfully!' : 'Connection successful!'}
                {testResult.model && (
                  <small>Model: {testResult.model}{testResult.responseTime ? ` | Response time: ${testResult.responseTime}ms` : ''}</small>
                )}
                {testResult.saved && (
                  <small>Your settings are ready. You can close this panel.</small>
                )}
              </>
            ) : (
              <>
                ❌ Configuration test failed: {testResult.error}
              </>
            )}
          </div>
        )}

        <div className="action-buttons">
          <button
            className="save-btn"
            onClick={handleTestAndSave}
            disabled={
              isLoading
              || (currentProvider?.requiresApiKey && !hasStoredApiKeyForProvider && !apiKey.trim())
              || (selectedProvider === 'custom' && !customEndpoint.trim())
              || (useCustomModel && !customModel.trim())
            }
          >
            {isLoading ? 'Testing & Saving...' : 'Test & Save'}
          </button>
        </div>
      </div>
      )}
    </div>
  );
};

export default GettingStarted;

GettingStarted.__testHooks = GettingStarted.__testHooks || {};