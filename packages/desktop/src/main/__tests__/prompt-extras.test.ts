import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@aim/shared';
import { buildSystemPromptExtras } from '../system-prompt-extras.js';
import { appFromTitle } from '../active-window.js';

describe('system prompt extras', () => {
  it('mentions the extension state and platform', () => {
    const on = buildSystemPromptExtras({ extensionConnected: true, platform: 'win32', userName: 'ana', settings: DEFAULT_SETTINGS, hubPort: 1 });
    expect(on).toContain('Windows');
    expect(on).toContain('user: ana');
    expect(on).toContain('CONNECTED');
    const off = buildSystemPromptExtras({ extensionConnected: false, platform: 'linux', settings: { ...DEFAULT_SETTINGS, desktopCursorOverlay: false }, hubPort: 1 });
    expect(off).toContain('NOT connected');
    expect(off).toContain('overlay is disabled');
  });
  it('derives an app name from a window title', () => {
    expect(appFromTitle('Inbox - Outlook - Microsoft Edge')).toBe('Microsoft Edge');
    expect(appFromTitle('Untitled')).toBe('Untitled');
    expect(appFromTitle('')).toBe('unknown');
  });
});
