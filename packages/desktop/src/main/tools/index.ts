/** Assemble every tool implementation and the policy context for the ToolRouter. */
import { AIM_TOOLS } from '@aim/shared';
import type { AppContext } from '../context.js';
import { createBrowserTools } from './browser.js';
import { createChatTools } from './chat-tools.js';
import { createInputTools } from './input.js';
import { createMemoryTools } from './memory-tools.js';
import { createScreenTools } from './screen.js';
import { createSystemTools } from './system.js';
import { ToolRouter } from './tool-router.js';
import { createWindowTools } from './windows.js';

export interface ToolRouterHooks {
  onMemoryChanged?: () => void;
  onGoalsChanged?: () => void;
  onNotify?: (title: string, body: string) => void;
  onExtensionMissing?: () => void;
  appVersion: string;
  iconPath?: string;
}

export function createToolRouter(ctx: AppContext, hooks: ToolRouterHooks): ToolRouter {
  const log = ctx.log.child('tools');
  const browser = createBrowserTools({ hub: ctx.hub, log, onNotConnected: hooks.onExtensionMissing });
  const impls = {
    ...createScreenTools({ activeWindow: ctx.activeWindow, hub: ctx.hub, log }),
    ...createInputTools({ overlay: ctx.overlay, log }),
    ...createWindowTools({ settings: ctx.settings.getter, activeWindow: ctx.activeWindow, log }),
    ...browser.impls,
    ...createSystemTools({ appVersion: hooks.appVersion, iconPath: hooks.iconPath, log, onNotify: hooks.onNotify }),
    ...createChatTools(() => ctx.services?.chatService ?? null),
    ...createMemoryTools({
      memory: () => ctx.services?.memory ?? null,
      observer: () => ctx.services?.observer ?? null,
      directives: () => ctx.services?.directives ?? null,
      goals: () => ctx.services?.goals ?? null,
      onMemoryChanged: hooks.onMemoryChanged,
      onGoalsChanged: hooks.onGoalsChanged,
    }),
  };
  const router = new ToolRouter({
    impls,
    policy: browser.policy,
    log,
    onCall: (info) => {
      log.debug(`${info.name}${info.chatId ? ` [${info.chatId}]` : ''} ${info.blocked ? 'BLOCKED' : info.ok ? 'ok' : 'failed'} in ${info.durationMs} ms`);
      const def = AIM_TOOLS.find((t) => t.name === info.name);
      if (def?.takesOverDesktop) ctx.overlay.touch();
    },
  });
  const missing = router.missingImplementations();
  if (missing.length) log.warn(`tools without implementation: ${missing.join(', ')}`);
  return router;
}
