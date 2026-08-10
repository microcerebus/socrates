/**
 * The panel's synchronous truth about which problem it is on, and what may be
 * written for it.
 *
 * Everything else in the panel is React state, which is *scheduled* rather than
 * applied: anything running before the next render still sees the previous
 * values out of a closure. Three separate bugs came out of that, all of them
 * writing or displaying the wrong problem's work, so the decisions that must be
 * right in the same tick they are made live here instead - which is the same
 * reason `settings-writer.ts` keeps the settings intent outside React.
 *
 * It owns three things: whether a session has been discarded, which problem is
 * active, and whether an in-flight page read has been overtaken by a navigation.
 *
 * ## The bug this exists to make impossible
 *
 * "Start fresh" throws a stored session away. But the panel's own `turns` and
 * `rung` are React state, and the save that runs on `pagehide` reads them from a
 * render closure - so between the click and the re-render that clears them there
 * is a window where a save would write the discarded conversation straight back
 * over the storage that was just cleared. The user chose to start over and the
 * old session reappears next time they open the problem.
 *
 * Resetting the React state is necessary but not sufficient, because a state
 * update is scheduled rather than applied: anything that runs before the next
 * render still sees the old values. So the decision cannot live in a render
 * closure either. It lives here, as one synchronous flag flipped in the same
 * tick as the click, which is the same reason `settings-writer.ts` keeps the
 * settings intent outside React.
 *
 * ## Why there is no queue here
 *
 * Ordering is already total. `PortClient` posts each request to the worker
 * synchronously when the method is called, so the port sees clear-then-save in
 * call order, and `transcript-store.ts` serialises the mutations behind that in
 * the order they arrive. Adding a second queue here would not make anything
 * safer, and two independent orderings of the same writes is exactly the sort of
 * thing that later disagrees with itself.
 */

import type { StoredSession } from '../shared/types.ts';

/**
 * The outcome of a page read that may have been overtaken by a navigation.
 * `{ current: false }` means the panel moved to a different problem while the
 * read was in flight, so whatever came back describes a page the user is no
 * longer looking at.
 */
export type Current<T> = { current: true; value: T } | { current: false };

export interface SessionWriterOptions {
  save(session: StoredSession): Promise<unknown>;
  clear(slug: string): Promise<unknown>;
}

export interface SessionWriter {
  /**
   * Persist this session, unless it describes one the user has discarded or one
   * the panel has already navigated away from. A session with no turns is not
   * worth a write and is silently skipped.
   */
  save(session: StoredSession | null): void;
  /** Throw the stored session away, and refuse saves built from it. */
  discard(slug: string): void;
  /**
   * A turn has begun for this slug, so whatever the panel holds now is new work
   * rather than the leftovers of a discarded session. Saves are meaningful
   * again.
   */
  beginTurn(slug: string): void;
  /**
   * The problem the panel is showing now. Set it *after* saving the one being
   * left, because from this moment saves for any other slug are refused.
   */
  setActive(slug: string): void;
  /**
   * Run an asynchronous read of the page in the current navigation epoch, and
   * throw its result away if the panel adopted a different problem while it was
   * outstanding.
   *
   * This is the guard that has to be applied at *resolution*, not at
   * initiation. A capture takes a round trip through the worker and the content
   * script, and the user can navigate inside that window. Everything the caller
   * closed over when it started - the snapshot, the transcript, the rung - then
   * describes a problem that is no longer on screen, so a result compared
   * against it reaches exactly the wrong conclusion: a stale capture of the old
   * problem looks like an ordinary refresh, and the panel walks itself back to
   * the problem the user just left.
   *
   * The result is wrapped rather than collapsed to `null`, because "we navigated
   * away" and "the page could not be read" need opposite handling - the first
   * abandons the turn, the second falls back to the snapshot already on screen -
   * and both of the reads this guards can legitimately answer `null`.
   *
   * Rejections are passed through untouched; only a *successful* stale result is
   * dropped.
   */
  ifStillCurrent<T>(work: () => Promise<T>): Promise<Current<T>>;
  /** Which slug is currently discarded, if any. Exposed for tests. */
  readonly discarded: string | null;
  /** Which problem the panel believes it is showing. Exposed for tests. */
  readonly active: string | null;
  /**
   * The navigation epoch: how many times the panel has moved to a different
   * problem. Every asynchronous read of the page is stamped with the epoch it
   * was issued in and is only believed if that epoch is still current, so
   * out-of-order resolutions cannot drag the panel backwards.
   */
  readonly epoch: number;
}

export function createSessionWriter(options: SessionWriterOptions): SessionWriter {
  /*
   * At most one slug matters: the panel shows one problem at a time, and the
   * offer to resume is answered before anything else can happen.
   */
  let discarded: string | null = null;

  /*
   * Which problem the panel is showing. A turn that finishes after the user has
   * navigated away still carries the slug it ran against, and writing it then
   * would resurrect a session the panel has already closed - so the write is
   * refused rather than raced. `null` means nothing has been adopted yet, which
   * is only true before the first capture lands.
   */
  let active: string | null = null;

  /*
   * Counts problem changes, not calls. Anything awaiting across a bump describes
   * a page the panel has already moved on from - including the A -> B -> A case,
   * where comparing slugs alone would wrongly conclude nothing had happened.
   */
  let epoch = 0;

  return {
    get discarded(): string | null {
      return discarded;
    },

    get active(): string | null {
      return active;
    },

    get epoch(): number {
      return epoch;
    },

    async ifStillCurrent<T>(work: () => Promise<T>): Promise<Current<T>> {
      const startedIn = epoch;
      const value = await work();
      return epoch === startedIn ? { current: true, value } : { current: false };
    },

    save(session): void {
      if (session === null || session.turns.length === 0) return;
      if (discarded === session.slug) return;
      if (active !== null && active !== session.slug) return;
      void options.save(session).catch(() => undefined);
    },

    discard(slug): void {
      // Synchronous, and before the round trip starts, so a `pagehide` firing in
      // the very next microtask is already refused.
      discarded = slug;
      void options.clear(slug).catch(() => undefined);
    },

    beginTurn(slug): void {
      if (discarded === slug) discarded = null;
    },

    setActive(slug): void {
      // Re-adopting the same problem is not a navigation, and bumping for it
      // would cancel captures that are still perfectly valid.
      if (active === slug) return;
      active = slug;
      epoch += 1;
    },
  };
}
