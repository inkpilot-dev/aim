import { defineConfig } from 'vitest/config';

// Node environment by default (main-process tests). Renderer tests can opt into jsdom with a
// `// @vitest-environment jsdom` header comment.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
