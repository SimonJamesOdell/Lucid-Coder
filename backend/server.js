import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'node:fs';
import { initializeDatabase } from './database.js';
import { llmClient } from './llm-client.js';
import llmRoutes from './routes/llm.js';
import projectRoutes from './routes/projects.js';
import branchRoutes from './routes/branches.js';
import commitRoutes from './routes/commits.js';
import testsRoutes from './routes/tests.js';
import settingsRoutes from './routes/settings.js';
import jobRoutes from './routes/jobs.js';
import goalsRoutes from './routes/goals.js';
import agentRoutes from './routes/agent.js';
import { createPreviewProxy } from './routes/previewProxy.js';
import { attachSocketServer } from './socket/createSocketServer.js';
import { auditHttpRequestsMiddleware } from './services/auditLog.js';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const resolvePort = () => process.env.PORT || 5000;

const PROVIDERS_WITHOUT_API_KEY = new Set(['ollama', 'lmstudio', 'textgen']);

const isProviderWithoutKey = (provider) => PROVIDERS_WITHOUT_API_KEY.has(String(provider || '').toLowerCase());

const getLlmReadinessSnapshot = () => {
  const config = llmClient?.config;

  if (!config) {
    return {
      configured: false,
      ready: false,
      reason: 'No LLM configuration found'
    };
  }

  const providerWithoutKey = isProviderWithoutKey(config.provider);
  const requiresApiKey = !providerWithoutKey;

  const hasApiUrl = typeof config.api_url === 'string' && config.api_url.trim().length > 0;
  const hasModel = typeof config.model === 'string' && config.model.trim().length > 0;

  let apiKeyOk = !requiresApiKey;
  let reason = null;

  if (requiresApiKey) {
    if (!config.api_key_encrypted) {
      apiKeyOk = false;
      reason = 'Missing API key';
    } else {
      apiKeyOk = Boolean(llmClient?.apiKey);
      if (!apiKeyOk) {
        reason = 'Failed to decrypt API key';
      }
    }
  }

  const ready = Boolean(hasApiUrl && hasModel && apiKeyOk);
  if (ready) {
    return { configured: true, ready: true, reason: null };
  }

  return {
    configured: true,
    ready: false,
    reason: reason || (!hasApiUrl ? 'Missing API URL' : 'Missing model')
  };
};

const requireLlmReady = (req, res, next) => {
  const snapshot = getLlmReadinessSnapshot();
  if (snapshot.ready) {
    next();
    return;
  }

  res.status(503).json({
    success: false,
    error: 'LLM is not configured',
    configured: snapshot.configured,
    ready: snapshot.ready,
    reason: snapshot.reason
  });
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Append-only audit logging for mutating API requests.
app.use(auditHttpRequestsMiddleware());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ 
    message: 'Backend server is running!', 
    timestamp: new Date().toISOString(),
    database: 'connected',
    llm: llmClient.config ? 'configured' : 'not configured'
  });
});

const readJsonFile = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));
const readTextFile = (filePath) => readFileSync(filePath, 'utf8');

// Version info route
app.get('/api/version', (req, res) => {
  try {
    const repoRoot = path.resolve(__dirname, '..');

    const versionFile = readTextFile(path.join(repoRoot, 'VERSION')).trim();
    const rootPackage = readJsonFile(path.join(repoRoot, 'package.json'));
    const backendPackage = readJsonFile(path.join(__dirname, 'package.json'));
    const frontendPackage = readJsonFile(path.join(repoRoot, 'frontend', 'package.json'));

    res.json({
      success: true,
      version: versionFile,
      versionFile,
      root: {
        name: rootPackage.name,
        version: rootPackage.version
      },
      backend: {
        name: backendPackage.name,
        version: backendPackage.version
      },
      frontend: {
        name: frontendPackage.name,
        version: frontendPackage.version
      }
    });
  } catch (error) {
    console.error('❌ Version endpoint failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load version information'
    });
  }
});

// Routes
app.use('/api/llm', llmRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/branches', branchRoutes);
app.use('/api/projects/:projectId/commits', commitRoutes);
app.use('/api/projects/:projectId/tests', testsRoutes);
app.use('/api/projects/:projectId/jobs', jobRoutes);
app.use('/api/settings', settingsRoutes);
app.use(
  '/api/goals',
  (req, res, next) => {
    if (req.method !== 'POST') {
      return next();
    }

    const target = req.path;
    if (target === '/' || target === '' || target === '/plan' || target === '/plan-from-prompt') {
      return requireLlmReady(req, res, next);
    }

    return next();
  },
  goalsRoutes
);

app.use(
  '/api/agent',
  (req, res, next) => {
    if (req.method === 'POST' && req.path === '/request') {
      return requireLlmReady(req, res, next);
    }

    return next();
  },
  agentRoutes
);

const previewProxy = createPreviewProxy({ logger: console });
app.use(previewProxy.middleware);

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  
  // Handle JSON parsing errors
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON format'
    });
  }
  
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Initialize database and start server
const startServer = async () => {
  try {
    console.log('🔧 Initializing database...');
    await initializeDatabase();
    
    // Initialize LLM client
    await llmClient.initialize();
    
    // Start server
    const port = resolvePort();

    const server = http.createServer(app);
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use. Another backend instance is likely running.`);
        console.error('   Refusing to start a second backend process.');
        process.exit(1);
      }

      console.error('❌ Server failed to start:', err);
      process.exit(1);
    });

    previewProxy.registerUpgradeHandler(server);

    server.listen(port, () => {
      console.log(`🚀 Server is running on http://localhost:${port}`);
      console.log(`📊 Health check: http://localhost:${port}/api/health`);
      console.log(`🤖 LLM API: http://localhost:${port}/api/llm`);
    });

    const socketIoEnabled = process.env.ENABLE_SOCKET_IO !== 'false';
    if (socketIoEnabled && typeof server?.on === 'function') {
      const io = attachSocketServer(server);
      app.set('io', io);
    }
    
    return server;
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Server terminated');
  process.exit(0);
});

// Export for testing
export { app, startServer };

// Start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  startServer().then(server => {
    // Server started successfully
  }).catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}