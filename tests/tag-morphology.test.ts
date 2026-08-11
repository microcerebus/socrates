/**
 * A tag concept must not surface below its rung through surface variation.
 *
 * The guard withholds an *idea*, not a spelling. Matching the tag verbatim
 * withheld "Heap" and passed "heaps", which is not a smaller leak - it is the
 * same leak with a false sense of coverage. These tests run over LeetCode's
 * whole tag vocabulary rather than a handful of examples, because the property
 * has to hold for all 75 of them and the failures were never in the obvious
 * ones.
 *
 * They also pin the *other* edge. A guard that redacts a third of a rung-1 reply
 * is not safer, it is unusable, so the false-positive cases are asserted with
 * the same weight as the leaks.
 */

import { describe, expect, it } from 'vitest';

import {
  TAG_NOTICE,
  createSpoilerGuard,
  redactCode,
  withheldTags,
} from '../src/prompt/spoiler-guard.ts';
import { stemWord, tagConcepts, tagStems } from '../src/prompt/tag-forms.ts';
import { LEETCODE_TOPIC_TAGS } from './fixtures/topic-tags.ts';

/** The concepts, flattened - "Heap (Priority Queue)" is two of them. */
const CONCEPTS = LEETCODE_TOPIC_TAGS.flatMap(tagConcepts);

/**
 * The surface forms a model might reasonably write for a tag.
 *
 * Generated from the tag rather than listed, so a tag added to LeetCode is
 * covered the day the fixture is refreshed.
 */
function variants(tag: string): string[] {
  const words = tag.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const last = words.at(-1) ?? '';
  const head = words.slice(0, -1);
  const withLast = (form: string): string => [...head, form].join(' ');

  // Inflections are built off the stem, not off the tag's own spelling: the
  // last word of "Two Pointers" is already plural, and "Two Pointerss" is not a
  // form anything would write.
  const stem = stemWord(last.toLowerCase());

  const forms = new Set<string>([
    tag,
    tag.toLowerCase(),
    tag.toUpperCase(),
    // Separator variation, which only means anything for multi-word tags.
    words.join(' '),
    words.join('-'),
    words.join('_'),
    words.join(''),
    words.join('  '),
    words.join('\n'),
    // Number, in both directions from the stem.
    withLast(stem),
    withLast(`${stem}s`),
    // Possessive.
    withLast(`${stem}'s`),
    withLast(`${stem}’s`),
    withLast(`${stem}s'`),
  ]);
  if (/(ss|s|x|z|ch|sh)$/.test(stem)) forms.add(withLast(`${stem}es`));
  // A tag written as a gerund is a verb the model will conjugate.
  if (/ing$/i.test(last)) {
    forms.add(withLast(`${stem}ed`));
    forms.add(withLast(`${stem}ing`));
  }
  return [...forms].filter((form) => form.trim() !== '');
}

describe('every tag, in every form', () => {
  it.each(CONCEPTS)('withholds "%s" however it is written', (tag) => {
    for (const form of variants(tag)) {
      const output = redactCode(1, `you might reach for a ${form} here`, { topicTags: [tag] });
      expect(output, `"${tag}" leaked as ${JSON.stringify(form)}`).toContain(TAG_NOTICE);
      // The prose either side survives - this redacts, it does not swallow.
      expect(output).toContain('you might reach for a');
      expect(output).toContain('here');
    }
  });

  /**
   * The reported gap, stated as its own case because it is the one that was
   * shipped: a single-word tag inflected by one letter.
   */
  it('withholds the plural of a single-word tag', () => {
    expect(redactCode(1, 'use heaps here', { topicTags: ['Heap'] })).toBe(`use ${TAG_NOTICE} here`);
    expect(redactCode(1, 'the arrays are sorted', { topicTags: ['Array'] })).toContain(TAG_NOTICE);
    expect(redactCode(1, 'walk both tries', { topicTags: ['Trie'] })).toContain(TAG_NOTICE);
  });

  it('withholds a tag whose stem the model conjugates', () => {
    const cases: [string, string][] = [
      ['Sorting', 'try sorting it first'],
      ['Sorting', 'once you sort the pairs'],
      ['Counting', 'count each character'],
      ['Greedy', 'take them greedily'],
      ['Backtracking', 'you can backtrack from there'],
      ['Binary Search', 'binary searching the range'],
      ['Two Pointers', 'move the two pointer inwards'],
      ['Memoization', 'memoizations of the subproblem'],
    ];
    for (const [tag, sentence] of cases) {
      expect(redactCode(1, sentence, { topicTags: [tag] }), `${tag} in "${sentence}"`).toContain(
        TAG_NOTICE,
      );
    }
  });

  it('splits a bracketed alias into both concepts', () => {
    expect(tagConcepts('Heap (Priority Queue)')).toEqual(['Heap', 'Priority Queue']);
    const tags = { topicTags: ['Heap (Priority Queue)'] };
    expect(redactCode(1, 'reach for a heap', tags)).toContain(TAG_NOTICE);
    expect(redactCode(1, 'reach for a priority queue', tags)).toContain(TAG_NOTICE);
    expect(redactCode(1, 'reach for priority queues', tags)).toContain(TAG_NOTICE);
  });
});

/**
 * Every form, arriving a fragment at a time.
 *
 * The matcher and the streaming hold-back are separate mechanisms and have
 * disagreed before - the stems said `slidwindow` while the buffer said "Slidi",
 * so the fragment went out and nothing ever matched it. Cutting every form at
 * every offset is the only way to keep them honest about each other.
 */
describe('every form, split across the stream', () => {
  const MULTI_WORD = CONCEPTS.filter((tag) => tagStems(tag).length > 1);
  const INFLECTED = [
    'Heap',
    'Array',
    'Trie',
    'Stack',
    'Queue',
    'Sorting',
    'Counting',
    'Greedy',
    'Tree',
  ];

  it.each([...MULTI_WORD, ...INFLECTED])('never leaks a fragment of "%s"', (tag) => {
    for (const form of variants(tag)) {
      for (let cut = 1; cut < form.length; cut += 1) {
        const guard = createSpoilerGuard(1, { topicTags: [tag] });
        const output =
          guard.push(`try a ${form.slice(0, cut)}`) +
          guard.push(`${form.slice(cut)} for this`) +
          guard.flush();

        for (const word of tagStems(tag)) {
          expect(
            output.toLowerCase().includes(word),
            `"${tag}" as ${JSON.stringify(form)} cut at ${cut} leaked "${word}": ${JSON.stringify(output)}`,
          ).toBe(false);
        }
        expect(output).toContain('try a');
        expect(output).toContain('for this');
      }
    }
  });
});

/**
 * The other edge.
 *
 * Inflection is where this stops. Words that merely share a prefix with a tag
 * are ordinary English, and redacting them would make the panel unusable on
 * exactly the problems the tags describe.
 */
describe('what it must not touch', () => {
  const NEVER: [string, string][] = [
    ['Counting', 'there are two countries in the input'],
    ['String', 'a stringent bound on n'],
    ['Tree', 'a treehouse on the hillside'],
    ['Array', 'a subarray in disarray'],
    ['Math', 'the mathematics of it'],
    ['Design', 'the designation of each node'],
    ['Stack', 'the stackable blocks'],
    ['Heap', 'the heapsort variant'],
    ['Queue', 'a queueless design'],
    ['Sorting', 'the sortie was cancelled'],
  ];

  it.each(NEVER)('leaves ordinary prose alone near "%s"', (tag, sentence) => {
    expect(redactCode(1, sentence, { topicTags: [tag] })).toBe(sentence);
  });

  it('does not run a multi-word tag across a sentence boundary', () => {
    // Unbounded separators used to make this one match.
    const sentence = 'compute a hash.\n\nTable stakes for the next part.';
    expect(redactCode(1, sentence, { topicTags: ['Hash Table'] })).toBe(sentence);
  });
});

/**
 * The counterweight that makes the breadth affordable.
 *
 * LeetCode tags a problem `Array` and `String` as readily as `Hash Table`, and a
 * Two Sum statement opens "given an array of integers". Withholding a word the
 * user is looking at protects nothing and turns the reply into "you scan the
 * [withheld] twice" - which is both useless and a signal in its own right. The
 * guard exists because the user has *not seen* the tags; one quoted in the
 * statement has been seen.
 */
describe('tags the user can already read', () => {
  const statement =
    'Given an array of integers nums, return the indices of the two numbers that add up to target.';

  it('withholds only what is not already on the page', () => {
    expect(withheldTags(1, { topicTags: ['Array', 'Hash Table'], visibleText: statement })).toEqual(
      ['Hash Table'],
    );
  });

  it("leaves the problem's own vocabulary intact", () => {
    const options = { topicTags: ['Array', 'Hash Table'], visibleText: statement };
    expect(redactCode(1, 'you scan the array twice', options)).toBe('you scan the array twice');
    expect(redactCode(1, 'the arrays are sorted', options)).toBe('the arrays are sorted');
    // ...and still withholds the one that is not.
    expect(redactCode(1, 'use a hash table', options)).toContain(TAG_NOTICE);
  });

  it('matches the statement by concept too, not just verbatim', () => {
    // The statement says "arrays"; the tag is "Array". Same thing seen.
    expect(withheldTags(1, { topicTags: ['Array'], visibleText: 'merge the two arrays' })).toEqual(
      [],
    );
  });

  it('withholds everything when the caller has no problem text', () => {
    // The safe default: no evidence the user has seen anything.
    expect(withheldTags(1, { topicTags: ['Array', 'Hash Table'] })).toEqual([
      'Array',
      'Hash Table',
    ]);
  });

  it('stops withholding at rung 2, where naming the technique is the rung', () => {
    expect(withheldTags(2, { topicTags: ['Hash Table'] })).toEqual([]);
  });
});
