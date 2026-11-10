// Renders trailer.html frame by frame (deterministic seek) with parallel Chromium pages.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const FPS = 30, WORKERS = 4;
(async () => {
  const out = path.join(__dirname, 'frames'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const probe = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await probe.goto('file://' + path.join(__dirname, 'trailer.html')); await probe.waitForFunction(() => window.READY === true);
  const total = Math.round((await probe.evaluate(() => window.DURATION)) * FPS); await probe.close();
  let next = 0, done = 0; const t0 = Date.now();
  const worker = async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto('file://' + path.join(__dirname, 'trailer.html')); await page.waitForFunction(() => window.READY === true);
    for (;;) {
      const i = next++; if (i >= total) break;
      await page.evaluate((t) => window.seek(t), i / FPS);
      await page.screenshot({ path: path.join(out, `f${String(i).padStart(5, '0')}.png`) });
      if (++done % 300 === 0) console.log(`${done}/${total} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await page.close();
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  await browser.close();
  console.log(`rendered ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
