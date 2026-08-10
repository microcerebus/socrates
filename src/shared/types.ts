/**
 * Types shared across the service worker, the content script and the side panel.
 * Nothing in here may import from a specific extension surface - keep it pure.
 */

/** A rung on the hint ladder. See `src/prompt/rungs.ts` for what each one may reveal. */
export type Rung = 0 | 1 | 2 | 3 | 4 | 5;

export const MIN_RUNG: Rung = 0;
export const MAX_RUNG: Rung = 5;

/** Rung 0 is free (understanding the problem is not a hint). Rungs 1-5 are the six-step ladder. */
export const HINT_RUNG_COUNT = 6;

export const MODEL_IDS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL: ModelId = 'claude-sonnet-5';

export interface ModelChoice {
  id: ModelId;
  label: string;
  blurb: string;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', blurb: 'Balanced. The default.' },
  { id: 'claude-opus-5', label: 'Opus 5', blurb: 'Deepest reasoning, slower.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', blurb: 'Fastest, cheapest.' },
];

export interface Settings {
  model: ModelId;
}

export const DEFAULT_SETTINGS: Settings = { model: DEFAULT_MODEL };

/** Where a piece of context came from. Surfaced in the UI so the user knows what the model sees. */
export type ContextSource = 'leetcode' | 'manual';

export interface ProblemContext {
  /** LeetCode slug, e.g. `two-sum`. `manual` when pasted without a URL. */
  slug: string;
  title: string;
  url: string | null;
  difficulty: string | null;
  /** The prose statement, newline-separated plain text. */
  statement: string;
  /** Example blocks, verbatim. */
  examples: string[];
  /** Constraint bullets, verbatim. */
  constraints: string[];
  source: ContextSource;
}

export interface EditorContext {
  /** Monaco language id (`javascript`, `typescript`, `python`, ...). */
  language: string;
  code: string;
  source: ContextSource | 'unavailable';
}

export interface PageSnapshot {
  problem: ProblemContext;
  editor: EditorContext;
  capturedAt: number;
}

/** Why a scrape failed. The panel maps these onto an actionable message. */
export type ScrapeFailure =
  | 'not-a-problem-page'
  | 'no-problem-markup'
  | 'no-statement'
  | 'no-content-script';

export type ScrapeResult =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; reason: ScrapeFailure; detail?: string };

export interface AttemptRecord {
  slug: string;
  title: string;
  /** ISO-8601 timestamp of when the session started. */
  startedAt: string;
  durationMs: number;
  deepestRung: Rung;
  /** Number of rungs unlocked that count as hints (rungs 1-5). */
  hintsUsed: number;
}

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  text: string;
  /** The rung that was unlocked when this turn was produced. */
  rung: Rung;
}

/** What the user asked for. Shapes the instruction appended to the conversation. */
export type AskIntent = 'unlock' | 'chat' | 'review' | 'giveup';

export type ErrorCode =
  | 'native-host-missing'
  | 'dcli-missing'
  | 'vault-locked'
  | 'vault-item-missing'
  | 'key-fetch-failed'
  | 'api-auth'
  | 'api-rate-limit'
  | 'api-error'
  | 'network'
  | 'aborted'
  | 'no-context';

export interface Remedy {
  label: string;
  /** A shell command the user can copy verbatim. */
  command: string;
}

export interface AppError {
  code: ErrorCode;
  message: string;
  remedies: Remedy[];
}

export function appError(code: ErrorCode, message: string, remedies: Remedy[] = []): AppError {
  return { code, message, remedies };
}
