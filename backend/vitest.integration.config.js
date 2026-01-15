import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';
const isCoverageRun = process.env.VITEST_COVERAGE === '1';
const envMaxWorkers = Number(process.env.VITEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(envMaxWorkers) && envMaxWorkers > 0
  ? envMaxWorkers
  : (isWindows ? 4 : undefined);

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.integration.js'],
    globalSetup: ['./tests/globalSetup.cleanup.js'],
    timeout: 120000,
    testTimeout: 120000,

    // Integration lane: use forks so sqlite + per-worker env isolation is safe cross-platform.
    pool: 'forks',
    maxWorkers: isCoverageRun ? 1 : maxWorkers,
    fileParallelism: isCoverageRun ? false : true,
    sequence: {
      concurrent: false
    },

    include: [
      'test/integration/**/*.test.js',
      'tests/server.test.js',
      'tests/projectScaffolding.test.js',
      'tests/startProject.ports.test.js',
      'tests/integration/**/*.test.js',
      'tests/**/*.integration.test.js',
      'tests/api.processes.integration.test.js'
    ],

    exclude: ['node_modules/**', 'coverage/**'],

    cacheDir: './.vite-cache'
  }
});
