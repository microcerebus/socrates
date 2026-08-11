/**
 * A deterministic backstop for the two leaks the prompt cannot fully prevent:
 * code appearing below rung 4, and a topic tag appearing below rung 2.
 *
 * The prompt is the primary control. These two are guarded mechanically because
 * they share the property that makes mechanical enforcement worth its cost: each
 * is a *literal string* the reply either contains or does not, and each is
 * catastrophic when it slips - a fenced solution at rung 2 ends the session, and
 * "this is a Hash Table problem" at rung 1 ends it just as thoroughly while
 * looking like a helpful sentence.
 *
 * Softer rules (naming a technique by description, stacking questions until they
 * are an outline) are left to the prompt: pattern-matching those against prose
 * produces false positives that would mangle legitimate replies.
 *
 * ## Why tags are guarded but `TECHNIQUE_NAMES` is not
 *
 * The rung-1 prohibition on technique names is prompt-only on purpose: those
 * words have innocent uses ("your stack of conditions", "queue up the reads"),
 * and redacting them would maul ordinary sentences. A topic tag is different in
 * one decisive way - the user has *not seen it*. It came off a collapsed toggle
 * that the panel scraped on their behalf, so passing it through is not a hint
 * they asked for at a rung they earned; it is the panel handing over the answer
 * with its own hand. That asymmetry is what earns the false positives.
 *
 * ## The concept, not the string
 *
 * A tag is withheld in every surface form it has - "Heap"/"heaps", "Hash
 * Table"/"hash-tables"/"the hash table's" - because the thing above the rung is
 * the idea, and withholding only the spelling LeetCode happened to use is the
 * same leak with a false sense of coverage. `tag-forms.ts` owns which
 * transformations count and, just as importantly, which do not.
 *
 * ## And only what the user has not already read
 *
 * That breadth is only safe because of its counterweight. LeetCode's tags are
 * not all techniques: `Array`, `String`, `Tree`, `Matrix`, `Sorting`, `Counting`
 * are ordinary problem vocabulary, and a Two Sum statement opens "given an array
 * of integers". Withholding those turns a rung-1 reply into "you scan the
 * [withheld] twice" - useless, and a signal in its own right.
 *
 * So `visibleText` narrows the set to the tags the user cannot already read on
 * the page. That is not a hole in the rule, it *is* the rule: this guard exists
 * because the user has not seen the tags. A tag quoted in the statement they are
 * reading has been seen, and redacting it protects nothing while damaging the
 * only thing the panel produces.
 *
 * The guard is streaming-aware: it holds text back at a fence boundary, and at a
 * possible partial tag *or a stem that an inflection may still be arriving for*,
 * rather than letting either reach the panel and then retracting it.
 */

import type { Rung } from '../shared/types.ts';
import { mentions, tagConcepts, tagKey, tagPrefixPattern, tagsPattern } from './tag-forms.ts';

/** Rungs strictly below this may not contain fenced code blocks. */
export const FIRST_RUNG_ALLOWING_CODE: Rung = 4;

/** Rungs strictly below this may not contain a scraped topic tag. */
export const FIRST_RUNG_ALLOWING_TAGS: Rung = 2;

export const WITHHELD_NOTICE = '\n\n_[code withheld - unlock rung 4 for pseudocode]_\n\n';

/** Deliberately says nothing about what was removed; naming it would be the leak. */
export const TAG_NOTICE = '[withheld]';

const FENCE = '```';

export interface SpoilerGuard {
  /** Feed a streamed chunk; returns the text that is safe to display now. */
  push(chunk: string): string;
  /** Call once the stream ends; returns any held-back tail. */
  flush(): string;
  /** How many fenced blocks were removed. */
  readonly redactions: number;
  /** How many topic tags were removed. */
  readonly tagRedactions: number;
}

export function guardsCode(rung: Rung): boolean {
  return rung < FIRST_RUNG_ALLOWING_CODE;
}

export function guardsTags(rung: Rung): boolean {
  return rung < FIRST_RUNG_ALLOWING_TAGS;
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

/**
 * How much of the tail is a partial tag that must not be emitted yet.
 *
 * Delegated to one regex (see `tagPrefixPattern`) rather than compared against
 * canonicalised stems. Stems were the previous approach and they cannot work:
 * the buffer carries *inflected* text, so "Slidi" on its way to "Sliding Window"
 * shares no prefix with the stem `slidwindow`, and the fragment went out.
 */
function heldBackTagTail(text: string, prefixPattern: RegExp | null): number {
  if (prefixPattern === null) return 0;
  const matched = prefixPattern.exec(text)?.[0].length ?? 0;
  // A pathological stream must not be able to pin the panel indefinitely.
  return Math.min(matched, MAX_HELD_CHARS);
}

/** Comfortably past the longest tag plus its separators and an inflection. */
const MAX_HELD_CHARS = 64;

export interface GuardOptions {
  /** LeetCode's topic tags for this problem, if any were scraped. */
  topicTags?: readonly string[];
  /**
   * What the user can already read: the statement, title, examples and
   * constraints. Tags that appear in it are not withheld - see the header.
   * Omitting it withholds every tag, which is the safe default for callers that
   * do not have the problem text to hand.
   */
  visibleText?: string;
}

/**
 * The tags this rung must withhold: every concept the tags name, minus the ones
 * already on the user's screen.
 */
export function withheldTags(rung: Rung, options: GuardOptions = {}): string[] {
  if (!guardsTags(rung)) return [];
  const visible = options.visibleText ?? '';
  return (options.topicTags ?? [])
    .flatMap(tagConcepts)
    .filter((tag) => tagKey(tag).length >= 3)
    .filter((tag) => visible === '' || !mentions(tag, visible));
}

export function createSpoilerGuard(rung: Rung, options: GuardOptions = {}): SpoilerGuard {
  const tags = withheldTags(rung, options);
  const pattern = tagsPattern(tags);
  // Built once, because the boundary check runs on every chunk.
  const prefixPattern = tagPrefixPattern(tags);
  let tagRedactions = 0;

  const stripTags = (text: string): string => {
    if (pattern === null || text === '') return text;
    pattern.lastIndex = 0;
    return text.replace(pattern, () => {
      tagRedactions += 1;
      return TAG_NOTICE;
    });
  };

  if (!guardsCode(rung)) {
    // Tags are only guarded below rung 2 and code below rung 4, so this branch
    // never has tags to strip - but it is written the same way so the two rules
    // cannot drift apart if the thresholds ever move.
    let held = '';
    return {
      push(chunk) {
        held += chunk;
        const hold = heldBackTagTail(held, prefixPattern);
        const out = stripTags(held.slice(0, held.length - hold));
        held = held.slice(held.length - hold);
        return out;
      },
      flush() {
        const out = stripTags(held);
        held = '';
        return out;
      },
      get redactions() {
        return 0;
      },
      get tagRedactions() {
        return tagRedactions;
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
          const hold = final
            ? 0
            : Math.max(heldBackTailLength(pending), heldBackTagTail(pending, prefixPattern));
          out += stripTags(pending.slice(0, pending.length - hold));
          pending = pending.slice(pending.length - hold);
          return out;
        }
        out += stripTags(pending.slice(0, open));
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
    get tagRedactions() {
      return tagRedactions;
    },
  };
}

/** Convenience for tests and non-streaming callers. */
export function redactCode(rung: Rung, text: string, options: GuardOptions = {}): string {
  const guard = createSpoilerGuard(rung, options);
  return guard.push(text) + guard.flush();
}
