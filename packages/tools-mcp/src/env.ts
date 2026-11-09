/** Resolve the hub WebSocket URL from the environment (adds the tools path when missing). */
import { HUB_DEFAULT_PORT, HUB_HOST, HUB_PATH_TOOLS } from '@aim/shared';

export function resolveHubUrl(raw: string | undefined): string {
  let url = (raw ?? '').trim();
  if (!url) url = `ws://${HUB_HOST}:${HUB_DEFAULT_PORT}`;
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/') u.pathname = HUB_PATH_TOOLS;
    return u.toString();
  } catch {
    return `ws://${HUB_HOST}:${HUB_DEFAULT_PORT}${HUB_PATH_TOOLS}`;
  }
}

