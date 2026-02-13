// Express template generators
export default {
  javascript: {
    packageJson: (name) => ({
      name: `${name}-backend`,
      version: "0.1.0",
      type: "module",
      main: "server.js",
      scripts: {
        start: "node server.js",
        dev: "node --watch server.js",
        test: "jest",
        "test:watch": "jest --watch",
        "test:coverage": "jest --coverage",
        "test:e2e": "jest --runInBand --testPathPattern=e2e"
      },
      dependencies: {
        express: "^4.18.2",
        cors: "^2.8.5",
        dotenv: "^16.3.1"
      },
      devDependencies: {
        jest: "^29.7.0",
        supertest: "^6.3.3",
        nodemon: "^3.0.2",
        "@babel/preset-env": "^7.23.6",
        "babel-jest": "^29.7.0"
      }
    }),
    serverJs: (name) => `import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    message: 'Backend is running successfully!',
    project: '${name}',
    timestamp: new Date().toISOString()
  });
});

// Basic API routes
app.get('/api', (req, res) => {
  res.json({ message: 'Welcome to ${name} API' });
});

app.post('/api/echo', (req, res) => {
  res.status(201).json({ received: req.body || {} });
});

// Fallback for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 ${name} backend server running on http://0.0.0.0:' + PORT);
  });
}

export default app;`,
    envExample: `PORT=3000
NODE_ENV=development`,
    jestConfig: `export default {
  testEnvironment: 'node',
  collectCoverageFrom: [
    '**/*.js',
    '!**/*.config.js',
    '!**/*.config.cjs',
    '!**/jest.config.js',
    '!**/babel.config.cjs',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/tests/**',
    '!**/test/**',
    '!**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  setupFilesAfterEnv: ['./test/setup.js'],
  verbose: true,
  transform: {
    '^.+\\.js$': 'babel-jest'
  }
}`,
    babelConfig: `module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]]
};`,
    serverTestJs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server.js'

describe('${name} Server', () => {
  test('creates an Express app instance', () => {
    expect(typeof app).toBe('function')
  })

  test('responds to the health check endpoint', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200)

    expect(response.body).toHaveProperty('message')
    expect(response.body).toHaveProperty('project', '${name}')
    expect(response.body).toHaveProperty('timestamp')
  })

  test('returns a JSON 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/nonexistent-route')
      .expect(404)

    expect(response.body).toHaveProperty('error', 'Route not found')
  })
})`,
    routesTestJs: `import { describe, test, expect } from '@jest/globals'

const validateRequest = (data) => Boolean(data && data.name && data.email)

const normalizeUser = (user) => ({
  id: user.id ?? 0,
  name: user.name.trim()
})

const formatApiResponse = (data, success = true) => ({
  success,
  data,
  timestamp: new Date().toISOString()
})

describe('API helper examples', () => {
  test('validates request payloads', () => {
    expect(validateRequest({ name: 'Test', email: 'test@example.com' })).toBe(true)
    expect(validateRequest({ name: 'Test' })).toBe(false)
  })

  test('normalizes user records', () => {
    expect(normalizeUser({ name: '  Ada Lovelace  ' })).toEqual({ id: 0, name: 'Ada Lovelace' })
  })

  test('formats API responses with metadata', () => {
    const response = formatApiResponse({ id: 1 })
    expect(response).toMatchObject({ success: true, data: { id: 1 } })
    expect(response).toHaveProperty('timestamp')
  })
})`,
    setupTests: `// Jest setup file for Express JavaScript backend
import { jest } from '@jest/globals'

// Mock environment variables for testing
process.env.NODE_ENV = 'test'
process.env.PORT = '0'

// Global test timeout
jest.setTimeout(10000)

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks()
})`,
    appTestJs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server.js'

describe('${name} Express App', () => {
  test('handles JSON payloads through /api/echo', async () => {
    const payload = { greeting: 'hello' }
    const response = await request(app)
      .post('/api/echo')
      .send(payload)
      .expect(201)

    expect(response.body).toEqual({ received: payload })
  })

  test('exposes CORS headers', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200)

    expect(response.headers['access-control-allow-origin']).toBe('*')
  })
})`,
    apiTestJs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server.js'

describe('${name} API Endpoints', () => {
  test('responds to GET /api/health', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200)

    expect(response.body).toMatchObject({
      message: 'Backend is running successfully!',
      project: '${name}'
    })
  })

  test('responds to GET /api', async () => {
    const response = await request(app)
      .get('/api')
      .expect(200)

    expect(response.body).toHaveProperty('message')
  })

  test('echoes payloads via POST /api/echo', async () => {
    const payload = { hello: 'world' }
    const response = await request(app)
      .post('/api/echo')
      .send(payload)
      .expect(201)

    expect(response.body).toEqual({ received: payload })
  })
})`,
    e2eHttpTestJs: (name) => `import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import app from '../server.js'

describe('${name} E2E (HTTP)', () => {
  let server
  let baseUrl

  beforeAll(() => {
    server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : null
    baseUrl = 'http://127.0.0.1:' + port
  })

  afterAll(() => {
    if (server) server.close()
  })

  test('responds to GET /api/health over the network', async () => {
    const response = await fetch(baseUrl + '/api/health')
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({
      message: 'Backend is running successfully!',
      project: '${name}'
    })
  })
})
`
  },
  typescript: {
    packageJson: (name) => ({
      name: `${name}-backend`,
      version: "0.1.0",
      main: "dist/server.js",
      scripts: {
        build: "tsc",
        start: "node dist/server.js",
        dev: "tsx --watch src/server.ts",
        test: "jest",
        "test:watch": "jest --watch",
        "test:coverage": "jest --coverage",
        "test:e2e": "jest --runInBand --testPathPattern=e2e"
      },
      dependencies: {
        express: "^4.18.2",
        cors: "^2.8.5",
        dotenv: "^16.3.1"
      },
      devDependencies: {
        "@types/express": "^4.17.21",
        "@types/cors": "^2.8.17",
        "@types/node": "^20.10.5",
        "@types/jest": "^29.5.8",
        "@types/supertest": "^2.0.16",
        jest: "^29.7.0",
        supertest: "^6.3.3",
        "ts-jest": "^29.1.1",
        typescript: "^5.3.3",
        tsx: "^4.6.2"
      }
    }),
    tsConfig: {
      compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "node",
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        strict: true,
        skipLibCheck: true,
        outDir: "dist",
        rootDir: "src"
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"]
    },
    serverTs: (name) => `import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ 
    message: 'Backend is running successfully!',
    project: '${name}',
    timestamp: new Date().toISOString()
  });
});

// Basic API routes
app.get('/api', (req: Request, res: Response) => {
  res.json({ message: 'Welcome to ${name} API' });
});

app.post('/api/echo', (req: Request, res: Response) => {
  res.status(201).json({ received: req.body || {} });
});

// Fallback for unknown routes
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 ${name} backend server running on http://0.0.0.0:' + PORT);
  });
}

export default app;`,
    e2eHttpTestTs: (name) => `import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import app from '../server'

describe('${name} E2E (HTTP)', () => {
  let server: any
  let baseUrl: string

  beforeAll(() => {
    server = app.listen(0)
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : null
    baseUrl = 'http://127.0.0.1:' + port
  })

  afterAll(() => {
    if (server) server.close()
  })

  test('responds to GET /api/health over the network', async () => {
    const response = await fetch(baseUrl + '/api/health')
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({
      message: 'Backend is running successfully!',
      project: '${name}'
    })
  })
})
`,
    envExample: `PORT=3000
NODE_ENV=development
# Add your environment variables here
DB_URL=your_database_url_here
SECRET_KEY=your_secret_key_here`,
    jestConfigTs: `export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/test/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  setupFilesAfterEnv: ['./src/test/setup.ts'],
  verbose: true,
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest'
  }
}`,
    serverTestTs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server'

describe('${name} Server', () => {
  test('creates an Express app instance', () => {
    expect(typeof app).toBe('function')
  })

  test('responds to the health check endpoint', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200)

    expect(response.body).toHaveProperty('message')
    expect(response.body).toHaveProperty('project', '${name}')
    expect(response.body).toHaveProperty('timestamp')
  })

  test('returns a JSON 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/nonexistent-route')
      .expect(404)

    expect(response.body).toHaveProperty('error', 'Route not found')
  })
})`,
    routesTestTs: `import { describe, test, expect } from '@jest/globals'

interface UserPayload {
  id?: number
  name: string
  email?: string
}

interface ApiResponse<T> {
  success: boolean
  data: T
  timestamp: string
}

const validateRequest = (data: UserPayload): data is Required<UserPayload> =>
  Boolean(data.name && data.email)

const normalizeUser = (user: UserPayload): Required<UserPayload> => ({
  id: user.id ?? 0,
  name: user.name.trim(),
  email: user.email ?? 'unknown@example.com'
})

const formatApiResponse = <T>(data: T, success = true): ApiResponse<T> => ({
  success,
  data,
  timestamp: new Date().toISOString()
})

describe('API helper examples', () => {
  test('validates request payloads', () => {
    expect(validateRequest({ name: 'Test', email: 'test@example.com' })).toBe(true)
    expect(validateRequest({ name: 'Test' })).toBe(false)
  })

  test('normalizes user records', () => {
    expect(normalizeUser({ name: '  Ada  ' })).toEqual({
      id: 0,
      name: 'Ada',
      email: 'unknown@example.com'
    })
  })

  test('formats API responses with metadata', () => {
    const response = formatApiResponse({ id: 1 })
    expect(response.success).toBe(true)
    expect(response.data).toEqual({ id: 1 })
    expect(response.timestamp).toEqual(expect.any(String))
  })
})`,
    setupTestsTs: `// Jest setup file for Express TypeScript backend
import { jest } from '@jest/globals'

// Mock environment variables for testing
process.env.NODE_ENV = 'test'
process.env.PORT = '0'

// Global test timeout
jest.setTimeout(10000)

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks()
})`,
    appTestTs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server'

describe('${name} Express App', () => {
  test('handles JSON payloads through /api/echo', async () => {
    const payload = { greeting: 'hello' }
    const response = await request(app)
      .post('/api/echo')
      .send(payload)
      .expect(201)

    expect(response.body).toEqual({ received: payload })
  })

  test('exposes CORS headers', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
      .expect(200)

    expect(response.headers['access-control-allow-origin']).toBe('*')
  })
})`,
    apiTestTs: (name) => `import request from 'supertest'
import { describe, test, expect } from '@jest/globals'
import app from '../server'

describe('${name} API Endpoints', () => {
  test('responds to GET /api/health', async () => {
    const response = await request(app)
      .get('/api/health')
      .expect(200)

    expect(response.body).toMatchObject({
      message: 'Backend is running successfully!',
      project: '${name}'
    })
  })

  test('responds to GET /api', async () => {
    const response = await request(app)
      .get('/api')
      .expect(200)

    expect(response.body).toHaveProperty('message')
  })

  test('echoes payloads via POST /api/echo', async () => {
    const payload = { hello: 'world' }
    const response = await request(app)
      .post('/api/echo')
      .send(payload)
      .expect(201)

    expect(response.body).toEqual({ received: payload })
  })
})`
  }
}
