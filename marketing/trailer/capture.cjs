// Captures the real A.I.M. interface (mock backend) at 2x for use as trailer footage.
const { chromium } = require('playwright');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [
  ['home', '?chat=none'],
  ['chat', '?chat=first'],
  ['goals', '?view=goals'],
  ['memory', '?view=memory'],
];
(async () => {
  const browser = await chromium.launch();
  for (const [name, q] of shots) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:5190/' + q, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await sleep(900);
    if (name === 'chat') { await page.evaluate(() => { const el = document.querySelector('.message-scroll'); if (el) el.scrollTop = 0; }); await sleep(200); }
    await page.screenshot({ path: path.join(__dirname, 'shots', name + '.png') });
    await ctx.close();
  }
  await browser.close();
  console.log('captured', shots.length);
})().catch((e) => { console.error(e); process.exit(1); });
