import { describe, expect, it } from 'vitest';
import type { Chat } from '@aim/shared';
import { groupChats } from './groupChats';

const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime(); // local 15:00
const H = 3_600_000;
const D = 24 * H;

function chat(id: string, updatedAt: number, extra: Partial<Chat> = {}): Chat {
  return { id, title: id, createdAt: updatedAt, updatedAt, status: 'idle', origin: 'user', ...extra };
}

describe('groupChats', () => {
  it('buckets chats by recency and puts pinned first', () => {
    const chats = [
      chat('old', NOW - 30 * D),
      chat('today', NOW - H),
      chat('yesterday', NOW - 20 * H), // 19:00 previous day
      chat('week', NOW - 3 * D),
      chat('pinned', NOW - 10 * D, { pinned: true }),
      chat('archived', NOW - H, { archived: true }),
    ];
    const groups = groupChats(chats, NOW);
    expect(groups.map((g) => g.key)).toEqual(['pinned', 'today', 'yesterday', 'week', 'older']);
    expect(groups.find((g) => g.key === 'pinned')!.chats.map((c) => c.id)).toEqual(['pinned']);
    expect(groups.find((g) => g.key === 'today')!.chats.map((c) => c.id)).toEqual(['today']);
    expect(groups.find((g) => g.key === 'yesterday')!.chats.map((c) => c.id)).toEqual(['yesterday']);
    expect(groups.find((g) => g.key === 'week')!.chats.map((c) => c.id)).toEqual(['week']);
    expect(groups.find((g) => g.key === 'older')!.chats.map((c) => c.id)).toEqual(['old']);
  });

  it('includes archived chats only when asked, in their own group', () => {
    const chats = [chat('a', NOW - H, { archived: true }), chat('b', NOW - 2 * H)];
    expect(groupChats(chats, NOW).map((g) => g.key)).toEqual(['today']);
    const withArchived = groupChats(chats, NOW, { includeArchived: true });
    expect(withArchived.map((g) => g.key)).toEqual(['today', 'archived']);
  });

  it('sorts within a group by most recent first and omits empty groups', () => {
    const chats = [chat('a', NOW - 3 * H), chat('b', NOW - H), chat('c', NOW - 2 * H)];
    const groups = groupChats(chats, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].chats.map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns no groups for no chats', () => {
    expect(groupChats([], NOW)).toEqual([]);
  });
});

import { splitChats, displayTitle } from './groupChats';

describe('splitChats', () => {
  const base = { createdAt: 1, updatedAt: 1, status: 'idle' as const };
  it("separates the user's chats from chats A.I.M. started, keeping starred chats with the user's", () => {
    const chats = [
      { ...base, id: 'u', title: 'Mine', origin: 'user' as const },
      { ...base, id: 'g', title: 'Goal — Tidy Downloads', origin: 'goal' as const },
      { ...base, id: 's', title: 'System', origin: 'system' as const },
      { ...base, id: 'gp', title: 'Goal — Starred', origin: 'goal' as const, pinned: true },
    ];
    const { mine, aim } = splitChats(chats);
    expect(mine.map((c) => c.id)).toEqual(['u', 'gp']);
    expect(aim.map((c) => c.id)).toEqual(['g', 's']);
    expect(displayTitle(chats[1])).toBe('Tidy Downloads');
    expect(displayTitle(chats[0])).toBe('Mine');
  });
});
