import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'path';
import net from 'node:net';
import db, {
  initializeDatabase,
  closeDatabase,
  createProject
} from '../database.js';
import { app } from '../server.js';
import { getProjectsDir } from '../utils/projectPaths.js';

const DEFAULT_FRONTEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_FRONTEND_PORT_BASE) || 5100;
const DEFAULT_BACKEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_BACKEND_PORT_BASE) || 5500;

const isPortAvailable = (port) =>
  new Promise((resolve) => {
    const server = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => server.close(() => resolve(true)))
      .listen(port, '0.0.0.0');

    server.unref();
  });

const findFirstAvailablePortFromBase = async (portBase, maxOffset = 25) => {
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const candidate = portBase + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }

  return portBase;
};

const runStatement = (sql) =>
  new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const getRow = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

const resetDatabase = async () => {
  await runStatement('DELETE FROM api_logs');
  await runStatement('DELETE FROM llm_config');
  await runStatement('DELETE FROM projects');
  await runStatement('DELETE FROM git_settings');
  await runStatement('DELETE FROM project_git_settings');
  await runStatement('DELETE FROM port_settings');
};

const buildProjectPayload = (suffix = 'integration') => {
  const timestamp = Date.now();
  return {
    name: `Integration Project ${suffix} ${timestamp}`,
    description: 'Integration test project',
    language: 'javascript,javascript',
    framework: 'react,express',
    path: path.join(getProjectsDir(), `integration-project-${suffix}-${timestamp}`)
  };
};

describe('Project startup integration (real scaffolding logic)', () => {
  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    try {
      await resetDatabase();
    } finally {
      closeDatabase();
    }
  });

  const createProjectRecord = async (suffix = 'integration') => {
    const projectData = buildProjectPayload(suffix);
    return createProject(projectData);
  };

  test('default settings fall back to reserved bases when necessary', async () => {
    const project = await createProjectRecord('default');

    const startResponse = await request(app)
      .post(`/api/projects/${project.id}/start`)
      .expect(200);

    expect(startResponse.body).toHaveProperty('success', true);

    const selectedFrontendPort = startResponse.body.processes.frontend.port;
    const selectedBackendPort = startResponse.body.processes.backend.port;

    // Avoid TOCTOU checks that bind ports *before* startProject runs.
    // On Windows, a probe-bind+close can transiently make the same port unavailable.
    expect(selectedFrontendPort).toBeGreaterThanOrEqual(DEFAULT_FRONTEND_PORT_BASE);
    expect(selectedFrontendPort).toBeLessThan(DEFAULT_FRONTEND_PORT_BASE + 25);
    expect(selectedBackendPort).toBeGreaterThanOrEqual(DEFAULT_BACKEND_PORT_BASE);
    expect(selectedBackendPort).toBeLessThan(DEFAULT_BACKEND_PORT_BASE + 25);

    // Since startProject is stubbed in test mode, the returned ports should be bindable.
    expect(await isPortAvailable(selectedFrontendPort)).toBe(true);
    expect(await isPortAvailable(selectedBackendPort)).toBe(true);

    const statusResponse = await request(app)
      .get(`/api/projects/${project.id}/processes`)
      .expect(200);

    expect(statusResponse.body.ports.active.frontend).toBe(selectedFrontendPort);
    expect(statusResponse.body.ports.active.backend).toBe(selectedBackendPort);

    const dbRow = await getRow('SELECT frontend_port, backend_port FROM projects WHERE id = ?', [project.id]);
    expect(dbRow.frontend_port).toBe(selectedFrontendPort);
    expect(dbRow.backend_port).toBe(selectedBackendPort);
  });

  test('customized global port bases are honored during project start', async () => {
    const frontendPortBase = 5300;
    const backendPortBase = 5800;

    await request(app)
      .put('/api/settings/ports')
      .send({ frontendPortBase, backendPortBase })
      .expect(200);

    const project = await createProjectRecord('custom');

    const startResponse = await request(app)
      .post(`/api/projects/${project.id}/start`)
      .expect(200);

    const selectedFrontendPort = startResponse.body.processes.frontend.port;
    const selectedBackendPort = startResponse.body.processes.backend.port;

    expect(selectedFrontendPort).toBeGreaterThanOrEqual(frontendPortBase);
    expect(selectedFrontendPort).toBeLessThan(frontendPortBase + 25);
    expect(selectedBackendPort).toBeGreaterThanOrEqual(backendPortBase);
    expect(selectedBackendPort).toBeLessThan(backendPortBase + 25);

    expect(await isPortAvailable(selectedFrontendPort)).toBe(true);
    expect(await isPortAvailable(selectedBackendPort)).toBe(true);

    const statusResponse = await request(app)
      .get(`/api/projects/${project.id}/processes`)
      .expect(200);

    expect(statusResponse.body.ports.active.frontend).toBe(selectedFrontendPort);
    expect(statusResponse.body.ports.active.backend).toBe(selectedBackendPort);

    const dbRow = await getRow('SELECT frontend_port, backend_port FROM projects WHERE id = ?', [project.id]);
    expect(dbRow.frontend_port).toBe(selectedFrontendPort);
    expect(dbRow.backend_port).toBe(selectedBackendPort);
  });
});
