import { defineConfig } from 'vitest/config';
import { resolveCoverageProvider } from './vitest.coverageProvider.js';

const isWindows = process.platform === 'win32';
const isCoverageRun = process.env.VITEST_COVERAGE === '1';
const envMaxWorkers = Number(process.env.VITEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(envMaxWorkers) && envMaxWorkers > 0
  ? envMaxWorkers
  : (isWindows ? 4 : undefined);

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.parallel.js'],
    globalSetup: ['./tests/globalSetup.cleanup.js'],
    timeout: 120000,
    testTimeout: 120000,

    // Parallelize the main backend unit/route tests that are safe when isolated.
    pool: 'forks',
    maxWorkers: isCoverageRun ? 1 : maxWorkers,
    fileParallelism: isCoverageRun ? false : true,
    sequence: {
      concurrent: false
    },

    include: ['tests/**/*.test.js'],
    exclude: [
      'node_modules/**',
      'coverage/**',

      // Manual debug suite (spawns servers/processes; intentionally excluded from CI runs).
      'tests/debug.test.js',

      // Keep these serialized in the integration config.
      'tests/server.test.js',
      'tests/projectScaffolding.test.js',
      'tests/startProject.ports.test.js',

      // Integration-style tests (kept serial).
      'tests/integration/**',
      'tests/**/*.integration.test.js',
      'tests/api.processes.integration.test.js'
    ],

    cacheDir: './.vite-cache',
    coverage: {
      provider: resolveCoverageProvider()
    }
  }
});
