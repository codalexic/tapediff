import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/unit/**/*.test.tsx',
      'test/e2e/**/*.test.ts',
    ],
    environment: 'node',
    // e2e tests spawn several processes; Windows CI runners can be slow.
    testTimeout: 30_000,
    globalSetup: ['test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
