/**
 * One mutation at a time, in call order, per storage key.
 *
 * Every store in here is a read-modify-write over a *whole* `chrome.storage.local`
 * key: get the record, change one entry, set it all back. Two of those in flight
 * at once both read the same "before", and the second `set` silently discards the
 * first one's work. The panel really does overlap them - a finished turn saves at
 * the same moment a `pagehide` does, an attempt is upserted while a session is
 * being written, and "clear all saved data" fires while either may be landing.
 *
 * The load-bearing detail is at the call sites, not here: the record must be read
 * *inside* the queued work rather than before it, so each mutation merges into
 * whatever the previous one actually wrote. Reads go through the queue too, so a
 * caller cannot be handed a record that a queued clear is about to invalidate.
 *
 * A rejected operation must not wedge the chain, hence the same handler on both
 * settle paths; each caller still sees its own rejection.
 */

export type WriteQueue = <T>(work: () => Promise<T>) => Promise<T>;

export function createWriteQueue(): WriteQueue {
  let queue: Promise<unknown> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
