# LucidCoder backend

The backend is an Express + Socket.IO API server responsible for project orchestration, goal planning, agent workflows, and persistence.

## Entry points

- Server: [backend/server.js](backend/server.js)
- LLM client: [backend/llm-client.js](backend/llm-client.js)
- Database: [backend/database.js](backend/database.js)

## Key folders

- Routes: [backend/routes](backend/routes)
- Services: [backend/services](backend/services)
- Socket.IO server: [backend/socket](backend/socket)
- Utilities: [backend/utils](backend/utils)
- Tests: [backend/test](backend/test)

## Environment configuration

Environment variables are loaded from [backend/.env](backend/.env).

Common variables:
- `PORT` — server port (default 5000)
- `DATABASE_PATH` — SQLite path (defaults to backend/lucidcoder.db)
- `ENABLE_SOCKET_IO` — set to false to disable Socket.IO
- LLM settings (provider, API URL, model, API key) used by the LLM client

## Scripts

- npm run start — start the backend with nodemon
- npm test — run unit, parallel, and integration suites
- npm run test:coverage — run coverage suites

## Testing notes

Tests run against backend/test-lucidcoder.db by default (see scripts in [backend/package.json](backend/package.json)).
