import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import axios from 'axios';

vi.mock('../components/ProjectInspector', () => ({
  default: () => <div data-testid="project-inspector">Project Inspector</div>
}));

const mockAxios = axios;

const mockProjectsResponse = (projects = []) => ({
  data: {
    success: true,
    projects
  }
});

const mockLLMTestSuccess = () => ({
  data: {
    success: true,
    model: 'llama-3',
    responseTime: 120
  }
});

const mockLLMConfigureSuccess = () => ({ data: { success: true } });

const mockCreateProjectSuccess = (projectOverrides = {}) => ({
  data: {
    success: true,
    project: {
      id: 'proj-123',
      name: 'Integration App',
      frontend: { framework: 'react' },
      backend: { framework: 'express' },
      ...projectOverrides
    },
    processes: {
      frontend: { port: 3000 },
      backend: { port: 4000 }
    }
  }
});

let llmStatusResponse;

const buildLlmStatus = ({ configured = true, ready = true } = {}) => ({
  success: true,
  configured,
  ready,
  ...(configured
    ? {
        config: {
          provider: 'groq',
          model: 'llama-3.1-70b-versatile',
          api_url: 'https://api.groq.com/openai/v1',
          requires_api_key: true,
          has_api_key: true
        }
      }
    : { reason: 'No LLM configuration found' })
});

const setupFetchMock = () => {
  fetch.mockReset();
  fetch.mockImplementation((url) => {
    if (url === '/api/llm/status') {
      return Promise.resolve({
        ok: true,
        json: async () => llmStatusResponse
      });
    }

    if (url === '/api/projects') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, projects: [] })
      });
    }

    return Promise.resolve({
      ok: true,
      json: async () => ({ message: 'ok' })
    });
  });

  return fetch;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'dark');
  llmStatusResponse = buildLlmStatus({ configured: true, ready: true });
  setupFetchMock();
  mockAxios.get.mockResolvedValue(mockProjectsResponse());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Integration Tests', () => {
  test('complete workflow: LLM configuration to project creation', async () => {
    llmStatusResponse = buildLlmStatus({ configured: false, ready: false });

    mockAxios.post.mockImplementation((url) => {
      if (url === '/api/llm/test') {
        return Promise.resolve(mockLLMTestSuccess());
      }
      if (url === '/api/llm/configure') {
        llmStatusResponse = buildLlmStatus({ configured: true, ready: true });
        return Promise.resolve(mockLLMConfigureSuccess());
      }
      if (url === '/api/projects') {
        return Promise.resolve(mockCreateProjectSuccess());
      }
      return Promise.resolve({ data: {} });
    });

    const user = userEvent.setup();
    render(<App />);

    const apiInput = await screen.findByLabelText('API Key');
    await user.type(apiInput, 'secret-key');
    await user.click(screen.getByRole('button', { name: /Test & Save/i }));
    await waitFor(() => expect(mockAxios.post).toHaveBeenCalledWith('/api/llm/test', expect.any(Object)));
    await waitFor(() => expect(mockAxios.post).toHaveBeenCalledWith('/api/llm/configure', expect.any(Object)));

    await waitFor(() => {
      expect(screen.queryByTestId('backend-offline-overlay')).not.toBeInTheDocument();
    });
    await screen.findByRole('button', { name: 'Create New Project' });

    const createButton = await screen.findByRole('button', { name: 'Create New Project' });
    await user.click(createButton);
    await screen.findByRole('heading', { name: 'Create New Project' });

    await user.type(screen.getByLabelText('Project Name *'), 'Integration App');
    await user.type(screen.getByLabelText('Description'), 'End-to-end flow');
    fireEvent.submit(screen.getByRole('form'));
    await waitFor(() => expect(mockAxios.post).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        name: 'Integration App',
        description: 'End-to-end flow'
      })
    ));
  });

  test('theme switching works throughout the app', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Create New Project' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    const toggle = screen.getByRole('button', { name: /switch to light mode/i });
    await user.click(toggle);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');

    await user.click(screen.getByRole('button', { name: 'Create New Project' }));
    await screen.findByRole('heading', { name: 'Create New Project' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('navigation between create and import views', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: 'Create New Project' }));
    await screen.findByRole('heading', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: /back to projects/i }));
    await screen.findByRole('button', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));
    await screen.findByText('Choose an import source');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('button', { name: 'Create New Project' });
  });

  test('form validation across views', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('button', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: 'Create New Project' }));
    const createForm = screen.getByRole('form');
    fireEvent.submit(createForm);

    expect(await screen.findByText('Project name is required')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /back to projects/i }));
    await screen.findByRole('button', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));
    await screen.findByText('Choose an import source');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Project path is required')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/Sample');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('Project Name *')).toHaveValue('Sample');
  });

  test('error handling across views', async () => {
    llmStatusResponse = buildLlmStatus({ configured: false, ready: false });

    const responses = [
      () => Promise.reject({ response: { data: { error: 'LLM test failed' } } }),
      () => Promise.resolve(mockLLMTestSuccess()),
      () => {
        llmStatusResponse = buildLlmStatus({ configured: true, ready: true });
        return Promise.resolve(mockLLMConfigureSuccess());
      },
      () => Promise.reject({ response: { data: { error: 'Project creation failed' } } })
    ];

    mockAxios.post.mockImplementation(() => {
      const next = responses.shift();
      return next ? next() : Promise.resolve({ data: {} });
    });

    const user = userEvent.setup();
    render(<App />);

    const apiInput = await screen.findByLabelText('API Key');
    await user.type(apiInput, 'secret-key');

    await user.click(screen.getByRole('button', { name: /Test & Save/i }));
    const llmErrors = await screen.findAllByText(/LLM test failed/i);
    expect(llmErrors.length).toBeGreaterThanOrEqual(1);
    llmErrors.forEach((node) => expect(node).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /Test & Save/i }));
    await waitFor(() => expect(mockAxios.post).toHaveBeenCalledWith('/api/llm/configure', expect.any(Object)));

    await waitFor(() => {
      expect(screen.queryByTestId('backend-offline-overlay')).not.toBeInTheDocument();
    });
    await screen.findByRole('button', { name: 'Create New Project' });

    await user.click(screen.getByRole('button', { name: 'Create New Project' }));
    await screen.findByRole('heading', { name: 'Create New Project' });

    await user.type(screen.getByLabelText('Project Name *'), 'Failing Project');
    await user.type(screen.getByLabelText('Description'), 'Should fail');
    fireEvent.submit(screen.getByRole('form'));

    const failureMessage = await screen.findByText((text) => text.includes('Project creation failed'));
    expect(failureMessage).toBeInTheDocument();
  });

  test('state persistence during view changes', async () => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('currentProject', JSON.stringify({
      id: 'persisted-1',
      name: 'Persisted Project',
      frontend: { framework: 'react' },
      backend: { framework: 'express' }
    }));

    const user = userEvent.setup();
    render(<App />);

    await screen.findByTestId('project-inspector');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByText('Persisted Project')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close project' }));
    await screen.findByRole('button', { name: 'Create New Project' });

    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });
});