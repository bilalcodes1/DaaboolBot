import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    clearMocks: true,
    // Bound local workerd/SQLite contention; keep the existing timeout and every test intact.
    maxWorkers: 2,
  },
});
