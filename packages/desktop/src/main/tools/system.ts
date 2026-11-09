/** system_info / clipboard / notify_user. */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { Notification, clipboard, nativeImage } from 'electron';
import type { ToolImpl } from './tool-router.js';

export interface SystemToolDeps {
  appVersion: string;
  iconPath?: string;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
  onNotify?: (title: string, body: string) => void;
}

let defaultBrowserCache: { at: number; value: string } | null = null;

export async function detectDefaultBrowser(): Promise<string> {
  if (defaultBrowserCache && Date.now() - defaultBrowserCache.at < 300_000) return defaultBrowserCache.value;
  let value = 'unknown';
  try {
    if (process.platform === 'win32') {
      const out = await new Promise<string>((resolve, reject) =>
        execFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'], { timeout: 2_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
      );
      const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out);
      const prog = m?.[1] ?? '';
      value = /edge/i.test(prog) ? 'msedge' : /chrome/i.test(prog) ? 'chrome' : /firefox/i.test(prog) ? 'firefox' : /brave/i.test(prog) ? 'brave' : /opera/i.test(prog) ? 'opera' : prog || 'unknown';
    } else if (process.platform === 'darwin') {
      value = 'system default';
    } else {
      const out = await new Promise<string>((resolve) => execFile('xdg-settings', ['get', 'default-web-browser'], { timeout: 2_000 }, (_e, stdout) => resolve(String(stdout ?? ''))));
      value = out.trim().replace(/\.desktop$/, '') || 'unknown';
    }
  } catch {
    /* best effort */
  }
  defaultBrowserCache = { at: Date.now(), value };
  return value;
}

export function createSystemTools(deps: SystemToolDeps): Record<string, ToolImpl> {
  const system_info: ToolImpl = async () => {
    const user = (() => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env['USERNAME'] ?? process.env['USER'] ?? 'unknown';
      }
    })();
    const cpus = os.cpus();
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const defaultBrowser = await detectDefaultBrowser();
    const info = {
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      version: os.version?.() ?? '',
      arch: os.arch(),
      hostname: os.hostname(),
      user,
      homeDir: os.homedir(),
      uptimeSec: Math.round(os.uptime()),
      cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length },
      memory: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) },
      defaultBrowser,
      timeZone: tz,
      localTime: now.toLocaleString(undefined, { hour12: false }),
      iso: now.toISOString(),
      aimVersion: deps.appVersion,
    };
    const text = [
      `${info.os} (${info.arch}), host ${info.hostname}, user ${info.user}.`,
      `Uptime ${Math.floor(info.uptimeSec / 3600)} h ${Math.floor((info.uptimeSec % 3600) / 60)} min. CPU ${info.cpu.model} ×${info.cpu.cores}. Memory ${info.memory.freeMB} MB free of ${info.memory.totalMB} MB.`,
      `Default browser: ${defaultBrowser}. Time zone ${tz}; local time ${info.localTime}. A.I.M. ${deps.appVersion}.`,
    ].join('\n');
    return { ok: true, text, data: info };
  };

  const clipboardTool: ToolImpl = async (args) => {
    const action = args['action'];
    if (action === 'read') {
      const text = clipboard.readText();
      const formats = clipboard.availableFormats();
      return { ok: true, text: text ? text : `(clipboard has no text; formats: ${formats.join(', ') || 'none'})`, data: { text, formats } };
    }
    if (action === 'write') {
      const text = String(args['text'] ?? '');
      clipboard.writeText(text);
      return { ok: true, text: `Wrote ${text.length} character(s) to the clipboard.` };
    }
    return { ok: false, error: 'action must be "read" or "write".' };
  };

  const notify_user: ToolImpl = async (args) => {
    const title = String(args['title'] ?? 'A.I.M.').slice(0, 120);
    const body = String(args['body'] ?? '').slice(0, 500);
    deps.onNotify?.(title, body);
    if (!Notification.isSupported()) return { ok: true, text: 'Notifications are not supported on this system; the message was shown in the chat instead.' };
    try {
      const n = new Notification({ title, body, silent: false, icon: deps.iconPath ? nativeImage.createFromPath(deps.iconPath) : undefined });
      n.show();
    } catch (err) {
      return { ok: false, error: `Notification failed: ${(err as Error).message}` };
    }
    return { ok: true, text: `Notification shown: "${title}".` };
  };

  return { system_info, clipboard: clipboardTool, notify_user };
}
