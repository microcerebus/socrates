/**
 * Per-problem session log and settings, in `chrome.storage.local`.
 *
 * The attempt log is a read-modify-write over one key, exactly like
 * `transcript-store.ts`, so it takes the same two precautions: every mutation
 * goes through a queue in call order (`write-queue.ts`), and a write for a
 * session a clear-all has already deleted is refused at write time
 * (`clear-boundary.ts`). Settings are neither - a settings write replaces the
 * whole value rather than merging into it, `settings-writer.ts` already
 * serialises the intent behind it, and a model choice is a preference that
 * deliberately survives "clear all saved data".
 */

import {
  DEFAULT_SETTINGS,
  MODEL_IDS,
  type AttemptRecord,
  type ModelId,
  type Settings,
} from '../shared/types.ts';
import { predatesClearAll } from './clear-boundary.ts';
import { createWriteQueue } from './write-queue.ts';

const ATTEMPTS_KEY = 'socrates:attempts';
const SETTINGS_KEY = 'socrates:settings';
const MAX_ATTEMPTS_PER_PROBLEM = 20;

type AttemptsBySlug = Record<string, AttemptRecord[]>;

/** Reads happen in here too, so nothing is handed a record a queued clear is about to drop. */
const enqueue = createWriteQueue();

async function readAttempts(): Promise<AttemptsBySlug> {
  const stored = await chrome.storage.local.get(ATTEMPTS_KEY);
  const value = stored[ATTEMPTS_KEY];
  return typeof value === 'object' && value !== null ? (value as AttemptsBySlug) : {};
}

export function getAttempts(slug: string): Promise<AttemptRecord[]> {
  return enqueue(async () => {
    const all = await readAttempts();
    return all[slug] ?? [];
  });
}

/**
 * Upserts by `(slug, startedAt)` so the panel can keep the live session's record
 * current as the user climbs the ladder, instead of trying to catch the moment
 * the panel closes.
 *
 * That upsert key is also what makes the write refusable: an attempt carries the
 * moment it began, so a turn finishing after a clear-all - from a closure built
 * before it - is recognisable as belonging to a session the user deleted, and is
 * dropped rather than recreating its row. The list the caller gets back is then
 * what is really stored, which is what the panel puts on screen.
 */
export function recordAttempt(attempt: AttemptRecord): Promise<AttemptRecord[]> {
  return enqueue(async () => {
    const all = await readAttempts();
    const existing = all[attempt.slug] ?? [];
    // Judged here rather than at the call, because a clear can be marked while
    // this write is waiting its turn in the queue.
    if (predatesClearAll(attempt.startedAt)) return existing;

    const index = existing.findIndex((entry) => entry.startedAt === attempt.startedAt);
    const next =
      index === -1
        ? [...existing, attempt].slice(-MAX_ATTEMPTS_PER_PROBLEM)
        : existing.map((entry, i) => (i === index ? attempt : entry));
    all[attempt.slug] = next;
    await chrome.storage.local.set({ [ATTEMPTS_KEY]: all });
    return next;
  });
}

/** Deletes the whole session log. Settings are a preference, not data, and survive. */
export function clearAllAttempts(): Promise<void> {
  return enqueue(async () => {
    await chrome.storage.local.remove(ATTEMPTS_KEY);
  });
}

function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && (MODEL_IDS as readonly string[]).includes(value);
}

function coerceSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  const record = value as { model?: unknown };
  return { model: isModelId(record.model) ? record.model : DEFAULT_SETTINGS.model };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return coerceSettings(stored[SETTINGS_KEY]);
}

export async function setSettings(settings: Settings): Promise<Settings> {
  const safe = coerceSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: safe });
  return safe;
}
