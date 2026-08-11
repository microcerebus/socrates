/**
 * The surface forms of a topic tag.
 *
 * ## Why a literal match is not enough
 *
 * The guard withholds a tag because the *concept* is above the rung, not because
 * a particular string is. "Heap" and "heaps" are the same hint; so are "Hash
 * Table", "hash tables", "hash-table" and "the hash table's buckets". Matching
 * the tag verbatim withholds the first of each pair and passes the rest, which
 * is not a smaller leak than passing both - it is the same leak with a false
 * sense of coverage.
 *
 * ## Stemming both sides, not enumerating one
 *
 * The tag is reduced to a stem and the stem is matched with an *allowed suffix
 * set*, so the match works in both directions: the tag "Two Pointers" is stemmed
 * to `pointer` and therefore matches the singular "two pointer" as well as the
 * plural, and the tag "Heap" matches "heaps" without the plural ever being
 * written down. Stemming the streamed text instead is not possible - it arrives
 * a fragment at a time - so the stemming happens once, on the tag, and the
 * inverse shows up as the suffix set.
 *
 * ## Where the line is
 *
 * Covered here: case, the separators between words of a multi-word tag
 * (including none at all), number in both directions, possessives, and the
 * verbal and adverbial inflections of the stem.
 *
 * Not covered here, on purpose: synonyms ("hash map" for Hash Table),
 * abbreviations ("DFS"), and description ("a structure with constant-time
 * lookup"). Those are the prompt's job - `TECHNIQUE_NAMES` in `rungs.ts`
 * enumerates them for exactly that reason - because matching them mechanically
 * means matching ordinary English, and the false positives would mangle every
 * legitimate reply. A guard that redacts a third of a rung-1 answer is not
 * safer, it is unusable.
 */

/** Splits a tag into words on anything that is not alphanumeric. */
const WORD_SPLIT = /[^a-z0-9]+/;

/**
 * What may sit between two words of a tag in the text, including nothing at all
 * so that "hashtable" is caught alongside "hash table" and "hash-table".
 *
 * Bounded, and the bound is load-bearing in both directions. Unbounded, "compute
 * a hash\n\nTable stakes for the next part" reads as one tag across a paragraph
 * break - a false positive that redacts two unrelated sentences. Unbounded also
 * lets a long run of whitespace keep the streaming hold alive, so the panel
 * shows nothing while the buffer grows. Three characters covers every real
 * spelling, including a newline with indentation either side.
 */
const SEPARATOR = '[\\s\\-_]{0,3}';

/**
 * The inflections a stem may carry.
 *
 * Longest first: alternation is ordered, so `s'` has to be tried before `s` or
 * the trailing apostrophe of "the tables' keys" is left dangling outside the
 * match and the word boundary check fails.
 */
const SUFFIXES = ["'s", '’s', "s'", '’', 's’', 'ing', 'ies', 'ed', 'es', 'ly', 's'];

/** The longest suffix, which bounds how far past a stem the stream must be held. */
export const MAX_SUFFIX_LENGTH = Math.max(...SUFFIXES.map((suffix) => suffix.length));

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One inflectional suffix stripped from a word.
 *
 * Deliberately shallow. A real stemmer would take "Memoization" to "memo" and
 * "Recursion" to "recur", and then match half the vocabulary of an interview -
 * "recurring", "memory". The rule here is only to undo the inflection the tag
 * itself happens to carry, so that the suffix set can put it back in any form.
 */
export function stemWord(word: string): string {
  if (word.length <= 3) return word;
  // "binaries" -> "binary", but not "series" -> "sery": needs a consonant.
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  // "searches" -> "search", "boxes" -> "box".
  if (/(ss|s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  // "sorting" -> "sort", "counting" -> "count".
  if (/ing$/.test(word) && word.length > 6) return word.slice(0, -3);
  // "pointers" -> "pointer", but never "class" -> "clas".
  if (/[^su]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The concepts a tag names.
 *
 * LeetCode writes an alias in brackets - "Heap (Priority Queue)" - and both
 * halves are the hint, so they become two tags rather than one string that
 * matches neither half on its own.
 */
export function tagConcepts(tag: string): string[] {
  const bracketed = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(tag.trim());
  if (!bracketed) return [tag.trim()].filter((part) => part !== '');
  return [bracketed[1] ?? '', bracketed[2] ?? '']
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** A tag reduced to its stems, lowercased. `['hash', 'table']`. */
export function tagStems(tag: string): string[] {
  return tag
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter((word) => word !== '')
    .map(stemWord);
}

/** The concatenated stems, which is what a partially-arrived tag is matched against. */
export function tagKey(tag: string): string {
  return tagStems(tag).join('');
}

/** One stem, plus every inflection it may wear. */
export function stemSource(stem: string): string {
  const alternatives = [`${escapeRegExp(stem)}(?:${SUFFIXES.map(escapeRegExp).join('|')})?`];
  // A stem ending consonant-y inflects on an `i`: greedy -> greedily, greedier.
  if (/[^aeiou]y$/.test(stem)) {
    alternatives.push(`${escapeRegExp(stem.slice(0, -1))}i(?:es|ly|ed|er|est)`);
  }
  return `(?:${alternatives.join('|')})`;
}

/**
 * The matcher for one tag: its stems in order, any separator between them, any
 * inflection on each, and a non-word boundary either side so "Array" does not
 * fire inside "subarray".
 */
export function tagRegexSource(tag: string): string | null {
  const stems = tagStems(tag);
  if (stems.length === 0) return null;
  return stems.map(stemSource).join(SEPARATOR);
}

/** `a(?:b(?:c)?)?` - matches every non-empty prefix of `abc`. */
function anyPrefixSource(value: string): string {
  let source = '';
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const char = escapeRegExp(value[i] ?? '');
    source = source === '' ? char : `${char}(?:${source})?`;
  }
  return source;
}

/**
 * A stem that has not finished arriving: any prefix of it, or the whole stem
 * with an inflection still in flight.
 *
 * The second half is deliberately generous - "the stem plus a few more letters"
 * rather than the exact suffix set. Holding too much only costs a character or
 * two of latency; holding too little puts half a tag on screen and then never
 * matches it, because the two halves were emitted separately.
 */
function stemPrefixSource(stem: string): string {
  return `(?:${anyPrefixSource(stem)}|${escapeRegExp(stem)}[a-z'’]{0,${MAX_SUFFIX_LENGTH}})`;
}

/**
 * Matches a *partial* tag sitting at the end of the buffer, so it can be held
 * back rather than emitted and then never matched.
 *
 * Two shapes count as partial, and both have bitten: a tag whose later words
 * have not arrived ("Hash Ta" waiting for "ble"), and a word whose *inflection*
 * has not arrived ("Slidi" on its way to "Sliding Window", where the stem is
 * `slid` and no amount of comparing stems to raw text would have spotted it).
 *
 * `$` anchors it to the end. JS picks the leftmost start that can reach the end,
 * which is exactly the longest trailing partial.
 */
export function tagPrefixPattern(tags: readonly string[]): RegExp | null {
  const sources = tags
    .map((tag) => {
      const stems = tagStems(tag);
      let source = '';
      for (let i = stems.length - 1; i >= 0; i -= 1) {
        const stem = stems[i] ?? '';
        source =
          source === ''
            ? stemPrefixSource(stem)
            : `(?:${stemPrefixSource(stem)}|${stemSource(stem)}${SEPARATOR}(?:${source})?)`;
      }
      return source;
    })
    .filter((source) => source !== '');
  if (sources.length === 0) return null;
  return new RegExp(`(?<![\\w-])(?:${sources.join('|')})$`, 'i');
}

/** One case-insensitive pattern over every tag, longest tag first. */
export function tagsPattern(tags: readonly string[]): RegExp | null {
  const sources = [...tags]
    .sort((a, b) => tagKey(b).length - tagKey(a).length)
    .map(tagRegexSource)
    .filter((source): source is string => source !== null);
  if (sources.length === 0) return null;
  return new RegExp(`(?<![\\w-])(?:${sources.join('|')})(?![\\w-])`, 'gi');
}

/** Whether a tag appears anywhere in some text, in any of its forms. */
export function mentions(tag: string, text: string): boolean {
  const source = tagRegexSource(tag);
  if (source === null) return false;
  return new RegExp(`(?<![\\w-])(?:${source})(?![\\w-])`, 'i').test(text);
}
