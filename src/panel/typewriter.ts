/**
 * Paces arrived text onto the screen, because the transport does not arrive
 * smoothly.
 *
 * ## The measurement this exists for
 *
 * The `claude` CLI does emit incremental text - `--include-partial-messages` is
 * doing its job - but it coalesces deltas into blocks of roughly 150 characters
 * arriving about every 500ms. Rendering each block the instant it lands puts a
 * whole sentence on screen at once, four times a second. That reads as a page
 * repeatedly reflowing, not as something being written, and it is the reason a
 * genuinely streaming panel felt like it was not streaming.
 *
 * ## This is pacing, not fabrication
 *
 * Nothing here invents text or predicts it. Every character revealed has already
 * arrived from the model; the only decision is *when* in the next few hundred
 * milliseconds to show it.
 *
 * The rate is proportional to the backlog rather than fixed, which is what stops
 * the display drifting behind - the failure mode that would make this a lie. A
 * fixed characters-per-second either lags further behind with every block or
 * flickers when the model is slow; scaling the step to what is queued gives an
 * exponential drain whose steady-state lag settles at roughly one
 * `REVEAL_WINDOW_MS` of text and stays there however long the reply runs. At the
 * measured arrival rate (~150 characters every ~500ms) that is around a tenth of
 * a second behind, and a burst is caught up on rather than queued.
 *
 * `finish()` exists so the end of a turn is immediate: once the stream is over,
 * a user waiting on an animation is waiting for nothing.
 *
 * ## Reduced motion
 *
 * A window of 0 makes every reveal instantaneous, which is what the panel passes
 * when `prefers-reduced-motion: reduce` is set. Same code path, no branch in the
 * component, and the honest behaviour (all arrived text is shown) is unchanged.
 */

/**
 * How long the pacer aims to take to clear whatever is queued. Short enough that
 * the text never trails the model by a perceptible amount, long enough that a
 * 150-character block becomes about twenty frames of typing.
 */
export const REVEAL_WINDOW_MS = 320;

export interface Typewriter {
  /** Everything that has arrived from the model. */
  readonly full: string;
  /** The part of it that should be on screen now. */
  readonly visible: string;
  /** True when the screen has caught up with what arrived. */
  readonly settled: boolean;
  /** Feed newly arrived text. */
  push(text: string): void;
  /**
   * Advance by one animation frame. `frameMs` is the time since the last tick.
   * Returns the text to display.
   */
  tick(frameMs: number): string;
  /** Reveal everything at once, for the end of a turn or a cancellation. */
  finish(): string;
}

/**
 * How many characters to release this frame.
 *
 * Proportional to the backlog rather than fixed, so a long block types faster
 * than a short one instead of taking proportionally longer to appear. At least
 * one character always moves, so a one-character tail cannot stick, and never
 * more than has arrived.
 */
export function charsToReveal(backlog: number, frameMs: number, windowMs: number): number {
  if (backlog <= 0) return 0;
  if (windowMs <= 0 || frameMs >= windowMs) return backlog;
  const share = Math.ceil((backlog * frameMs) / windowMs);
  return Math.min(backlog, Math.max(1, share));
}

export function createTypewriter(windowMs: number = REVEAL_WINDOW_MS): Typewriter {
  let full = '';
  let shown = 0;

  return {
    get full() {
      return full;
    },
    get visible() {
      return full.slice(0, shown);
    },
    get settled() {
      return shown >= full.length;
    },
    push(text) {
      full += text;
    },
    tick(frameMs) {
      shown += charsToReveal(full.length - shown, frameMs, windowMs);
      return full.slice(0, shown);
    },
    finish() {
      shown = full.length;
      return full;
    },
  };
}
