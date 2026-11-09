/** Global constants shared by every A.I.M. process. Pure data — no Node or DOM APIs. */

export const APP_NAME = 'A.I.M.';
export const APP_ID = 'com.aim.desktop';
export const APP_LONG_NAME = 'Artificial Intelligence Management';

/** Brand colours. Teal is AIM's signature (icon cursor, AIM's on-screen cursor, accents). */
export const COLORS = {
  black: '#0B0B0D',
  surface: '#141417',
  surfaceRaised: '#1C1C21',
  border: '#2A2A31',
  text: '#ECECEF',
  textMuted: '#9A9AA6',
  teal: '#1ABFB0',
  tealBright: '#2EE6D6',
  tealDim: '#128C82',
  danger: '#E5484D',
  warning: '#F5A524',
  success: '#2ECC71',
} as const;

/** Local hub (Electron main) — the single process that owns tools, overlay, browser bridge. */
export const HUB_DEFAULT_PORT = 47821;
export const HUB_HOST = '127.0.0.1';
/** WebSocket paths on the hub. */
export const HUB_PATH_TOOLS = '/aim/tools'; // MCP proxy connects here
export const HUB_PATH_EXTENSION = '/aim/ext'; // browser extension connects here
export const HUB_PATH_INTERNAL = '/aim/internal'; // reserved

/** Environment variables the hub passes to the MCP proxy process. */
export const ENV_HUB_URL = 'AIM_HUB_URL';
export const ENV_HUB_TOKEN = 'AIM_HUB_TOKEN';
export const ENV_CHAT_ID = 'AIM_CHAT_ID';

/** Name of the MCP server as Claude sees it. Tool names become `mcp__aim__<tool>`. */
export const MCP_SERVER_NAME = 'aim';

/** Global shortcut to toggle the main window. */
export const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+A';

/** Default time (24h, local) at which AIM plans the day's goals. */
export const DEFAULT_DAILY_GOALS_TIME = '08:00';

/** How often the behaviour observer samples the active window (ms). */
export const OBSERVER_SAMPLE_MS = 5_000;

/** Max automatic self-repair attempts before AIM asks the user. */
export const MAX_SELF_HEAL_ATTEMPTS = 3;

/** Max parallel worker agents the orchestrator may run for one chat. */
export const MAX_PARALLEL_AGENTS = 4;
