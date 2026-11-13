// Live recovery test against the real app (build first: pnpm --filter @aim/desktop build).
// Run: node packages/desktop/test/recovery-e2e.cjs   (on Linux without a display: xvfb-run -a node …)
// Crashes the interface process three times (reload → safe mode → recovery screen), uses "Try again",
// feeds a malformed message, and checks the failures reach aim.log.
// After a renderer crash Playwright's page handle is dead, so the
// window is driven through the main process (webContents.executeJavaScript) instead.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Scratch user-data folder; screenshots land there too.
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-recovery-'));
fs.mkdirSync(path.join(S, 'userdata'), { recursive: true });
fs.writeFileSync(path.join(S, 'userdata', 'settings.json'), JSON.stringify({ observerEnabled: false, dailyGoalsEnabled: false, launchAtLogin: false, updatesEnabled: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, AIM_USER_DATA: path.join(S, 'userdata'), NODE_OPTIONS: '' },
    cwd: path.join(__dirname, '..'),
  });
  await app.firstWindow();
  const js = (code) =>
    app.evaluate(async ({ BrowserWindow }, c) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'A.I.M. cursor');
      try { return await w.webContents.executeJavaScript(c, true); } catch (e) { return `__err ${e.message}`; }
    }, code);
  const url = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'A.I.M. cursor').webContents.getURL());
  const uiUp = async (timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if ((await js("!!document.querySelector('.sb-new')")) === true) return true; await sleep(300); }
    return false;
  };
  const text = () => js('document.body ? document.body.innerText : ""');
  const crash = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'A.I.M. cursor').webContents.forcefullyCrashRenderer());
  const shot = async (name) => { const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'A.I.M. cursor').webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(path.join(S, name), Buffer.from(b64, 'base64')); };

  try {
    check('interface starts and signals ready', await uiUp());
    await crash(); await sleep(1500);
    check('recovers by itself after the interface process crashes', await uiUp());
    await sleep(500); await crash(); await sleep(1500);
    check('second failure reloads in safe mode', (await uiUp()) && /interface failure 2/.test(fs.readFileSync(path.join(S, 'userdata', 'logs', 'aim.log'), 'utf8')));
    await sleep(500); await crash(); await sleep(2500);
    const rec = String(await text());
    check('third failure shows the recovery screen', /hit a problem showing its window/.test(rec), rec.slice(0, 70).replace(/\s+/g, ' '));
    await shot('recovery-screen.png');
    await js("document.querySelector('a.btn.primary').click()");
    check('"Try again" brings the interface back', await uiUp());

    await js("document.querySelector('.sb-new').click()"); await sleep(600);
    const chatId = await js("window.aim.createChat({}).then(c => c.id)");
    await js(`window.aim.sendMessage({ chatId: ${JSON.stringify(chatId)}, text: 'Hello AIM' })`);
    await js(`(async () => { /* open the chat in the UI */ })()`);
    await app.evaluate(({ BrowserWindow }, id) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('aim:event:chat', { type: 'message.start', chatId: id, message: { id: 'bad1', chatId: id, role: 'assistant', createdAt: Date.now(), content: [{ type: 'tool_use', id: 'x', name: 12345, input: null }] } });
    }, chatId);
    await sleep(900);
    const after = String(await text());
    check('a malformed message cannot take the window down', after.includes('New chat'), after.includes('could not be displayed') ? 'that message was replaced by a notice' : 'rendered without error');
    await shot('after-bad-message.png');
    const logText = fs.readFileSync(path.join(S, 'userdata', 'logs', 'aim.log'), 'utf8');
    check('failures are written to aim.log', /interface failure 1: The interface process stopped/.test(logText));
  } finally {
    await app.close().catch(() => undefined);
    console.log(results.join('\n'));
    if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
  }
})().catch((e) => { console.error('RECOVERY_E2E_FAIL', e.message); process.exit(1); });
