/**
 * Extra runtime context appended to the system prompt (through the behaviourDigest hook, since
 * ChatService owns buildSystemPrompt). Keep it short — it is sent on every turn.
 */
import os from 'node:os';
import type { Settings } from '@aim/shared';

export interface PromptExtrasInput {
  extensionConnected: boolean;
  platform?: string;
  userName?: string;
  settings: Settings;
  hubPort: number;
  now?: Date;
}

export function currentUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env['USERNAME'] ?? process.env['USER'];
  }
}

export function buildSystemPromptExtras(input: PromptExtrasInput): string {
  const platform = input.platform ?? process.platform;
  const now = input.now ?? new Date();
  const lines = [
    '## Environment (live)',
    `- Platform: ${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform}${input.userName ? `; user: ${input.userName}` : ''}.`,
    `- Local time: ${now.toLocaleString(undefined, { hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    input.extensionConnected
      ? '- A.I.M. browser extension: CONNECTED. Prefer browser_* tools for anything in the browser; they work in background tabs and do not move the user\'s cursor.'
      : '- A.I.M. browser extension: NOT connected. browser_* tools will fail until the user opens Edge/Chrome with the extension; use app_launch("browser") once and then check browser_status, or fall back to screen/mouse/keyboard tools.',
    input.settings.preferredBrowser ? `- Preferred browser: ${input.settings.preferredBrowser}.` : '',
    input.settings.desktopCursorOverlay ? '- Desktop input tools move the real pointer; A.I.M.\'s teal cursor overlay is shown so the user can tell it is you.' : '- The desktop cursor overlay is disabled; desktop input moves the real pointer silently.',
    '- Payments and purchases are blocked by policy; stop before any checkout/payment step and hand over to the user.',
  ].filter(Boolean);
  return lines.join('\n');
}
