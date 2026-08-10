/**
 * A deterministic backstop for the one leak the prompt cannot fully prevent:
 * code appearing below rung 4.
 *
 * The prompt is the primary control. This guard exists because "no code" is the
 * single rung rule that is both (a) unambiguous enough to enforce mechanically
 * and (b) catastrophic when it fails - a fenced solution at rung 2 ends the
 * session. Softer rules (naming a technique, stacking questions) are left to the
 * prompt: pattern-matching them against prose produces false positives that would
 * mangle legitimate replies.
 *
 * The guard is streaming-aware: it holds text back at a fence boundary rather
 * than letting a partial block reach the panel and then retracting it.
 */

import type { Rung } from '../shared/types.ts';

/** Rungs strictly below this may not contain fenced code blocks. */
export const FIRST_RUNG_ALLOWING_CODE: Rung = 4;

export const WITHHELD_NOTICE = '\n\n_[code withheld - unlock rung 4 for pseudocode]_\n\n';

const FENCE = '```';

export interface SpoilerGuard {
  /** Feed a streamed chunk; returns the text that is safe to display now. */
  push(chunk: string): string;
  /** Call once the stream ends; returns any held-back tail. */
  flush(): string;
  /** How many fenced blocks were removed. */
  readonly redactions: number;
}

export function guardsCode(rung: Rung): boolean {
  return rung < FIRST_RUNG_ALLOWING_CODE;
}

/**
 * How many trailing characters could be the start of a fence that got split
 * across chunk boundaries (`` ` `` or ``` `` ```).
 */
function heldBackTailLength(text: string): number {
  let n = 0;
  while (n < 2 && n < text.length && text[text.length - 1 - n] === '`') n += 1;
  return n;
}

export function createSpoilerGuard(rung: Rung): SpoilerGuard {
  if (!guardsCode(rung)) {
    return {
      push: (chunk) => chunk,
      flush: () => '',
      get redactions() {
        return 0;
      },
    };
  }

  let pending = '';
  let insideFence = false;
  let redactions = 0;

  function drain(final: boolean): string {
    let out = '';
    for (;;) {
      if (!insideFence) {
        const open = pending.indexOf(FENCE);
        if (open === -1) {
          const hold = final ? 0 : heldBackTailLength(pending);
          out += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          return out;
        }
        out += pending.slice(0, open);
        pending = pending.slice(open + FENCE.length);
        insideFence = true;
        redactions += 1;
        out += WITHHELD_NOTICE;
      } else {
        const close = pending.indexOf(FENCE);
        if (close === -1) {
          // Everything still inside the fence is dropped, except a possible
          // split closing delimiter.
          pending = final ? '' : pending.slice(pending.length - heldBackTailLength(pending));
          return out;
        }
        pending = pending.slice(close + FENCE.length);
        insideFence = false;
      }
    }
  }

  return {
    push(chunk) {
      pending += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
    get redactions() {
      return redactions;
    },
  };
}

/** Convenience for tests and non-streaming callers. */
export function redactCode(rung: Rung, text: string): string {
  const guard = createSpoilerGuard(rung);
  return guard.push(text) + guard.flush();
}
