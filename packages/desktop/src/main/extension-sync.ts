/**
 * Keeps the browser extension in step with the app. The extension is loaded unpacked from the app's
 * resources folder, so an app update replaces its files on disk, but the browser keeps running the old
 * code until the extension is reloaded. When the extension that connects is older than the one the app
 * ships, the hub asks it to reload itself (ext.reload) — once per version, to avoid loops.
 */
import { compareVersions } from './updater.js';

/** "edge/142.0 ext/0.1.6" → "0.1.6". */
export function parseExtensionVersion(hello: string | undefined): string | undefined {
  const m = /ext\/(\d+(?:\.\d+){1,3})/.exec(hello ?? '');
  return m?.[1];
}

export function readBundledExtensionVersion(manifestPath: string, readFile: (p: string) => string): string | undefined {
  try {
    const v = (JSON.parse(readFile(manifestPath)) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

export type ExtensionSyncAction = 'none' | 'reload' | 'stale-folder';

/**
 * Decides what to do when an extension connects. `requested` holds the running versions we already asked
 * to reload; seeing one again means the reload did not pick up new files, i.e. the browser loads the
 * extension from some other (older) folder.
 */
export function extensionSyncAction(running: string | undefined, bundled: string | undefined, requested: ReadonlySet<string>): ExtensionSyncAction {
  if (!running || !bundled) return 'none';
  if (compareVersions(bundled, running) <= 0) return 'none';
  return requested.has(running) ? 'stale-folder' : 'reload';
}
