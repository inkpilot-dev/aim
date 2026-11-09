#!/usr/bin/env node
/**
 * Make sure the Electron binary is present. Newer pnpm versions block install scripts unless approved,
 * so `node_modules/electron` can exist without its downloaded executable ("Electron uninstall").
 * Runs electron's own installer when path.txt is missing. Safe to run repeatedly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let electronDir;
try {
  electronDir = path.dirname(require.resolve('electron/package.json'));
} catch {
  console.error('[aim] electron is not installed. Run `pnpm install` first.');
  process.exit(1);
}
const pathTxt = path.join(electronDir, 'path.txt');
const present = fs.existsSync(pathTxt) && fs.existsSync(path.join(electronDir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim()));
if (present) process.exit(0);

console.log('[aim] Electron binary missing; downloading it now (one time)...');
const r = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit', cwd: electronDir });
if (r.status !== 0) {
  console.error('[aim] Electron download failed. Check your network, or run `pnpm approve-builds` and `pnpm install` again.');
  process.exit(r.status ?? 1);
}
console.log('[aim] Electron is ready.');
