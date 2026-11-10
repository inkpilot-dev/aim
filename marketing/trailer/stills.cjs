const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const times = process.argv.slice(2).map(Number);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('file://' + path.join(__dirname, 'trailer.html'));
  await page.waitForFunction(() => window.READY === true);
  for (const t of times) { await page.evaluate((x) => window.seek(x), t); await page.screenshot({ path: path.join(__dirname, 'out', `still-${String(t).replace('.', '_')}.jpg`), type: 'jpeg', quality: 80 }); }
  await browser.close();
  console.log('stills', times.length, 'errors', errs.length, errs.slice(0, 3).join(' | '));
})();
