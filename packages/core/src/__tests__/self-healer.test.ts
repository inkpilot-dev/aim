import { describe, expect, it } from 'vitest';
import type { CliRunResult } from '../cli-bridge.js';
import { SelfHealer } from '../self-healer.js';
import { makeTmpDir, quietLogs } from './helpers.js';

const res = (p: Partial<CliRunResult>): CliRunResult => ({ ok: false, isError: true, exitCode: 0, ...p });

describe('SelfHealer', () => {
  quietLogs(makeTmpDir());
  const healer = new SelfHealer({ maxAttempts: () => 2 });

  it('classifies errors', () => {
    expect(healer.classify(res({ errorMessage: 'Claude CLI exited (exit code 3) without a result', exitCode: 3 })).kind).toBe('cli_crash');
    expect(healer.classify(res({ errorMessage: 'The CLI reached its maximum number of turns.' })).kind).toBe('max_turns');
    expect(healer.classify('Not logged in. Please run /login').kind).toBe('auth');
    expect(healer.classify(new Error('browser extension is not connected')).kind).toBe('extension_disconnected');
    expect(healer.classify('Tool exploded: tool call failed {"ok":false}').kind).toBe('tool_error');
    expect(healer.classify({ message: 'something odd' }).kind).toBe('unknown');
    expect(healer.classify(res({ errorMessage: 'Turn timed out after 30 s' })).kind).toBe('cli_crash');
  });

  it('limits retries per chat and never retries auth errors', () => {
    const err = res({ errorMessage: 'boom' });
    expect(healer.shouldRetry('c1', err)).toBe(true);
    expect(healer.nextAttempt('c1')).toBe(1);
    expect(healer.shouldRetry('c1', err)).toBe(true);
    expect(healer.nextAttempt('c1')).toBe(2);
    expect(healer.shouldRetry('c1', err)).toBe(false);
    expect(healer.shouldRetry('c2', err)).toBe(true);
    healer.reset('c1');
    expect(healer.shouldRetry('c1', err)).toBe(true);
    expect(healer.shouldRetry('c3', 'unauthorized: invalid api key')).toBe(false);
  });

  it('builds a repair prompt with the error and kind-specific guidance', () => {
    const p = healer.buildRepairPrompt(res({ errorMessage: 'browser extension disconnected' }), 1);
    expect(p).toContain('Self-repair attempt 1 of 2');
    expect(p).toContain('browser extension disconnected');
    expect(p).toContain('mcp__aim__browser_status');
    expect(p).toContain('mcp__aim__ask_user');
    const crash = healer.buildRepairPrompt(res({ errorMessage: 'CLI exited (signal SIGKILL) without a result' }), 2);
    expect(crash).toContain('interrupted');
  });
});
