import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '@aim/shared';
import { groupContent, TOOL_GROUP_MIN } from './ToolGroupRow';

const tool = (name: string, id: string): ContentBlock => ({ type: 'tool_use', id, name, input: {} });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('groupContent', () => {
  it('collapses runs of identical tools at or above the threshold', () => {
    const content = [text('a'), tool('ToolSearch', '1'), tool('ToolSearch', '2'), tool('ToolSearch', '3'), tool('ToolSearch', '4'), text('b')];
    const items = groupContent(content);
    expect(items.map((i) => i.kind)).toEqual(['block', 'group', 'block']);
    expect(items[1].kind === 'group' && items[1].blocks.length).toBe(4);
    expect(TOOL_GROUP_MIN).toBe(3);
  });
  it('leaves short runs and mixed tools alone', () => {
    const content = [tool('mcp__aim__tasks_update', '1'), tool('mcp__aim__tasks_update', '2'), tool('mcp__aim__screen_capture', '3'), tool('Read', '4'), tool('Read', '5'), tool('Read', '6')];
    const items = groupContent(content);
    expect(items.map((i) => i.kind)).toEqual(['block', 'block', 'block', 'group']);
  });
  it('passes empty content through', () => {
    expect(groupContent([])).toEqual([]);
  });
});
