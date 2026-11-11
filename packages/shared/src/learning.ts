/** Memory, behaviour observation, directives and goals — the self-learning layer. */

export type MemoryKind = 'preference' | 'fact' | 'lesson' | 'procedure' | 'goal_feedback';

export interface MemoryEntry {
  key: string;
  value: string;
  kind: MemoryKind;
  confidence: number; // 0..1
  createdAt: number;
  updatedAt: number;
  /** Number of times this memory was reinforced. */
  hits: number;
  source: 'user' | 'aim' | 'reflection' | 'observer';
}

export interface BehaviorSample {
  ts: number;
  app: string; // process / app name, e.g. "msedge", "RobloxPlayerBeta"
  title: string; // window title
  url?: string; // when it's a browser tab the extension reported
  durationMs: number; // how long this sample covered
  idle?: boolean;
}

export interface BehaviorSummary {
  days: number;
  totalActiveMs: number;
  topApps: { app: string; ms: number; share: number }[];
  topSites: { host: string; ms: number; share: number }[];
  activeHours: number[]; // 24 buckets, ms per hour-of-day
  routines: string[]; // natural-language observations, e.g. "Opens Outlook most mornings around 09:00"
  lastSeen?: BehaviorSample;
}

/** A standing instruction from the user: what AIM should keep pursuing. */
export interface Directive {
  id: string;
  text: string; // "Keep my inbox at zero", "Find me internships in ML every week"
  createdAt: number;
  active: boolean;
  priority: 1 | 2 | 3; // 1 = highest
  lastPursuedAt?: number;
}

export type GoalStatus = 'planned' | 'in_progress' | 'done' | 'failed' | 'deferred';

export interface Goal {
  id: string;
  date: string; // YYYY-MM-DD the goal was planned for
  title: string;
  rationale: string;
  directiveId?: string;
  status: GoalStatus;
  priority: 1 | 2 | 3;
  /** Est. effort label for the UI. */
  effort: 'small' | 'medium' | 'large';
  chatId?: string; // the chat that executes it
  notes?: string;
  createdAt: number;
  updatedAt: number;
  scheduledAt?: number; // when the runner should start it
  /** Who created the goal: the user (Goals page) or A.I.M. (daily planning, follow-ups). Missing = A.I.M. */
  origin?: 'user' | 'aim';
}

export interface DailyPlan {
  date: string;
  goals: Goal[];
  summary: string;
  createdAt: number;
}

/** JSON schema for the goal planner's structured output (used with `claude --json-schema`). */
export const DAILY_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    goals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rationale: { type: 'string' },
          directiveId: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          effort: { type: 'string', enum: ['small', 'medium', 'large'] },
        },
        required: ['title', 'rationale', 'priority', 'effort'],
      },
    },
  },
  required: ['summary', 'goals'],
} as const;

/** Reflection output extracted after each completed turn. */
export const REFLECTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          kind: { type: 'string', enum: ['preference', 'fact', 'lesson', 'procedure', 'goal_feedback'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['key', 'value', 'kind', 'confidence'],
      },
    },
    chatTitle: { type: 'string', description: 'A short (<=6 words) title for the chat if it has none' },
  },
  required: ['memories'],
} as const;
