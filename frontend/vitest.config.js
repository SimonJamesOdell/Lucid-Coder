import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const isWindows = process.platform === 'win32'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: true,
    pool: isWindows ? 'forks' : 'threads',
    onConsoleLog(log, type) {
      if (process.env.VITE_VERBOSE_TEST_LOGS === 'true') {
        return
      }

      const message =
        typeof log === 'string'
          ? log
          : log && typeof log === 'object' && typeof log.message === 'string'
            ? log.message
            : String(log)

      const suppressedPatterns = [
        /DOMException \[(AbortError|NetworkError)\]/i,
        /Failed to execute "fetch\(\)" on "Window"/i,
        /happy-dom\/src\/fetch\/Fetch\.ts/i,
        /HTMLIFrameElement\.ts/i,
        /connect ECONNREFUSED .*:5555/i,
        /http:\/\/localhost:5173\//i,
        /The operation was aborted\.?/i
      ]

      const isStderr = type === 'stderr' || type === 'error'
      if (isStderr && suppressedPatterns.some((pattern) => pattern.test(message))) {
        return false
      }

      return
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    isolate: true,
    cacheDir: './.vite-cache', 
    coverage: {
      reporter: ['text', 'json', 'html'],
      tempDirectory: './coverage-tmp',
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100
      },
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.test.{js,jsx}',
        '**/*.spec.{js,jsx}',
        'vite.config.js',
        'vitest.config.js'
      ]
    }
  }
})