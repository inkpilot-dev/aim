#!/usr/bin/env node
/**
 * Build the A.I.M. Browser Bridge into ./dist (a self-contained, loadable MV3 extension).
 *   node build.mjs           one-off build
 *   node build.mjs --watch   rebuild on change
 *
 * The source manifest at the package root references `dist/...` so the package folder itself is
 * also loadable; the copy written into dist/ has those prefixes stripped so dist/ stands alone.
 */
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const watch = process.argv.includes('--watch');

const sharedDist = join(here, '..', 'shared', 'dist', 'index.js');
if (!existsSync(sharedDist)) {
  console.error('[extension] @aim/shared is not built. Run `pnpm --filter @aim/shared build` first.');
  process.exit(1);
}
if (!existsSync(join(here, 'icons', 'icon128.png'))) {
  console.error('[extension] icons are missing. Run `node icons/generate-icons.mjs` first.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  target: ['chrome116'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const configs = [
  { ...common, entryPoints: [join(here, 'src/background.ts')], outfile: join(dist, 'background.js'), format: 'esm' },
  { ...common, entryPoints: [join(here, 'src/content.ts')], outfile: join(dist, 'content.js'), format: 'iife' },
  { ...common, entryPoints: [join(here, 'src/popup/popup.ts')], outfile: join(dist, 'popup.js'), format: 'iife' },
];

function copyStatic() {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  // The extension ships inside the desktop app and is versioned with it, so the app can tell when the
  // extension running in the browser is older than the one it carries (and ask it to reload itself).
  try {
    const appVersion = JSON.parse(readFileSync(join(here, '..', 'desktop', 'package.json'), 'utf8')).version;
    if (typeof appVersion === 'string' && /^\d+\.\d+\.\d+$/.test(appVersion)) manifest.version = appVersion;
  } catch {
    /* building the extension on its own: keep the manifest version */
  }
  const strip = (p) => (typeof p === 'string' ? p.replace(/^dist\//, '') : p);
  manifest.background.service_worker = strip(manifest.background.service_worker);
  for (const cs of manifest.content_scripts ?? []) cs.js = cs.js.map(strip);
  if (manifest.action?.default_popup) manifest.action.default_popup = strip(manifest.action.default_popup);
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  cpSync(join(here, 'src/popup/popup.html'), join(dist, 'popup.html'));
  cpSync(join(here, 'src/popup/popup.css'), join(dist, 'popup.css'));
  mkdirSync(join(dist, 'icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) cpSync(join(here, 'icons', `icon${size}.png`), join(dist, 'icons', `icon${size}.png`));
  console.log('[extension] static files copied');
}

if (watch) {
  const contexts = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  copyStatic();
  console.log('[extension] watching for changes…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  copyStatic();
  console.log(`[extension] built into ${dist}`);
}
