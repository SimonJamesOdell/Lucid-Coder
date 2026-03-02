import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  getRunningProcessEntry,
  runningProcesses,
  sanitizeProcessSnapshot,
  storeRunningProcesses
} from '../routes/projects/processManager.js';

describe('processManager port inference', () => {
  beforeEach(() => {
    runningProcesses.clear();
  });

  afterEach(() => {
    runningProcesses.clear();
  });

  test('sanitizeProcessSnapshot infers frontend port from Vite Local log line with ANSI codes', () => {
    const snapshot = sanitizeProcessSnapshot({
      pid: 12345,
      port: 5100,
      status: 'running',
      logs: [
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: '\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5104\u001b[22m/\u001b[39m'
        }
      ]
    });

    expect(snapshot.port).toBe(5104);
  });

  test('getRunningProcessEntry reconciles stored process port using latest log output', () => {
    const projectId = 'project-port-reconcile';

    storeRunningProcesses(
      projectId,
      {
        frontend: {
          pid: 22222,
          port: 5100,
          status: 'running',
          logs: [
            {
              timestamp: new Date().toISOString(),
              stream: 'stdout',
              message: 'Port 5100 is in use, trying another one...'
            },
            {
              timestamp: new Date().toISOString(),
              stream: 'stdout',
              message: 'Local: http://localhost:5105/'
            }
          ]
        },
        backend: null
      },
      'running'
    );

    const entry = getRunningProcessEntry(projectId);
    expect(entry.processes?.frontend?.port).toBe(5105);
  });

  test('sanitizeProcessSnapshot infers frontend port from generic URL log line', () => {
    const snapshot = sanitizeProcessSnapshot({
      pid: 55555,
      port: 5100,
      status: 'running',
      logs: [
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: 'Server listening on http://127.0.0.1:5108/'
        }
      ]
    });

    expect(snapshot.port).toBe(5108);
  });

  test('sanitizeProcessSnapshot keeps existing port when log parsing yields invalid local/generic ports', () => {
    const snapshot = sanitizeProcessSnapshot({
      pid: 55556,
      port: 5100,
      status: 'running',
      logs: [
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: 'Local: http://localhost:0/'
        },
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: null
        }
      ]
    });

    expect(snapshot.port).toBe(5100);
  });

  test('getRunningProcessEntry keeps existing port when inferred log port already matches current port', () => {
    const projectId = 'project-port-already-matching';

    storeRunningProcesses(
      projectId,
      {
        frontend: {
          pid: 23232,
          port: 5105,
          status: 'running',
          logs: [
            {
              timestamp: new Date().toISOString(),
              stream: 'stdout',
              message: 'Local: http://localhost:5105/'
            }
          ]
        },
        backend: null
      },
      'running'
    );

    const entry = getRunningProcessEntry(projectId);
    expect(entry.processes?.frontend?.port).toBe(5105);
  });

  test('sanitizeProcessSnapshot keeps existing port when generic URL match has invalid port', () => {
    const snapshot = sanitizeProcessSnapshot({
      pid: 55557,
      port: 5100,
      status: 'running',
      logs: [
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: 'Server listening on http://127.0.0.1:0/'
        }
      ]
    });

    expect(snapshot.port).toBe(5100);
  });

  test('sanitizeProcessSnapshot keeps existing port when non-empty logs contain no URL candidates', () => {
    const snapshot = sanitizeProcessSnapshot({
      pid: 55558,
      port: 5100,
      status: 'running',
      logs: [
        {
          timestamp: new Date().toISOString(),
          stream: 'stdout',
          message: 'Development server initialized without explicit URL output'
        }
      ]
    });

    expect(snapshot.port).toBe(5100);
  });
});
