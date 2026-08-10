/**
 * Saving a practice session and picking it back up.
 *
 * Two things are being protected. The first is the user's Max window: resuming
 * has to restore the transcript *and* the rung, because restoring one without
 * the other means paying again for hints already earned. The second is their
 * disk: a transcript store with no ceiling is the largest thing this extension
 * would ever own, and nothing in the UI would ever show it, so the bounds are
 * asserted rather than assumed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_SESSIONS,
  MAX_SESSION_CHARS,
  MAX_TURNS_PER_SESSION,
  MAX_TURN_CHARS,
  TRUNCATION_MARKER,
  clearSession,
  coerceSession,
  getSession,
  normaliseSession,
  pruneSessions,
  saveSession,
} from '../src/background/transcript-store.ts';
import { hintsUsedFor } from '../src/prompt/rungs.ts';
import type { Rung, StoredSession, Turn } from '../src/shared/types.ts';

/** A `chrome.storage.local` that lives and dies with the test. */
function stubChrome(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (values: Record<string, unknown>) => {
          Object.assign(store, values);
          return Promise.resolve();
        },
      },
    },
  };
  return store;
}

beforeEach(() => {
  stubChrome();
});

function turn(role: 'user' | 'assistant', text: string, rung: Rung = 0): Turn {
  return { role, text, rung };
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    slug: 'two-sum',
    title: '1. Two Sum',
    startedAt: '2026-08-11T09:00:00.000Z',
    updatedAt: 1_000,
    elapsedMs: 8 * 60_000,
    rung: 2,
    deepestRung: 2,
    turns: [turn('user', 'is it about pairs?', 1), turn('assistant', 'what does the order buy you?', 1)],
    ...overrides,
  };
}

describe('restoring a session', () => {
  it('round-trips the transcript, the rung and the clock', async () => {
    await saveSession(session());
    const restored = await getSession('two-sum');

    expect(restored).not.toBeNull();
    expect(restored?.turns).toHaveLength(2);
    expect(restored?.turns[1]?.text).toBe('what does the order buy you?');
    expect(restored?.rung).toBe(2);
    expect(restored?.elapsedMs).toBe(8 * 60_000);
  });

  /*
   * The whole point. A transcript without its rung would have the panel offer
   * "next hint" as rung 1 again, and the user would pay a turn to be told
   * something they are already looking at.
   */
  it('restores the rung alongside the transcript, not just the words', async () => {
    await saveSession(session({ rung: 4, deepestRung: 4 }));
    const restored = await getSession('two-sum');
    expect(restored?.rung).toBe(4);
    expect(hintsUsedFor(restored?.deepestRung ?? 0)).toBe(hintsUsedFor(4));
  });

  /*
   * `startedAt` is the session log's upsert key, so carrying it across a resume
   * is what keeps one problem-sitting one row. Losing it would split a session
   * into several attempts that each report a shallower rung than the truth.
   */
  it('keeps the attempt identity stable so the session log stays one row', async () => {
    await saveSession(session({ rung: 1, deepestRung: 1 }));
    const first = await getSession('two-sum');

    await saveSession(session({ rung: 3, deepestRung: 3, startedAt: first?.startedAt ?? '', updatedAt: 2_000 }));
    const second = await getSession('two-sum');

    expect(second?.startedAt).toBe(first?.startedAt);
    expect(second?.deepestRung).toBe(3);
  });

  it('never reports a deepest rung below the rung it restored', async () => {
    await saveSession(session({ rung: 5, deepestRung: 2 }));
    expect((await getSession('two-sum'))?.deepestRung).toBe(5);
  });

  it('has nothing to offer for a problem never opened', async () => {
    expect(await getSession('never-seen')).toBeNull();
  });

  it('forgets a session on request, so "start fresh" really is fresh', async () => {
    await saveSession(session());
    await clearSession('two-sum');
    expect(await getSession('two-sum')).toBeNull();
  });

  it('keeps sessions apart by problem', async () => {
    await saveSession(session());
    await saveSession(session({ slug: 'valid-parentheses', title: '20. Valid Parentheses', rung: 5, deepestRung: 5 }));
    expect((await getSession('two-sum'))?.rung).toBe(2);
    expect((await getSession('valid-parentheses'))?.rung).toBe(5);
  });
});

describe('surviving what is already on disk', () => {
  it('drops a record with no identity rather than resuming into nonsense', () => {
    expect(coerceSession({ turns: [] })).toBeNull();
    expect(coerceSession(null)).toBeNull();
    expect(coerceSession('two-sum')).toBeNull();
  });

  it('drops turns that are not turns, and keeps the ones that are', () => {
    const restored = coerceSession({
      slug: 'two-sum',
      startedAt: '2026-08-11T09:00:00.000Z',
      turns: [{ role: 'wizard', text: 'hi' }, { role: 'user' }, turn('user', 'real', 2)],
    });
    expect(restored?.turns).toEqual([turn('user', 'real', 2)]);
  });

  it('clamps a rung written by a future version with more of them', () => {
    const restored = coerceSession({ slug: 'x', startedAt: 'then', rung: 9, turns: [] });
    expect(restored?.rung).toBe(0);
  });
});

describe('the storage bounds', () => {
  it('truncates a single runaway turn rather than storing it whole', () => {
    const huge = normaliseSession(session({ turns: [turn('assistant', 'x'.repeat(MAX_TURN_CHARS * 3), 5)] }));
    const text = huge.turns[0]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_TURN_CHARS * 3);
    expect(text).toContain(TRUNCATION_MARKER.trim());
  });

  it('caps the number of turns, keeping the newest', () => {
    const many = Array.from({ length: MAX_TURNS_PER_SESSION + 20 }, (_, i) => turn('user', `turn ${i}`, 0));
    const capped = normaliseSession(session({ turns: many }));
    expect(capped.turns).toHaveLength(MAX_TURNS_PER_SESSION);
    expect(capped.turns.at(-1)?.text).toBe(`turn ${many.length - 1}`);
  });

  it('caps the total size by dropping the oldest turns, not the newest', () => {
    const big = Array.from({ length: 20 }, (_, i) => turn('assistant', `${i}:${'y'.repeat(5_000)}`, 3));
    const capped = normaliseSession(session({ turns: big }));
    const total = capped.turns.reduce((sum, t) => sum + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SESSION_CHARS);
    expect(capped.turns.at(-1)?.text.startsWith('19:')).toBe(true);
  });

  it('keeps at least the last turn even if that one turn is over the total cap', () => {
    const capped = normaliseSession(session({ turns: [turn('assistant', 'z'.repeat(MAX_TURN_CHARS), 5)] }));
    expect(capped.turns).toHaveLength(1);
  });

  it('prunes the least recently touched problems once there are too many', () => {
    const all = Object.fromEntries(
      Array.from({ length: MAX_SESSIONS + 6 }, (_, i) => [
        `problem-${i}`,
        session({ slug: `problem-${i}`, updatedAt: i }),
      ]),
    );
    const pruned = pruneSessions(all);
    expect(Object.keys(pruned)).toHaveLength(MAX_SESSIONS);
    expect(pruned['problem-0']).toBeUndefined();
    expect(pruned[`problem-${MAX_SESSIONS + 5}`]).toBeDefined();
  });

  it('leaves a store that is already small enough alone', () => {
    const all = { 'two-sum': session() };
    expect(pruneSessions(all)).toBe(all);
  });

  it('enforces the bounds on the way to storage, not just in the helper', async () => {
    const many = Array.from({ length: MAX_TURNS_PER_SESSION + 50 }, (_, i) => turn('user', `turn ${i}`, 0));
    await saveSession(session({ turns: many }));
    expect((await getSession('two-sum'))?.turns).toHaveLength(MAX_TURNS_PER_SESSION);
  });

  it('cannot be made to grow without bound by visiting problem after problem', async () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i += 1) {
      await saveSession(session({ slug: `p-${i}`, updatedAt: i }));
    }
    const stored = (globalThis as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } })
      .chrome.storage.local;
    const record = (await stored.get('socrates:sessions'))['socrates:sessions'] as Record<string, unknown>;
    expect(Object.keys(record)).toHaveLength(MAX_SESSIONS);
  });

  it('refuses to save something it could not read back', async () => {
    await expect(saveSession({ ...session(), slug: '' })).rejects.toThrow();
  });
});
