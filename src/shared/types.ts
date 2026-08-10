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

/**
 * Where a reply comes from.
 *
 * `claude-code` drives the local `claude` CLI through the native host, so it
 * runs on the Claude subscription you are already logged into and needs no API
 * credits. `api-key` posts to api.anthropic.com with a key read from Dashlane.
 * The rung discipline, the prompt and the spoiler guard are identical either
 * way - only the transport differs.
 */
export const PROVIDER_IDS = ['claude-code', 'api-key'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEFAULT_PROVIDER: ProviderId = 'claude-code';

export interface ProviderChoice {
  id: ProviderId;
  label: string;
  blurb: string;
  /** The honest cost of choosing this one. Shown under the choice, always. */
  caveat: string;
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    id: 'claude-code',
    label: 'Claude Code (Max plan)',
    blurb: 'Runs the claude CLI you are already logged into. No API credits, no key, no setup.',
    caveat:
      'Hints draw on the same Max usage windows as every other Claude Code session on this machine. ' +
      'It is one pool - interview sessions are small, but they are not free of it.',
  },
  {
    id: 'api-key',
    label: 'Anthropic API key (Dashlane)',
    blurb: 'Calls api.anthropic.com directly with a key read from your vault at session start.',
    caveat: 'Bills prepaid API credits on your Anthropic console account, separately from any subscription.',
  },
];

export interface Settings {
  provider: ProviderId;
  model: ModelId;
}

export const DEFAULT_SETTINGS: Settings = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

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

/**
 * A practice session, saved per problem so returning to it does not start over.
 *
 * The point is usage, not convenience: on the Claude Code provider every turn is
 * charged against the same Max window as the user's real work, so re-explaining
 * a problem and re-earning three hints they already paid for is the single most
 * wasteful thing the panel can do. This is what makes that avoidable.
 *
 * `startedAt` doubles as the key of the `AttemptRecord` in the session log, so a
 * session resumed twice stays one attempt with one deepest rung rather than
 * three attempts that each look shallower than the truth.
 */
export interface StoredSession {
  slug: string;
  title: string;
  /** ISO-8601. The identity of the session, and the session log's upsert key. */
  startedAt: string;
  /** Epoch ms of the last write. Only used to decide what to prune first. */
  updatedAt: number;
  /** Wall-clock spent on the problem, carried across resumes. */
  elapsedMs: number;
  /** The rung that was unlocked when the panel closed. */
  rung: Rung;
  /** The deepest rung ever reached, which is what the session log reports. */
  deepestRung: Rung;
  turns: Turn[];
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
  | 'claude-cli-missing'
  | 'claude-logged-out'
  | 'claude-usage-limit'
  | 'claude-cli-failed'
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
