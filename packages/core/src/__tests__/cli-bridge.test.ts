import { describe, expect, it } from 'vitest';
import type { CliEvent } from '@aim/shared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliBridge, buildOnceArgs, buildStreamArgs, parseOnceOutput, parseVersion, resolveCommand, writeArgFiles } from '../cli-bridge.js';
import { createLogger } from '../logger.js';
import { FAKE_CLI, fakeBridge, makeTmpDir, quietLogs } from './helpers.js';

const cwd = makeTmpDir();
quietLogs(cwd);

describe('ClaudeCliBridge', () => {
  it('builds the documented argv', () => {
    const args = buildStreamArgs({
      cwd,
      sessionId: 's1',
      model: 'sonnet',
      effort: 'high',
      maxBudgetUsd: 2,
      appendSystemPrompt: 'SYS',
      agentsJson: '{"a":1}',
      mcpConfigJson: '{"mcpServers":{}}',
      addDirs: ['/a', '/b'],
    });
    expect(args.slice(0, 5)).toEqual(['-p', '--verbose', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']);
    for (const pair of [
      ['--resume', 's1'],
      ['--model', 'sonnet'],
      ['--effort', 'high'],
      ['--max-budget-usd', '2'],
      ['--append-system-prompt', 'SYS'],
      ['--agents', '{"a":1}'],
      ['--mcp-config', '{"mcpServers":{}}'],
      ['--output-format', 'stream-json'],
      ['--input-format', 'stream-json'],
    ]) {
      const i = args.indexOf(pair[0]);
      expect(i, pair[0]).toBeGreaterThan(0);
      expect(args[i + 1]).toBe(pair[1]);
    }
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--include-partial-messages');
    expect(args.slice(-3)).toEqual(['--add-dir', '/a', '/b']);
    const once = buildOnceArgs({ cwd, jsonSchema: { type: 'object' } });
    expect(once).toContain('--json-schema');
    expect(once[once.indexOf('--output-format') + 1]).toBe('json');
    expect(once).not.toContain('--input-format');
  });

  it('writes large values to temp files and references them', () => {
    const opts = { cwd, appendSystemPrompt: 'SYS', agentsJson: '{"a":1}', mcpConfigJson: '{"mcpServers":{}}' };
    const { files, cleanup } = writeArgFiles(opts, createLogger('test'));
    expect(fs.readFileSync(files.systemPrompt!, 'utf8')).toBe('SYS');
    expect(fs.readFileSync(files.agents!, 'utf8')).toBe('{"a":1}');
    const args = buildStreamArgs(opts, files);
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(files.systemPrompt);
    expect(args[args.indexOf('--agents') + 1]).toBe(files.agents);
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(files.mcpConfig);
    expect(args).not.toContain('--append-system-prompt');
    cleanup();
    expect(fs.existsSync(files.systemPrompt!)).toBe(false);
    expect(fs.existsSync(files.mcpConfig!)).toBe(false);
  });

  it('cleans up arg files once the process closes', async () => {
    const bridge = fakeBridge();
    const h = bridge.start({ cwd, appendSystemPrompt: 'SYS' });
    h.send({ text: 'hi' });
    h.end();
    await h.done;
    await new Promise((r) => setTimeout(r, 50));
    const left = fs.readdirSync(path.join(os.tmpdir(), 'aim-cli')).filter((f) => f.includes(`${process.pid}-`));
    expect(left).toEqual([]);
  }, 20_000);

  it('resolves commands and parses helpers', () => {
    expect(resolveCommand('node /tmp/x.mjs', undefined)).toMatchObject({ file: 'node', prefix: ['/tmp/x.mjs'] });
    expect(resolveCommand(undefined, undefined).file).toBe('claude');
    expect(parseVersion('2.1.319 (Claude Code)')).toBe('2.1.319');
    expect(parseOnceOutput('warning\n{"type":"result","result":"x"}\n')).toMatchObject({ result: 'x' });
    expect(parseOnceOutput('')).toBeUndefined();
  });

  it('streams events, resolves the session id and the result', async () => {
    const bridge = fakeBridge();
    const h = bridge.start({ cwd });
    const events: CliEvent[] = [];
    h.on('event', (e) => events.push(e));
    h.send({ text: 'hello', images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] });
    h.end();
    const sid = await h.sessionId;
    expect(sid).toMatch(/[0-9a-f-]{36}/);
    const r = await h.done;
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('Echo: hello [1 image(s)]');
    expect(r.sessionId).toBe(sid);
    expect(r.costUsd).toBe(0.002);
    expect(events.map((e) => e.type)).toContain('stream_event');
    expect(events.at(-1)?.type).toBe('result');
    expect(typeof h.pid).toBe('number');
  }, 20_000);

  it('passes --resume through and reports crashes without a result', async () => {
    const bridge = fakeBridge();
    const h = bridge.start({ cwd, sessionId: '11111111-1111-1111-1111-111111111111' });
    h.send({ text: 'again' });
    h.end();
    const r = await h.done;
    expect(r.resultText).toBe('Echo: again [resumed]');
    expect(r.sessionId).toBe('11111111-1111-1111-1111-111111111111');

    const crash = bridge.start({ cwd });
    const stderr: string[] = [];
    crash.on('stderr', (l) => stderr.push(l));
    crash.send({ text: 'CRASH now' });
    crash.end();
    const cr = await crash.done;
    expect(cr.ok).toBe(false);
    expect(cr.exitCode).toBe(3);
    expect(cr.errorMessage).toMatch(/exit code 3/);
    expect(cr.errorMessage).toContain('simulated crash');
    expect(stderr.join('\n')).toContain('simulated crash');
    expect(await crash.sessionId).toMatch(/[0-9a-f-]{36}/);
  }, 20_000);

  it('aborts and times out', async () => {
    const bridge = fakeBridge();
    const h = bridge.start({ cwd });
    h.send({ text: 'SLOW' });
    setTimeout(() => h.abort(), 100);
    const r = await h.done;
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe('Aborted');

    const t = bridge.start({ cwd, timeoutMs: 300 });
    t.send({ text: 'SLOW' });
    const tr = await t.done;
    expect(tr.ok).toBe(false);
    expect(tr.errorMessage).toMatch(/timed out/);

    const ac = new AbortController();
    const s = bridge.start({ cwd, abortSignal: ac.signal });
    s.send({ text: 'SLOW' });
    ac.abort();
    expect((await s.done).errorMessage).toBe('Aborted');
    expect(bridge.liveProcessCount).toBe(0);
  }, 20_000);

  it('reports a missing executable gracefully', async () => {
    const bridge = new ClaudeCliBridge({ cliPath: '/definitely/not/here/claude' });
    const h = bridge.start({ cwd });
    h.send({ text: 'x' });
    const r = await h.done;
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/Failed to start Claude CLI/);
    const once = await bridge.runOnce('x', { cwd });
    expect(once.ok).toBe(false);
  }, 20_000);

  it('runOnce returns text and structured output', async () => {
    const bridge = fakeBridge();
    const r = await bridge.runOnce('summarise this', { cwd, jsonSchema: { type: 'object' } });
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('Echo: summarise this');
    expect(r.structured).toEqual({ echo: 'summarise this', schema: 'object' });
    const f = await bridge.runOnce('FAIL please', { cwd });
    expect(f.ok).toBe(false);
    expect(f.isError).toBe(true);
    expect(f.errorMessage).toBe('boom');
    expect(f.exitCode).toBe(1);
  }, 20_000);

  it('detect() finds an explicit path and reports the version', async () => {
    const health = await ClaudeCliBridge.detect(`${process.execPath} ${FAKE_CLI}`);
    expect(health.found).toBe(true);
    expect(health.path).toBe(`${process.execPath} ${FAKE_CLI}`);
    expect(health.version).toBe('2.1.319');
    expect(typeof health.authenticated).toBe('boolean');
    const missing = await ClaudeCliBridge.detect('/nope/claude');
    // Falls through to PATH search; either way no crash and a defined answer.
    expect(typeof missing.found).toBe('boolean');
  }, 30_000);
});
