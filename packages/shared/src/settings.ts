import { DEFAULT_DAILY_GOALS_TIME, DEFAULT_TOGGLE_SHORTCUT, HUB_DEFAULT_PORT, COLORS } from './constants.js';

export interface Settings {
  /** Path to the claude CLI (auto-detected when empty). */
  claudeCliPath: string;
  /** Model alias passed to the CLI, e.g. "sonnet" | "opus" | "fable" | ""(default). */
  model: string;
  /** Effort level, '' = CLI default. */
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Working directory for chats; empty = user home. */
  defaultCwd: string;
  hubPort: number;
  /** Pairing token the extension must present. Generated on first run. */
  hubToken: string;
  toggleShortcut: string;
  launchAtLogin: boolean;
  startMinimized: boolean;
  theme: 'dark' | 'light' | 'system';
  cursorColor: string;
  /** Show AIM's teal cursor overlay on the desktop when AIM uses mouse tools. */
  desktopCursorOverlay: boolean;
  /** Daily goal planning. */
  dailyGoalsEnabled: boolean;
  dailyGoalsTime: string; // HH:mm
  /** Execute planned goals automatically (vs. plan-only). */
  autoRunGoals: boolean;
  /** Behaviour observer (active window sampling). */
  observerEnabled: boolean;
  /** Post-turn reflection to extract memories. */
  reflectionEnabled: boolean;
  /** Payment guard — always on; exposed for display only. */
  paymentGuard: true;
  maxSelfHealAttempts: number;
  maxParallelAgents: number;
  /** Per-run budget cap passed to the CLI (USD). 0 = none. */
  maxBudgetUsdPerTurn: number;
  /** Which browser AIM should prefer when launching ("msedge" | "chrome" | ""=default). */
  preferredBrowser: string;
  /** Extra directories the CLI may access. */
  additionalDirs: string[];
  /** Show thinking blocks in the chat. */
  showThinking: boolean;
  /** Self-update from GitHub Releases (electron-updater). */
  updatesEnabled: boolean;
  /** Download new versions automatically (install happens on quit or on demand). */
  updatesAutoDownload: boolean;
  /** "owner/repo" or a github.com URL. Empty = the repository baked in at build time. */
  updatesRepo: string;
  /** Accept pre-release (beta) versions. */
  updatesAllowPrerelease: boolean;
  /** Personal access token, only needed when releases are in a private repository. Stored locally. */
  updatesToken: string;
  /** Hours between automatic update checks. */
  updatesCheckIntervalHours: number;
  /** Telemetry-free; kept for future. */
  version: number;
}

export const DEFAULT_SETTINGS: Settings = {
  claudeCliPath: '',
  model: '',
  effort: '',
  defaultCwd: '',
  hubPort: HUB_DEFAULT_PORT,
  hubToken: '',
  toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
  launchAtLogin: true,
  startMinimized: false,
  theme: 'dark',
  cursorColor: COLORS.teal,
  desktopCursorOverlay: true,
  dailyGoalsEnabled: true,
  dailyGoalsTime: DEFAULT_DAILY_GOALS_TIME,
  autoRunGoals: true,
  observerEnabled: true,
  reflectionEnabled: true,
  paymentGuard: true,
  maxSelfHealAttempts: 3,
  maxParallelAgents: 4,
  maxBudgetUsdPerTurn: 0,
  preferredBrowser: '',
  additionalDirs: [],
  showThinking: false,
  updatesEnabled: true,
  updatesAutoDownload: true,
  updatesRepo: '',
  updatesAllowPrerelease: false,
  updatesToken: '',
  updatesCheckIntervalHours: 6,
  version: 1,
};
