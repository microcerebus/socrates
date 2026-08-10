/**
 * Deciding whether a session is still worth saving.
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

export interface SessionWriterOptions {
  save(session: StoredSession): Promise<unknown>;
  clear(slug: string): Promise<unknown>;
}

export interface SessionWriter {
  /**
   * Persist this session, unless it describes one the user has discarded.
   * A session with no turns is not worth a write and is silently skipped.
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
  /** Which slug is currently discarded, if any. Exposed for tests. */
  readonly discarded: string | null;
}

export function createSessionWriter(options: SessionWriterOptions): SessionWriter {
  /*
   * At most one slug matters: the panel shows one problem at a time, and the
   * offer to resume is answered before anything else can happen.
   */
  let discarded: string | null = null;

  return {
    get discarded(): string | null {
      return discarded;
    },

    save(session): void {
      if (session === null || session.turns.length === 0) return;
      if (discarded === session.slug) return;
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
  };
}
