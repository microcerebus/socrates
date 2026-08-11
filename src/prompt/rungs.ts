/**
 * The hint ladder.
 *
 * This file is the single source of truth for what may be said at each rung.
 * It is consumed by `system-prompt.ts` (to build the model instructions) and by
 * the side panel (to label buttons and show the user where they are).
 *
 * Design rule: every rung's `reveals` list is a *ceiling*, not a checklist. The
 * `withholds` list restates the ceiling as prohibitions, because in practice the
 * model follows an explicit "do not say X" far more reliably than it infers X
 * from the absence of permission.
 */

import type { Rung } from '../shared/types.ts';

export interface RungSpec {
  id: Rung;
  /** Short name shown in the UI and in the prompt. */
  name: string;
  /** One-line description of the rung, shown under the Next hint button. */
  summary: string;
  /** Label for the button that unlocks this rung. */
  unlockLabel: string;
  /**
   * An imperative phrase completing "do not ...", used to state the rung as a
   * prohibition while it is still locked. Written by hand rather than derived
   * from `summary`, which is a noun phrase and reads as nonsense after "do not".
   */
  lockedPhrase: string;
  /** Rung 0 is free - understanding the problem is not a hint. */
  countsAsHint: boolean;
  /** What the model may reveal once this rung is unlocked. */
  reveals: string[];
  /** What the model must still withhold at this rung. */
  withholds: string[];
  /** How deep a "check my code" review may go at this rung. */
  reviewPolicy: string;
}

/**
 * Technique names are enumerated so the rung-1 prohibition is concrete. A vague
 * "don't name the technique" gets rationalised away; a list does not.
 */
export const TECHNIQUE_NAMES = [
  'hash map',
  'hash set',
  'two pointers',
  'sliding window',
  'binary search',
  'dynamic programming',
  'memoisation',
  'greedy',
  'prefix sum',
  'stack',
  'monotonic stack',
  'queue',
  'deque',
  'heap',
  'priority queue',
  'trie',
  'union-find',
  'BFS',
  'DFS',
  'topological sort',
  'backtracking',
  'divide and conquer',
  'bit manipulation',
  'linked-list cycle detection',
] as const;

export const RUNGS: readonly RungSpec[] = [
  {
    id: 0,
    name: 'Understand',
    summary: 'Restate the problem, surface edge cases, agree the contract.',
    unlockLabel: 'Understand the problem',
    lockedPhrase: 'restate the problem or enumerate its edge cases',
    countsAsHint: false,
    reveals: [
      'A short restatement of the problem in your own words.',
      'Edge cases and ambiguities worth pinning down before coding: empty input, single element, duplicates, ties, overflow, ordering guarantees.',
      'The contract: what goes in, what comes out, what happens on degenerate input.',
      'A question about what the user has already tried or noticed.',
    ],
    withholds: [
      'Any characterisation of how the problem should be solved, however oblique.',
      'A target time or space complexity - that is rung 1.',
      'Observations that only matter because of the intended technique (for example pointing out that the array is sorted when sortedness is the whole trick).',
    ],
    reviewPolicy:
      'Check the code only against the contract you just agreed: does it handle the stated inputs and edge cases, does it return the right shape. Say nothing about whether the approach can reach a better complexity.',
  },
  {
    id: 1,
    name: 'Pattern smell',
    summary: 'One Socratic question pointing at the family of technique.',
    unlockLabel: 'Next hint',
    lockedPhrase: 'point at the family of technique, even obliquely',
    countsAsHint: true,
    reveals: [
      'Exactly one Socratic question that points at the family of technique without naming it.',
      'Structural observations the user could have made from the statement themselves: sortedness, monotonicity, a bounded alphabet, repeated subwork, an invariant that survives one pass.',
      'A target complexity to beat, phrased as a challenge ("can you do this without looking at every pair?").',
    ],
    withholds: [
      'The name of any technique or data structure. This includes naming it by description: "a structure with constant-time lookup" is naming a hash map, "walk from both ends" is naming two pointers.',
      'Any ordered steps, pseudocode, or code.',
      'More than one question - a barrage of questions is a disguised outline.',
    ],
    reviewPolicy:
      'Say whether the code is correct on its own terms and whether it matches the contract. You may say the complexity is worse than the target, but not what would fix it.',
  },
  {
    id: 2,
    name: 'Name the technique',
    summary: 'Name the technique or data structure, and why it fits.',
    unlockLabel: 'Next hint',
    lockedPhrase: 'name the technique or data structure, or describe it in a way that names it',
    countsAsHint: true,
    reveals: [
      'The name of the technique or data structure this problem wants.',
      'Why the structure of this specific problem invites it - tie the name back to a property of the statement.',
      'The complexity that technique buys you, and what it costs in space.',
    ],
    withholds: [
      'How to apply it: no ordered steps, no loop structure, no invariants, no state to maintain.',
      'Pseudocode and code of any kind.',
    ],
    reviewPolicy:
      'Say whether the code is using the named technique, and whether the technique as used can reach the target complexity. Do not describe the correct application.',
  },
  {
    id: 3,
    name: 'Approach outline',
    summary: 'Three to five plain-English steps. No code.',
    unlockLabel: 'Next hint',
    lockedPhrase: 'give ordered steps or an outline of the approach',
    countsAsHint: true,
    reveals: [
      'An outline of three to five plain-English steps.',
      'What state is tracked and why it is enough.',
      'The complexity of the outlined approach and where the cost sits.',
    ],
    withholds: [
      'Code and pseudocode in any form: no fenced blocks, no loop headers, no variable declarations, no assignment arrows, no index arithmetic written out.',
      'The exact update rule or invariant stated formally - describe the idea in prose, not in symbols.',
    ],
    reviewPolicy:
      "Compare the code's shape against the outline you gave. Name which step is missing or wrong, in prose. Do not write the corrected line.",
  },
  {
    id: 4,
    name: 'Pseudocode',
    summary: 'Structure and invariants, in your language idioms.',
    unlockLabel: 'Next hint',
    lockedPhrase: 'give pseudocode, a loop structure, or an invariant',
    countsAsHint: true,
    reveals: [
      'Pseudocode: the loop structure, the state, the update rule, and the invariant that makes it correct.',
      "Idioms of the user's language so it reads naturally to them, without being a submittable solution.",
      'Where the edge cases are handled and why.',
    ],
    withholds: [
      'A complete, runnable, copy-pasteable solution.',
      "A full line-by-line rewrite of the user's code.",
    ],
    reviewPolicy:
      "Map the user's code onto the pseudocode and point at the lines that diverge. Describe the fix precisely; still stop short of handing over the finished function.",
  },
  {
    id: 5,
    name: 'Full walkthrough',
    summary: 'Working solution, complexity, and a review of your code.',
    unlockLabel: 'I give up - walk me through it',
    lockedPhrase: 'give a working solution or a line-level rewrite of their code',
    countsAsHint: true,
    reveals: [
      'A complete, working solution in the language they are writing.',
      'Time and space complexity with a one-line justification for each.',
      "A review of the user's own code against that solution: what they got right, what breaks, and the smallest change that would have got them there.",
      'The idea to remember for next time, in one sentence.',
    ],
    withholds: ['Nothing is withheld at this rung. Be complete and be kind.'],
    reviewPolicy: 'Full line-level review against the reference solution.',
  },
];

export function rungSpec(rung: Rung): RungSpec {
  const spec = RUNGS[rung];
  if (!spec) throw new Error(`Unknown rung: ${String(rung)}`);
  return spec;
}

/** Rungs 1-5 count as hints; rung 0 does not. */
export function hintsUsedFor(deepestRung: Rung): number {
  return RUNGS.filter((r) => r.countsAsHint && r.id <= deepestRung).length;
}

export const TOTAL_HINTS = RUNGS.filter((r) => r.countsAsHint).length;
