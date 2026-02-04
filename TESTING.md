# LucidCoder Testing Guide

## Overview
This project includes comprehensive testing coverage for both frontend and backend components, providing robust validation of all established functionality.

## Test Structure

### Backend Tests (`backend/tests/`, `backend/test/`)
- **Route/API tests** - REST endpoint coverage (including contract-style tests)
- **Database tests** - Database operations and data integrity
- **Service/unit tests** - Core orchestration, git, import compatibility, and job handling

### Frontend Tests (`frontend/src/test/`)
- **Component Tests** - Individual React component testing
  - `Navigation.test.jsx` - Navigation component and dropdown functionality
  - `GettingStarted.test.jsx` - LLM configuration interface
- **Context Tests** (`AppStateContext.test.jsx`) - State management and persistence
- **Integration Tests** (`Integration.test.jsx`) - End-to-end user workflows

## Running Tests

### Quick Start
```powershell
# Run all tests
./run-tests.ps1

# Faster local loop (frontend + backend unit-only)
npm run test:quick

# Release sanity checks (recommended before tagging a release)
npm run release:check
npm test
npm run e2e

# Single-command local release gate
npm run release:gate

# Run tests via npm scripts from repo root
npm test
npm run test:frontend
npm run test:backend

# Force reinstall dependencies (slower, but ensures a clean install)
./run-tests.ps1 -ForceInstall

# Generate coverage reports
./coverage-report.ps1
```

### Browser E2E (Playwright)
```powershell
# One-time: install browser binaries
npm run e2e:install

# Run E2E smoke tests (starts backend + frontend automatically)
npm run e2e

# Run the long-batch, cross-browser full suite
npm run e2e:full

# If you often hit "port already used" failures, use the clean wrapper
npm run e2e:clean-run

# Clean wrapper for the long-batch full suite
npm run e2e:full:clean-run

# Repeat clean E2E runs to detect flakes (fails fast)
npm run e2e:flake-check
npm run e2e:flake-check:smoke

# Helpful modes
npm run e2e:ui
npm run e2e:headed
npm run e2e:debug
```

Notes:
- E2E uses a dedicated SQLite DB at `backend/e2e-lucidcoder.db` (deleted before each run). Override via `E2E_DB_PATH`.
- E2E defaults to frontend `http://localhost:3100` and backend `http://localhost:5100` to avoid colliding with dev servers.
- Server reuse is **opt-in only**: set `E2E_REUSE_SERVER=1` to reuse already-running E2E servers.
- You can explicitly point to running servers via `E2E_FRONTEND_URL` / `E2E_BACKEND_URL`.

### E2E isolation (important)
Playwright E2E tests create real projects, goals, and settings in the backend database. To prevent polluting your local dev database:

- E2E runs the backend with `DATABASE_PATH` set to `E2E_DB_PATH` (defaults to `backend/e2e-lucidcoder.db`).
- E2E runs the frontend with a proxy target pointing at the E2E backend (port 5100).
- The E2E bootstrap refuses to write LLM config unless backend diagnostics confirm the backend is using the expected E2E DB path.

If you want to reuse servers (faster local loop):
```powershell
$env:E2E_REUSE_SERVER = '1'
npm run e2e
```

### Individual Test Suites

#### Backend Tests
```bash
cd backend
npm test                    # Run all backend tests
npm run test:watch         # Run tests in watch mode
npm run test:coverage      # Generate coverage report

# Shardable helpers
npm run test:unit
npm run test:parallel
npm run test:integration-only
```

#### Frontend Tests
```bash
cd frontend
npm test                    # Run all frontend tests
npm run test:ui            # Run tests with UI
npm run test:coverage      # Generate coverage report
```

## Test Coverage

### Backend Coverage
- ✅ **API Endpoints** - All REST API routes (/api/llm/*, /api/projects/*)
- ✅ **Database Operations** - CRUD operations, encryption, data integrity
- ✅ **LLM Integrations** - 12+ provider support, payload formatting, response parsing
- ✅ **Error Handling** - Network errors, API failures, validation errors
- ✅ **Authentication** - API key validation, secure storage

### Frontend Coverage
- ✅ **Component Rendering** - All React components render correctly
- ✅ **User Interactions** - Click handlers, form submissions, dropdown navigation
- ✅ **State Management** - Context providers, localStorage persistence
- ✅ **API Integration** - HTTP requests, error handling, loading states
- ✅ **Configuration Flow** - Complete LLM setup workflow
- ✅ **Project Management** - Create, select, import projects
- ✅ **Theme System** - Dark/light mode switching

### Integration Coverage
- ✅ **Complete Workflows** - End-to-end user journeys
- ✅ **State Persistence** - localStorage and app state synchronization
- ✅ **Error Recovery** - Graceful handling of failures
- ✅ **Provider Switching** - Dynamic model updates, validation
- ✅ **Cross-Component Communication** - Context updates, UI reactions

## Test Technologies

### Backend Testing Stack
- **Vitest** - Test framework (unit/integration/parallel configs)
- **Supertest** - HTTP assertion library for API testing
- **SQLite** - In-memory database for isolated testing
- **Mocks** - Axios mocking for external API calls

### Frontend Testing Stack
- **Vitest** - Fast Vite-native test runner
- **React Testing Library** - Component testing utilities
- **Jest DOM** - Custom Jest matchers for DOM testing
- **User Events** - Realistic user interaction simulation
- **JSDOM** - Browser environment simulation

## Test Data & Mocking

### Mock Data
- **LLM Configurations** - Valid/invalid provider configs
- **API Responses** - Success/error response patterns
- **Project Data** - Sample project structures
- **User Interactions** - Simulated clicks, typing, form submissions

### Environment Setup
- **Isolated Testing** - Each test runs in clean environment
- **LocalStorage Mocking** - Persistent state simulation
- **Network Mocking** - Controlled API response testing
- **Error Simulation** - Network failures, API errors

## Continuous Integration

### Test Automation
The test suite is designed for CI/CD integration, but this repo can also be run as **local-only** (recommended while GitHub Actions is unavailable):

```yaml
# Example CI configuration
test:
  script:
    - ./run-tests.ps1
  coverage:
    - backend/coverage/
    - frontend/coverage/
```

### Coverage Thresholds
- **Statements**: 100%
- **Branches**: 100%
- **Functions**: 100%
- **Lines**: 100%

## Debugging Tests

### Common Issues
1. **Port Conflicts** - Tests use isolated ports (5001, 3001)
2. **Database Locks** - Tests clean up SQLite connections
3. **Async Operations** - waitFor() used for async state updates
4. **Mock Cleanup** - Mocks reset between tests

Update:
- E2E ports are `5100` (backend) and `3100` (frontend).
- If you see E2E projects/settings showing up in your normal app, double-check you did not run E2E against a non-E2E backend (or reuse a server pointing at your real DB).

## Cleaning up accidental E2E projects
If E2E projects ended up in your local DB (they typically have names starting with `E2E `), you can safely remove them with:

```powershell
# Dry run (shows what would be deleted)
node backend/scripts/purge-e2e-projects.mjs

# Apply deletions
node backend/scripts/purge-e2e-projects.mjs --apply
```

To target a specific DB file, set `DATABASE_PATH`:
```powershell
$env:DATABASE_PATH = "$env:LOCALAPPDATA\LucidCoder\lucidcoder.db"
node backend/scripts/purge-e2e-projects.mjs --apply
```

### Debug Commands
```bash
# Backend debugging
cd backend
npm run test:watch --verbose

# Frontend debugging  
cd frontend
npm run test:ui
```

## Adding New Tests

### Backend Test Pattern
```javascript
describe('New Feature', () => {
  beforeEach(async () => {
    // Setup test database
    await initializeDatabase();
  });

  test('should handle new functionality', async () => {
    const response = await request(app)
      .post('/api/new-endpoint')
      .send(testData)
      .expect(200);
    
    expect(response.body).toHaveProperty('success', true);
  });
});
```

### Frontend Test Pattern
```javascript
describe('New Component', () => {
  test('renders and handles interaction', async () => {
    const user = userEvent.setup();
    
    render(
      <TestWrapper>
        <NewComponent />
      </TestWrapper>
    );
    
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('Expected Result')).toBeInTheDocument();
  });
});
```

## Performance Testing

### Load Testing
- API endpoint stress testing
- Database query performance
- Memory leak detection
- Concurrent user simulation

### Metrics
- Response times < 100ms (local operations)
- Database queries < 50ms
- UI interactions < 16ms (60fps)
- Memory usage stable over time

---

**Total Test Count**: 100+ tests across all suites  
**Coverage Target**: 100% across all metrics  
**Test Execution Time**: ~30 seconds full suite