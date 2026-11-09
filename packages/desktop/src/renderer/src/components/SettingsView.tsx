import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '@aim/shared';
import { useStore } from '../state/store';
import { IconCheck, IconCopy, IconExternal, IconFolder, IconRefresh } from './Icons';

function Group({ title, children, desc }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="section-title">{title}</span>
        {desc ? <span className="small faint">{desc}</span> : null}
      </div>
      <div className="settings-group">{children}</div>
    </section>
  );
}

function Row({ label, desc, children, col }: { label: string; desc?: string; children: ReactNode; col?: boolean }) {
  return (
    <div className={`setting ${col ? 'col' : ''}`}>
      <div className="s-text">
        <div className="s-label">{label}</div>
        {desc ? <div className="s-desc">{desc}</div> : null}
      </div>
      <div className="s-control">{children}</div>
    </div>
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="switch" role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)} />;
}

/** Text input that commits on blur / Enter so every keystroke does not hit the backend. */
function TextField({ value, onCommit, placeholder, className = '', type = 'text', mono }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; type?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      className={`input selectable ${className} ${mono ? 'mono' : ''}`}
      type={type}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function NumberField({ value, onCommit, min, max, step = 1 }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <TextField
      className="narrow"
      type="number"
      value={String(value)}
      onCommit={(s) => {
        let n = Number(s);
        if (!Number.isFinite(n)) return;
        if (min != null) n = Math.max(min, n);
        if (max != null) n = Math.min(max, n);
        onCommit(step >= 1 ? Math.round(n) : n);
      }}
    />
  );
}

function UpdatesGroup({ s, set }: { s: Settings; set: <K extends keyof Settings>(key: K, value: Settings[K]) => void }) {
  const { state, dispatch, toast } = useStore();
  const u = state.update ?? state.health?.update ?? null;
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'state' in (r as object)) dispatch({ type: 'globalEvent', event: { type: 'update', status: r as NonNullable<typeof u> } });
      if (okMsg) toast('info', okMsg);
    } catch (e) {
      toast('error', 'Update action failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stateLabel = (() => {
    if (!u) return 'Checking status…';
    switch (u.state) {
      case 'unsupported':
        return 'Development build — updates apply to installed releases only.';
      case 'disabled':
        return u.message ?? 'Updates are off.';
      case 'idle':
        return 'Not checked yet.';
      case 'checking':
        return 'Checking GitHub Releases…';
      case 'available':
        return `Version ${u.latestVersion ?? ''} is available.`;
      case 'not_available':
        return `You are on the latest version${u.checkedAt ? ` (checked ${new Date(u.checkedAt).toLocaleTimeString()})` : ''}.`;
      case 'downloading':
        return `Downloading ${u.latestVersion ?? 'update'}… ${u.percent != null ? `${Math.round(u.percent)}%` : ''}`;
      case 'downloaded':
        return `Version ${u.latestVersion ?? ''} is downloaded and ready to install.`;
      case 'error':
        return u.error ?? 'Update check failed.';
    }
  })();
  const dotClass = !u ? '' : u.state === 'downloaded' || u.state === 'not_available' ? 'ok' : u.state === 'error' ? 'danger' : u.state === 'available' || u.state === 'downloading' ? 'warning' : '';
  return (
    <Group title="Updates" desc="A.I.M. updates itself from GitHub Releases.">
      <div className="setting col">
        <div className="row between">
          <span className="status-pill">
            <span className={`dot ${dotClass}`} />
            {stateLabel}
          </span>
          <span className="small faint">
            v{u?.currentVersion ?? state.health?.version ?? ''}
            {u?.repo ? ` · ${u.repo}` : ''}
          </span>
        </div>
        {u?.state === 'downloading' && u.percent != null ? (
          <div className="progress-bar" aria-label="Download progress">
            <div className="progress-fill" style={{ width: `${Math.max(2, Math.min(100, u.percent))}%` }} />
          </div>
        ) : null}
        {u?.releaseNotes && (u.state === 'available' || u.state === 'downloaded' || u.state === 'downloading') ? <pre className="release-notes selectable">{u.releaseNotes}</pre> : null}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" disabled={busy || u?.state === 'unsupported' || u?.state === 'checking' || u?.state === 'downloading'} onClick={() => void run(() => window.aim.checkForUpdates())}>
            <IconRefresh size={13} /> Check now
          </button>
          {u?.state === 'available' ? (
            <button className="btn sm primary" disabled={busy} onClick={() => void run(() => window.aim.downloadUpdate())}>
              Download {u.latestVersion ?? ''}
            </button>
          ) : null}
          {u?.state === 'downloaded' ? (
            <button className="btn sm primary" disabled={busy} onClick={() => void run(() => window.aim.installUpdate())}>
              Restart and update
            </button>
          ) : null}
        </div>
      </div>
      <Row label="Automatic updates" desc="Check GitHub Releases on a schedule and keep A.I.M. current.">
        <Toggle value={s.updatesEnabled} onChange={(v) => set('updatesEnabled', v)} label="Automatic updates" />
      </Row>
      <Row label="Download automatically" desc="Fetch new versions in the background; they install when you quit.">
        <Toggle value={s.updatesAutoDownload} onChange={(v) => set('updatesAutoDownload', v)} label="Download automatically" />
      </Row>
      <Row label="Check every (hours)" desc="How often to look for a new release.">
        <NumberField value={s.updatesCheckIntervalHours} min={1} max={168} onCommit={(v) => set('updatesCheckIntervalHours', v)} />
      </Row>
      <Row label="GitHub repository" desc='"owner/repo" or a github.com URL hosting the releases. Leave empty to use the repository this build was published from.'>
        <TextField className="wide" mono value={s.updatesRepo} placeholder="owner/aim" onCommit={(v) => set('updatesRepo', v.trim())} />
      </Row>
      <Row label="Include pre-releases" desc="Also install beta versions marked as pre-release on GitHub.">
        <Toggle value={s.updatesAllowPrerelease} onChange={(v) => set('updatesAllowPrerelease', v)} label="Include pre-releases" />
      </Row>
      <Row label="Access token (private repositories)" desc="Only needed if the releases live in a private repository. Stored locally in settings.json.">
        <TextField className="wide" mono type="password" value={s.updatesToken} placeholder="ghp_…" onCommit={(v) => set('updatesToken', v.trim())} />
      </Row>
    </Group>
  );
}

export function SettingsView() {
  const { state, updateSettings, refreshHealth, toast, dispatch } = useStore();
  const s = state.settings;
  const health = state.health;
  const [detecting, setDetecting] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!s) {
    return (
      <div className="view">
        <div className="view-inner">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => void updateSettings({ [key]: value } as Partial<Settings>);

  const redetect = async () => {
    setDetecting(true);
    try {
      const cli = await window.aim.detectCli();
      if (health) dispatch({ type: 'health.set', health: { ...health, cli } });
      else await refreshHealth();
      toast(cli.found ? 'success' : 'warning', cli.found ? `Claude CLI found${cli.version ? ` (${cli.version})` : ''}` : 'Claude CLI not found', cli.found ? cli.path : cli.error);
    } catch (e) {
      toast('error', 'Detection failed', e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(s.hubToken || health?.hub.token || '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('warning', 'Clipboard unavailable');
    }
  };

  const cli = health?.cli;
  const ext = health?.extension;
  const token = s.hubToken || health?.hub.token || '';

  return (
    <div className="view">
      <div className="view-inner">
        <h1 className="view-title">Settings</h1>
        <p className="view-sub">Changes are saved immediately.</p>

        <Group title="Claude CLI" desc="A.I.M. uses your existing Claude Code login. No API key is stored.">
          <div className="setting col">
            <div className="row between">
              <span className="status-pill">
                <span className={`dot ${!cli ? '' : cli.found && cli.authenticated !== false ? 'ok' : cli.found ? 'warning' : 'danger'}`} />
                {!cli ? 'Checking…' : !cli.found ? 'Not found' : cli.authenticated === false ? 'Found, not signed in' : 'Ready'}
              </span>
              <button className="btn sm" onClick={() => void redetect()} disabled={detecting}>
                {detecting ? <span className="spinner" /> : <IconRefresh size={13} />}
                Re-detect
              </button>
            </div>
            <dl className="kv">
              <dt>Path</dt>
              <dd className="mono" title={cli?.path}>
                {cli?.path || '—'}
              </dd>
              <dt>Version</dt>
              <dd>{cli?.version || '—'}</dd>
              <dt>Auth</dt>
              <dd>{cli ? (cli.authenticated === undefined ? 'Unknown' : cli.authenticated ? 'Signed in' : 'Not signed in') : '—'}</dd>
              {cli?.error ? (
                <>
                  <dt>Error</dt>
                  <dd style={{ color: 'var(--danger)', whiteSpace: 'normal' }}>{cli.error}</dd>
                </>
              ) : null}
            </dl>
          </div>
          <Row label="CLI path" desc="Leave empty to auto-detect.">
            <TextField className="wide" mono value={s.claudeCliPath} placeholder="auto" onCommit={(v) => set('claudeCliPath', v.trim())} />
          </Row>
          <Row label="Model" desc="Passed to the CLI as --model.">
            <select className="select" value={s.model} onChange={(e) => set('model', e.target.value)}>
              <option value="">CLI default</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="fable">Fable</option>
              <option value="haiku">Haiku</option>
            </select>
          </Row>
          <Row label="Effort" desc="Reasoning effort for each turn.">
            <select className="select" value={s.effort} onChange={(e) => set('effort', e.target.value as Settings['effort'])}>
              <option value="">CLI default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
              <option value="max">Maximum</option>
            </select>
          </Row>
          <Row label="Default working directory" desc="Where new chats run. Empty = your home folder.">
            <TextField className="wide" mono value={s.defaultCwd} placeholder="~" onCommit={(v) => set('defaultCwd', v.trim())} />
          </Row>
          <Row label="Per-turn budget (USD)" desc="Cap passed to the CLI. 0 = no cap.">
            <NumberField value={s.maxBudgetUsdPerTurn} min={0} step={0.5} onCommit={(v) => set('maxBudgetUsdPerTurn', v)} />
          </Row>
        </Group>

        <Group title="Browser extension" desc="Lets A.I.M. drive Edge or Chrome in background tabs.">
          <div className="setting col">
            <div className="row between">
              <span className="status-pill">
                <span className={`dot ${!ext ? '' : ext.connected ? 'ok' : 'danger'}`} />
                {!ext ? 'Checking…' : ext.connected ? `Connected${ext.browser ? ` — ${ext.browser}` : ''}${ext.tabs != null ? `, ${ext.tabs} tab${ext.tabs === 1 ? '' : 's'}` : ''}` : 'Disconnected'}
              </span>
              <span className="small faint">
                Hub {health?.hub.listening ? 'listening' : 'offline'} on port {health?.hub.port ?? s.hubPort}
              </span>
            </div>
            <div className="token-box">
              <span className="small muted" style={{ flex: 'none' }}>
                Pairing token
              </span>
              <code title={token}>{token || '—'}</code>
              <button className="btn sm" onClick={() => void copyToken()} disabled={!token}>
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                className="btn sm ghost"
                title="Generate a new pairing token. The extension must be paired again."
                onClick={() => {
                  if (!window.confirm('Generate a new pairing token? The browser extension will disconnect until you paste the new token.')) return;
                  const bytes = new Uint8Array(24);
                  crypto.getRandomValues(bytes);
                  set('hubToken', Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
                }}
              >
                <IconRefresh size={13} /> Regenerate
              </button>
            </div>
          </div>
          <Row label="Hub port" desc="Local WebSocket port the extension and tools connect to. Restart required.">
            <NumberField value={s.hubPort} min={1024} max={65535} onCommit={(v) => set('hubPort', v)} />
          </Row>
          <Row label="Preferred browser" desc="Which browser A.I.M. launches when none is open.">
            <select className="select" value={s.preferredBrowser} onChange={(e) => set('preferredBrowser', e.target.value)}>
              <option value="">System default</option>
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
            </select>
          </Row>
          <div className="setting col">
            <div className="s-label">How to install the extension</div>
            <ol className="steps">
              <li>
                In Edge open <code>edge://extensions</code> (Chrome: <code>chrome://extensions</code>) and turn on <strong>Developer mode</strong>.
              </li>
              <li>
                Choose <strong>Load unpacked</strong> and select the <code>extension</code> folder shipped with A.I.M.
                {health?.paths?.extensionDir ? (
                  <div className="token-box" style={{ marginTop: 6 }}>
                    <code title={health.paths.extensionDir}>{health.paths.extensionDir}</code>
                    <button className="btn sm" onClick={() => void window.aim.openPath(health.paths!.extensionDir)}>
                      <IconFolder size={13} /> Open folder
                    </button>
                  </div>
                ) : null}
              </li>
              <li>Click the A.I.M. extension icon in the toolbar and paste the pairing token above.</li>
              <li>The status above turns to Connected within a few seconds.</li>
            </ol>
            <div>
              <button
                className="btn sm ghost"
                disabled={!health?.paths?.docsDir}
                onClick={() => void window.aim.openPath(`${health?.paths?.docsDir ?? ''}/EXTENSION.md`)}
              >
                <IconExternal size={13} /> Full guide (docs/EXTENSION.md)
              </button>
            </div>
          </div>
        </Group>

        <UpdatesGroup s={s} set={set} />

        <Group title="Autonomy">
          <Row label="Daily goals" desc="Plan concrete goals from your directives every day.">
            <input className="input narrow" type="time" value={s.dailyGoalsTime} disabled={!s.dailyGoalsEnabled} onChange={(e) => set('dailyGoalsTime', e.target.value)} aria-label="Daily goals time" />
            <Toggle value={s.dailyGoalsEnabled} onChange={(v) => set('dailyGoalsEnabled', v)} label="Daily goals" />
          </Row>
          <Row label="Run goals automatically" desc="Execute each planned goal in its own chat. Off = plan only.">
            <Toggle value={s.autoRunGoals} onChange={(v) => set('autoRunGoals', v)} label="Auto-run goals" />
          </Row>
          <Row label="Behaviour observer" desc="Sample the active window to learn your routines. Stays on this device.">
            <Toggle value={s.observerEnabled} onChange={(v) => set('observerEnabled', v)} label="Behaviour observer" />
          </Row>
          <Row label="Reflection" desc="After each turn, extract memories and a chat title with a small model.">
            <Toggle value={s.reflectionEnabled} onChange={(v) => set('reflectionEnabled', v)} label="Reflection" />
          </Row>
          <Row label="Self-repair attempts" desc="Automatic retries before A.I.M. asks you for help.">
            <NumberField value={s.maxSelfHealAttempts} min={0} max={10} onCommit={(v) => set('maxSelfHealAttempts', v)} />
          </Row>
          <Row label="Max parallel agents" desc="Worker agents one chat may run at once.">
            <NumberField value={s.maxParallelAgents} min={1} max={16} onCommit={(v) => set('maxParallelAgents', v)} />
          </Row>
          <Row label="Payment guard" desc="A.I.M. never completes purchases or enters card details. Always on.">
            <span className="tag success">Enforced</span>
          </Row>
        </Group>

        <Group title="Appearance and behaviour">
          <Row label="Theme">
            <select className="select narrow" value={s.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </Row>
          <Row label="Show thinking" desc="Reveal the model's reasoning blocks in chats.">
            <Toggle value={s.showThinking} onChange={(v) => set('showThinking', v)} label="Show thinking" />
          </Row>
          <Row label="Desktop cursor overlay" desc="Draw A.I.M.'s teal cursor on screen while it controls the mouse.">
            <Toggle value={s.desktopCursorOverlay} onChange={(v) => set('desktopCursorOverlay', v)} label="Desktop cursor overlay" />
          </Row>
          <Row label="Toggle window shortcut" desc="Global shortcut in Electron accelerator syntax.">
            <TextField mono value={s.toggleShortcut} onCommit={(v) => set('toggleShortcut', v.trim())} />
          </Row>
          <Row label="Launch at login">
            <Toggle value={s.launchAtLogin} onChange={(v) => set('launchAtLogin', v)} label="Launch at login" />
          </Row>
          <Row label="Start minimised" desc="Start in the tray without showing the window.">
            <Toggle value={s.startMinimized} onChange={(v) => set('startMinimized', v)} label="Start minimised" />
          </Row>
        </Group>

        <p className="small faint" style={{ textAlign: 'center' }}>
          A.I.M. {health?.version ? `v${health.version}` : ''} {health?.platform ? `· ${health.platform}` : ''}
        </p>
      </div>
    </div>
  );
}
