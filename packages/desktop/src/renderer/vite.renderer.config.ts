// Standalone Vite config for previewing the renderer in a plain browser (dev mock installs window.aim).
// The real build goes through electron.vite.config.ts at the package root.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  server: { port: 5190, strictPort: false, host: '127.0.0.1' },
  build: { outDir: '../../out/renderer-preview', emptyOutDir: true },
});
