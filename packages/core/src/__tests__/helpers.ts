import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, type Settings } from '@aim/shared';
import { ClaudeCliBridge } from '../cli-bridge.js';
import { configureLogging } from '../logger.js';

export const FAKE_CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

export function makeTmpDir(prefix = 'aim-core-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function quietLogs(dir: string): void {
  configureLogging({ dir, level: 'error', console: false });
}

export function fakeBridge(): ClaudeCliBridge {
  return new ClaudeCliBridge({ cliPath: process.execPath, argvPrefix: [FAKE_CLI] });
}

export function testSettings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, maxSelfHealAttempts: 2, maxParallelAgents: 2, ...patch };
}

export function waitFor(pred: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
