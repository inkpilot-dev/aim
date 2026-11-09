import { describe, expect, it } from 'vitest';
import { AIM_TOOLS, fullToolName } from '@aim/shared';
import { AGENT_DEFINITIONS, buildAgentsJson, buildSystemPrompt, buildWorkerSystemPrompt, roleDisplayName } from '../prompts.js';

describe('prompts', () => {
  it('system prompt lists every AIM tool and the key rules', () => {
    const p = buildSystemPrompt({ memoryDigest: 'User prefers Edge.', behaviorDigest: 'Mostly in VS Code.', platform: 'win32', now: new Date(2026, 0, 5, 9, 30), extensionConnected: true });
    for (const t of AIM_TOOLS) expect(p).toContain(fullToolName(t.name));
    expect(p).toContain('mcp__aim__tasks_set');
    expect(p).toContain('User prefers Edge.');
    expect(p).toContain('Mostly in VS Code.');
    expect(p).toContain('Windows');
    expect(p).toContain('2026-01-05 09:30');
    expect(p).toMatch(/payment/i);
    expect(p).toMatch(/never use emoji/i);
    expect(p).toContain('extension is connected');
    expect(/\p{Extended_Pictographic}/u.test(p)).toBe(false);
  });

  it('system prompt adapts to extension state and empty memory', () => {
    const off = buildSystemPrompt({ memoryDigest: '', platform: 'linux', now: new Date(), extensionConnected: false });
    expect(off).toContain('NOT connected');
    expect(off).toContain('no memories yet');
    const unknown = buildSystemPrompt({ memoryDigest: '', platform: 'darwin', now: new Date() });
    expect(unknown).toContain('status is unknown');
    expect(unknown).not.toContain('behaviour digest');
  });

  it('agents JSON defines the six roles with prompts and tools', () => {
    const json = JSON.parse(buildAgentsJson()) as Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
    expect(Object.keys(json).sort()).toEqual(['browser_operator', 'coder', 'desktop_operator', 'planner', 'researcher', 'verifier']);
    for (const def of Object.values(json)) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.prompt).toMatch(/payment/i);
      expect(def.tools?.length).toBeGreaterThan(0);
    }
    expect(json.browser_operator.tools).toContain('mcp__aim__browser_click');
    expect(json.desktop_operator.tools).toContain('mcp__aim__mouse_click');
    expect(json.coder.tools).toContain('Bash');
    expect(json.planner.model).toBe('sonnet');
    expect(AGENT_DEFINITIONS.verifier.model).toBe('sonnet');
  });

  it('worker prompt and role names', () => {
    const w = buildWorkerSystemPrompt('browser_operator', 'Browser Operator', { platform: 'win32', now: new Date(), memoryDigest: 'x' });
    expect(w).toContain('worker agent "Browser Operator"');
    expect(w).toContain('mcp__aim__browser_snapshot');
    expect(w).toContain('## Memory digest');
    expect(roleDisplayName('desktop_operator')).toBe('Desktop Operator');
  });
});
