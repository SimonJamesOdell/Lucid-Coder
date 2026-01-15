# LucidCoder Fullstack App

A minimal fullstack application built with React + Vite for the frontend and Node.js + Express for the backend.

## Project Structure

```
lucidcoder/
├── frontend/          # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── index.css
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── backend/           # Node.js + Express backend
│   ├── server.js
│   ├── package.json
│   └── .env
└── package.json       # Root package.json with dev scripts
```

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- npm

### Installation

1. Install all dependencies for both frontend and backend:
```bash
npm run install-all
```

### Development

1. Start both frontend and backend in development mode:
```bash
npm run dev
```

This will start:
- Backend server on http://localhost:5000
- Frontend development server on http://localhost:3000

### Individual Services

- **Frontend only**: `npm run frontend` (runs `frontend`'s `npm run start`)
- **Backend only**: `npm run backend` (runs `backend`'s `npm run start`)

### Production Build

```bash
npm run build
```

### Database Storage & Testing

- Backend development writes to `backend/lucidcoder.db` by default. Delete it if you want a clean slate; a new one will be recreated on next start.
- Backend tests always run against `backend/test-lucidcoder.db`, enforced via `cross-env`, and the file is removed before/after the suite. This keeps user-created projects such as LSML Composer intact.
- If you need a different location, set `DATABASE_PATH` before launching the backend or a custom test command; relative paths are resolved from `backend/`.

## API Endpoints

- `GET /api/health` - Health check endpoint
- `GET /api/data` - Get sample data
- `POST /api/data` - Create new item

## Features

- ✅ React 18 with Vite for fast development
- ✅ Express.js REST API
- ✅ CORS enabled for frontend-backend communication
- ✅ Proxy configuration for API calls
- ✅ Environment variable support
- ✅ Hot reload for both frontend and backend
- ✅ Responsive design with light/dark mode support
- ✅ Basic form handling and data fetching

## Tech Stack

**Frontend:**
- React 18
- Vite
- Axios for API calls
- CSS3 with custom properties

**Backend:**
- Node.js
- Express.js
- CORS middleware
- dotenv for environment variables

**Development:**
- Nodemon for backend hot reload
- Concurrently to run both services
- ESLint for code linting