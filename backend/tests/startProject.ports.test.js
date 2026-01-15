import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const ORIGINAL_ENV = { ...process.env };

const createMockChild = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
};

describe('startProject port management', () => {
  let spawnMock;
  let startProject;
  let loadStartProject;
  let mockUnavailablePorts;

  beforeEach(() => {
    vi.resetModules();
    mockUnavailablePorts = new Set();
    spawnMock = vi.fn(() => createMockChild());

    const accessMock = vi.fn((targetPath) => {
      if (targetPath.endsWith('package.json')) {
        return Promise.resolve();
      }
      if (targetPath.endsWith('app.py') || targetPath.includes('venv')) {
        const error = new Error('Not found');
        error.code = 'ENOENT';
        return Promise.reject(error);
      }
      return Promise.resolve();
    });

    vi.doMock('fs/promises', () => ({
      default: { access: accessMock },
      access: accessMock
    }));

    vi.doMock('child_process', () => ({
      spawn: spawnMock,
      exec: vi.fn()
    }));

    const netMock = {
      createServer: () => {
        const handlers = {};
        return {
          once: (event, handler) => {
            handlers[event] = handler;
          },
          listen: (port) => {
            setTimeout(() => {
              if (mockUnavailablePorts.has(port)) {
                handlers.error?.(new Error('in use'));
              } else {
                handlers.listening?.();
              }
            }, 0);
          },
          close: (callback) => {
            if (callback) {
              setTimeout(callback, 0);
            }
          },
          unref: () => {}
        };
      }
    };

    vi.doMock('net', () => ({
      default: netMock,
      ...netMock
    }));

    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'development',
      LUCIDCODER_PROJECT_FRONTEND_PORT_BASE: '9100',
      LUCIDCODER_PROJECT_BACKEND_PORT_BASE: '5500',
      VITE_PORT: '5173'
    };

    loadStartProject = async () => {
      ({ startProject } = await import('../services/projectScaffolding.js'));
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('assigns non-reserved ports and passes them to child processes', async () => {
    vi.useFakeTimers();

    await loadStartProject();

    const startPromise = startProject('C:/tmp/demo-project', {
      frontendPort: 5173,
      backendPort: 3000
    });

    await vi.runAllTimersAsync();
    const result = await startPromise;
    vi.useRealTimers();

    expect(spawnMock).toHaveBeenCalledTimes(2);

    const backendCall = spawnMock.mock.calls[0];
    expect(backendCall[0]).toBe('npm');
    expect(backendCall[2].env.PORT).toBe('3000');

    const frontendCall = spawnMock.mock.calls[1];
    expect(frontendCall[1]).toContain('--port');

    const frontendPort = result.processes.frontend.port;
    expect(frontendPort).not.toBe(5173);
    expect(frontendPort).toBeGreaterThanOrEqual(9100);
  });

  it('reassigns backend ports that collide with host services', async () => {
    process.env = {
      ...process.env,
      LUCIDCODER_BACKEND_HOST_PORTS: '3000'
    };
    await loadStartProject();

    vi.useFakeTimers();
    const startPromise = startProject('C:/tmp/demo-project', {
      frontendPort: 5173,
      backendPort: 3000
    });

    await vi.runAllTimersAsync();
    const result = await startPromise;
    vi.useRealTimers();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const backendCall = spawnMock.mock.calls[0];
    expect(backendCall[2].env.PORT).not.toBe('3000');
    expect(Number(backendCall[2].env.PORT)).toBeGreaterThanOrEqual(5500);
    expect(result.processes.backend.port).toBe(Number(backendCall[2].env.PORT));
  });

  it('respects custom port bases when provided', async () => {
    await loadStartProject();

    vi.useFakeTimers();
    const startPromise = startProject('C:/tmp/demo-project', {
      frontendPort: 5173,
      backendPort: 3000,
      frontendPortBase: 5300,
      backendPortBase: 5700
    });

    await vi.runAllTimersAsync();
    const result = await startPromise;
    vi.useRealTimers();

    expect(result.processes.frontend.port).toBe(5300);
    expect(result.processes.backend.port).toBe(5700);

    const backendCall = spawnMock.mock.calls[0];
    expect(backendCall[2].env.PORT).toBe('5700');
  });
});
