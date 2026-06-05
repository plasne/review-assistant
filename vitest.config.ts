import { defineConfig } from 'vitest/config';
import os from 'node:os';

export default defineConfig({
  server: {
    fs: {
      allow: [os.tmpdir()]
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    testTimeout: 10000
  }
});
