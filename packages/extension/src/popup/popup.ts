/** Popup UI — pairing, connection status, A.I.M. tab management. Talks only to the background worker. */
import { HUB_DEFAULT_PORT } from '@aim/shared';
import type { FromPopupMessage, StatusReport, TestResult } from '../messages.js';
import { STORAGE_KEYS } from '../messages.js';
import { browserLabel, errorMessage, normalizePort } from '../shared-utils.js';

type Reply<T> = { ok: true; result: T } | { ok: false; message: string };

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const els = {
  browser: $<HTMLDivElement>('browser'),
  status: $<HTMLDivElement>('status'),
  statusText: $<HTMLSpanElement>('statusText'),
  reason: $<HTMLParagraphElement>('reason'),
  port: $<HTMLInputElement>('port'),
  token: $<HTMLInputElement>('token'),
  toggleToken: $<HTMLButtonElement>('toggleToken'),
  save: $<HTMLButtonElement>('save'),
  test: $<HTMLButtonElement>('test'),
  testResult: $<HTMLParagraphElement>('testResult'),
  aimTabs: $<HTMLDivElement>('aimTabs'),
  closeTabs: $<HTMLButtonElement>('closeTabs'),
  version: $<HTMLSpanElement>('version'),
};

async function ask<T>(message: FromPopupMessage): Promise<T> {
  let reply: Reply<T> | undefined;
  try {
    reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
  } catch (e) {
    throw new Error(`The extension background is not responding (${errorMessage(e)}). Try reloading the extension.`);
  }
  if (!reply) throw new Error('No reply from the extension background.');
  if (!reply.ok) throw new Error(reply.message);
  return reply.result;
}

function setResult(text: string, kind: 'ok' | 'err' | '' = ''): void {
  els.testResult.textContent = text;
  els.testResult.className = `result ${kind}`.trim();
}

let tokenDirty = false;

function render(status: StatusReport): void {
  els.status.dataset.state = status.state;
  els.statusText.textContent = status.state === 'connected' ? 'Connected to A.I.M.' : status.state === 'connecting' ? 'Connecting…' : 'Disconnected';
  els.reason.textContent = status.state === 'connected' ? `Link established${status.hubVersion ? ` (hub version ${status.hubVersion})` : ''}.` : status.reason ?? '';
  els.browser.textContent = browserLabel({ name: status.browser as never, version: status.browserVersion });
  els.aimTabs.textContent = String(status.aimTabCount);
  els.closeTabs.disabled = status.aimTabCount === 0;
  els.version.textContent = `Version ${status.extensionVersion}`;
  if (document.activeElement !== els.port && !els.port.value) els.port.value = String(status.port);
}

async function refresh(): Promise<void> {
  try {
    render(await ask<StatusReport>({ kind: 'popup.status' }));
  } catch (e) {
    els.status.dataset.state = 'disconnected';
    els.statusText.textContent = 'Unavailable';
    els.reason.textContent = errorMessage(e);
  }
}

async function loadStoredToken(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.port]);
    if (typeof stored[STORAGE_KEYS.token] === 'string' && !tokenDirty) els.token.value = stored[STORAGE_KEYS.token] as string;
    if (!els.port.value) els.port.value = String(normalizePort(stored[STORAGE_KEYS.port], HUB_DEFAULT_PORT));
  } catch {
    /* storage unavailable; fields stay empty */
  }
}

els.token.addEventListener('input', () => {
  tokenDirty = true;
});

els.toggleToken.addEventListener('click', () => {
  const show = els.token.type === 'password';
  els.token.type = show ? 'text' : 'password';
  els.toggleToken.textContent = show ? 'Hide' : 'Show';
  els.toggleToken.setAttribute('aria-label', show ? 'Hide token' : 'Show token');
});

els.save.addEventListener('click', async () => {
  const port = normalizePort(els.port.value, HUB_DEFAULT_PORT);
  const token = els.token.value.trim();
  els.port.value = String(port);
  if (!token) {
    setResult('Enter the pairing token shown in A.I.M. Settings before connecting.', 'err');
    els.token.focus();
    return;
  }
  els.save.disabled = true;
  setResult('Saving and connecting…');
  try {
    const status = await ask<StatusReport>({ kind: 'popup.save', port, token });
    tokenDirty = false;
    render(status);
    setResult(status.state === 'connected' ? 'Connected to A.I.M.' : status.reason ?? 'Not connected.', status.state === 'connected' ? 'ok' : 'err');
  } catch (e) {
    setResult(errorMessage(e), 'err');
  } finally {
    els.save.disabled = false;
  }
});

els.test.addEventListener('click', async () => {
  els.test.disabled = true;
  setResult('Testing…');
  try {
    const result = await ask<TestResult>({ kind: 'popup.test' });
    setResult(result.message, result.ok ? 'ok' : 'err');
    await refresh();
  } catch (e) {
    setResult(errorMessage(e), 'err');
  } finally {
    els.test.disabled = false;
  }
});

els.closeTabs.addEventListener('click', async () => {
  els.closeTabs.disabled = true;
  try {
    const { closed } = await ask<{ closed: number }>({ kind: 'popup.closeAimTabs' });
    setResult(closed === 1 ? 'Closed 1 tab opened by A.I.M.' : `Closed ${closed} tabs opened by A.I.M.`, 'ok');
  } catch (e) {
    setResult(errorMessage(e), 'err');
  } finally {
    await refresh();
  }
});

void (async () => {
  await loadStoredToken();
  await refresh();
})();

const timer = setInterval(() => void refresh(), 2_000);
window.addEventListener('unload', () => clearInterval(timer));
