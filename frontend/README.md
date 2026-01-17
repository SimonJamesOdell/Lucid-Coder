# LucidCoder frontend

The frontend is a React + Vite application that provides the UI for interacting with projects, goals, and agent workflows.

## Entry points

- App root: [frontend/src/App.jsx](frontend/src/App.jsx)
- Bootstrap: [frontend/src/main.jsx](frontend/src/main.jsx)

## Key folders

- Components: [frontend/src/components](frontend/src/components)
- Context providers: [frontend/src/context](frontend/src/context)
- API and socket services: [frontend/src/services](frontend/src/services)
- Styles: [frontend/src/styles](frontend/src/styles)
- Tests: [frontend/src/test](frontend/src/test)

## Dev server

The dev server runs on port 3000 and proxies API calls to http://localhost:5000 (see [frontend/vite.config.js](frontend/vite.config.js)).

## Scripts

- npm run start — start Vite dev server
- npm run build — build the frontend
- npm run test — run the frontend test suite
- npm run test:coverage — run coverage
