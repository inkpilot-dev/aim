/**
 * Active window provider for the BehaviorObserver and for screen_info / window tools.
 * - All platforms: nut-js getActiveWindow() → title (+ region).
 * - win32: PowerShell (user32 GetForegroundWindow + Get-Process) adds the process name and pid.
 * Results are cached for `cacheMs`; every probe is bounded by a timeout so the observer never hangs.
 */
import { execFile } from 'node:child_process';

export interface ActiveWindowInfo {
  app: string;
  title: string;
  pid?: number;
  /** Native handle (HWND on Windows) when known. */
  id?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ActiveWindowProviderOptions {
  cacheMs?: number;
  timeoutMs?: number;
  log?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

type NutModule = typeof import('@nut-tree-fork/nut-js');
let nutPromise: Promise<NutModule | null> | null = null;
export function loadNut(): Promise<NutModule | null> {
  if (!nutPromise) {
    nutPromise = import('@nut-tree-fork/nut-js').then(
      (m) => m,
      () => null,
    );
  }
  return nutPromise;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const PS_FOREGROUND = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AimWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [AimWin]::GetForegroundWindow()
$pid2 = 0
[void][AimWin]::GetWindowThreadProcessId($h, [ref]$pid2)
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
[pscustomobject]@{ hwnd = [int64]$h; pid = [int]$pid2; process = $(if ($p) { $p.ProcessName } else { '' }); title = $(if ($p) { $p.MainWindowTitle } else { '' }) } | ConvertTo-Json -Compress
`;

export function runPowerShell(script: string, timeoutMs = 1_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString());
      },
    );
    child.on('error', reject);
  });
}

/** Derive a short app name from a window title when no process name is available. */
export function appFromTitle(title: string): string {
  if (!title) return 'unknown';
  const parts = title.split(/\s[-–—|]\s/);
  const last = parts[parts.length - 1]?.trim();
  if (parts.length > 1 && last && last.length <= 40) return last;
  return title.slice(0, 40);
}

export class ActiveWindowProvider {
  private cache: { at: number; value: ActiveWindowInfo | null } | null = null;
  private inflight: Promise<ActiveWindowInfo | null> | null = null;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private psFailures = 0;

  constructor(private readonly opts: ActiveWindowProviderOptions = {}) {
    this.cacheMs = opts.cacheMs ?? 1_000;
    this.timeoutMs = opts.timeoutMs ?? 1_000;
  }

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.probe()
      .catch((err) => {
        this.opts.log?.debug(`active window probe failed: ${(err as Error).message}`);
        return null;
      })
      .then((v) => {
        this.cache = { at: Date.now(), value: v };
        this.inflight = null;
        return v;
      });
    return this.inflight;
  }

  private async probe(): Promise<ActiveWindowInfo | null> {
    const [nutInfo, winInfo] = await Promise.all([this.probeNut(), process.platform === 'win32' ? this.probeWin32() : Promise.resolve(null)]);
    if (!nutInfo && !winInfo) return null;
    const title = winInfo?.title || nutInfo?.title || '';
    const app = winInfo?.app || appFromTitle(title);
    return { app, title, pid: winInfo?.pid, id: winInfo?.id ?? nutInfo?.id, bounds: nutInfo?.bounds };
  }

  private async probeNut(): Promise<ActiveWindowInfo | null> {
    const nut = await loadNut();
    if (!nut) return null;
    try {
      const w = await withTimeout(nut.getActiveWindow(), this.timeoutMs, 'getActiveWindow');
      const [title, region] = await withTimeout(Promise.all([w.getTitle(), w.getRegion().catch(() => null)]), this.timeoutMs, 'window details');
      const id = (w as unknown as { windowHandle?: number }).windowHandle;
      return {
        app: appFromTitle(title),
        title,
        id: typeof id === 'number' ? id : undefined,
        bounds: region ? { x: region.left, y: region.top, width: region.width, height: region.height } : undefined,
      };
    } catch (err) {
      this.opts.log?.debug(`nut-js active window failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async probeWin32(): Promise<ActiveWindowInfo | null> {
    if (this.psFailures > 5) return null; // PowerShell unusable; stop paying for it
    try {
      const out = await runPowerShell(PS_FOREGROUND, this.timeoutMs);
      const j = JSON.parse(out.trim()) as { hwnd: number; pid: number; process: string; title: string };
      this.psFailures = 0;
      return { app: j.process || '', title: j.title || '', pid: j.pid || undefined, id: j.hwnd || undefined };
    } catch (err) {
      this.psFailures++;
      this.opts.log?.debug(`PowerShell foreground probe failed: ${(err as Error).message}`);
      return null;
    }
  }
}
