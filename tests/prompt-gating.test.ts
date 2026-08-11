/**
 * Rung-gating tests.
 *
 * Two layers are checked:
 *  1. the request we send - that the system prompt actually carries the
 *     prohibitions for the unlocked rung and nothing looser, and that the live
 *     context (problem, editor buffer, hint state) rides along;
 *  2. the response we surface - that a model reply containing code below rung 4
 *     never reaches the panel, even when it arrives split across stream chunks.
 *
 * The end-to-end version of (2), run against the actual streaming transport, is
 * in `tests/claude-code.test.ts` instead - this file covers the pieces that do
 * not depend on any transport.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runInterviewTurn, toApiMessages } from '../src/background/interview.ts';
import { buildUserTurn } from '../src/prompt/context.ts';
import { RUNGS, TECHNIQUE_NAMES, TOTAL_HINTS } from '../src/prompt/rungs.ts';
import {
  TAG_NOTICE,
  WITHHELD_NOTICE,
  createSpoilerGuard,
  redactCode,
} from '../src/prompt/spoiler-guard.ts';
import { SYSTEM_PROMPT_VERSION, buildSystemPrompt } from '../src/prompt/system-prompt.ts';
import type { Rung } from '../src/shared/types.ts';
import {
  SNAPSHOT,
  WRONG_ANSWER,
  askRequest,
  recordingStream,
  sentTurn,
  streamOf,
} from './helpers.ts';

const ALL_RUNGS: Rung[] = [0, 1, 2, 3, 4, 5];

describe('system prompt', () => {
  it('is versioned', () => {
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(ALL_RUNGS)('marks rung %i as current and everything above it as locked', (rung) => {
    const prompt = buildSystemPrompt({ rung, language: 'javascript' });
    expect(prompt).toContain(
      `Rung ${rung} - ${RUNGS[rung]!.name}: ${RUNGS[rung]!.summary} [UNLOCKED (current)]`,
    );
    for (const spec of RUNGS) {
      if (spec.id > rung) {
        expect(prompt).toContain(`Rung ${spec.id} - ${spec.name}: ${spec.summary} [LOCKED]`);
        expect(prompt).toContain(
          `Rung ${spec.id} (${spec.name}) is LOCKED: do not ${spec.lockedPhrase}.`,
        );
      }
    }
  });

  it.each(ALL_RUNGS)('carries rung %i reveals and withholds verbatim', (rung) => {
    const prompt = buildSystemPrompt({ rung, language: 'typescript' });
    for (const line of RUNGS[rung]!.reveals) expect(prompt).toContain(line);
    for (const line of RUNGS[rung]!.withholds) expect(prompt).toContain(line);
    expect(prompt).toContain(RUNGS[rung]!.reviewPolicy);
  });

  it('forbids every enumerated technique name before rung 2', () => {
    const prompt = buildSystemPrompt({ rung: 1, language: 'javascript' });
    for (const name of TECHNIQUE_NAMES) expect(prompt).toContain(name);
    expect(prompt).toContain('none of which may appear before rung 2');
    expect(prompt).toContain('Naming by description still counts as naming');
  });

  it("never lets a lower rung inherit a higher rung's permission", () => {
    // "name the technique" is rung 2's job; rung 0 and 1 must not grant it.
    const permission = RUNGS[2]!.reveals[0]!;
    expect(buildSystemPrompt({ rung: 0, language: 'js' })).not.toContain(permission);
    expect(buildSystemPrompt({ rung: 1, language: 'js' })).not.toContain(permission);
    expect(buildSystemPrompt({ rung: 2, language: 'js' })).toContain(permission);
  });

  it('constrains reply length below rung 4 and relaxes it at rung 5', () => {
    expect(buildSystemPrompt({ rung: 2, language: 'js' })).toContain('under about 120 words');
    expect(buildSystemPrompt({ rung: 5, language: 'js' })).not.toContain('under about 120 words');
  });

  it('names the language the user is writing in, the way LeetCode names it', () => {
    expect(buildSystemPrompt({ rung: 3, language: 'typescript' })).toContain(
      'They are writing TypeScript.',
    );
    expect(buildSystemPrompt({ rung: 3, language: 'golang' })).toContain('They are writing Go.');
    expect(buildSystemPrompt({ rung: 3, language: 'cpp' })).toContain('They are writing C++.');
    // An id we do not know is passed through rather than replaced with a guess.
    expect(buildSystemPrompt({ rung: 3, language: 'plaintext' })).toContain(
      'They are writing plaintext.',
    );
  });

  it("binds every rung's output to that language, not just the prose", () => {
    const prompt = buildSystemPrompt({ rung: 5, language: 'rust' });
    expect(prompt).toContain('Everything you write for them is in Rust');
    expect(prompt).toContain('Do not answer in a language they are not writing');
    // The walkthrough rung used to promise TypeScript or JavaScript by name.
    expect(prompt).not.toContain('working TypeScript or JavaScript solution');
  });

  it('offers a legal move instead of a leak when asked directly', () => {
    const prompt = buildSystemPrompt({ rung: 2, language: 'js' });
    expect(prompt).toContain('Direct questions get the rung answer, not the true answer');
    expect(prompt).toContain('is rung 3 territory');
  });
});

describe('context turn', () => {
  it('includes the problem, the live editor buffer and the hint state', () => {
    const turn = buildUserTurn({
      snapshot: SNAPSHOT,
      rung: 2,
      intent: 'unlock',
      message: '',
      elapsedMs: 9 * 60_000,
      language: 'javascript',
    });
    expect(turn).toContain('1. Two Sum');
    expect(turn).toContain('Problem number: 1');
    expect(turn).toContain('Given an array of integers');
    expect(turn).toContain('2 <= nums.length <= 10^4');
    expect(turn).toContain('var twoSum = function(nums, target)');
    expect(turn).toContain('Unlocked rung: 2 - Name the technique');
    expect(turn).toContain(`Hints used: 2 of ${TOTAL_HINTS}`);
    expect(turn).toContain('Writing in: JavaScript');
    expect(turn).toContain('Time on this problem: 9m');
  });

  it('fences the gleaned metadata off from the statement', () => {
    const turn = buildUserTurn({
      snapshot: SNAPSHOT,
      rung: 1,
      intent: 'unlock',
      message: '',
      elapsedMs: 0,
      language: 'javascript',
    });
    expect(turn).toContain('# PAGE METADATA - NOT SHOWN TO THE USER');
    // The tag names came off the page, so they ride inside the page-data fence
    // like every other scraped string; the warning around them did not, so it
    // does not. See `context.ts`.
    expect(turn).toContain('## LeetCode topic tags');
    expect(turn).toMatch(/<<<PAGE-DATA id=[0-9a-f]{16} field=topic-tags>>>\nArray, Hash Table\n/);
    expect(turn).toContain('An editorial exists for this problem.');
    expect(turn).toContain('LeetCode ships its own hints for this problem.');
    expect(turn).toContain('The user has not seen any of this');
    expect(turn).toContain('Below rung 2, do not name a tag');
  });

  it('omits the metadata section entirely when nothing was gleaned', () => {
    const turn = buildUserTurn({
      snapshot: {
        ...SNAPSHOT,
        problem: { ...SNAPSHOT.problem, topicTags: [], hasEditorial: false, hasHints: false },
      },
      rung: 1,
      intent: 'unlock',
      message: '',
      elapsedMs: 0,
      language: 'javascript',
    });
    expect(turn).not.toContain('PAGE METADATA');
  });

  it('lays the run result out field by field, omitting the ones the page did not show', () => {
    const turn = buildUserTurn({
      snapshot: { ...SNAPSHOT, run: WRONG_ANSWER },
      rung: 1,
      intent: 'review',
      message: '',
      elapsedMs: 0,
      language: 'javascript',
    });
    expect(turn).toContain('# LAST RUN RESULT');
    expect(turn).toContain('Source: Run (the testcases in the console)');
    expect(turn).toContain('## Verdict');
    expect(turn).toContain('## Testcases');
    expect(turn).toContain('## Failing input');
    expect(turn).toContain('nums = [3,2,4]');
    expect(turn).toContain('## Their output');
    expect(turn).toContain('## Expected output');
    expect(turn).toContain('## Printed to stdout');
    // Nothing errored, so there is no error block at all rather than an empty one.
    expect(turn).not.toContain('## Error message');
    // Every value is page data, so every value is inside the fence.
    for (const field of ['run-verdict', 'run-input', 'run-output', 'run-expected', 'run-stdout']) {
      expect(turn).toContain(`field=${field}>>>`);
    }
  });

  it('has no run section when nothing has been run', () => {
    const turn = buildUserTurn({
      snapshot: SNAPSHOT,
      rung: 0,
      intent: 'chat',
      message: '',
      elapsedMs: 0,
      language: 'javascript',
    });
    expect(turn).not.toContain('LAST RUN RESULT');
  });

  it("names the effective language on the buffer, not the page's", () => {
    const turn = buildUserTurn({
      snapshot: SNAPSHOT,
      rung: 4,
      intent: 'review',
      message: '',
      elapsedMs: 0,
      language: 'rust',
    });
    // The language rides in its own fenced block, and is named outside every
    // fence on the session line.
    expect(turn).toMatch(/<<<PAGE-DATA id=[0-9a-f]{16} field=editor-language>>>\nrust\n/);
    expect(turn).toContain('Writing in: Rust');
    expect(turn).toContain(SNAPSHOT.editor.code);
  });

  it('says so when the editor could not be read', () => {
    const turn = buildUserTurn({
      snapshot: { ...SNAPSHOT, editor: { language: 'plaintext', code: '', source: 'unavailable' } },
      rung: 1,
      intent: 'review',
      message: '',
      elapsedMs: 0,
      language: 'plaintext',
    });
    expect(turn).toContain('# CURRENT EDITOR CODE\n(empty');
  });

  it('routes each intent to its own instruction', () => {
    const at = (intent: 'unlock' | 'chat' | 'review' | 'giveup', rung: Rung): string =>
      buildUserTurn({
        snapshot: SNAPSHOT,
        rung,
        intent,
        message: '',
        elapsedMs: 0,
        language: 'javascript',
      });

    expect(at('unlock', 3)).toContain('unlocked rung 3 (Approach outline)');
    expect(at('chat', 1)).toContain('Reply inside rung 1');
    expect(at('review', 4)).toContain('rung 4 review policy');
    expect(at('giveup', 5)).toContain('gave up and unlocked rung 5');
  });

  it('keeps the conversation valid for the API', () => {
    const messages = toApiMessages(
      askRequest({
        history: [
          { role: 'assistant', text: 'earlier reply', rung: 0 },
          { role: 'user', text: 'my thinking', rung: 1 },
        ],
      }),
    );
    expect(messages[0]?.role).toBe('user');
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toContain('# SESSION');
  });
});

/**
 * The topic-tag boundary, end to end.
 *
 * These go through `runInterviewTurn` rather than the guard directly, because
 * the claim being made is about what reaches the panel - a guard that is correct
 * but not wired into the turn would pass a unit test and leak in production.
 */
describe('the topic-tag boundary', () => {
  it('states the boundary in the prompt, at every rung', () => {
    for (const rung of ALL_RUNGS) {
      const prompt = buildSystemPrompt({ rung, language: 'javascript' });
      expect(prompt).toContain('# Context you were given that the user has not seen');
      expect(prompt).toContain('Topic tags are the answer, written down');
      expect(prompt).toContain('Below rung 2 you must not name a tag');
      expect(prompt).toContain(
        "Below rung 4, analysis of a failing testcase follows this rung's review policy",
      );
      expect(prompt).toContain('Never volunteer that an editorial or hints exist');
    }
  });

  it('strips a tag name from a rung-1 reply', async () => {
    let output = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 1 }),
      onText: (text) => {
        output += text;
      },
      stream: streamOf(['You want a hash table here - the Hash Table tag says so.']),
    });

    for (const tag of SNAPSHOT.problem.topicTags)
      expect(output.toLowerCase()).not.toContain(tag.toLowerCase());
    expect(output).toContain(TAG_NOTICE);
  });

  it('strips a tag arriving split across stream chunks', async () => {
    let output = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 1 }),
      onText: (text) => {
        output += text;
      },
      stream: streamOf(['Think about a Hash', ' Table for this.']),
    });
    expect(output.toLowerCase()).not.toContain('hash table');
  });

  it('lets tags through from rung 2, where naming the technique is the rung', async () => {
    let output = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 2 }),
      onText: (text) => {
        output += text;
      },
      stream: streamOf(['This is a Hash Table problem.']),
    });
    expect(output).toContain('Hash Table');
  });

  it('lets a rung-1 review talk about the failing input while still withholding the technique', async () => {
    const recorded = recordingStream([
      'On nums = [3,2,4] with target = 6 you return [] where [1,2] is expected. ' +
        'The fix is a Hash Table lookup.',
    ]);
    let output = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({
        rung: 1,
        intent: 'review',
        snapshot: { ...SNAPSHOT, run: WRONG_ANSWER },
      }),
      onText: (text) => {
        output += text;
      },
      stream: recorded.stream,
    });

    // The concrete failure is the user's own screen, so it survives verbatim.
    expect(output).toContain('nums = [3,2,4]');
    expect(output).toContain('[1,2]');
    // The technique it points at does not.
    expect(output.toLowerCase()).not.toContain('hash table');

    // ...and the failing testcase reached the model in the first place.
    const sent = sentTurn(recorded.seen);
    expect(sent).toContain('## Verdict');
    expect(sent).toContain('Wrong Answer');
    expect(sent).toContain('nums = [3,2,4]');
    expect(sent).toContain('rung 1 review policy');
  });
});

/**
 * The tags are model context and only model context.
 *
 * Asserted against the panel's source rather than a rendered tree, because the
 * rule is "no code path in the panel can display them" and a render test only
 * covers the paths it happens to exercise. `topicTags` appearing anywhere under
 * `src/panel/` is the thing to catch, whatever it is being used for.
 */
describe('the panel never displays topic tags', () => {
  it('does not so much as name the field', () => {
    const panelDir = resolve(import.meta.dirname, '..', 'src', 'panel');
    const offenders = readdirSync(panelDir)
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
      .filter((name) => readFileSync(resolve(panelDir, name), 'utf8').includes('topicTags'));
    expect(offenders).toEqual([]);
  });
});

describe('spoiler guard', () => {
  it('holds back a fence split across chunks', () => {
    expect(redactCode(2, 'before ``')).toBe('before ``');
    expect(redactCode(2, 'before ```js\nx\n``` after')).toBe(`before ${WITHHELD_NOTICE} after`);
  });

  it('drops an unterminated block rather than leaking a partial solution', () => {
    const out = redactCode(3, 'idea\n\n```js\nconst m = new Map();');
    expect(out).not.toContain('new Map');
    expect(out).toContain('idea');
  });

  it('leaves inline code alone', () => {
    expect(redactCode(1, 'the `nums` array')).toBe('the `nums` array');
  });

  it('is a pass-through from rung 4 up', () => {
    const source = 'x\n```js\ncode\n```';
    expect(redactCode(4, source)).toBe(source);
    expect(redactCode(5, source)).toBe(source);
  });

  const tags = { topicTags: ['Array', 'Hash Table', 'Binary Search'] };

  it('redacts a tag whatever case it arrives in', () => {
    expect(redactCode(1, 'use a hash table', tags)).toBe(`use a ${TAG_NOTICE}`);
    expect(redactCode(1, 'use a HASH TABLE', tags)).toBe(`use a ${TAG_NOTICE}`);
  });

  it('tolerates the whitespace between the words of a tag', () => {
    expect(redactCode(1, 'a hash  table', tags)).toBe(`a ${TAG_NOTICE}`);
    expect(redactCode(1, 'a hash\ntable', tags)).toBe(`a ${TAG_NOTICE}`);
  });

  it('does not fire inside a longer word', () => {
    // "Array" is a tag, and "subarray"/"disarray" merely contain it.
    expect(redactCode(1, 'a subarray in disarray', tags)).toBe('a subarray in disarray');
    expect(redactCode(1, 'the array itself', tags)).toBe(`the ${TAG_NOTICE} itself`);
    // ...but an inflection of it is it. See `tag-forms.ts` for where the line is.
    expect(redactCode(1, 'the arrays', tags)).toBe(`the ${TAG_NOTICE}`);
  });

  it('leaves a tag alone from rung 2, and code alone from rung 4', () => {
    expect(redactCode(2, 'a hash table', tags)).toBe('a hash table');
    expect(redactCode(5, 'an array', tags)).toBe('an array');
  });

  it('still guards tags at rung 2 and 3 for code, without confusing the two rules', () => {
    // Code is guarded to rung 4, tags only to rung 2: rung 3 strips the fence
    // and keeps the tag.
    const out = redactCode(3, 'a hash table\n\n```js\nx\n```', tags);
    expect(out).toContain('a hash table');
    expect(out).not.toContain('```');
  });

  it('never redacts when the page had no tags to glean', () => {
    expect(redactCode(1, 'a hash table', { topicTags: [] })).toBe('a hash table');
    expect(redactCode(1, 'a hash table')).toBe('a hash table');
  });

  /**
   * The split-tag leak, exhaustively.
   *
   * A multi-word tag is the case that actually breaks: it can straddle a chunk
   * boundary, and the separator the model writes need not be the single space
   * LeetCode uses. Every one of these combinations released the first word to
   * the panel before the boundary check was made canonical on both sides, so
   * every one of them is now a test rather than an example.
   */
  describe('a tag split across a stream boundary', () => {
    // LeetCode's own multi-word topic tags, plus the two-word technique names
    // the ladder already enumerates.
    const MULTI_WORD = [
      'Hash Table',
      'Two Pointers',
      'Binary Search',
      'Binary Search Tree',
      'Dynamic Programming',
      'Sliding Window',
      'Union Find',
      'Monotonic Stack',
      'Divide and Conquer',
      'Bit Manipulation',
      'Prefix Sum',
      'Topological Sort',
      'Depth-First Search',
      'Breadth-First Search',
      'Linked List',
      'Priority Queue',
    ];

    /** The separators a model actually produces where LeetCode wrote one space. */
    const SEPARATORS = [' ', '  ', '\n', ' \n', '\n\n', '-'];

    it.each(MULTI_WORD)('never leaks a fragment of "%s"', (tag) => {
      const words = tag.split(/[\s-]+/);

      for (const separator of SEPARATORS) {
        const written = words.join(separator);
        // Every boundary inside the written form, not only the word seams: the
        // stream can break mid-word too.
        for (let cut = 1; cut < written.length; cut += 1) {
          const guard = createSpoilerGuard(1, { topicTags: MULTI_WORD });
          const before = `You could try a ${written.slice(0, cut)}`;
          const after = `${written.slice(cut)} for this one.`;
          const output = guard.push(before) + guard.push(after) + guard.flush();

          const seen = output.toLowerCase();
          for (const word of words) {
            expect(
              seen.includes(word.toLowerCase()),
              `"${tag}" written as ${JSON.stringify(written)} and cut at ${cut} leaked "${word}": ${JSON.stringify(output)}`,
            ).toBe(false);
          }
          expect(output).toContain(TAG_NOTICE);
          // The surrounding prose is untouched - the guard redacts, it does not swallow.
          expect(output).toContain('You could try a');
          expect(output).toContain('for this one.');
        }
      }
    });

    it('holds nothing back once the stream ends, however it ended', () => {
      // A tag that never finishes arriving must not be able to eat the tail of
      // the reply: whatever is held is released by `flush`.
      const guard = createSpoilerGuard(1, { topicTags: ['Hash Table'] });
      const output = guard.push('think about a Hash') + guard.flush();
      expect(output).toBe('think about a Hash');
    });

    it('does not hold the panel hostage to a run of separators', () => {
      // Past the slack a partial tag stops being a candidate, so a stream of
      // newlines cannot pin the reply.
      const guard = createSpoilerGuard(1, { topicTags: ['Hash Table'] });
      const first = guard.push(`a Hash${'\n'.repeat(40)}`);
      expect(first).toContain('a Hash');
    });
  });

  it('counts what it removed, so the redaction is not silent to callers', () => {
    const guard = createSpoilerGuard(1, tags);
    const out = guard.push('an array and a hash table') + guard.flush();
    expect(guard.tagRedactions).toBe(2);
    expect(out).not.toContain('array');
  });
});
