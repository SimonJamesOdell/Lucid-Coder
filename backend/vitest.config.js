import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    timeout: 120000,
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'coverage/**',
        'tests/**',
        '**/*.config.js',
        '**/*.test.js',
        '**/*.spec.js'
      ]
    },
    testTimeout: 120000,
    pool: isWindows ? 'forks' : 'threads',
    cacheDir: './.vite-cache',
    fileParallelism: false,
    sequence: {
      concurrent: false
    }
  }
});