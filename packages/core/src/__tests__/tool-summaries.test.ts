import { describe, expect, it } from 'vitest';
import { summarizeToolResult, summarizeToolUse } from '../tool-summaries.js';

describe('tool summaries', () => {
  it('summarises tool use', () => {
    expect(summarizeToolUse('mcp__aim__browser_click', { tabId: 3, ref: 'e12' })).toBe('browser_click e12');
    expect(summarizeToolUse('mcp__aim__browser_open_tab', { url: 'https://example.com/path?x=1' })).toBe('browser_open_tab example.com');
    expect(summarizeToolUse('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(summarizeToolUse('mcp__aim__tasks_set', { tasks: [{ title: 'a' }, { title: 'b' }] })).toBe('tasks_set 2 tasks');
    expect(summarizeToolUse('Agent', { subagent_type: 'researcher', description: 'Find docs' })).toBe('Agent researcher: Find docs');
    expect(summarizeToolUse('mcp__aim__keyboard_type', { text: 'x'.repeat(200) }).length).toBeLessThanOrEqual(90);
  });

  it('summarises results including images and errors', () => {
    const r = summarizeToolResult('mcp__aim__screen_capture', {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, data: { width: 1920, height: 1080 } }) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
    expect(r).toMatchObject({ ok: true, summary: 'screen_capture → 1920×1080', imageBase64: 'AAAA' });
    const err = summarizeToolResult('mcp__aim__browser_click', { content: JSON.stringify({ ok: false, error: 'element e12 not found' }) });
    expect(err.ok).toBe(false);
    expect(err.error).toBe('element e12 not found');
    expect(err.summary).toContain('browser_click failed');
    const plain = summarizeToolResult('Bash', { content: 'all tests passed\n', is_error: false });
    expect(plain).toEqual({ ok: true, summary: 'all tests passed' });
    const direct = summarizeToolResult('mcp__aim__browser_tabs', { ok: true, data: { tabs: [{}, {}, {}] } });
    expect(direct.summary).toBe('3 tabs');
  });
});
