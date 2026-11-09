import type { Chat } from '@aim/shared';
import { startOfDay } from './format';

export type ChatGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older' | 'archived';

export interface ChatGroup {
  key: ChatGroupKey;
  label: string;
  chats: Chat[];
}

const LABELS: Record<ChatGroupKey, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older',
  archived: 'Archived',
};

const ORDER: ChatGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older', 'archived'];

export function groupChats(chats: Chat[], now = Date.now(), opts: { includeArchived?: boolean } = {}): ChatGroup[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const buckets = new Map<ChatGroupKey, Chat[]>();
  const push = (k: ChatGroupKey, c: Chat) => {
    const arr = buckets.get(k) ?? [];
    arr.push(c);
    buckets.set(k, arr);
  };
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const c of sorted) {
    if (c.archived) {
      if (opts.includeArchived) push('archived', c);
      continue;
    }
    if (c.pinned) push('pinned', c);
    else if (c.updatedAt >= todayStart) push('today', c);
    else if (c.updatedAt >= yesterdayStart) push('yesterday', c);
    else if (c.updatedAt >= weekStart) push('week', c);
    else push('older', c);
  }
  return ORDER.filter((k) => buckets.has(k)).map((k) => ({ key: k, label: LABELS[k], chats: buckets.get(k)! }));
}
