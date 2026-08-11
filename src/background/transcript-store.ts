/**
 * Per-problem transcripts in `chrome.storage.local`, so reopening a problem can
 * pick up where it left off instead of paying for the same hints twice.
 *
 * ## Why this is bounded rather than "big enough"
 *
 * `chrome.storage.local` is a shared quota that nothing else in the extension
 * asks for permission to fill, and a transcript grows without any natural
 * ceiling: every reply at rung 5 is a full worked solution, and a determined
 * user will visit hundreds of problems. Left alone this becomes the largest
 * thing the extension owns, silently, and there is no UI that would ever show
 * it. So every write clamps four separate dimensions (`normaliseSession`) and
 * then prunes the whole record down to `MAX_SESSIONS`.
 *
 * The clamps drop the *oldest* turns rather than the newest, which is the right
 * way round for two reasons: the newest turns are what a resumed session needs
 * to continue coherently, and `toApiMessages` already keeps only the last 12
 * turns, so anything beyond that was never going back to the model anyway.
 *
 * ## What is deliberately not stored
 *
 * The page snapshot. It is re-scraped on resume, because the whole value of
 * "check my code" is that it reads the buffer as it is now, and a stale
 * statement or a stale editor buffer would be worse than no resume at all.
 */

import {
  MAX_RUNG,
  MIN_RUNG,
  type Rung,
  type StoredSession,
  type Turn,
  type TurnRole,
} from '../shared/types.ts';
import { predatesClearAll } from './clear-boundary.ts';
import { createWriteQueue } from './write-queue.ts';

const SESSIONS_KEY = 'socrates:sessions';

/** How many problems keep a transcript. Oldest-touched are pruned first. */
export const MAX_SESSIONS = 24;
/** Turns kept per session, newest first. Comfortably past `MAX_HISTORY_TURNS`. */
export const MAX_TURNS_PER_SESSION = 40;
/** A single turn longer than this is stored truncated. A rung-5 reply is ~4k. */
export const MAX_TURN_CHARS = 8_000;
/** Total transcript characters per session, enforced by dropping oldest turns. */
export const MAX_SESSION_CHARS = 60_000;

export const TRUNCATION_MARKER = '\n\n_[earlier text trimmed to keep the saved session small]_';

type SessionsBySlug = Record<string, StoredSession>;

function isRung(value: unknown): value is Rung {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_RUNG && value <= MAX_RUNG
  );
}

function coerceRung(value: unknown, fallback: Rung): Rung {
  return isRung(value) ? value : fallback;
}

function coerceTurns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  const turns: Turn[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { role?: unknown; text?: unknown; rung?: unknown };
    const role: TurnRole | null =
      record.role === 'user' || record.role === 'assistant' ? record.role : null;
    if (role === null || typeof record.text !== 'string') continue;
    turns.push({ role, text: record.text, rung: coerceRung(record.rung, 0) });
  }
  return turns;
}

/**
 * Anything read back from storage is untrusted: it may have been written by an
 * older version of this file, or by a version that had a rung 6.
 */
export function coerceSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['slug'] !== 'string' || record['slug'] === '') return null;
  if (typeof record['startedAt'] !== 'string' || record['startedAt'] === '') return null;

  const rung = coerceRung(record['rung'], 0);
  return {
    slug: record['slug'],
    title: typeof record['title'] === 'string' ? record['title'] : record['slug'],
    startedAt: record['startedAt'],
    updatedAt: typeof record['updatedAt'] === 'number' ? record['updatedAt'] : 0,
    elapsedMs:
      typeof record['elapsedMs'] === 'number' && record['elapsedMs'] >= 0 ? record['elapsedMs'] : 0,
    rung,
    // A deepest rung below the current one is incoherent; the current rung wins.
    deepestRung: Math.max(rung, coerceRung(record['deepestRung'], rung)) as Rung,
    turns: coerceTurns(record['turns']),
  };
}

function truncateTurn(turn: Turn): Turn {
  if (turn.text.length <= MAX_TURN_CHARS) return turn;
  return { ...turn, text: turn.text.slice(0, MAX_TURN_CHARS) + TRUNCATION_MARKER };
}

/** Applies every per-session bound. Exported so the bounds can be tested directly. */
export function normaliseSession(session: StoredSession): StoredSession {
  const turns = session.turns.slice(-MAX_TURNS_PER_SESSION).map(truncateTurn);

  // Drop from the front until the whole transcript fits. The newest turns are
  // the ones a resumed session actually needs.
  let total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  let first = 0;
  while (total > MAX_SESSION_CHARS && first < turns.length - 1) {
    total -= turns[first]?.text.length ?? 0;
    first += 1;
  }

  return { ...session, turns: turns.slice(first) };
}

/**
 * Every mutation runs one at a time, and reads its own copy of the record - see
 * `write-queue.ts` for why, and for the detail that `readSessions()` has to be
 * called *inside* the queued work rather than before it.
 */
const enqueue = createWriteQueue();

async function readSessions(): Promise<SessionsBySlug> {
  const stored = await chrome.storage.local.get(SESSIONS_KEY);
  const value = stored[SESSIONS_KEY];
  if (typeof value !== 'object' || value === null) return {};

  const out: SessionsBySlug = {};
  for (const [slug, entry] of Object.entries(value as Record<string, unknown>)) {
    const session = coerceSession(entry);
    if (session !== null) out[slug] = session;
  }
  return out;
}

/** Keeps the `MAX_SESSIONS` most recently touched, dropping the rest. */
export function pruneSessions(all: SessionsBySlug): SessionsBySlug {
  const entries = Object.entries(all);
  if (entries.length <= MAX_SESSIONS) return all;
  entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

export function getSession(slug: string): Promise<StoredSession | null> {
  return enqueue(async () => {
    const all = await readSessions();
    return all[slug] ?? null;
  });
}

/**
 * Returns `null` when the write was refused because the session it describes was
 * deleted by a clear-all - the panel's own `onDone` closure carries the
 * `startedAt` the turn began with, so a turn finishing after the clear would
 * otherwise write the deleted transcript straight back. See `clear-boundary.ts`.
 */
export function saveSession(session: StoredSession): Promise<StoredSession | null> {
  // Validating and clamping are pure, so they happen up front: a caller passing
  // nonsense should be rejected without taking a turn in the queue.
  const coerced = coerceSession(session);
  if (coerced === null) {
    return Promise.reject(new Error('Refusing to save a session without a slug and a start time.'));
  }
  const normalised = normaliseSession(coerced);

  return enqueue(async () => {
    // Judged here rather than at the call, because a clear can be marked while
    // this write waits its turn in the queue.
    if (predatesClearAll(normalised.startedAt)) return null;
    const all = await readSessions();
    all[normalised.slug] = normalised;
    await chrome.storage.local.set({ [SESSIONS_KEY]: pruneSessions(all) });
    return normalised;
  });
}

/**
 * Deletes every stored transcript, for the user who wants what they typed into
 * the editor off this machine. Goes through the same queue as everything else,
 * so a save already in flight cannot land after the clear and resurrect a slug.
 */
export function clearAllSessions(): Promise<null> {
  return enqueue(async () => {
    await chrome.storage.local.remove(SESSIONS_KEY);
    return null;
  });
}

export function clearSession(slug: string): Promise<null> {
  return enqueue(async () => {
    const all = await readSessions();
    if (!(slug in all)) return null;
    delete all[slug];
    await chrome.storage.local.set({ [SESSIONS_KEY]: all });
    return null;
  });
}
