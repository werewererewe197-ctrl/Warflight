import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.js'], environment: 'node', testTimeout: 60000 } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.js'], environment: 'node', testTimeout: 60000, hookTimeout: 30000, fileParallelism: false } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.js'], environment: 'node', testTimeout: 120000, hookTimeout: 60000, fileParallelism: false } },
    ],
  },
});
