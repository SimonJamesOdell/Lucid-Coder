# Project overview

LucidCoder is a fullstack system for coordinating goal-driven coding workflows. The frontend delivers a React-based experience, while the backend provides REST and Socket.IO APIs for projects, goals, agent orchestration, and test execution.

Roadmap:
- 0.3.x hardening plan: [ROADMAP_0.3.x.md](ROADMAP_0.3.x.md)

## System at a glance

- Frontend: React + Vite UI in [frontend](frontend)
- Backend: Express + Socket.IO server in [backend](backend)
- Storage: SQLite managed by the backend database layer in [backend/database.js](backend/database.js)
- LLM integration: handled by [backend/llm-client.js](backend/llm-client.js) and routed via [backend/routes/llm.js](backend/routes/llm.js)

## Runtime flow

1. The UI issues API requests to `/api/*` and subscribes to Socket.IO events (see [frontend/vite.config.js](frontend/vite.config.js)).
2. The backend routes requests through Express in [backend/server.js](backend/server.js).
3. Feature-specific endpoints live under [backend/routes](backend/routes) and delegate to service modules in [backend/services](backend/services).
4. Long-running workflows (agent requests, goals, jobs) are coordinated in services such as [backend/services/agentAutopilot.js](backend/services/agentAutopilot.js), [backend/services/goalLifecycle.js](backend/services/goalLifecycle.js), and [backend/services/jobRunner.js](backend/services/jobRunner.js).
5. Persistence is handled via SQLite and helper modules in [backend/database.js](backend/database.js).
6. Realtime updates are broadcast through Socket.IO in [backend/socket](backend/socket).

## Backend structure

- Entry point: [backend/server.js](backend/server.js)
- Routes: [backend/routes](backend/routes)
- Services and orchestration: [backend/services](backend/services)
- Database and encryption: [backend/database.js](backend/database.js), [backend/encryption.js](backend/encryption.js)
- Socket.IO server: [backend/socket](backend/socket)
- Tests: [backend/test](backend/test)

## Frontend structure

- Entry point: [frontend/src/main.jsx](frontend/src/main.jsx)
- App root: [frontend/src/App.jsx](frontend/src/App.jsx)
- Context providers: [frontend/src/context](frontend/src/context)
- UI components: [frontend/src/components](frontend/src/components)
- API and socket services: [frontend/src/services](frontend/src/services)
- Tests: [frontend/src/test](frontend/src/test)

## Testing strategy

- Backend unit, parallel, and integration suites live in [backend/test](backend/test) and are orchestrated by scripts in [backend/package.json](backend/package.json).
- Frontend tests are in [frontend/src/test](frontend/src/test) and run via Vitest.

## Extending the system

- Add new REST endpoints by introducing a route module in [backend/routes](backend/routes) and a corresponding service in [backend/services](backend/services).
- Introduce new UI features by extending components and context state in [frontend/src](frontend/src).
