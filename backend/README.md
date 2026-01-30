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
- SQLite default location: per-user application data directory (platform-specific). The backend logs the resolved path on startup.
- `DATABASE_PATH` — SQLite file path override (absolute or relative to the process working directory)
- `LUCIDCODER_DB_DIR` — SQLite base directory override (absolute or relative to the process working directory)
- `ENABLE_SOCKET_IO` — set to false to disable Socket.IO
- `ENCRYPTION_KEY` — optional override for the backend encryption key. When unset, the backend generates a strong key on first run and stores it in the OS keychain (desktop builds). Production builds refuse to start if the key is missing or set to a placeholder value.
- LLM settings (provider, API URL, model, API key) used by the LLM client

## Scripts

- npm run start — start the backend with nodemon
- npm test — run unit, parallel, and integration suites
- npm run test:coverage — run coverage suites

## Testing notes

Tests run against backend/test-lucidcoder.db by default (see scripts in [backend/package.json](backend/package.json)).
