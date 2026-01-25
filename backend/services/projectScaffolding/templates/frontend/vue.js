// Vue template generators
export default {
  javascript: {
    packageJson: (name) => ({
      name: `${name}-frontend`,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        preview: "vite preview",
        test: "vitest run",
        "test:watch": "vitest",
        "test:coverage": "vitest run --coverage",
        "test:e2e": "playwright test"
      },
      dependencies: {
        vue: "^3.3.11",
        axios: "^1.6.0"
      },
      devDependencies: {
        "@vitejs/plugin-vue": "^4.5.2",
        "@vue/test-utils": "^2.4.2",
        "@testing-library/vue": "^8.0.1",
        "@testing-library/jest-dom": "^6.1.4",
        "@vitest/coverage-v8": "^1.0.4",
        jsdom: "^23.0.1",
        "@playwright/test": "^1.49.1",
        vite: "^5.0.8",
        vitest: "^1.0.4"
      }
    }),
    vitestConfig: `import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})`,
    testSetup: `import '@testing-library/jest-dom'

process.env.NODE_ENV = 'test'
`,
    appTestJs: (name) => `import { render, screen } from '@testing-library/vue'
import { describe, test, expect } from 'vitest'
import App from '../App.vue'

describe('${name} App', () => {
  test('renders project heading', () => {
    render(App)
    expect(screen.getByRole('heading', { level: 1, name: '${name}' })).toBeInTheDocument()
  })
})
`,
    playwrightConfig: `import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
`,
    e2eTest: (name) => `import { test, expect } from '@playwright/test'

test('${name} loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '${name}' })).toBeVisible()
})
`,
    viteConfig: `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})`,
    appVue: (name) => `<template>
  <div id="app">
    <header class="app-header">
      <h1>${name}</h1>
      <p>{{ loading ? 'Connecting to backend...' : message }}</p>
      <p>
        Edit <code>src/App.vue</code> and save to test HMR
      </p>
    </header>
  </div>
</template>

<script>
import axios from 'axios'

export default {
  name: 'App',
  data() {
    return {
      message: '',
      loading: true
    }
  },
  async mounted() {
    await this.fetchMessage()
  },
  methods: {
    async fetchMessage() {
      try {
        const response = await axios.get('/api/health')
        this.message = response.data.message
      } catch (error) {
        this.message = 'Failed to connect to backend'
      } finally {
        this.loading = false
      }
    }
  }
}
</script>

<style>
.app-header {
  background-color: #282c34;
  padding: 20px;
  color: white;
  border-radius: 8px;
  text-align: center;
}

.app-header h1 {
  font-size: 2rem;
  margin-bottom: 1rem;
}

.app-header p {
  font-size: 1.1rem;
  margin: 0.5rem 0;
}

.app-header code {
  background-color: #444;
  padding: 2px 4px;
  border-radius: 4px;
}
</style>`,
    mainJs: `import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

createApp(App).mount('#app')`,
    styleCss: `body {
  margin: 0;
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  background-color: #f0f0f0;
}

#app {
  margin-top: 60px;
}`
  }
}
