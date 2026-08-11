/**
 * Race-safe settings changes.
 *
 * The panel writes settings from a radio group, and a user clicking through
 * models faster than a round trip to the worker can still race: two replies can
 * land in either order and overwrite each other on the way back. Building each
 * write from React's render-scoped `settings` loses that race too - the second
 * handler reads the state as it was when the render happened, before the first
 * change, so it sends a full object that undoes it.
 *
 * So the intent lives here rather than in a render closure, and three things
 * keep it straight:
 *
 * - a change is a **patch**, never a whole object, applied to the newest intent
 *   synchronously, so a second change in the same tick builds on the first;
 * - writes are **serialised** through one promise chain, so the worker sees them
 *   in the order they were made and the last one is what lands in storage;
 * - a reply is **adopted only if it is still the newest** intent, so a slow
 *   earlier round trip cannot resurrect the value it was carrying - and for the
 *   same reason the initial load defers to a change already in flight rather
 *   than overwriting it.
 *
 * It is deliberately free of React: this is the part worth testing, and a
 * promise-ordering test should not need a renderer.
 */

import { DEFAULT_SETTINGS, type AppError, type Settings } from '../shared/types.ts';

export interface SettingsWriterOptions {
  save(settings: Settings): Promise<Settings>;
  /** Called with every value the panel should show, optimistic ones included. */
  onSettings(settings: Settings): void;
  onError(error: AppError): void;
}

export interface SettingsWriter {
  /** Take what the worker reports as the truth, e.g. on first load. */
  adopt(settings: Settings): void;
  /** Change some fields. Safe to call again before the last write has answered. */
  patch(patch: Partial<Settings>): void;
  /** The newest intent, whether or not it has been confirmed yet. */
  readonly current: Settings;
}

export function createSettingsWriter(options: SettingsWriterOptions): SettingsWriter {
  /** The newest intent. What the panel is showing. */
  let current: Settings = { ...DEFAULT_SETTINGS };
  /** The last value the worker confirmed. What a failed write falls back to. */
  let confirmed: Settings = current;
  /** Identity of the write still in flight, so stale replies can be recognised. */
  let newest: Settings | null = null;
  let queue: Promise<void> = Promise.resolve();

  return {
    get current(): Settings {
      return current;
    },

    /**
     * The load is a read, not a change, and it can land *after* the user has
     * already touched a radio - the panel asks for settings on mount and the
     * sheet is one click away. So it always updates the baseline a failed write
     * falls back to, but it only takes over the display when nothing is in
     * flight. Clobbering `newest` here would revert the user's choice on screen
     * *and* orphan its reply, leaving the panel disagreeing with storage until
     * the next reload.
     *
     * A change made before the stored value was known is still built on the
     * defaults for the fields it did not name; that is inherent to acting before
     * the answer arrives, and the window is a few milliseconds wide.
     */
    adopt(settings: Settings): void {
      confirmed = settings;
      if (newest !== null) return;
      current = settings;
      options.onSettings(settings);
    },

    patch(patch: Partial<Settings>): void {
      // Synchronous, so the next patch in this tick sees this one.
      const next: Settings = { ...current, ...patch };
      current = next;
      newest = next;
      // Move the radio now; waiting on a round trip makes the panel feel stuck.
      options.onSettings(next);

      queue = queue
        .then(() => options.save(next))
        .then((saved) => {
          if (newest !== next) return; // a later change has already superseded this one
          current = saved;
          confirmed = saved;
          newest = null;
          options.onSettings(saved);
        })
        .catch((error: AppError) => {
          if (newest === next) {
            // Nothing newer is coming to correct the display, so undo the guess.
            current = confirmed;
            newest = null;
            options.onSettings(confirmed);
          }
          options.onError(error);
        });
    },
  };
}
