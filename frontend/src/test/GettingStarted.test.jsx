import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import GettingStarted from '../components/StatusPanel';

const mockConfigureLLM = vi.fn();
const useAppStateMock = vi.fn();

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => useAppStateMock()
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn()
  }
}));

const mockAxios = axios;

const setAppState = (overrides = {}) => {
  useAppStateMock.mockReturnValue({
    isLLMConfigured: false,
    configureLLM: mockConfigureLLM,
    llmConfig: null,
    ...overrides
  });
};

const renderComponent = (props = {}) => {
  const user = userEvent.setup();
  render(<GettingStarted {...props} />);
  return { user };
};

const waitForTestHooks = async () => {
  await waitFor(() => {
    expect(typeof GettingStarted.__testHooks.handleTestAndSave).toBe('function');
  });
  return GettingStarted.__testHooks;
};

const fillApiKey = async (user, value = 'sk-test-key') => {
  const apiInput = screen.getByLabelText('API Key');
  await user.type(apiInput, value);
  return apiInput;
};

const flushInitialRender = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  setAppState();
});

describe('GettingStarted Component', () => {
  test('renders getting started panel when LLM not configured', () => {
    render(<GettingStarted />);

    expect(screen.getByText('🚀 Getting Started')).toBeInTheDocument();
    expect(screen.getByText(/Configure your LLM provider/i)).toBeInTheDocument();
  });

  test('does not render when LLM is configured', () => {
    setAppState({ isLLMConfigured: true });
    const { container } = render(<GettingStarted />);

    expect(container).toBeEmptyDOMElement();
  });

  test('renders when allowConfigured is true even if already configured', () => {
    setAppState({ isLLMConfigured: true });
    render(<GettingStarted allowConfigured />);

    expect(screen.getByText('🚀 Getting Started')).toBeInTheDocument();
  });

  test('shows all provider options in dropdown', () => {
    render(<GettingStarted />);

    const providerSelect = screen.getByLabelText('Provider');
    const options = within(providerSelect).getAllByRole('option');
    expect(options).toHaveLength(12);
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([
        'Groq',
        'OpenAI',
        'Anthropic',
        'Google AI',
        'Cohere',
        'Mistral AI',
        'Perplexity',
        'Together AI',
        'Ollama (Local)',
        'LM Studio (Local)',
        'Text Generation WebUI (Local)',
        'Custom Provider'
      ])
    );
  });

  test('updates model options when provider changes', async () => {
    const { user } = renderComponent();
    const providerSelect = screen.getByLabelText('Provider');

    await user.selectOptions(providerSelect, 'anthropic');

    const modelSelect = screen.getByLabelText('Model');
    const modelOptions = within(modelSelect).getAllByRole('option').map((option) => option.value);

    expect(modelOptions).toContain('claude-3-5-sonnet-20241022');
    expect(modelOptions).not.toContain('llama-3.1-70b-versatile');
  });

  test('shows API key input for providers that require it', () => {
    render(<GettingStarted />);

    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
  });

  test('shows stored API key hint when API key already exists for provider', () => {
    setAppState({
      llmConfig: {
        provider: 'groq',
        model: 'llama-3.1-70b-versatile',
        apiUrl: '',
        hasApiKey: true
      }
    });

    render(<GettingStarted />);

    expect(
      screen.getByText(
        /An API key is already stored in the local database/i
      )
    ).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Test & Save/i })).toBeEnabled();
  });

  test('hides API key input for local providers', async () => {
    const { user } = renderComponent();

    await user.selectOptions(screen.getByLabelText('Provider'), 'ollama');

    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(screen.getByText(/No API key required for local inference/)).toBeInTheDocument();
  });

  test('shows custom endpoint input for custom provider', async () => {
    const { user } = renderComponent();

    await user.selectOptions(screen.getByLabelText('Provider'), 'custom');

    expect(screen.getByLabelText('API Endpoint')).toBeInTheDocument();
  });

  test('API key input handles masking correctly', async () => {
    const { user } = renderComponent();
    const apiInput = screen.getByLabelText('API Key');

    expect(apiInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByTitle('Show API key'));
    expect(apiInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByTitle('Hide API key'));
    expect(apiInput).toHaveAttribute('type', 'password');
  });

  test('API key input handles pasting correctly', async () => {
    const { user } = renderComponent();
    const apiInput = screen.getByLabelText('API Key');

    await user.click(apiInput);
    await user.paste('secret-value');

    expect(apiInput).toHaveValue('secret-value');
  });

  test('test & save button is disabled with invalid configuration', () => {
    render(<GettingStarted />);

    expect(screen.getByRole('button', { name: 'Test & Save' })).toBeDisabled();
  });

  test('test & save button is enabled with valid configuration', async () => {
    const { user } = renderComponent();
    await fillApiKey(user);

    expect(screen.getByRole('button', { name: 'Test & Save' })).toBeEnabled();
  });

  test('handles successful test and save flow', async () => {
    const { user } = renderComponent();
    mockAxios.post
      .mockResolvedValueOnce({
        data: {
          success: true,
          model: 'llama-3.1-70b-versatile',
          responseTime: 120
        }
      })
      .mockResolvedValueOnce({ data: { success: true } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    await waitFor(() =>
      expect(mockAxios.post).toHaveBeenNthCalledWith(
        1,
        '/api/llm/test',
        expect.objectContaining({
          provider: 'groq',
          apiKey: 'sk-test-key',
          model: 'llama-3.1-70b-versatile',
          apiUrl: 'https://api.groq.com/openai/v1'
        })
      )
    );

    await waitFor(() =>
      expect(mockAxios.post).toHaveBeenNthCalledWith(
        2,
        '/api/llm/configure',
        expect.objectContaining({
          provider: 'groq',
          apiKey: 'sk-test-key',
          model: 'llama-3.1-70b-versatile',
          apiUrl: 'https://api.groq.com/openai/v1'
        })
      )
    );

    expect(screen.getByText(/Configuration saved successfully/i)).toBeInTheDocument();
    expect(screen.getByText(/Model:/i)).toBeInTheDocument();
    expect(mockConfigureLLM).toHaveBeenCalledWith({
      provider: 'groq',
      model: 'llama-3.1-70b-versatile',
      apiUrl: 'https://api.groq.com/openai/v1',
      configured: true
    });
  });

  test('renders model metadata without response time when API omits measurement', async () => {
    const { user } = renderComponent();
    mockAxios.post
      .mockResolvedValueOnce({
        data: {
          success: true,
          model: 'llama-3.1-70b-versatile'
        }
      })
      .mockResolvedValueOnce({ data: { success: true } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    await screen.findByText(/Configuration saved successfully!/);
    const modelLine = screen.getByText(/Model: llama-3.1-70b-versatile/);
    expect(modelLine.textContent).not.toContain('Response time');
  });

  test('omits API key when provider does not require one', async () => {
    const { user } = renderComponent();
    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: { success: true } });

    await user.selectOptions(screen.getByLabelText('Provider'), 'ollama');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');

    const testAndSaveButton = screen.getByRole('button', { name: 'Test & Save' });
    expect(testAndSaveButton).toBeEnabled();
    await user.click(testAndSaveButton);

    await waitFor(() =>
      expect(mockAxios.post).toHaveBeenNthCalledWith(
        1,
        '/api/llm/test',
        expect.objectContaining({
          provider: 'ollama',
          apiKey: '',
          apiUrl: 'http://localhost:11434'
        })
      )
    );
  });

  test('handles failed configuration test', async () => {
    const { user } = renderComponent();
    mockAxios.post.mockRejectedValueOnce({ response: { data: { error: 'Invalid key' } } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    const errorMessages = await screen.findAllByText(/Invalid key/);
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(screen.getByText(/Configuration test failed: Invalid key/)).toBeInTheDocument();
  });

  test('displays failure banner when test endpoint reports an error response', async () => {
    const { user } = renderComponent();
    mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'LLM offline' } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    const offlineMessages = await screen.findAllByText(/LLM offline/);
    expect(offlineMessages.length).toBeGreaterThan(0);
    expect(screen.getByText(/Configuration test failed: LLM offline/)).toBeInTheDocument();
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  test('invokes onConfigured callback after saving', async () => {
    const onConfigured = vi.fn();
    const { user } = renderComponent({ allowConfigured: true, onConfigured });

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true, model: 'llama-3.1-70b-versatile', responseTime: 80 } })
      .mockResolvedValueOnce({ data: { success: true } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    await waitFor(() => expect(onConfigured).toHaveBeenCalledTimes(1));
  });

  test('shows error when saving configuration fails after successful test', async () => {
    const { user } = renderComponent();
    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true, model: 'llama-3.1-70b-versatile', responseTime: 50 } })
      .mockResolvedValueOnce({ data: { success: false, error: 'Persistence failed' } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    await waitFor(() => expect(mockAxios.post).toHaveBeenCalledTimes(2));
    const persistenceMessages = await screen.findAllByText(/Persistence failed/);
    expect(persistenceMessages.length).toBeGreaterThan(0);
    expect(screen.getByText(/Configuration test failed: Persistence failed/)).toBeInTheDocument();
    expect(mockConfigureLLM).not.toHaveBeenCalled();
  });

  test('shows generic failure when test endpoint omits error detail', async () => {
    const { user } = renderComponent();
    mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    expect(
      await screen.findByText(/Configuration test failed: Configuration test failed/)
    ).toBeInTheDocument();
  });

  test('shows generic failure when save endpoint omits error detail', async () => {
    const { user } = renderComponent();
    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true, responseTime: 10 } })
      .mockResolvedValueOnce({ data: { success: false } });

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    expect(
      await screen.findByText(/Configuration test failed: Failed to save configuration/)
    ).toBeInTheDocument();
    expect(mockConfigureLLM).not.toHaveBeenCalled();
  });

  test('falls back to catch-all error message when rejection lacks details', async () => {
    const { user } = renderComponent();
    mockAxios.post.mockRejectedValueOnce({});

    await fillApiKey(user);
    await user.click(screen.getByRole('button', { name: 'Test & Save' }));

    expect(
      await screen.findByText(/Configuration test failed: Failed to test and save configuration/)
    ).toBeInTheDocument();
  });

  test('shows connection success message before save completes', async () => {
    const { user } = renderComponent();
    await fillApiKey(user);

    let resolveConfigure;
    const configurePromise = new Promise((resolve) => {
      resolveConfigure = resolve;
    });

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true } })
      .mockImplementationOnce(() => configurePromise);

    const button = screen.getByRole('button', { name: 'Test & Save' });
    await user.click(button);

    expect(await screen.findByText(/Connection successful!/)).toBeInTheDocument();
    expect(screen.queryByText('Configuration saved successfully!')).toBeNull();
    expect(screen.queryByText(/Model:/)).toBeNull();

    await act(async () => {
      resolveConfigure({ data: { success: true } });
      await configurePromise;
    });

    await waitFor(() =>
      expect(screen.getByText(/Configuration saved successfully!/)).toBeInTheDocument()
    );
  });

  test('custom model checkbox works correctly', async () => {
    const { user } = renderComponent();
    await flushInitialRender();

    const modelSelect = screen.getByLabelText('Model', { selector: 'select' });
    expect(modelSelect.tagName).toBe('SELECT');

    const customToggle = screen.getByLabelText('Use custom model name');
    await user.click(customToggle);
    await waitFor(() => expect(customToggle).toBeChecked());
    let modelInput;
    await waitFor(() => {
      modelInput = screen.getByRole('textbox', { name: 'Model' });
      expect(modelInput).toBeInTheDocument();
    });
  });

  test('clears custom model input when checkbox is unchecked', async () => {
    const { user } = renderComponent();
    await flushInitialRender();

    const customToggle = screen.getByLabelText('Use custom model name');
    await user.click(customToggle);
    await waitFor(() => expect(customToggle).toBeChecked());
    let modelInput;
    await waitFor(() => {
      modelInput = screen.getByRole('textbox', { name: 'Model' });
      expect(modelInput).toBeInTheDocument();
    });
    await user.type(modelInput, 'experimental-model');
    expect(modelInput).toHaveValue('experimental-model');

    await user.click(customToggle);
    await waitFor(() => expect(customToggle).not.toBeChecked());
    await waitFor(() => {
      const select = screen.getByLabelText('Model', { selector: 'select' });
      expect(select.tagName).toBe('SELECT');
    });

    await user.click(customToggle);
    const restoredInput = await screen.findByRole('textbox', { name: 'Model' });
    expect(restoredInput).toHaveValue('');
  });

  test('validates required fields', async () => {
    const { user } = renderComponent();

    await user.selectOptions(screen.getByLabelText('Provider'), 'custom');
    await fillApiKey(user);

    const testAndSaveButton = screen.getByRole('button', { name: 'Test & Save' });
    expect(testAndSaveButton).toBeDisabled();

    await user.type(screen.getByLabelText('API Endpoint'), 'https://example.com/v1');

    expect(testAndSaveButton).toBeEnabled();
  });

  test('preselects provider and model from saved configuration', () => {
    setAppState({
      isLLMConfigured: true,
      llmConfig: {
        provider: 'openai',
        model: 'gpt-4o',
        apiUrl: 'https://api.openai.com/v1',
        configured: true
      }
    });

    render(<GettingStarted allowConfigured />);

    expect(screen.getByLabelText('Provider')).toHaveValue('openai');
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4o');
  });

  test('restores custom provider inputs from saved configuration', () => {
    setAppState({
      isLLMConfigured: true,
      llmConfig: {
        provider: 'custom',
        model: 'acme-model',
        apiUrl: 'https://custom.example.com/v1',
        configured: true
      }
    });

    render(<GettingStarted allowConfigured />);

    expect(screen.getByLabelText('Provider')).toHaveValue('custom');
    expect(screen.getByLabelText('Model')).toHaveValue('acme-model');
    expect(screen.getByLabelText('API Endpoint')).toHaveValue('https://custom.example.com/v1');
  });

  test('defaults custom provider fields when persisted values are missing', () => {
    setAppState({
      isLLMConfigured: true,
      llmConfig: {
        provider: 'custom',
        model: '',
        apiUrl: '',
        configured: true
      }
    });

    render(<GettingStarted allowConfigured />);

    expect(screen.getByLabelText('Provider')).toHaveValue('custom');
    const modelInput = screen.getByLabelText('Model');
    expect(modelInput.tagName).toBe('INPUT');
    expect(modelInput).toHaveValue('');
    expect(screen.getByLabelText('API Endpoint')).toHaveValue('');
  });

  test('switches to custom model input when saved model is unknown', () => {
    setAppState({
      isLLMConfigured: true,
      llmConfig: {
        provider: 'groq',
        model: 'experimental-model',
        apiUrl: 'https://api.groq.com/openai/v1',
        configured: true
      }
    });

    render(<GettingStarted allowConfigured />);

    expect(screen.getByLabelText('Provider')).toHaveValue('groq');
    const modelInput = screen.getByLabelText('Model');
    expect(modelInput).toHaveValue('experimental-model');
    expect(modelInput.tagName).toBe('INPUT');
    expect(screen.getByLabelText('Use custom model name')).toBeChecked();
  });

  test('falls back to default provider metadata when provider id is unknown', async () => {
    const { user } = renderComponent();
    const hooks = await waitForTestHooks();

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: { success: true } });

    await fillApiKey(user);

    act(() => {
      hooks.setSelectedProvider('mystery-provider');
    });

    await act(async () => {
      await hooks.handleTestAndSave();
    });

    expect(mockAxios.post).toHaveBeenNthCalledWith(
      1,
      '/api/llm/test',
      expect.objectContaining({
        provider: 'mystery-provider',
        model: 'llama-3.1-70b-versatile',
        apiUrl: 'https://api.groq.com/openai/v1'
      })
    );
  });

  test('falls back to empty model when provider lacks default options', async () => {
    const { user } = renderComponent();
    const hooks = await waitForTestHooks();
    const originalModels = [...(hooks.getProviderModels('ollama') || [])];

    mockAxios.post
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: { success: true } });

    try {
      act(() => {
        hooks.overrideProviderModels('ollama', []);
        hooks.setSelectedProvider('ollama');
      });

      const testAndSaveButton = screen.getByRole('button', { name: 'Test & Save' });
      expect(testAndSaveButton).toBeEnabled();
      await user.click(testAndSaveButton);

      await waitFor(() =>
        expect(mockAxios.post).toHaveBeenNthCalledWith(
          1,
          '/api/llm/test',
          expect.objectContaining({
            provider: 'ollama',
            model: ''
          })
        )
      );
    } finally {
      act(() => {
        hooks.overrideProviderModels('ollama', originalModels);
      });
    }
  });

  describe('Validation Guards', () => {
    test('handleTestAndSave reports missing API key', async () => {
      render(<GettingStarted />);
      const hooks = await waitForTestHooks();

      await act(async () => {
        await hooks.handleTestAndSave();
      });

      expect(hooks.getError()).toBe('Please enter an API key');
      expect(await screen.findByText(/Please enter an API key/)).toBeInTheDocument();
    });

    test('handleTestAndSave allows blank API key when one is already stored', async () => {
      setAppState({
        llmConfig: {
          provider: 'groq',
          model: 'llama-3.1-70b-versatile',
          apiUrl: '',
          hasApiKey: true
        }
      });

      render(<GettingStarted />);
      const hooks = await waitForTestHooks();

      mockAxios.post
        .mockResolvedValueOnce({ data: { success: true } })
        .mockResolvedValueOnce({ data: { success: true } });

      await act(async () => {
        await hooks.handleTestAndSave();
      });

      expect(mockAxios.post).toHaveBeenNthCalledWith(
        1,
        '/api/llm/test',
        expect.objectContaining({ provider: 'groq' })
      );

      const payload = mockAxios.post.mock.calls[0][1];
      expect(payload).toHaveProperty('apiKey', undefined);
    });

    test('handleTestAndSave requires custom endpoint when provider is custom', async () => {
      render(<GettingStarted />);
      const hooks = await waitForTestHooks();

      act(() => {
        hooks.setSelectedProvider('custom');
        hooks.setApiKey('sk-test');
        hooks.setCustomEndpoint('');
      });

      await act(async () => {
        await hooks.handleTestAndSave();
      });

      expect(hooks.getError()).toBe('Please enter a custom API endpoint');
      expect(await screen.findByText(/Please enter a custom API endpoint/)).toBeInTheDocument();
    });

    test('handleTestAndSave requires custom model name when using custom model flag', async () => {
      render(<GettingStarted />);
      const hooks = await waitForTestHooks();

      act(() => {
        hooks.setApiKey('sk-test');
        hooks.setUseCustomModel(true);
        hooks.setCustomModel('');
      });

      await act(async () => {
        await hooks.handleTestAndSave();
      });

      expect(hooks.getError()).toBe('Please enter a custom model name');
      expect(await screen.findByText(/Please enter a custom model name/)).toBeInTheDocument();
    });
  });

  describe('Test Hook Guards', () => {
    test('skips hook wiring when hooks container is missing', async () => {
      const originalHooks = GettingStarted.__testHooks;
      GettingStarted.__testHooks = undefined;
      setAppState();

      render(<GettingStarted />);

      await waitFor(() => {
        expect(GettingStarted.__testHooks).toBeUndefined();
      });

      GettingStarted.__testHooks = originalHooks || {};
    });

    test('cleanup guard exits when hooks container disappears before unmount', async () => {
      const originalHooks = GettingStarted.__testHooks;
      const tempHooks = {};
      GettingStarted.__testHooks = tempHooks;
      setAppState();

      const { unmount } = render(<GettingStarted />);

      await waitFor(() => {
        expect(typeof tempHooks.handleTestAndSave).toBe('function');
      });

      GettingStarted.__testHooks = undefined;

      expect(() => {
        unmount();
      }).not.toThrow();

      expect(typeof tempHooks.handleTestAndSave).toBe('function');

      GettingStarted.__testHooks = originalHooks || {};
    });

    test('overrideProviderModels no-ops when provider id is unknown', async () => {
      render(<GettingStarted />);
      const hooks = await waitForTestHooks();

      expect(() => hooks.overrideProviderModels('missing-provider', ['foo'])).not.toThrow();
    });

    test('overrideProviderModels accepts non-array values', async () => {
      render(<GettingStarted />);
      const hooks = await waitForTestHooks();
      const originalModels = [...(hooks.getProviderModels('ollama') || [])];

      try {
        hooks.overrideProviderModels('ollama', 'solo-model');
        expect(hooks.getProviderModels('ollama')).toBe('solo-model');
      } finally {
        hooks.overrideProviderModels('ollama', originalModels);
      }
    });
  });
});