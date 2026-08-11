/**
 * Per-problem session log and settings, in `chrome.storage.local`.
 */

import { DEFAULT_SETTINGS, MODEL_IDS, type AttemptRecord, type ModelId, type Settings } from '../shared/types.ts';

const ATTEMPTS_KEY = 'socrates:attempts';
const SETTINGS_KEY = 'socrates:settings';
const MAX_ATTEMPTS_PER_PROBLEM = 20;

type AttemptsBySlug = Record<string, AttemptRecord[]>;

async function readAttempts(): Promise<AttemptsBySlug> {
  const stored = await chrome.storage.local.get(ATTEMPTS_KEY);
  const value = stored[ATTEMPTS_KEY];
  return typeof value === 'object' && value !== null ? (value as AttemptsBySlug) : {};
}

export async function getAttempts(slug: string): Promise<AttemptRecord[]> {
  const all = await readAttempts();
  return all[slug] ?? [];
}

/**
 * Upserts by `(slug, startedAt)` so the panel can keep the live session's record
 * current as the user climbs the ladder, instead of trying to catch the moment
 * the panel closes.
 */
export async function recordAttempt(attempt: AttemptRecord): Promise<AttemptRecord[]> {
  const all = await readAttempts();
  const existing = all[attempt.slug] ?? [];
  const index = existing.findIndex((entry) => entry.startedAt === attempt.startedAt);
  const next =
    index === -1
      ? [...existing, attempt].slice(-MAX_ATTEMPTS_PER_PROBLEM)
      : existing.map((entry, i) => (i === index ? attempt : entry));
  all[attempt.slug] = next;
  await chrome.storage.local.set({ [ATTEMPTS_KEY]: all });
  return next;
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
