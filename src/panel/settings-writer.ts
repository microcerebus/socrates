/**
 * Race-safe settings changes.
 *
 * The panel writes settings from two independent radio groups, and a user
 * switching provider and then model does it faster than a round trip to the
 * worker. Building each write from React's render-scoped `settings` loses that
 * race twice over: the second handler reads the state as it was when the render
 * happened - before the first change - so it sends a full object that undoes it,
 * and two replies can land in either order and overwrite each other on the way
 * back.
 *
 * So the intent lives here rather than in a render closure, and three things
 * keep it straight:
 *
 * - a change is a **patch**, never a whole object, applied to the newest intent
 *   synchronously, so a second change in the same tick builds on the first;
 * - writes are **serialised** through one promise chain, so the worker sees them
 *   in the order they were made and the last one is what lands in storage;
 * - a reply is **adopted only if it is still the newest** intent, so a slow
 *   earlier round trip cannot resurrect the value it was carrying.
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

    adopt(settings: Settings): void {
      current = settings;
      confirmed = settings;
      newest = null;
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
