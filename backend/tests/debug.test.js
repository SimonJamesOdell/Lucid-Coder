import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;
let server;

describe.skip('Debug Backend Issues', () => {
  beforeAll(async () => {
    console.log('🔍 Starting debug tests...');
    console.log('Environment:', {
      NODE_ENV: process.env.NODE_ENV,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ? 'SET' : 'NOT SET'
    });
    
    // Initialize database first
    const { initializeDatabase } = await import('../database.js');
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    const serverModule = await import('../server.js');
    app = serverModule.app;
    server = serverModule.server;
    
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  test('Health check works', async () => {
    const response = await request(app).get('/api/health');
    
    console.log('Health response:', {
      status: response.status,
      body: response.body
    });
    
    expect(response.status).toBe(200);
  });

  test('LLM configure with detailed error', async () => {
    const validConfig = {
      provider: 'groq',
      apiKey: 'test-api-key-123',
      model: 'llama-3.1-70b-versatile',
      apiUrl: 'https://api.groq.com/openai/v1'
    };

    const response = await request(app)
      .post('/api/llm/configure')
      .send(validConfig);
    
    console.log('LLM configure response:', {
      status: response.status,
      body: response.body,
      error: response.error
    });
    
    if (response.status !== 200) {
      console.error('LLM configure failed with:', response.body);
    }
    
    expect(response.status).toBe(200);
  });

  test('Project creation with detailed error', async () => {
    const projectData = {
      name: `Debug Project ${Date.now()}`,
      description: 'Test project',
      frontend: {
        language: 'javascript',
        framework: 'react'
      },
      backend: {
        language: 'javascript',
        framework: 'express'
      }
    };

    const response = await request(app)
      .post('/api/projects')
      .send(projectData);
    
    console.log('Project creation response:', {
      status: response.status,
      body: response.body,
      error: response.error
    });
    
    if (response.status !== 201) {
      console.error('Project creation failed with:', response.body);
    }
    
    expect(response.status).toBe(201);
  });
});
