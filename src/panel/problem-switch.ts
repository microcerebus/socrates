/**
 * What a fresh page capture means for a panel that is already showing a problem.
 *
 * ## Why this is a decision and not an `if`
 *
 * The panel is a view of whatever LeetCode is showing, but it is a *stateful*
 * one: it holds a transcript, an unlocked rung, a clock and an attempt id, all
 * of which belong to one specific problem. So a capture that comes back with a
 * different slug is not a stale read to be discarded - it is the user having
 * navigated, and the panel is now wrong about what it is looking at.
 *
 * The earlier version threw that capture away and kept the old snapshot, which
 * quietly produced the worst outcome available: the next turn ran against the
 * problem the user had left, and its reply was persisted into that problem's
 * session, while the user watched it appear next to a different question.
 *
 * ## The rung is the reason this matters more than it looks
 *
 * Carrying the panel's state across a switch would carry the *rung* across it.
 * Unlocking rung 4 on one problem and navigating to another would hand out
 * pseudocode for a problem where nothing had been earned - the ladder defeated
 * by the back button. A switch therefore closes the old session and starts the
 * new one at rung 0, like any other first visit.
 *
 * ## Two reads of the *same* problem still have an order
 *
 * The navigation epoch in `session-writer.ts` settles reads across a problem
 * change, but it says nothing about two reads of the problem already on screen -
 * and there are routinely two in flight, because the panel captures on focus, on
 * tab events and again at the start of every turn. They can resolve in either
 * order, and the loser carries a staler editor buffer, a staler language and a
 * staler run result. Adopting it would walk the panel back to the code as it was
 * a second ago, and worse, `snapshotForTurn` would then run the turn against it -
 * reviewing a buffer the user has already moved past.
 *
 * So a same-problem capture must be strictly newer than what is on screen to be
 * worth anything. `capturedAt` is the measure: it is stamped in the service
 * worker once the content script has answered, which is exactly "how fresh is
 * this reading of the page". A tie keeps the incumbent, because two reads from
 * the same millisecond are equally fresh and churning the snapshot for one of
 * them buys nothing.
 */

import type { PageSnapshot } from '../shared/types.ts';

export type CaptureOutcome =
  /**
   * Nothing worth adopting: no capture came back, the panel is on a pasted
   * problem, or this is an older read of the problem already on screen. All
   * three mean the same thing to the caller - keep what you have - and none of
   * them is an error.
   */
  | { kind: 'unchanged' }
  /** The same problem, read more recently than what is on screen. */
  | { kind: 'refreshed'; snapshot: PageSnapshot }
  /** A different problem. The panel has to follow the page. */
  | { kind: 'switched'; snapshot: PageSnapshot };

export function classifyCapture(
  current: PageSnapshot | null,
  captured: PageSnapshot | null,
): CaptureOutcome {
  if (captured === null) return { kind: 'unchanged' };

  /*
   * A pasted problem outranks the page. The paste box only appears because the
   * page could not be read, so letting a later successful scrape of that same
   * unreadable page take over would throw away what the user typed in to work
   * around it.
   */
  if (current !== null && current.problem.source === 'manual') return { kind: 'unchanged' };

  if (current === null) return { kind: 'switched', snapshot: captured };
  if (current.problem.slug !== captured.problem.slug)
    return { kind: 'switched', snapshot: captured };

  // Same problem: only a strictly newer read is worth anything. See the header.
  return captured.capturedAt > current.capturedAt
    ? { kind: 'refreshed', snapshot: captured }
    : { kind: 'unchanged' };
}
