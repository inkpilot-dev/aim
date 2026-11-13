import { describe, it, expect, vi, afterEach } from 'vitest';
import { RendererGuard, recoveryActionFromUrl } from '../renderer-guard.js';
import { limitChatImages } from '../ipc.js';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, shell: {}, app: {} }));

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('RendererGuard', () => {
  afterEach(() => vi.useRealTimers());

  it('escalates: reload, then safe mode, then the recovery screen', () => {
    const loads: boolean[] = [];
    const recover: string[] = [];
    const g = new RendererGuard({ load: async (o) => void loads.push(o.safe), showRecovery: (r) => recover.push(r), log });
    g.recordError('TypeError: x is undefined');
    g.fail('crash 1');
    g.fail('crash 2');
    expect(loads).toEqual([false, true]);
    g.fail('crash 3');
    expect(recover).toEqual(['crash 3']);
    g.fail('crash 4'); // stays on the recovery screen
    expect(recover).toHaveLength(1);
    g.retry();
    g.fail('after retry');
    expect(loads).toEqual([false, true, false]);
  });

  it('a healthy interface resets the failure count after it stays up', () => {
    vi.useFakeTimers();
    const loads: boolean[] = [];
    const g = new RendererGuard({ load: async (o) => void loads.push(o.safe), showRecovery: () => undefined, log, stableMs: 1000 });
    g.fail('one');
    g.ready();
    vi.advanceTimersByTime(1001);
    expect(g.failureCount).toBe(0);
    g.fail('two');
    expect(loads).toEqual([false, false]);
  });

  it('keeps the latest renderer errors for the recovery screen', () => {
    const details: string[] = [];
    const g = new RendererGuard({ load: async () => undefined, showRecovery: (_r, d) => details.push(d), log });
    for (let i = 0; i < 25; i++) g.recordError(`error ${i}`);
    expect(g.recentErrors).toHaveLength(20);
    g.fail('a');
    g.fail('b');
    g.fail('c');
    expect(details[0]).toContain('error 24');
    expect(details[0]).not.toContain('error 10\n');
  });

  it('parses recovery links', () => {
    expect(recoveryActionFromUrl('https://aim.recover/reload')).toBe('reload');
    expect(recoveryActionFromUrl('https://aim.recover/software')).toBe('software');
    expect(recoveryActionFromUrl('https://aim.recover/rm-rf')).toBeNull();
    expect(recoveryActionFromUrl('https://example.com/reload')).toBeNull();
  });
});

describe('limitChatImages', () => {
  it('keeps the newest images within the budget and trims older ones', () => {
    const img = (n: number) => 'A'.repeat(n);
    const chat = {
      id: 'c',
      messages: [
        { content: [{ type: 'image', mediaType: 'image/png', dataBase64: img(600) }] },
        { content: [{ type: 'tool_use', id: 't1', name: 'mcp__aim__screen_capture', input: {}, result: { ok: true, summary: 's', imageBase64: img(500) } }] },
        { content: [{ type: 'tool_use', id: 't2', name: 'mcp__aim__screen_capture', input: {}, result: { ok: true, summary: 's', imageBase64: img(500) } }] },
      ],
    };
    const out = limitChatImages(chat, 1100);
    expect((out.messages[2]!.content[0] as { result: { imageBase64?: string } }).result.imageBase64).toHaveLength(500);
    expect((out.messages[1]!.content[0] as { result: { imageBase64?: string } }).result.imageBase64).toHaveLength(500);
    expect(out.messages[0]!.content[0]).toEqual({ type: 'status', text: 'Older image not shown to keep A.I.M. responsive.' });
    // the original is untouched
    expect((chat.messages[0]!.content[0] as { type: string }).type).toBe('image');
  });
});
