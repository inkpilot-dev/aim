import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Main and preload are bundled to CommonJS (package.json has no "type":"module").
 * Workspace packages (@aim/shared, @aim/core) are bundled from their dist builds so the
 * main bundle is self-contained; native/heavy runtime deps stay external.
 */
const NATIVE_OR_RUNTIME_EXTERNALS = ['electron', 'better-sqlite3', 'ws', /^@nut-tree-fork\//, '@aim/tools-mcp'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@aim/shared', '@aim/core'] })],
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: NATIVE_OR_RUNTIME_EXTERNALS,
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
    resolve: { alias: { '@main': resolve(__dirname, 'src/main') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@aim/shared'] })],
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer') } },
  },
});
