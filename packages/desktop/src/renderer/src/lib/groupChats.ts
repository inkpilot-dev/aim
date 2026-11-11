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

/** Chats A.I.M. started on its own (daily goals, follow-ups) rather than the user. */
export function isAimChat(c: Chat): boolean {
  return c.origin === 'goal' || c.origin === 'system';
}

/** Splits the list into the user's chats and A.I.M.'s. Starred chats stay with the user's, wherever they came from. */
export function splitChats(chats: Chat[]): { mine: Chat[]; aim: Chat[] } {
  const mine: Chat[] = [];
  const aim: Chat[] = [];
  for (const c of chats) (isAimChat(c) && !c.pinned ? aim : mine).push(c);
  return { mine, aim };
}

/** Goal chats are titled "Goal — …"; inside A.I.M.'s section the prefix is noise. */
export function displayTitle(c: Chat): string {
  const t = c.title || 'Untitled';
  return isAimChat(c) ? t.replace(/^Goal\s+[—-]\s+/, '') : t;
}

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
