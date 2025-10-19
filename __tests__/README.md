# Test Suite Documentation

## Overview

Production-ready test suite for MCP SearXNG Server. Tests are organized into unit tests (8 files), integration tests (2 files), and shared helpers (4 files).

## Running Tests

```bash
npm test                    # Run all tests
npm run test:coverage       # Run with coverage report
npm run test:watch          # Watch mode (auto-rerun)
npx tsx __tests__/unit/logging.test.ts  # Run single test file
```

**Note**: Tests automatically set `SEARXNG_URL=https://test-searx.example.com` for testing purposes.

## Key Testing Patterns

### Mock External Dependencies
```typescript
const fetchMocker = new FetchMocker();
fetchMocker.mock(createMockFetch({ json: { results: [] } }));
// ... test code ...
fetchMocker.restore();
```

### Manage Environment Variables
```typescript
const envManager = new EnvManager();
envManager.set('SEARXNG_URL', 'https://test.com');
// ... test code ...
envManager.restore();
```

### Test Error Handling
```typescript
await testFunction('Error scenario', async () => {
  try {
    await functionThatShouldFail();
    assert.fail('Should have thrown error');
  } catch (error: any) {
    assert.ok(error.message.includes('Expected error'));
  }
}, results);
```

## Adding New Tests

Create test file following pattern `[module-name].test.ts`:

```typescript
#!/usr/bin/env tsx
import { strict as assert } from 'node:assert';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';

const results = createTestResults();

async function runTests() {
  console.log('🧪 Testing: [module-name]\n');

  await testFunction('Test case 1', () => {
    // Test implementation
  }, results);

  printTestSummary(results, '[Module Name]');
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
```

Then add to `__tests__/run-all.ts` test runner.
