import { defineConfig } from 'vitest/config';
// Generous timeouts: the SQLite-backed tests are slow on CI Windows runners.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 } });
