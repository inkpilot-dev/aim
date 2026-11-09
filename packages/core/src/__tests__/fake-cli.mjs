#!/usr/bin/env node
/**
 * Fake Claude CLI for tests. Speaks the stream-json protocol well enough for the bridge/service tests.
 * Behaviour is driven by keywords in the user text:
 *   CRASH  → exit(3) without a result        FAIL → result with is_error
 *   TOOL   → tool_use + tool_result (image)  AGENT → Agent tool_use with sub-agent events
 *   SLOW   → waits 5 s before answering      "Self-repair attempt" → success "Recovered"
 *   default → streams "Echo: <text>"
 */
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.319 (Claude Code)\n');
  process.exit(0);
}
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outputFormat = opt('--output-format') ?? 'text';
const resumed = opt('--resume');
const jsonSchema = opt('--json-schema');
const sessionId = resumed ?? randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.FAKE_CLI_STDERR) process.stderr.write(process.env.FAKE_CLI_STDERR + '\n');

if (outputFormat === 'json') {
  // One-shot mode: prompt arrives on stdin.
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', () => {
    const fail = prompt.includes('FAIL');
    const r = {
      type: 'result',
      subtype: fail ? 'error_during_execution' : 'success',
      is_error: fail,
      session_id: sessionId,
      result: fail ? 'boom' : `Echo: ${prompt.trim()}`,
      duration_ms: 5,
      num_turns: 1,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (jsonSchema && !fail) r.structured_output = { echo: prompt.trim(), schema: JSON.parse(jsonSchema).type };
    process.stdout.write('some warning line that is not json\n');
    out(r);
    process.exit(fail ? 1 : 0);
  });
} else {
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: ['Bash'], mcp_servers: [{ name: 'aim', status: 'connected' }], model: 'fake' });
  let stdinEnded = false;
  let busy = 0;
  const maybeExit = () => {
    if (stdinEnded && busy === 0) process.exit(0);
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const content = msg?.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const images = Array.isArray(content) ? content.filter((b) => b.type === 'image').length : 0;
    busy++;
    handle(text, images).finally(() => {
      busy--;
      maybeExit();
    });
  });
  rl.on('close', () => {
    stdinEnded = true;
    maybeExit();
  });

  const result = (extra) =>
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, duration_ms: 12, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0.002, usage: { input_tokens: 20, output_tokens: 7 }, ...extra });

  const streamText = async (text) => {
    const id = `msg_${randomUUID().slice(0, 8)}`;
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } });
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    const half = Math.ceil(text.length / 2);
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } } });
    await sleep(5);
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } } });
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_stop' } });
    out({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  };

  async function handle(text, images) {
    if (text.includes('CRASH')) {
      process.stderr.write('fatal: simulated crash\n');
      process.exit(3);
    }
    if (text.includes('SLOW')) await sleep(5000);
    if (text.startsWith('Self-repair attempt')) {
      await streamText('Recovered');
      result({ result: 'Recovered' });
      return;
    }
    if (text.includes('FAIL')) {
      out({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { id: 'msg_fail', role: 'assistant', content: [{ type: 'text', text: 'Attempting...' }] } });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'Tool exploded: browser_click failed', duration_ms: 3, num_turns: 1, total_cost_usd: 0.001 });
      return;
    }
    if (text.includes('TOOL')) {
      out({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: 'msg_t1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__aim__screen_capture', input: { scale: 0.5 } }] },
      });
      await sleep(5);
      out({
        type: 'user',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [
                { type: 'text', text: JSON.stringify({ ok: true, data: { width: 1920, height: 1080 } }) },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
              ],
            },
          ],
        },
      });
      await streamText('Screenshot taken.');
      result({ result: 'Screenshot taken.' });
      return;
    }
    if (text.includes('AGENT')) {
      out({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: 'msg_a1', role: 'assistant', content: [{ type: 'tool_use', id: 'agent_1', name: 'Agent', input: { subagent_type: 'researcher', description: 'Find docs', prompt: 'Find the docs' } }] },
      });
      out({
        type: 'assistant',
        session_id: sessionId,
        parent_tool_use_id: 'agent_1',
        message: { id: 'msg_a2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_ws', name: 'WebSearch', input: { query: 'docs' } }] },
      });
      out({ type: 'user', session_id: sessionId, parent_tool_use_id: 'agent_1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_ws', content: 'results' }] } });
      out({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent_1', content: 'Found the docs.' }] } });
      await streamText('Delegated and done.');
      result({ result: 'Delegated and done.' });
      return;
    }
    const reply = `Echo: ${text}${images ? ` [${images} image(s)]` : ''}${resumed ? ' [resumed]' : ''}`;
    await streamText(reply);
    result({ result: reply });
  }
}
