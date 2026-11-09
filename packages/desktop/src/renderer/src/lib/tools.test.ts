import { describe, expect, it } from 'vitest';
import { humanizeToolName, summarizeToolInput, toolCategory } from './tools';

describe('tools', () => {
  it('humanises AIM tool names', () => {
    expect(humanizeToolName('mcp__aim__screen_capture')).toBe('Screen capture');
    expect(humanizeToolName('mcp__aim__browser_click')).toBe('Browser click');
    expect(humanizeToolName('Bash')).toBe('Shell command');
    expect(humanizeToolName('WebFetch')).toBe('Fetch web page');
    expect(humanizeToolName('mcp__other__doThingNow')).toBe('Do thing now');
  });

  it('categorises tools', () => {
    expect(toolCategory('mcp__aim__screen_capture')).toBe('screen');
    expect(toolCategory('mcp__aim__browser_open_tab')).toBe('browser');
    expect(toolCategory('mcp__aim__mouse_click')).toBe('input');
    expect(toolCategory('mcp__aim__tasks_set')).toBe('tasks');
    expect(toolCategory('mcp__aim__memory_search')).toBe('memory');
    expect(toolCategory('Bash')).toBe('shell');
    expect(toolCategory('Read')).toBe('file');
    expect(toolCategory('Agent')).toBe('agent');
    expect(toolCategory('mcp__aim__ask_user')).toBe('ask');
    expect(toolCategory('Mystery')).toBe('other');
  });

  it('summarises inputs by preferred keys', () => {
    expect(summarizeToolInput({ tabId: 3, url: 'https://x.io' })).toBe('https://x.io');
    expect(summarizeToolInput({ command: 'ls   -la' })).toBe('ls -la');
    expect(summarizeToolInput({ a: 1, b: true })).toBe('a: 1, b: true');
    expect(summarizeToolInput('x'.repeat(200)).length).toBe(120);
    expect(summarizeToolInput(null)).toBe('');
  });
});
