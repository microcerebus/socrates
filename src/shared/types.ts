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
  /** The number LeetCode prints before the title ("1" for "1. Two Sum"), when there is one. */
  number: string | null;
  /** The prose statement, newline-separated plain text. */
  statement: string;
  /** Example blocks, verbatim. */
  examples: string[];
  /** Constraint bullets, verbatim. */
  constraints: string[];
  /**
   * LeetCode's own topic tags, e.g. `['Array', 'Hash Table']`.
   *
   * **Model context only.** These name the intended technique, and on the page
   * they sit behind a collapsed "Topics" toggle the user has usually not opened.
   * The panel must never render them at any rung; see the spoiler boundary in
   * `src/prompt/system-prompt.ts` and the guard in `src/prompt/spoiler-guard.ts`.
   */
  topicTags: string[];
  /** Whether an editorial tab exists. A boolean, never its content. */
  hasEditorial: boolean;
  /** Whether the problem ships hints. A boolean, never their content. */
  hasHints: boolean;
  source: ContextSource;
}

export interface EditorContext {
  /** A LeetCode language id (`javascript`, `python3`, `golang`, ...). See `languages.ts`. */
  language: string;
  code: string;
  source: ContextSource | 'unavailable';
}

/** How LeetCode's judge answered. The strings are LeetCode's own, in English. */
export type RunVerdict =
  | 'Accepted'
  | 'Wrong Answer'
  | 'Time Limit Exceeded'
  | 'Memory Limit Exceeded'
  | 'Output Limit Exceeded'
  | 'Runtime Error'
  | 'Compile Error'
  | 'Internal Error'
  | 'Invalid Testcase'
  | 'Finished'
  | 'other';

/**
 * The run/submission result panel, when the user has run something.
 *
 * This is what turns "check my code" from a reading exercise into a diagnosis:
 * with the failing input and the two outputs in hand the interviewer can talk
 * about the actual defect. Every field is optional because the panel shows
 * different subsets per verdict - an accepted run has no `expected`, a compile
 * error has no testcase at all.
 */
export interface RunResult {
  /** Whether this came from Run (custom testcases) or Submit (the full set). */
  kind: 'run' | 'submission';
  /** Verbatim from the page, so an unmapped verdict still reaches the model. */
  verdictText: string;
  verdict: RunVerdict;
  /** "35 / 57 testcases passed", when the page shows a tally. */
  testcases: string | null;
  /** The failing (or last executed) input. */
  input: string | null;
  output: string | null;
  expected: string | null;
  /** Anything the code printed. */
  stdout: string | null;
  /** The compiler or runtime message, on the verdicts that carry one. */
  errorMessage: string | null;
}

export interface PageSnapshot {
  problem: ProblemContext;
  editor: EditorContext;
  /** `null` whenever the console has no result on screen, which is most of the time. */
  run: RunResult | null;
  capturedAt: number;
}

/** Why a scrape failed. The panel maps these onto an actionable message. */
export type ScrapeFailure =
  'not-a-problem-page' | 'no-problem-markup' | 'no-statement' | 'no-content-script';

export type ScrapeResult =
  { ok: true; snapshot: PageSnapshot } | { ok: false; reason: ScrapeFailure; detail?: string };

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
  | 'api-error'
  | 'claude-cli-missing'
  | 'claude-logged-out'
  | 'claude-usage-limit'
  | 'claude-cli-failed'
  | 'aborted'
  | 'no-context'
  /**
   * The service worker went away while this request was in flight.
   *
   * Chrome stops an idle MV3 worker, which is normal and not a failure of
   * anything - but the run it was hosting is gone with it. The panel reconnects
   * for the *next* request; this code exists so the one that was interrupted
   * says so instead of spinning. See `src/panel/port-client.ts`.
   */
  | 'worker-restarted';

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
