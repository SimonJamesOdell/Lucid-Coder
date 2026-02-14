# LucidCoder

## Important notice

This project is 100% code-generated and maintained by AI.

The project owner has not inspected and will not be manually inspecting the code, and cannot answer questions about the implementation details.

This software is released as-is, with no express or implied warranty, including fitness for any particular purpose.

This repository is intended as a proof of concept and proof of principle for fully AI-generated complex application development.

If you want to understand the system and its contents, it is strongly recommended to use an LLM to inspect the codebase.

Human manual processes for understanding the code are not recommended, because any part of the codebase has a non-zero probability of being removed, heavily modified, or replaced in any future release.

Version: 0.6.6

Version is managed by `npm run release -- <semver>` and mirrored in [VERSION](VERSION).
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
- npm run test:quick — fast local loop (frontend + backend unit-only)
- npm run e2e — end-to-end tests (Playwright)
- npm run e2e:flake-check — repeat clean E2E runs to detect flakes
- npm run release -- <semver> — update all version artifacts via the release tool

## Configuration

Backend reads environment variables from [backend/.env](backend/.env). For LLM-backed features, configure provider, API URL, model, and API key. Socket.IO can be disabled with `ENABLE_SOCKET_IO=false`. For desktop builds, the backend generates and stores an encryption key in the OS keychain if `ENCRYPTION_KEY` is not set.

Database defaults to a per-user application data directory (platform-specific). You can override with `DATABASE_PATH` (full file path) or `LUCIDCODER_DB_DIR` (base directory). If you previously used a repo-local DB under backend/, the backend will do a best-effort one-time copy into the new default location.

Tests use backend/test-lucidcoder.db by default (also controllable via `DATABASE_PATH`).

## Documentation

- Project overview: [docs/OVERVIEW.md](docs/OVERVIEW.md)
- Versioning policy: [docs/VERSIONING.md](docs/VERSIONING.md)
- Release process: [RELEASE.md](RELEASE.md)
- Backend details: [backend/README.md](backend/README.md)
- Frontend details: [frontend/README.md](frontend/README.md)

## License

MIT
