import { describe, it, expect, afterEach, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

// Keep this suite fast: in test mode, startProject returns stubbed processes
// instead of launching real dev servers.
delete process.env.LUCIDCODER_FORCE_REAL_START;

const projectScaffoldingPromise = import('../../services/projectScaffolding.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PROJECT_PATH = path.resolve(__dirname, '../fixtures/smoke-project');

// (Real-server health checks are covered elsewhere; this smoke is for the startProject API contract.)

describe('startProject smoke test', () => {
  const spawnedProcesses = [];

  afterEach(async () => {
    while (spawnedProcesses.length) {
      const proc = spawnedProcesses.pop();
      // Stub mode returns fake process objects; nothing to stop.
      if (!proc?.isStub && proc?.pid) {
        try {
          process.kill(proc.pid, 'SIGTERM');
        } catch {
          // already stopped
        }
      }
    }
  });

  afterAll(() => {
    delete process.env.LUCIDCODER_FORCE_REAL_START;
  });

  it('returns stubbed frontend and backend processes in test mode', async () => {
    const { startProject } = await projectScaffoldingPromise;

    const result = await startProject(FIXTURE_PROJECT_PATH, {
      frontendPortBase: 14000,
      backendPortBase: 14500
    });

    expect(result.success).toBe(true);
    expect(result.processes.frontend.port).toBeGreaterThanOrEqual(14000);
    expect(result.processes.backend.port).toBeGreaterThanOrEqual(14500);

    expect(result.processes.frontend.isStub).toBe(true);
    expect(result.processes.backend.isStub).toBe(true);

    spawnedProcesses.push(result.processes.frontend, result.processes.backend);
  }, 20000);
});
