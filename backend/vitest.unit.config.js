import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';
const envMaxWorkers = Number(process.env.VITEST_MAX_WORKERS);
const maxWorkers = Number.isInteger(envMaxWorkers) && envMaxWorkers > 0
  ? envMaxWorkers
  : (isWindows ? 4 : undefined);

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.unit.js'],
    globalSetup: ['./tests/globalSetup.cleanup.js'],
    timeout: 120000,
    testTimeout: 120000,

    // Fast lane: allow Vitest to parallelize test files.
    pool: isWindows ? 'forks' : 'threads',
    maxWorkers,
    fileParallelism: true,
    sequence: {
      concurrent: false
    },

    // Run the main unit-style suite.
    include: ['test/**/*.test.js'],
    exclude: [
      'node_modules/**',
      'coverage/**',
      'test/integration/**'
    ],

    cacheDir: './.vite-cache'
  }
});
