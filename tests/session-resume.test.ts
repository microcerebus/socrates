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
  clearAllSessions,
  pruneSessions,
  saveSession,
} from '../src/background/transcript-store.ts';
import {
  clearAllAttempts,
  getAttempts,
  getSettings,
  recordAttempt,
  setSettings,
} from '../src/background/session-store.ts';
import { classifyCapture } from '../src/panel/problem-switch.ts';
import { createSessionWriter } from '../src/panel/session-writer.ts';
import { hintsUsedFor } from '../src/prompt/rungs.ts';
import type { PageSnapshot, Rung, StoredSession, Turn } from '../src/shared/types.ts';
import { SNAPSHOT } from './helpers.ts';

/**
 * A `chrome.storage.local` that lives and dies with the test.
 *
 * `get` deliberately settles on a later macrotask rather than immediately. The
 * store is one read-modify-write over a single key, so a same-tick stub hides
 * the interleaving that a real extension hits every time a finished turn and a
 * `pagehide` save land together - which is exactly the bug the queue exists for.
 */
function stubChrome(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  const later = <T>(value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), 0));
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => later(key in store ? { [key]: store[key] } : {}),
        set: (values: Record<string, unknown>) => {
          Object.assign(store, values);
          return later(undefined);
        },
        remove: (key: string) => {
          delete store[key];
          return later(undefined);
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
    turns: [
      turn('user', 'is it about pairs?', 1),
      turn('assistant', 'what does the order buy you?', 1),
    ],
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

    await saveSession(
      session({ rung: 3, deepestRung: 3, startedAt: first?.startedAt ?? '', updatedAt: 2_000 }),
    );
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
    await saveSession(
      session({
        slug: 'valid-parentheses',
        title: '20. Valid Parentheses',
        rung: 5,
        deepestRung: 5,
      }),
    );
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
    const huge = normaliseSession(
      session({ turns: [turn('assistant', 'x'.repeat(MAX_TURN_CHARS * 3), 5)] }),
    );
    const text = huge.turns[0]?.text ?? '';
    expect(text.length).toBeLessThan(MAX_TURN_CHARS * 3);
    expect(text).toContain(TRUNCATION_MARKER.trim());
  });

  it('caps the number of turns, keeping the newest', () => {
    const many = Array.from({ length: MAX_TURNS_PER_SESSION + 20 }, (_, i) =>
      turn('user', `turn ${i}`, 0),
    );
    const capped = normaliseSession(session({ turns: many }));
    expect(capped.turns).toHaveLength(MAX_TURNS_PER_SESSION);
    expect(capped.turns.at(-1)?.text).toBe(`turn ${many.length - 1}`);
  });

  it('caps the total size by dropping the oldest turns, not the newest', () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      turn('assistant', `${i}:${'y'.repeat(5_000)}`, 3),
    );
    const capped = normaliseSession(session({ turns: big }));
    const total = capped.turns.reduce((sum, t) => sum + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_SESSION_CHARS);
    expect(capped.turns.at(-1)?.text.startsWith('19:')).toBe(true);
  });

  it('keeps at least the last turn even if that one turn is over the total cap', () => {
    const capped = normaliseSession(
      session({ turns: [turn('assistant', 'z'.repeat(MAX_TURN_CHARS), 5)] }),
    );
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
    const many = Array.from({ length: MAX_TURNS_PER_SESSION + 50 }, (_, i) =>
      turn('user', `turn ${i}`, 0),
    );
    await saveSession(session({ turns: many }));
    expect((await getSession('two-sum'))?.turns).toHaveLength(MAX_TURNS_PER_SESSION);
  });

  it('cannot be made to grow without bound by visiting problem after problem', async () => {
    for (let i = 0; i < MAX_SESSIONS + 10; i += 1) {
      await saveSession(session({ slug: `p-${i}`, updatedAt: i }));
    }
    const stored = (
      globalThis as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.local;
    const record = (await stored.get('socrates:sessions'))['socrates:sessions'] as Record<
      string,
      unknown
    >;
    expect(Object.keys(record)).toHaveLength(MAX_SESSIONS);
  });

  it('refuses to save something it could not read back', async () => {
    await expect(saveSession({ ...session(), slug: '' })).rejects.toThrow();
  });
});

/**
 * The store is one read-modify-write over a single key, and the panel really
 * does overlap those: a finished turn saves at the same moment `pagehide` does,
 * and "start fresh" clears while a save may still be in flight. Unserialised,
 * the second `set` discards whatever the first one wrote.
 */
describe('overlapping mutations', () => {
  it('keeps both when two different problems are saved at once', async () => {
    await Promise.all([
      saveSession(session({ slug: 'two-sum' })),
      saveSession(session({ slug: 'valid-parentheses', rung: 5, deepestRung: 5 })),
      saveSession(session({ slug: 'lru-cache', rung: 3, deepestRung: 3 })),
    ]);

    expect(await getSession('two-sum')).not.toBeNull();
    expect((await getSession('valid-parentheses'))?.rung).toBe(5);
    expect((await getSession('lru-cache'))?.rung).toBe(3);
  });

  it('lets the last write to one problem win rather than an arbitrary one', async () => {
    await Promise.all([
      saveSession(session({ rung: 1, deepestRung: 1, updatedAt: 1 })),
      saveSession(session({ rung: 4, deepestRung: 4, updatedAt: 2 })),
    ]);
    expect((await getSession('two-sum'))?.rung).toBe(4);
  });

  it('does not resurrect a cleared problem when another save overlaps it', async () => {
    await saveSession(session({ slug: 'two-sum' }));
    await saveSession(session({ slug: 'lru-cache' }));

    // "Start fresh" on one problem while a save for another is still landing.
    await Promise.all([
      clearSession('two-sum'),
      saveSession(session({ slug: 'lru-cache', rung: 2 })),
    ]);

    expect(await getSession('two-sum')).toBeNull();
    expect((await getSession('lru-cache'))?.rung).toBe(2);
  });

  it('does not resurrect anything when a clear overlaps a prune', async () => {
    // Fill past the cap so the next save prunes, then clear while it does.
    for (let i = 0; i < MAX_SESSIONS; i += 1)
      await saveSession(session({ slug: `p-${i}`, updatedAt: 1_000 + i }));

    await Promise.all([
      clearSession('p-5'),
      saveSession(session({ slug: 'newcomer', updatedAt: 9_999 })),
      clearSession('p-6'),
    ]);

    expect(await getSession('p-5')).toBeNull();
    expect(await getSession('p-6')).toBeNull();
    expect(await getSession('newcomer')).not.toBeNull();
  });

  it('keeps serving later callers after one operation rejects', async () => {
    const bad = saveSession({ ...session(), slug: '' }).catch(() => 'rejected');
    const good = saveSession(session({ slug: 'still-works' }));
    expect(await bad).toBe('rejected');
    await good;
    expect(await getSession('still-works')).not.toBeNull();
  });
});

/**
 * "Start fresh" has to clear memory and storage together. Resetting React state
 * is not enough on its own, because a `setState` is scheduled rather than
 * applied - anything running before the next render still reads the old
 * transcript out of a render closure and writes it back over the storage that
 * was just cleared. `createSessionWriter` is where that decision lives so it can
 * be made synchronously, and tested without a renderer.
 */
describe('discarding a session', () => {
  function writer(): {
    writer: ReturnType<typeof createSessionWriter>;
    saved: StoredSession[];
    cleared: string[];
  } {
    const saved: StoredSession[] = [];
    const cleared: string[] = [];
    return {
      writer: createSessionWriter({
        save: (s) => {
          saved.push(s);
          return Promise.resolve(s);
        },
        clear: (slug) => {
          cleared.push(slug);
          return Promise.resolve(null);
        },
      }),
      saved,
      cleared,
    };
  }

  it('saves an ordinary session', () => {
    const { writer: w, saved } = writer();
    w.save(session());
    expect(saved).toHaveLength(1);
  });

  it('does not spend a write on a session with nothing in it', () => {
    const { writer: w, saved } = writer();
    w.save(session({ turns: [] }));
    w.save(null);
    expect(saved).toHaveLength(0);
  });

  /* The reported bug, in one test: start fresh, then close the panel. */
  it('refuses the save that a pagehide would fire after start fresh', () => {
    const { writer: w, saved, cleared } = writer();
    w.discard('two-sum');
    // The panel's React state has not caught up yet, so this still describes the
    // discarded conversation.
    w.save(session({ rung: 4, deepestRung: 4 }));

    expect(cleared).toEqual(['two-sum']);
    expect(saved).toHaveLength(0);
  });

  /*
   * "Clear all saved data" has the same problem as "start fresh", one step
   * bigger: the panel is still holding a live session for the problem on screen,
   * so a finishing turn or a `pagehide` would put the transcript the user just
   * deleted straight back on disk. The panel discards the active slug in the same
   * tick as the click, before the clear round trip starts.
   */
  it('refuses the save that would recreate a transcript just cleared', () => {
    const { writer: w, saved } = writer();
    w.discard('two-sum');
    w.save(session({ rung: 3, deepestRung: 3 }));
    expect(saved).toHaveLength(0);
  });

  it('refuses it synchronously, before the clear round trip has settled', () => {
    let releaseClear = (): void => undefined;
    const saved: StoredSession[] = [];
    const w = createSessionWriter({
      save: (s) => {
        saved.push(s);
        return Promise.resolve(s);
      },
      clear: () => new Promise((resolve) => (releaseClear = () => resolve(null))),
    });

    w.discard('two-sum');
    w.save(session());
    expect(saved).toHaveLength(0);
    releaseClear();
  });

  it('still saves a different problem after one is discarded', () => {
    const { writer: w, saved } = writer();
    w.discard('two-sum');
    w.save(session({ slug: 'lru-cache' }));
    expect(saved).toHaveLength(1);
  });

  it('saves again once a new turn has begun on the discarded problem', () => {
    const { writer: w, saved } = writer();
    w.discard('two-sum');
    w.beginTurn('two-sum');
    w.save(session({ rung: 1, deepestRung: 1 }));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.rung).toBe(1);
    expect(w.discarded).toBeNull();
  });

  it('is not un-discarded by a turn on some other problem', () => {
    const { writer: w, saved } = writer();
    w.discard('two-sum');
    w.beginTurn('lru-cache');
    w.save(session());
    expect(saved).toHaveLength(0);
  });

  /* Start fresh, close the panel, reopen: nothing should come back. */
  it('leaves storage empty across a close and reopen', async () => {
    await saveSession(session({ rung: 4, deepestRung: 4 }));
    const w = createSessionWriter({ save: saveSession, clear: clearSession });

    w.discard('two-sum');
    w.save(session({ rung: 4, deepestRung: 4 })); // the pagehide save
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await getSession('two-sum')).toBeNull();
  });
});

/**
 * Navigating to another problem with the panel open.
 *
 * The panel is a view of whatever LeetCode is showing, but a stateful one: the
 * transcript, the rung, the clock and the attempt id all belong to one problem.
 * Keeping them across a navigation is not a cosmetic bug - the next turn runs
 * against a statement the user is no longer looking at, its reply lands in the
 * previous problem's session, and the *rung* carries over, which would hand out
 * pseudocode for a problem where nothing was earned.
 */
describe('following the page to another problem', () => {
  const twoSum = SNAPSHOT;
  const lruCache: PageSnapshot = {
    ...SNAPSHOT,
    problem: { ...SNAPSHOT.problem, slug: 'lru-cache', title: '146. LRU Cache' },
  };

  it('treats a capture of the same problem as a refresh, not a switch', () => {
    const outcome = classifyCapture(twoSum, { ...twoSum, capturedAt: 2 });
    expect(outcome.kind).toBe('refreshed');
  });

  /* The blocker: this used to be discarded, leaving the panel on the old slug. */
  it('reports a different slug as a switch instead of discarding it', () => {
    const outcome = classifyCapture(twoSum, lruCache);
    expect(outcome).toEqual({ kind: 'switched', snapshot: lruCache });
  });

  it('adopts the first problem it ever sees', () => {
    expect(classifyCapture(null, twoSum)).toEqual({ kind: 'switched', snapshot: twoSum });
  });

  it('keeps what it has when the page cannot be read', () => {
    expect(classifyCapture(twoSum, null)).toEqual({ kind: 'unchanged' });
    expect(classifyCapture(null, null)).toEqual({ kind: 'unchanged' });
  });

  /* The paste box only exists because the page was unreadable; a later scrape of
   * that same page must not throw away what the user typed to work around it. */
  it('lets a pasted problem outrank the page', () => {
    const pasted: PageSnapshot = { ...twoSum, problem: { ...twoSum.problem, source: 'manual' } };
    expect(classifyCapture(pasted, lruCache)).toEqual({ kind: 'unchanged' });
  });

  it('refuses to persist a turn into the problem the panel has left', () => {
    const saved: StoredSession[] = [];
    const w = createSessionWriter({
      save: (s) => {
        saved.push(s);
        return Promise.resolve(s);
      },
      clear: () => Promise.resolve(null),
    });

    w.setActive('two-sum');
    // The switch: the old session is written while it is still the active one.
    w.save(session({ slug: 'two-sum', rung: 4, deepestRung: 4 }));
    w.setActive('lru-cache');
    // A turn that was in flight during the navigation finishes now.
    w.save(session({ slug: 'two-sum', rung: 5, deepestRung: 5 }));

    expect(saved).toHaveLength(1);
    expect(saved[0]?.rung).toBe(4);
  });

  it('saves the new problem once it is the active one', () => {
    const saved: StoredSession[] = [];
    const w = createSessionWriter({
      save: (s) => {
        saved.push(s);
        return Promise.resolve(s);
      },
      clear: () => Promise.resolve(null),
    });
    w.setActive('lru-cache');
    w.save(session({ slug: 'lru-cache', rung: 1, deepestRung: 1 }));
    expect(saved.map((s) => s.slug)).toEqual(['lru-cache']);
  });

  /* Navigate away, work on the new problem, come back: the first is untouched. */
  it('leaves the old session intact and offers it again on return', async () => {
    await saveSession(session({ slug: 'two-sum', rung: 4, deepestRung: 4 }));
    await saveSession(session({ slug: 'lru-cache', rung: 1, deepestRung: 1 }));

    const left = await getSession('two-sum');
    expect(left?.rung).toBe(4);
    expect(left?.turns).toHaveLength(2);
    expect((await getSession('lru-cache'))?.rung).toBe(1);
  });

  it('has nothing to offer for a problem visited for the first time', async () => {
    await saveSession(session({ slug: 'two-sum' }));
    expect(await getSession('lru-cache')).toBeNull();
  });
});

/**
 * Navigating *while a capture is in flight*.
 *
 * A capture is a read of the page that finishes later, and the user can navigate
 * inside that window. The guard therefore has to run at resolution, not at
 * initiation: at initiation everything still looks consistent. Checked at
 * resolution, a stale capture of the problem the user left is recognisably stale;
 * checked only at initiation, it looks like an ordinary refresh, and the panel
 * walks itself back to that problem and streams a whole turn there - a turn whose
 * transcript save is then refused by the active-slug guard, so the model work is
 * paid for and thrown away.
 */
describe('a capture overtaken by a navigation', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function writer(): ReturnType<typeof createSessionWriter> {
    return createSessionWriter({
      save: () => Promise.resolve(null),
      clear: () => Promise.resolve(null),
    });
  }

  it('counts a move to another problem, but not re-adopting the same one', () => {
    const w = writer();
    expect(w.epoch).toBe(0);
    w.setActive('two-sum');
    expect(w.epoch).toBe(1);
    w.setActive('two-sum');
    expect(w.epoch).toBe(1);
    w.setActive('lru-cache');
    expect(w.epoch).toBe(2);
  });

  it('passes a capture through when nothing moved', async () => {
    const w = writer();
    w.setActive('two-sum');
    expect(await w.ifStillCurrent(() => Promise.resolve(SNAPSHOT))).toEqual({
      current: true,
      value: SNAPSHOT,
    });
  });

  /* The blocker: navigate while the capture is outstanding. */
  it('drops a capture that resolves after the panel followed the page', async () => {
    const w = writer();
    w.setActive('two-sum');
    const capture = deferred<PageSnapshot>();

    const pending = w.ifStillCurrent(() => capture.promise);
    w.setActive('lru-cache'); // the user navigates, mid-capture
    capture.resolve(SNAPSHOT); // the old problem's capture finally lands

    expect(await pending).toEqual({ current: false });
  });

  /* Comparing slugs alone would call this unchanged and let the turn run. */
  it('drops it even when the panel ends up back where it started', async () => {
    const w = writer();
    w.setActive('two-sum');
    const capture = deferred<PageSnapshot>();

    const pending = w.ifStillCurrent(() => capture.promise);
    w.setActive('lru-cache');
    w.setActive('two-sum');
    capture.resolve(SNAPSHOT);

    expect(await pending).toEqual({ current: false });
  });

  /*
   * "Navigated away" and "the page could not be read" are different answers: the
   * first must abandon the turn, the second falls back to what is on screen. So
   * a legitimate null is not allowed to look like staleness.
   */
  it('distinguishes an unreadable page from a stale one', async () => {
    const w = writer();
    w.setActive('two-sum');
    expect(await w.ifStillCurrent(() => Promise.resolve(null))).toEqual({
      current: true,
      value: null,
    });
  });

  it('lets a rejection through rather than disguising it as staleness', async () => {
    const w = writer();
    w.setActive('two-sum');
    await expect(w.ifStillCurrent(() => Promise.reject(new Error('port died')))).rejects.toThrow(
      'port died',
    );
  });

  it('keeps guarding reads issued after the navigation', async () => {
    const w = writer();
    w.setActive('two-sum');
    w.setActive('lru-cache');
    // Issued on lru-cache and resolving on lru-cache: perfectly current.
    expect(await w.ifStillCurrent(() => Promise.resolve('ok'))).toEqual({
      current: true,
      value: 'ok',
    });
  });
});

/**
 * The class, not the symptom: rapid A -> B -> C with the captures resolving in
 * either order.
 *
 * Every read of the page is stamped with the navigation epoch it was issued in
 * and dropped if that epoch has passed, which stops a late read dragging the
 * panel backwards. On its own that is still not enough: if B's read lands first
 * the panel adopts B, which invalidates C's read, and the panel would sit on B
 * while the page shows C. So the follower reads again after every adoption, in
 * the new epoch, until the page and the panel agree. These tests model that loop
 * against both resolution orders.
 */
describe('rapid navigation with out-of-order resolutions', () => {
  const page = (slug: string): PageSnapshot => ({
    ...SNAPSHOT,
    problem: { ...SNAPSHOT.problem, slug },
  });

  /**
   * The follower from `App.tsx`, with React removed: read, drop if stale,
   * adopt on a switch, and read again until it settles.
   */
  async function follow(
    w: ReturnType<typeof createSessionWriter>,
    start: PageSnapshot | null,
    read: () => Promise<PageSnapshot | null>,
    adopt: (next: PageSnapshot) => void,
  ): Promise<void> {
    let showing = start;
    for (let step = 0; step < 5; step += 1) {
      const capture = await w.ifStillCurrent(read);
      if (!capture.current) return;
      const outcome = classifyCapture(showing, capture.value);
      if (outcome.kind !== 'switched') return;
      adopt(outcome.snapshot);
      showing = outcome.snapshot;
    }
  }

  /** A page that reports a queue of values, then whatever it settled on. */
  function pageReader(
    queue: (PageSnapshot | null)[],
    settled: PageSnapshot,
  ): () => Promise<PageSnapshot | null> {
    return () => Promise.resolve(queue.length > 0 ? (queue.shift() ?? null) : settled);
  }

  function panel(): {
    writer: ReturnType<typeof createSessionWriter>;
    adopt: (next: PageSnapshot) => void;
    adopted: string[];
  } {
    const adopted: string[] = [];
    const w = createSessionWriter({
      save: () => Promise.resolve(null),
      clear: () => Promise.resolve(null),
    });
    return {
      writer: w,
      adopted,
      adopt: (next) => {
        adopted.push(next.problem.slug);
        w.setActive(next.problem.slug);
      },
    };
  }

  it('lands on C when the newest capture resolves first', async () => {
    const { writer: w, adopt, adopted } = panel();
    w.setActive('a');
    await follow(w, page('a'), pageReader([page('c')], page('c')), adopt);
    expect(adopted).toEqual(['c']);
    expect(w.active).toBe('c');
  });

  /* The reported ordering: B lands first and must not be where we stop. */
  it('lands on C when a stale B capture resolves first', async () => {
    const { writer: w, adopt, adopted } = panel();
    w.setActive('a');
    await follow(w, page('a'), pageReader([page('b')], page('c')), adopt);
    expect(adopted.at(-1)).toBe('c');
    expect(w.active).toBe('c');
  });

  it('discards a stale read issued before an adoption', async () => {
    const { writer: w, adopt } = panel();
    w.setActive('a');

    let release!: (value: PageSnapshot) => void;
    const slow = new Promise<PageSnapshot>((r) => (release = r));
    const pending = follow(w, page('a'), () => slow, adopt);

    // Another follower wins the race and adopts C first.
    adopt(page('c'));
    release(page('b')); // the old read finally lands
    await pending;

    expect(w.active).toBe('c');
  });

  it('settles without adopting anything when the page never moved', async () => {
    const { writer: w, adopt, adopted } = panel();
    w.setActive('a');
    await follow(w, page('a'), pageReader([], page('a')), adopt);
    expect(adopted).toEqual([]);
    expect(w.epoch).toBe(1);
  });

  it('stops rather than looping forever on a page that never settles', async () => {
    const { writer: w, adopt, adopted } = panel();
    w.setActive('a');
    let n = 0;
    await follow(w, page('a'), () => Promise.resolve(page(`p-${(n += 1)}`)), adopt);
    expect(adopted).toHaveLength(5);
  });

  it('leaves the panel on C after a full A-B-C walk, whatever the order', async () => {
    for (const queue of [[page('b'), page('c')], [page('c')], [page('c'), page('c')]]) {
      const { writer: w, adopt } = panel();
      w.setActive('a');
      await follow(w, page('a'), pageReader(queue, page('c')), adopt);
      expect(w.active).toBe('c');
    }
  });

  /*
   * The honest boundary. The loop resolves ordering *within* one burst of
   * navigation events; it does not poll. If the page still reports B when the
   * loop re-reads, B is genuinely what is on screen at that moment, so it
   * settles there and waits - and the navigation to C raises its own tab event,
   * which starts a new follow. Documented because it is the reason the loop can
   * terminate at all.
   */
  it('settles on what the page currently reports and waits for the next event', async () => {
    const { writer: w, adopt, adopted } = panel();
    w.setActive('a');
    await follow(w, page('a'), pageReader([page('b')], page('b')), adopt);
    expect(adopted).toEqual(['b']);

    // The later navigation to C arrives as its own event.
    await follow(w, page('b'), pageReader([], page('c')), adopt);
    expect(w.active).toBe('c');
  });
});

/**
 * Transcripts hold the user's own editor buffer, unencrypted, for up to
 * `MAX_SESSIONS` problems, and until now the only way to remove one was
 * per-problem through a resume offer. "Clear all saved data" in Settings is the
 * answer to "get this off my machine", so it has to actually clear all of it.
 */
describe('clearing everything the extension has saved', () => {
  it('removes every transcript, not only the problem on screen', async () => {
    await saveSession(session({ slug: 'two-sum', turns: [turn('user', 'a')] }));
    await saveSession(session({ slug: 'three-sum', turns: [turn('user', 'b')] }));

    await clearAllSessions();

    expect(await getSession('two-sum')).toBeNull();
    expect(await getSession('three-sum')).toBeNull();
  });

  it('removes the session log too', async () => {
    await recordAttempt({
      slug: 'two-sum',
      title: '1. Two Sum',
      startedAt: '2026-08-11T10:00:00.000Z',
      durationMs: 60_000,
      deepestRung: 2,
      hintsUsed: hintsUsedFor(2),
    });
    expect(await getAttempts('two-sum')).toHaveLength(1);

    await clearAllAttempts();

    expect(await getAttempts('two-sum')).toEqual([]);
  });

  it('cannot be undone by a save that was already in flight', async () => {
    // The panel saves on `pagehide` and on every finished turn, so a save and a
    // clear really can overlap. Both go through the one queue, in call order.
    const saving = saveSession(session({ slug: 'two-sum', turns: [turn('user', 'a')] }));
    const clearing = clearAllSessions();
    await Promise.all([saving, clearing]);

    expect(await getSession('two-sum')).toBeNull();
  });

  it('leaves the settings alone: a model choice is a preference, not saved data', async () => {
    await setSettings({ model: 'claude-haiku-4-5-20251001' });
    await clearAllSessions();
    await clearAllAttempts();
    expect((await getSettings()).model).toBe('claude-haiku-4-5-20251001');
  });
});
