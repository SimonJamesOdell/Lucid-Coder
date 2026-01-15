# LucidCoder Testing Guide

## Overview
This project includes comprehensive testing coverage for both frontend and backend components, providing robust validation of all established functionality.

## Test Structure

### Backend Tests (`backend/tests/`)
- **API Tests** (`api.test.js`) - Integration tests for all API endpoints
- **Database Tests** (`database.test.js`) - Database operations and data integrity
- **LLM Client Tests** (`llm-client.test.js`) - LLM provider integrations and API calls

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

# Force reinstall dependencies (slower, but ensures a clean install)
./run-tests.ps1 -ForceInstall

# Generate coverage reports
./coverage-report.ps1
```

### Individual Test Suites

#### Backend Tests
```bash
cd backend
npm test                    # Run all backend tests
npm run test:watch         # Run tests in watch mode
npm run test:coverage      # Generate coverage report
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
- **Jest** - Test framework with ES modules support
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
The test suite is designed for CI/CD integration:

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
- **Statements**: 90%+
- **Branches**: 85%+  
- **Functions**: 90%+
- **Lines**: 90%+

## Debugging Tests

### Common Issues
1. **Port Conflicts** - Tests use isolated ports (5001, 3001)
2. **Database Locks** - Tests clean up SQLite connections
3. **Async Operations** - waitFor() used for async state updates
4. **Mock Cleanup** - Mocks reset between tests

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
**Coverage Target**: 90%+ across all metrics  
**Test Execution Time**: ~30 seconds full suite