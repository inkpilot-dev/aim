/**
 * ClaudeCliBridge — spawns the Claude Code CLI in headless stream-json mode and turns its stdout
 * into typed CliEvents. One process per turn. Also provides one-shot runs (`runOnce`) for the
 * learning layer and `detect()` for health checks.
 *
 *   claude -p --verbose --output-format stream-json --input-format stream-json --include-partial-messages
 *          --permission-mode bypassPermissions --dangerously-skip-permissions [--resume id] [--model m] ...
 */
import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ApiContentBlock, CliEvent, CliHealth, CliResultMessage, CliUserInput } from '@aim/shared';
import { isCliInit, isCliResult } from '@aim/shared';
import { createLogger, type Logger } from './logger.js';

export interface CliRunOptions {
  cwd: string;
  /** Resume this Claude session. */
  sessionId?: string;
  model?: string;
  effort?: string;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  /** JSON for --agents. */
  agentsJson?: string;
  /** JSON for --mcp-config (sent with --strict-mcp-config). */
  mcpConfigJson?: string;
  addDirs?: string[];
  env?: Record<string, string>;
  /** Structured output schema (one-shot runs only). */
  jsonSchema?: object;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface CliRunResult {
  ok: boolean;
  sessionId?: string;
  resultText?: string;
  structured?: unknown;
  isError: boolean;
  errorMessage?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  exitCode: number | null;
}

export interface CliTurnHandle {
  readonly pid: number | undefined;
  /** Resolves with the session id from `system/init`; resolves with '' if the process ends before init. */
  readonly sessionId: Promise<string>;
  send(input: { text: string; images?: { mediaType: string; dataBase64: string }[] }): void;
  /** Close stdin: the CLI finishes the current turn and exits. */
  end(): void;
  /** Terminate the process (SIGTERM, then SIGKILL). */
  abort(): void;
  /** Resolves on the `result` event, or on exit/timeout/abort without one. Never rejects. */
  readonly done: Promise<CliRunResult>;
  on(event: 'event', cb: (e: CliEvent) => void): () => void;
  on(event: 'stderr', cb: (line: string) => void): () => void;
}

/** What the learning layer depends on. */
export interface OneShotRunner {
  runOnce(prompt: string, opts: CliRunOptions): Promise<CliRunResult>;
}

export interface ClaudeCliBridgeOptions {
  /** Path to the claude executable. Defaults to `claude` on PATH. May contain a space-separated prefix (e.g. `node script.js`) if the path itself is not an existing file. */
  cliPath?: string;
  /** Arguments inserted before the CLI flags (e.g. a script path when cliPath is `node`). Mainly for tests. */
  argvPrefix?: string[];
  /**
   * Pass the system prompt, agents JSON and MCP config inline on the command line instead of through temp files.
   * Files are the default: they dodge cmd.exe's 8 191-character limit and its quoting rules on Windows.
   */
  inlineArgs?: boolean;
  log?: Logger;
}

/** Temp files that stand in for the large inline values. */
export interface ArgFiles {
  systemPrompt?: string;
  agents?: string;
  mcpConfig?: string;
}

/** Grace period after `result` before the process is killed if it has not exited on its own. */
const EXIT_GRACE_MS = 5_000;
/** Time between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;
const VERSION_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 20;

type Listener<T> = (v: T) => void;

/** Resolved command + fixed leading args + whether a shell is needed (Windows .cmd shims). */
interface Command {
  file: string;
  prefix: string[];
  shell: boolean;
}

function quoteForShell(arg: string): string {
  // Windows cmd.exe quoting: wrap in double quotes, escape inner double quotes.
  if (/^[A-Za-z0-9_\-=./:\\]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function resolveCommand(cliPath: string | undefined, argvPrefix: string[] | undefined): Command {
  let file = cliPath?.trim() || 'claude';
  let prefix: string[] = argvPrefix ? [...argvPrefix] : [];
  if (!argvPrefix && file.includes(' ') && !fs.existsSync(file)) {
    // Allow `node /path/to/script.js` style values.
    const parts = file.split(/\s+/).filter(Boolean);
    file = parts[0];
    prefix = parts.slice(1);
  }
  const lower = file.toLowerCase();
  if (process.platform === 'win32' && lower.endsWith('.ps1')) {
    return { file: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...prefix], shell: false };
  }
  const shell = process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat') || !path.extname(file));
  return { file, prefix, shell };
}

/** Builds the argv shared by streaming and one-shot runs. */
function commonArgs(opts: CliRunOptions, files: ArgFiles = {}): string[] {
  const args: string[] = ['-p', '--verbose', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  if (opts.appendSystemPrompt) {
    if (files.systemPrompt) args.push('--append-system-prompt-file', files.systemPrompt);
    else args.push('--append-system-prompt', opts.appendSystemPrompt);
  }
  if (opts.agentsJson) args.push('--agents', files.agents ?? opts.agentsJson);
  if (opts.mcpConfigJson) args.push('--mcp-config', files.mcpConfig ?? opts.mcpConfigJson, '--strict-mcp-config');
  return args;
}

const TMP_SUBDIR = 'aim-cli';

/**
 * Writes the large option values to temp files. Returns the paths and a cleanup function.
 * Never throws: on failure the values stay inline.
 */
export function writeArgFiles(opts: CliRunOptions, log: Logger): { files: ArgFiles; cleanup: () => void } {
  const files: ArgFiles = {};
  const written: string[] = [];
  const dir = path.join(os.tmpdir(), TMP_SUBDIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const put = (name: string, content: string): string => {
      const p = path.join(dir, `${stamp}-${name}`);
      fs.writeFileSync(p, content, 'utf8');
      written.push(p);
      return p;
    };
    if (opts.appendSystemPrompt) files.systemPrompt = put('system.md', opts.appendSystemPrompt);
    if (opts.agentsJson) files.agents = put('agents.json', opts.agentsJson);
    if (opts.mcpConfigJson) files.mcpConfig = put('mcp.json', opts.mcpConfigJson);
  } catch (err) {
    log.warn('could not write CLI arg files; passing values inline', err);
    for (const p of written) fs.rmSync(p, { force: true });
    return { files: {}, cleanup: () => undefined };
  }
  return {
    files,
    cleanup: () => {
      for (const p of written) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}

/** `--add-dir` is variadic, so it always goes last. */
function addDirArgs(opts: CliRunOptions): string[] {
  return opts.addDirs && opts.addDirs.length > 0 ? ['--add-dir', ...opts.addDirs] : [];
}

export function buildStreamArgs(opts: CliRunOptions, files?: ArgFiles): string[] {
  return [...commonArgs(opts, files), '--output-format', 'stream-json', '--input-format', 'stream-json', '--include-partial-messages', ...addDirArgs(opts)];
}

export function buildOnceArgs(opts: CliRunOptions, files?: ArgFiles): string[] {
  const args = [...commonArgs(opts, files), '--output-format', 'json'];
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  return [...args, ...addDirArgs(opts)];
}

function killTree(child: ChildProcess, log: Logger): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32' && pid) {
    // With shell:true, child.kill() would only kill cmd.exe; taskkill /T takes the tree down.
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => undefined);
    } catch (err) {
      log.warn('taskkill failed', err);
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch (err) {
    log.warn('SIGTERM failed', err);
  }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, KILL_GRACE_MS);
  t.unref();
}

/** Parses the version string out of `claude --version` output ("2.1.319 (Claude Code)"). */
export function parseVersion(out: string): string | undefined {
  const m = out.match(/(\d+\.\d+\.\d+[\w.-]*)/);
  return m ? m[1] : undefined;
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Candidate locations for the CLI beyond PATH. */
export function candidateCliPaths(): string[] {
  const home = homeDir();
  const list: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(appData, 'npm', 'claude'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.cmd'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(localAppData, 'Programs', 'Claude Code', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(home, '.local', 'bin', 'claude.cmd'),
      path.join(home, 'scoop', 'shims', 'claude.cmd'),
      'C:\\Program Files\\nodejs\\claude.cmd',
    );
  } else {
    list.push(
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
      path.join(home, 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/opt/node22/bin/claude',
      '/opt/claude-code/bin/claude',
    );
    const nvm = process.env.NVM_BIN;
    if (nvm) list.push(path.join(nvm, 'claude'));
  }
  return list;
}

function findOnPath(): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude.bat', 'claude.ps1', 'claude'] : ['claude'];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** Runs `<cli> --version` with a timeout. */
function getVersion(cliPath: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const cmd = resolveCommand(cliPath, undefined);
    const args = [...cmd.prefix, '--version'];
    const file = cmd.shell ? [quoteForShell(cmd.file), ...args.map(quoteForShell)].join(' ') : cmd.file;
    let settled = false;
    const finish = (r: { ok: boolean; version?: string; error?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = execFile(
        file,
        cmd.shell ? [] : args,
        { timeout: VERSION_TIMEOUT_MS, shell: cmd.shell, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            finish({ ok: false, error: err.message || String(stderr) });
            return;
          }
          const v = parseVersion(`${stdout}\n${stderr}`);
          finish(v ? { ok: true, version: v } : { ok: true, version: String(stdout).trim() || undefined });
        },
      );
      child.on('error', (err) => finish({ ok: false, error: err.message }));
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function hasCredentials(): boolean {
  const home = homeDir();
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const candidates = [path.join(home, '.claude.json'), path.join(cfgDir, '.credentials.json'), path.join(home, '.claude', '.credentials.json')];
  return candidates.some((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Internal event emitter without Node's EventEmitter error semantics. */
class Emitter {
  private readonly listeners = new Map<string, Set<Listener<never>>>();
  on<T>(name: string, cb: Listener<T>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb as Listener<never>);
    return () => {
      set?.delete(cb as Listener<never>);
    };
  }
  emit<T>(name: string, value: T, log: Logger): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Listener<T>)(value);
      } catch (err) {
        log.error(`listener for '${name}' threw`, err);
      }
    }
  }
}

export class ClaudeCliBridge implements OneShotRunner {
  private readonly cliPath?: string;
  private readonly argvPrefix?: string[];
  private readonly inlineArgs: boolean;
  private readonly log: Logger;
  private readonly live = new Set<ChildProcess>();

  constructor(opts: ClaudeCliBridgeOptions = {}) {
    this.cliPath = opts.cliPath;
    this.argvPrefix = opts.argvPrefix;
    this.inlineArgs = opts.inlineArgs ?? false;
    this.log = opts.log ?? createLogger('core:cli');
  }

  /** Large values go to temp files unless inline mode was requested. */
  private argFiles(opts: CliRunOptions): { files: ArgFiles; cleanup: () => void } {
    if (this.inlineArgs) return { files: {}, cleanup: () => undefined };
    return writeArgFiles(opts, this.log);
  }

  /** Find the CLI, check its version and whether a login appears to exist. No network calls. */
  static async detect(explicitPath?: string): Promise<CliHealth> {
    const tried: string[] = [];
    const candidates: string[] = [];
    if (explicitPath?.trim()) candidates.push(explicitPath.trim());
    const onPath = findOnPath();
    if (onPath) candidates.push(onPath);
    candidates.push(...candidateCliPaths());
    if (!explicitPath) candidates.push('claude'); // let the OS resolve it as a last resort

    for (const c of candidates) {
      const isBare = c === 'claude';
      // The explicit setting may be a command line such as "node wrapper.js" (see resolveCommand), which is
      // not a file on disk; always try it. Auto-detected candidates must exist as files.
      const isExplicit = !!explicitPath?.trim() && c === explicitPath.trim();
      if (!isBare && !isExplicit) {
        try {
          if (!fs.statSync(c).isFile()) continue;
        } catch {
          continue;
        }
      }
      tried.push(c);
      const v = await getVersion(c);
      if (v.ok) {
        return { found: true, path: c, version: v.version, authenticated: hasCredentials() };
      }
    }
    return {
      found: false,
      error: tried.length ? `Claude CLI did not respond to --version (tried: ${tried.join(', ')})` : 'Claude CLI not found. Install it with `npm install -g @anthropic-ai/claude-code`.',
      authenticated: hasCredentials(),
    };
  }

  private spawnCli(args: string[], opts: CliRunOptions): ChildProcess {
    const cmd = resolveCommand(this.cliPath, this.argvPrefix);
    // A configured path (as opposed to a bare command name resolved through PATH) must exist. Checking up
    // front gives the same clear error on every platform; on Windows a shell spawn of a missing file would
    // otherwise just exit 1 with "The system cannot find the path specified".
    if (cmd.prefix.length === 0 && (path.isAbsolute(cmd.file) || cmd.file.includes(path.sep)) && !fs.existsSync(cmd.file)) {
      throw new Error(`${cmd.file} does not exist`);
    }
    const fullArgs = [...cmd.prefix, ...args];
    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
    // Keep the CLI from trying to open a browser / IDE and avoid nested-session confusion.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // Load every tool up front. With deferred tool search the model must call ToolSearch before each
    // deferred tool, which in headless sessions produced long loops of ToolSearch calls.
    if (!env.ENABLE_TOOL_SEARCH) env.ENABLE_TOOL_SEARCH = 'false';
    const spawnOpts: SpawnOptions = { cwd: opts.cwd || homeDir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
    let child: ChildProcess;
    if (cmd.shell) {
      const line = [quoteForShell(cmd.file), ...fullArgs.map(quoteForShell)].join(' ');
      child = spawn(line, { ...spawnOpts, shell: true });
    } else {
      child = spawn(cmd.file, fullArgs, spawnOpts);
    }
    this.live.add(child);
    child.once('exit', () => this.live.delete(child));
    child.once('error', () => this.live.delete(child));
    return child;
  }

  start(opts: CliRunOptions): CliTurnHandle {
    const log = this.log;
    const emitter = new Emitter();
    const { files, cleanup } = this.argFiles(opts);
    const args = buildStreamArgs(opts, files);
    log.debug('spawn', args.filter((a) => a.length < 200).join(' '));

    let child: ChildProcess | undefined;
    let spawnError: Error | undefined;
    try {
      child = this.spawnCli(args, opts);
    } catch (err) {
      spawnError = err instanceof Error ? err : new Error(String(err));
    }
    if (child) child.once('close', cleanup);
    else cleanup();

    const stderrTail: string[] = [];
    let settledDone = false;
    let resultEvent: CliResultMessage | undefined;
    let sessionId = opts.sessionId ?? '';
    let initSeen = false;
    let exited = false;
    let exitCode: number | null = null;
    let abortReason: string | undefined;
    let stdinClosed = false;

    let resolveSession!: (s: string) => void;
    const sessionPromise = new Promise<string>((res) => {
      resolveSession = res;
    });
    let resolveDone!: (r: CliRunResult) => void;
    const donePromise = new Promise<CliRunResult>((res) => {
      resolveDone = res;
    });

    const timers: NodeJS.Timeout[] = [];
    const clearTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };

    const finish = (partial: Partial<CliRunResult> & { isError: boolean }) => {
      if (settledDone) return;
      settledDone = true;
      clearTimers();
      resolveSession(sessionId);
      const r: CliRunResult = {
        ok: !partial.isError,
        isError: partial.isError,
        exitCode: partial.exitCode ?? exitCode,
        sessionId: sessionId || undefined,
        resultText: partial.resultText,
        structured: partial.structured,
        errorMessage: partial.errorMessage,
        costUsd: partial.costUsd,
        durationMs: partial.durationMs,
        numTurns: partial.numTurns,
      };
      resolveDone(r);
    };

    const fromResult = (r: CliResultMessage, code: number | null): void => {
      const err = r.is_error || r.subtype !== 'success';
      const errorMessage = err ? describeResultError(r) : undefined;
      finish({
        isError: err,
        exitCode: code,
        resultText: typeof r.result === 'string' ? r.result : undefined,
        structured: r.structured_output,
        errorMessage,
        costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
        durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : undefined,
        numTurns: typeof r.num_turns === 'number' ? r.num_turns : undefined,
      });
    };

    const closeStdin = () => {
      if (stdinClosed) return;
      stdinClosed = true;
      try {
        child?.stdin?.end();
      } catch {
        /* ignore */
      }
    };

    const abort = (reason: string) => {
      if (!abortReason) abortReason = reason;
      closeStdin();
      if (child) killTree(child, log);
      if (!child || exited) finish({ isError: true, errorMessage: reason });
    };

    if (child) {
      child.stdin?.on('error', (err) => log.debug('stdin error', err.message));

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: CliEvent | undefined;
        if (trimmed.startsWith('{')) {
          try {
            ev = JSON.parse(trimmed) as CliEvent;
          } catch {
            ev = undefined;
          }
        }
        if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
          // Not an event: treat as diagnostic output.
          emitter.emit('stderr', trimmed, log);
          return;
        }
        if (isCliInit(ev)) {
          initSeen = true;
          sessionId = ev.session_id;
          resolveSession(sessionId);
        } else if (typeof (ev as { session_id?: unknown }).session_id === 'string' && !initSeen) {
          sessionId = (ev as { session_id: string }).session_id;
        }
        emitter.emit('event', ev, log);
        if (isCliResult(ev)) {
          resultEvent = ev;
          if (ev.session_id) sessionId = ev.session_id;
          // Resolve immediately so the caller can proceed; the process gets a grace period to exit.
          fromResult(ev, null);
          closeStdin();
          const t = setTimeout(() => {
            if (!exited && child) {
              log.warn('CLI did not exit after result; killing', child.pid);
              killTree(child, log);
            }
          }, EXIT_GRACE_MS);
          t.unref();
          timers.push(t);
        }
      });

      const errRl = readline.createInterface({ input: child.stderr!, crlfDelay: Infinity });
      errRl.on('line', (line) => {
        if (!line.trim()) return;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        emitter.emit('stderr', line, log);
      });

      child.once('error', (err) => {
        log.error('CLI spawn error', err);
        exited = true;
        finish({ isError: true, errorMessage: `Failed to start Claude CLI: ${err.message}`, exitCode: null });
      });

      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
      });
      // 'close' fires once stdio has drained, so every stdout line has been seen by then.
      child.once('close', (code, signal) => {
        exited = true;
        exitCode = code;
        setImmediate(() => {
          rl.close();
          errRl.close();
          if (settledDone) return;
          if (resultEvent) {
            fromResult(resultEvent, code);
            return;
          }
          if (abortReason) {
            finish({ isError: true, errorMessage: abortReason, exitCode: code });
            return;
          }
          const tail = stderrTail.slice(-5).join('\n').trim();
          const why = signal ? `signal ${signal}` : `exit code ${code}`;
          finish({ isError: true, errorMessage: `Claude CLI exited (${why}) without a result${tail ? `: ${tail}` : ''}`, exitCode: code });
        });
      });
    } else {
      // Spawn threw synchronously (e.g. invalid cwd).
      setImmediate(() => finish({ isError: true, errorMessage: `Failed to start Claude CLI: ${spawnError?.message ?? 'unknown error'}`, exitCode: null }));
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const t = setTimeout(() => abort(`Turn timed out after ${Math.round(opts.timeoutMs! / 1000)} s`), opts.timeoutMs);
      t.unref();
      timers.push(t);
    }
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) abort('Aborted');
      else opts.abortSignal.addEventListener('abort', () => abort('Aborted'), { once: true });
    }

    const handle: CliTurnHandle = {
      get pid() {
        return child?.pid;
      },
      sessionId: sessionPromise,
      done: donePromise,
      send: (input) => {
        if (!child || stdinClosed || exited) {
          log.warn('send() after stdin closed — ignored');
          return;
        }
        const content: ApiContentBlock[] = [];
        if (input.text) content.push({ type: 'text', text: input.text });
        for (const img of input.images ?? []) {
          content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
        }
        if (content.length === 0) content.push({ type: 'text', text: '(empty message)' });
        const msg: CliUserInput = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
        if (sessionId) msg.session_id = sessionId;
        try {
          child.stdin?.write(`${JSON.stringify(msg)}\n`);
        } catch (err) {
          log.error('stdin write failed', err);
        }
      },
      end: closeStdin,
      abort: () => abort('Aborted'),
      on: ((event: 'event' | 'stderr', cb: Listener<never>) => emitter.on(event, cb)) as CliTurnHandle['on'],
    };
    return handle;
  }

  /** One-shot text/JSON run. The prompt goes through stdin to dodge command-line length limits. */
  async runOnce(prompt: string, opts: CliRunOptions): Promise<CliRunResult> {
    const log = this.log;
    const { files, cleanup } = this.argFiles(opts);
    const args = buildOnceArgs(opts, files);
    return new Promise<CliRunResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnCli(args, opts);
      } catch (err) {
        cleanup();
        resolve({ ok: false, isError: true, errorMessage: `Failed to start Claude CLI: ${err instanceof Error ? err.message : String(err)}`, exitCode: null });
        return;
      }
      child.once('close', cleanup);
      let settled = false;
      let stdout = '';
      let stderr = '';
      const timers: NodeJS.Timeout[] = [];
      const finish = (r: CliRunResult) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        resolve(r);
      };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        stdout += d;
      });
      child.stderr?.on('data', (d: string) => {
        stderr += d;
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });
      child.stdin?.on('error', (err) => log.debug('stdin error', err.message));
      child.once('error', (err) => finish({ ok: false, isError: true, errorMessage: `Failed to start Claude CLI: ${err.message}`, exitCode: null }));
      child.once('close', (code, signal) => {
        setImmediate(() => {
          const parsed = parseOnceOutput(stdout);
          if (!parsed) {
            const tail = stderr.trim().split('\n').slice(-5).join('\n');
            finish({
              ok: false,
              isError: true,
              exitCode: code,
              errorMessage: `Claude CLI exited (${signal ? `signal ${signal}` : `exit code ${code}`}) without a JSON result${tail ? `: ${tail}` : ''}`,
            });
            return;
          }
          const err = parsed.is_error || (parsed.subtype !== undefined && parsed.subtype !== 'success');
          let structured: unknown = parsed.structured_output;
          if (structured === undefined && typeof parsed.result === 'string' && opts.jsonSchema) {
            structured = tryParseJson(parsed.result);
          }
          finish({
            ok: !err && (code === 0 || code === null),
            isError: err,
            exitCode: code,
            sessionId: parsed.session_id,
            resultText: typeof parsed.result === 'string' ? parsed.result : undefined,
            structured,
            errorMessage: err ? describeResultError(parsed) : undefined,
            costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
            durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
            numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined,
          });
        });
      });
      const abort = (reason: string) => {
        killTree(child, log);
        const t = setTimeout(() => finish({ ok: false, isError: true, errorMessage: reason, exitCode: child.exitCode }), KILL_GRACE_MS + 500);
        t.unref();
        timers.push(t);
        // If the process exits promptly, the exit handler produces the final result (or the reason wins if no JSON came back).
        child.once('close', () => {
          if (!settled) {
            const parsed = parseOnceOutput(stdout);
            if (!parsed) finish({ ok: false, isError: true, errorMessage: reason, exitCode: child.exitCode });
          }
        });
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const t = setTimeout(() => abort(`Run timed out after ${Math.round(opts.timeoutMs! / 1000)} s`), opts.timeoutMs);
        t.unref();
        timers.push(t);
      }
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) abort('Aborted');
        else opts.abortSignal.addEventListener('abort', () => abort('Aborted'), { once: true });
      }
      try {
        child.stdin?.end(prompt);
      } catch (err) {
        log.error('stdin write failed', err);
      }
    });
  }

  /** Kill every process this bridge started (shutdown). */
  dispose(): void {
    for (const c of [...this.live]) killTree(c, this.log);
    this.live.clear();
  }

  /** Number of CLI processes currently alive. */
  get liveProcessCount(): number {
    return this.live.size;
  }
}

function tryParseJson(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // Model may have wrapped JSON in a code fence.
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** `--output-format json` prints one JSON object; be tolerant of extra lines (warnings) around it. */
export function parseOnceOutput(stdout: string): CliResultMessage | undefined {
  const t = stdout.trim();
  if (!t) return undefined;
  const whole = tryParseJson(t);
  if (isResultLike(whole)) return whole;
  if (Array.isArray(whole)) {
    const r = [...whole].reverse().find(isResultLike);
    if (r) return r;
  }
  let found: CliResultMessage | undefined;
  for (const line of t.split('\n')) {
    const v = tryParseJson(line);
    if (isResultLike(v)) found = v;
  }
  return found;
}

function isResultLike(v: unknown): v is CliResultMessage {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'result';
}

export function describeResultError(r: CliResultMessage): string {
  if (r.subtype === 'error_max_turns') return 'The CLI reached its maximum number of turns.';
  if (r.subtype === 'error_max_budget_usd') return 'The per-turn budget was exhausted.';
  if (Array.isArray(r.errors) && r.errors.length) {
    const first = r.errors[0];
    const msg = typeof first === 'string' ? first : (first as { message?: string })?.message;
    if (msg) return msg;
  }
  if (typeof r.result === 'string' && r.result.trim()) return r.result.trim();
  return r.subtype === 'success' ? 'The CLI reported an error.' : `The CLI ended with ${r.subtype}.`;
}
