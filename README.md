# LucidCoder

Version: 0.4.9
LucidCoder is a fullstack system for orchestrating goal-driven coding workflows. The frontend provides a rich React UI and the backend exposes REST and Socket.IO APIs for projects, goals, agents, and test execution.

This project is a work in progress. Core functionality is in place, but many features and improvements are still planned. If you’re interested, please join in development and share updates, ideas, and contributions so we can evolve it together.

## Quick start

Prerequisites:
- Node.js 18+
- npm

Install dependencies:
- npm run install-all

Start dev servers:
- npm run dev

Default endpoints:
- Backend API: http://localhost:5000
- Frontend dev server: http://localhost:3000

## Repository layout

- frontend/ — React + Vite UI
- backend/ — Express + Socket.IO API server, services, and storage
- docs/ — architecture and versioning notes
- tools/ — repo utilities

## Scripts

- npm run dev — run frontend + backend
- npm run frontend — run frontend only
- npm run backend — run backend only
- npm run test:backend — backend test suite
- npm run test:frontend — frontend test suite
- npm run test:e2e — end-to-end tests via PowerShell

## Configuration

Backend reads environment variables from [backend/.env](backend/.env). For LLM-backed features, configure provider, API URL, model, and API key. Socket.IO can be disabled with `ENABLE_SOCKET_IO=false`. For desktop builds, the backend generates and stores an encryption key in the OS keychain if `ENCRYPTION_KEY` is not set.

Database defaults to a per-user application data directory (platform-specific). You can override with `DATABASE_PATH` (full file path) or `LUCIDCODER_DB_DIR` (base directory). If you previously used a repo-local DB under backend/, the backend will do a best-effort one-time copy into the new default location.

Tests use backend/test-lucidcoder.db by default (also controllable via `DATABASE_PATH`).

## Documentation

- Project overview: [docs/OVERVIEW.md](docs/OVERVIEW.md)
- 0.3.x roadmap: [docs/ROADMAP_0.3.x.md](docs/ROADMAP_0.3.x.md)
- Versioning policy: [docs/VERSIONING.md](docs/VERSIONING.md)
- Backend details: [backend/README.md](backend/README.md)
- Frontend details: [frontend/README.md](frontend/README.md)

## License

MIT
