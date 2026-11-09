import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db.js';
import { openSqlite, sqliteDriver } from '../sqlite-compat.js';
import { ChatStore } from '../chat-store.js';
import { MemoryStore } from '../learning/index.js';

describe('sqlite fallback driver (node:sqlite)', () => {
  it('runs the full schema and the stores through the node:sqlite adapter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-sqlite-'));
    const prev = process.env.AIM_SQLITE_DRIVER;
    process.env.AIM_SQLITE_DRIVER = 'node:sqlite';
    try {
      const db = openDatabase(path.join(dir, 'x.db'));
      expect(sqliteDriver()).toBe('node:sqlite');
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      const chats = new ChatStore(db);
      const chat = chats.createChat({ title: 'Fallback chat' });
      chats.appendMessage({ id: 'm1', chatId: chat.id, role: 'user', content: [{ type: 'text', text: 'hello sqlite fallback' }], createdAt: Date.now() });
      expect(chats.getChat(chat.id)?.messages).toHaveLength(1);
      expect(chats.search('fallback').map((c) => c.id)).toContain(chat.id);
      chats.setTasks(chat.id, [
        { id: 't1', chatId: chat.id, title: 'a', state: 'done', order: 0, createdAt: 1, updatedAt: 1 },
        { id: 't2', chatId: chat.id, title: 'b', state: 'pending', order: 1, createdAt: 1, updatedAt: 1 },
      ]);
      expect(chats.listChats()[0].progress?.total).toBe(2);
      const mem = new MemoryStore(db);
      mem.remember({ key: 'browser', value: 'Prefers Microsoft Edge', kind: 'preference' });
      expect(mem.recall('edge')[0]?.key).toBe('browser');
      // nested transaction + rollback
      const tx = db.transaction((n: number) => {
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('k' + n, 'v');
        if (n === 2) throw new Error('boom');
      });
      tx(1);
      expect(() => tx(2)).toThrow('boom');
      expect(db.prepare("SELECT count(*) AS c FROM meta WHERE key LIKE 'k%'").get()).toEqual({ c: 1 });
      db.close();
    } finally {
      if (prev === undefined) delete process.env.AIM_SQLITE_DRIVER;
      else process.env.AIM_SQLITE_DRIVER = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('prefers better-sqlite3 when it loads, otherwise falls back', () => {
    // In CI the native module may be compiled for Electron's ABI (postinstall), so Node cannot load it;
    // the fallback is then the expected outcome.
    let nativeLoads = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      createRequire(import.meta.url)('better-sqlite3');
    } catch {
      nativeLoads = false;
    }
    const db = openSqlite(':memory:');
    expect(sqliteDriver()).toBe(nativeLoads ? 'better-sqlite3' : 'node:sqlite');
    db.close();
  });
});
