/**
 * "Everything saved before this moment is gone, and is to stay gone."
 *
 * ## Why serialising the writes is not enough on its own
 *
 * "Clear all saved data" competes with two writers that were already in motion
 * when the user clicked: a turn that is about to finish, and the `pagehide` save.
 * Putting the clear through the same queue as those writes fixes the half of the
 * problem that is about *ordering* - a write already queued runs before the
 * clear and is then wiped by it.
 *
 * It does not fix the other half, which is about *identity*. `onDone` in
 * `App.tsx` fires from a closure built when the turn started, so it carries the
 * `startedAt` the attempt had then. That write is issued **after** the clear,
 * arrives after it, and is perfectly well-ordered - it just describes a session
 * the user has deleted, and it recreates its row in the session log.
 *
 * ## So the boundary is an identity, not an instant
 *
 * A wall-clock cutoff cannot express this. The panel resets its session
 * synchronously on the click, so the *new* attempt's `startedAt` is stamped
 * before the worker ever hears about the clear: any "refuse writes older than
 * the moment I cleared" rule refuses the replacement session too, forever.
 *
 * What the panel does know, in the same tick as the click, is the identity of
 * the session it is starting *instead* - and both things that get written carry
 * that identity (`AttemptRecord.startedAt`, `StoredSession.startedAt`). So the
 * clear names it, and anything that began strictly earlier is refused at write
 * time no matter when it arrives. The replacement session compares equal, so it
 * writes normally.
 *
 * The mark only ever moves forward: `epoch` counts clears and the boundary takes
 * the later of the two ids, so a clear that arrives out of order cannot reopen
 * writes an earlier one closed. ISO-8601 UTC strings order lexicographically,
 * which is why the comparison can be a plain `<`.
 *
 * Per-problem clears (`clearSession`, behind "start fresh") deliberately do not
 * come through here: they are scoped to one slug, they are already guarded
 * synchronously in the panel by `session-writer.ts`, and moving a global
 * boundary for one problem would refuse another problem's perfectly live save.
 */

export interface ClearMark {
  /** Counts clear-alls. Monotonic, and the reason a stale mark cannot win. */
  epoch: number;
  /**
   * The `startedAt` of the session the panel began at the moment of the clear.
   * `null` before the first clear-all, when nothing is refused.
   */
  activeFrom: string | null;
}

let mark: ClearMark = { epoch: 0, activeFrom: null };

export function clearMark(): ClearMark {
  return mark;
}

/**
 * Records a clear-all. Call this synchronously, when the request arrives and
 * before either store is touched, so a write landing during the clear is already
 * being judged against the new boundary.
 */
export function markClearAll(activeFrom: string): ClearMark {
  mark = {
    epoch: mark.epoch + 1,
    activeFrom:
      mark.activeFrom !== null && activeFrom < mark.activeFrom ? mark.activeFrom : activeFrom,
  };
  return mark;
}

/** Did the session this write describes begin before the last clear-all? */
export function predatesClearAll(startedAt: string): boolean {
  return mark.activeFrom !== null && startedAt < mark.activeFrom;
}

/** Test seam. Module state outlives a test file otherwise, and nothing else may call it. */
export function resetClearBoundary(): void {
  mark = { epoch: 0, activeFrom: null };
}
