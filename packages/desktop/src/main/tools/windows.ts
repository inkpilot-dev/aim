/**
 * window_list / window_focus / app_launch. nut-js getWindows() everywhere; on win32 PowerShell
 * (user32 EnumWindows + Get-Process) adds process names, pids and the focused HWND.
 */
import { spawn } from 'node:child_process';
import { shell } from 'electron';
import type { Settings } from '@aim/shared';
import type { ToolImpl } from './tool-router.js';
import { loadNut, runPowerShell, withTimeout, type ActiveWindowProvider } from '../active-window.js';

export interface WindowToolDeps {
  settings: () => Settings;
  activeWindow: ActiveWindowProvider;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  focused: boolean;
}

const PS_ENUM_WINDOWS = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class AimEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Rows = new List<string>();
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h); if (len == 0) return true;
    var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    Rows.Add(((long)h) + "\\t" + pid + "\\t" + r.Left + "\\t" + r.Top + "\\t" + (r.Right - r.Left) + "\\t" + (r.Bottom - r.Top) + "\\t" + sb.ToString().Replace("\\t"," ").Replace("\\n"," "));
    return true;
  }
}
"@
[void][AimEnum]::EnumWindows([AimEnum+EnumWindowsProc]{ param($h,$l) [AimEnum]::Cb($h,$l) }, [IntPtr]::Zero)
$fg = [int64][AimEnum]::GetForegroundWindow()
$procs = @{}
Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }
$rows = foreach ($line in [AimEnum]::Rows) {
  $p = $line -split "\\t", 7
  [pscustomobject]@{ id = [int64]$p[0]; pid = [int]$p[1]; x = [int]$p[2]; y = [int]$p[3]; width = [int]$p[4]; height = [int]$p[5]; title = $p[6]; app = $procs[[int]$p[1]]; focused = ([int64]$p[0] -eq $fg) }
}
@($rows) | ConvertTo-Json -Compress
`;

const PS_FOCUS = (hwnd: number) => `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AimFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$h = [IntPtr]${hwnd}
if ([AimFocus]::IsIconic($h)) { [void][AimFocus]::ShowWindow($h, 9) }
[AimFocus]::SetForegroundWindow($h)
`;

async function listViaNut(): Promise<WindowInfo[]> {
  const nut = await loadNut();
  if (!nut) return [];
  const wins = await withTimeout(nut.getWindows(), 3_000, 'getWindows');
  let activeHandle: number | undefined;
  try {
    const a = await withTimeout(nut.getActiveWindow(), 1_000, 'getActiveWindow');
    activeHandle = (a as unknown as { windowHandle?: number }).windowHandle;
  } catch {
    /* ignore */
  }
  const out: WindowInfo[] = [];
  for (const w of wins) {
    try {
      const [title, region] = await withTimeout(Promise.all([w.getTitle(), w.getRegion().catch(() => null)]), 1_000, 'window');
      if (!title) continue;
      const id = (w as unknown as { windowHandle?: number }).windowHandle ?? out.length;
      out.push({ id, title, app: appGuess(title), bounds: region ? { x: region.left, y: region.top, width: region.width, height: region.height } : undefined, focused: activeHandle !== undefined && id === activeHandle });
    } catch {
      /* skip */
    }
  }
  return out;
}

function appGuess(title: string): string {
  const parts = title.split(/\s[-–—|]\s/);
  const last = parts[parts.length - 1]?.trim();
  return parts.length > 1 && last && last.length <= 40 ? last : '';
}

export async function listWindows(log?: WindowToolDeps['log']): Promise<WindowInfo[]> {
  let wins: WindowInfo[] = [];
  if (process.platform === 'win32') {
    try {
      const out = await runPowerShell(PS_ENUM_WINDOWS, 4_000);
      const parsed = JSON.parse(out.trim() || '[]') as WindowInfo[] | WindowInfo;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      wins = rows
        .filter((r) => r && r.title)
        .map((r) => ({ id: Number(r.id), title: r.title, app: r.app ?? '', pid: r.pid, bounds: { x: (r as unknown as { x: number }).x, y: (r as unknown as { y: number }).y, width: (r as unknown as { width: number }).width, height: (r as unknown as { height: number }).height }, focused: !!r.focused }));
    } catch (err) {
      log?.debug(`PowerShell window enumeration failed: ${(err as Error).message}`);
    }
  }
  if (!wins.length) wins = await listViaNut();
  return wins.filter((w) => w.title && w.title !== 'A.I.M. cursor');
}

const APP_ALIASES: Record<string, { win32: string; darwin: string; linux: string }> = {
  edge: { win32: 'msedge', darwin: 'Microsoft Edge', linux: 'microsoft-edge' },
  msedge: { win32: 'msedge', darwin: 'Microsoft Edge', linux: 'microsoft-edge' },
  chrome: { win32: 'chrome', darwin: 'Google Chrome', linux: 'google-chrome' },
  notepad: { win32: 'notepad', darwin: 'TextEdit', linux: 'gedit' },
  calc: { win32: 'calc', darwin: 'Calculator', linux: 'gnome-calculator' },
  calculator: { win32: 'calc', darwin: 'Calculator', linux: 'gnome-calculator' },
  code: { win32: 'code', darwin: 'Visual Studio Code', linux: 'code' },
  vscode: { win32: 'code', darwin: 'Visual Studio Code', linux: 'code' },
  explorer: { win32: 'explorer', darwin: 'Finder', linux: 'nautilus' },
  terminal: { win32: 'wt', darwin: 'Terminal', linux: 'x-terminal-emulator' },
  cmd: { win32: 'cmd', darwin: 'Terminal', linux: 'x-terminal-emulator' },
  powershell: { win32: 'powershell', darwin: 'Terminal', linux: 'pwsh' },
  settings: { win32: 'ms-settings:', darwin: 'System Settings', linux: 'gnome-control-center' },
  outlook: { win32: 'outlook', darwin: 'Microsoft Outlook', linux: 'thunderbird' },
  word: { win32: 'winword', darwin: 'Microsoft Word', linux: 'libreoffice --writer' },
  excel: { win32: 'excel', darwin: 'Microsoft Excel', linux: 'libreoffice --calc' },
  spotify: { win32: 'spotify', darwin: 'Spotify', linux: 'spotify' },
  discord: { win32: 'discord', darwin: 'Discord', linux: 'discord' },
};

export function createWindowTools(deps: WindowToolDeps): Record<string, ToolImpl> {
  const window_list: ToolImpl = async () => {
    const wins = await listWindows(deps.log);
    if (!wins.length) return { ok: true, text: 'No titled top-level windows were found.', data: { windows: [] } };
    const text = wins.map((w) => `${w.focused ? '* ' : '  '}#${w.id} ${w.app ? `[${w.app}] ` : ''}"${w.title}"${w.bounds ? ` ${w.bounds.width}×${w.bounds.height} at (${w.bounds.x},${w.bounds.y})` : ''}`).join('\n');
    return { ok: true, text: `${wins.length} window(s) (* = focused):\n${text}`, data: { windows: wins } };
  };

  const window_focus: ToolImpl = async (args) => {
    const wins = await listWindows(deps.log);
    const id = typeof args['id'] === 'number' ? args['id'] : undefined;
    const tc = typeof args['titleContains'] === 'string' ? (args['titleContains'] as string).toLowerCase() : '';
    const ac = typeof args['appContains'] === 'string' ? (args['appContains'] as string).toLowerCase() : '';
    if (id === undefined && !tc && !ac) return { ok: false, error: 'Provide id, titleContains or appContains.' };
    const target = wins.find((w) => (id !== undefined && w.id === id) || (tc && w.title.toLowerCase().includes(tc)) || (ac && w.app.toLowerCase().includes(ac)));
    if (!target) return { ok: false, error: `No window matched ${id !== undefined ? `id ${id}` : tc ? `title "${tc}"` : `app "${ac}"`}. Call window_list to see current windows.` };
    let focused = false;
    if (process.platform === 'win32') {
      try {
        const out = await runPowerShell(PS_FOCUS(target.id), 3_000);
        focused = /true/i.test(out);
      } catch (err) {
        deps.log?.debug(`SetForegroundWindow failed: ${(err as Error).message}`);
      }
    }
    if (!focused) {
      const nut = await loadNut();
      if (nut) {
        try {
          const all = await withTimeout(nut.getWindows(), 3_000, 'getWindows');
          for (const w of all) {
            const h = (w as unknown as { windowHandle?: number }).windowHandle;
            const t = h === target.id ? true : (await w.getTitle().catch(() => '')) === target.title;
            if (t) {
              focused = await withTimeout(w.focus(), 3_000, 'focus');
              break;
            }
          }
        } catch (err) {
          deps.log?.debug(`nut focus failed: ${(err as Error).message}`);
        }
      }
    }
    if (!focused) return { ok: false, error: `Could not bring "${target.title}" to the foreground (the OS may prevent focus stealing). Try window_focus again after a user interaction, or use keyboard_press alt+tab.` };
    return { ok: true, text: `Focused "${target.title}"${target.app ? ` (${target.app})` : ''}.`, data: { window: target } };
  };

  const app_launch: ToolImpl = async (args) => {
    const target = String(args['target'] ?? '').trim();
    const extra = Array.isArray(args['args']) ? (args['args'] as unknown[]).map(String) : [];
    if (!target) return { ok: false, error: 'target is required.' };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^mailto:|^ms-settings:/i.test(target)) {
      await shell.openExternal(target);
      return { ok: true, text: `Opened ${target} with the default handler.` };
    }
    if (/^(?:[a-z]:\\|\\\\|\/|~\/)/i.test(target) && !/\.exe$/i.test(target)) {
      const err = await shell.openPath(target.replace(/^~\//, `${process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''}/`));
      return err ? { ok: false, error: `Could not open ${target}: ${err}` } : { ok: true, text: `Opened ${target}.` };
    }
    let name = target;
    const lower = target.toLowerCase();
    if (lower === 'browser') {
      const pref = deps.settings().preferredBrowser;
      name = pref || (process.platform === 'win32' ? 'msedge' : 'chrome');
    }
    const alias = APP_ALIASES[name.toLowerCase()];
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const resolved = alias ? alias[platform] : name;
    try {
      if (platform === 'win32') {
        if (/^ms-settings:/i.test(resolved)) {
          await shell.openExternal(resolved);
        } else {
          const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${resolved}" ${extra.map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')}`.trim()], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          await new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`start exited with code ${code}`))));
          });
        }
      } else if (platform === 'darwin') {
        const isApp = alias || !resolved.includes('/');
        const child = spawn(isApp ? 'open' : resolved, isApp ? ['-a', resolved, ...(extra.length ? ['--args', ...extra] : [])] : extra, { detached: true, stdio: 'ignore' });
        child.unref();
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', () => resolve());
        });
      } else {
        const [cmd, ...pre] = resolved.split(/\s+/);
        const child = spawn(cmd!, [...pre, ...extra], { detached: true, stdio: 'ignore' });
        child.unref();
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', () => resolve());
        });
      }
    } catch (err) {
      return { ok: false, error: `Failed to launch "${target}" (${resolved}): ${(err as Error).message}` };
    }
    return { ok: true, text: `Launched ${resolved}${extra.length ? ` ${extra.join(' ')}` : ''}.`, data: { target, resolved, args: extra } };
  };

  return { window_list, window_focus, app_launch };
}
