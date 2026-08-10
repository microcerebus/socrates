/**
 * Rung-gating tests.
 *
 * Two layers are checked:
 *  1. the request we send - that the system prompt actually carries the
 *     prohibitions for the unlocked rung and nothing looser, and that the live
 *     context (problem, editor buffer, hint state) rides along;
 *  2. the response we surface - that a model reply containing code below rung 4
 *     never reaches the panel, even when it arrives split across stream chunks.
 */

import { describe, expect, it } from 'vitest';

import { buildRequestBody } from '../src/background/anthropic.ts';
import { runInterviewTurn, toApiMessages } from '../src/background/interview.ts';
import { buildUserTurn } from '../src/prompt/context.ts';
import { RUNGS, TECHNIQUE_NAMES, TOTAL_HINTS } from '../src/prompt/rungs.ts';
import { WITHHELD_NOTICE, redactCode } from '../src/prompt/spoiler-guard.ts';
import { SYSTEM_PROMPT_VERSION, buildSystemPrompt } from '../src/prompt/system-prompt.ts';
import type { ModelId, Rung } from '../src/shared/types.ts';
import { SNAPSHOT, askRequest, mockAnthropic, sseBody } from './helpers.ts';

const ALL_RUNGS: Rung[] = [0, 1, 2, 3, 4, 5];

describe('system prompt', () => {
  it('is versioned', () => {
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(ALL_RUNGS)('marks rung %i as current and everything above it as locked', (rung) => {
    const prompt = buildSystemPrompt({ rung, language: 'javascript' });
    expect(prompt).toContain(`Rung ${rung} - ${RUNGS[rung]!.name}: ${RUNGS[rung]!.summary} [UNLOCKED (current)]`);
    for (const spec of RUNGS) {
      if (spec.id > rung) {
        expect(prompt).toContain(`Rung ${spec.id} - ${spec.name}: ${spec.summary} [LOCKED]`);
        expect(prompt).toContain(`Rung ${spec.id} (${spec.name}) is LOCKED: do not ${spec.lockedPhrase}.`);
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

  it('never lets a lower rung inherit a higher rung\'s permission', () => {
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

  it('names the language the user is writing in', () => {
    expect(buildSystemPrompt({ rung: 3, language: 'typescript' })).toContain('They are writing typescript.');
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
    });
    expect(turn).toContain('1. Two Sum');
    expect(turn).toContain('Given an array of integers');
    expect(turn).toContain('2 <= nums.length <= 10^4');
    expect(turn).toContain('var twoSum = function(nums, target)');
    expect(turn).toContain('Unlocked rung: 2 - Name the technique');
    expect(turn).toContain(`Hints used: 2 of ${TOTAL_HINTS}`);
    expect(turn).toContain('Time on this problem: 9m');
  });

  it('says so when the editor could not be read', () => {
    const turn = buildUserTurn({
      snapshot: { ...SNAPSHOT, editor: { language: 'plaintext', code: '', source: 'unavailable' } },
      rung: 1,
      intent: 'review',
      message: '',
      elapsedMs: 0,
    });
    expect(turn).toContain('# CURRENT EDITOR CODE\n(empty');
  });

  it('routes each intent to its own instruction', () => {
    const at = (intent: 'unlock' | 'chat' | 'review' | 'giveup', rung: Rung): string =>
      buildUserTurn({ snapshot: SNAPSHOT, rung, intent, message: '', elapsedMs: 0 });

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

describe('request body', () => {
  it('uses adaptive thinking and effort on the Claude 5 models', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5'] satisfies ModelId[]) {
      const body = buildRequestBody(model, 'system', [{ role: 'user', content: 'hi' }]);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'medium' });
      expect(body.stream).toBe(true);
    }
  });

  it('omits both on Haiku 4.5, which rejects them', () => {
    const body = buildRequestBody('claude-haiku-4-5-20251001', 'system', [{ role: 'user', content: 'hi' }]);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});

describe('an interview turn end to end', () => {
  const codeReply = [
    'Track what you have seen.\n\n',
    '```javascript\nconst seen = new Map();\n',
    'for (const n of nums) seen.set(n, 1);\n```\n\n',
    'That is the shape of it.',
  ];

  it('sends the gated system prompt and the direct-browser-access header', async () => {
    const mock = mockAnthropic(sseBody(['ok']));
    await runInterviewTurn({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 1 }),
      onText: () => undefined,
      fetchImpl: mock.impl,
    });

    const call = mock.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(call.headers['x-api-key']).toBe('sk-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');

    const system = (call.body['system'] as { text: string }[])[0]!.text;
    expect(system).toContain('You are at rung 1 - Pattern smell');
    expect(system).toContain('Rung 2 (Name the technique) is LOCKED');
  });

  it.each([0, 1, 2, 3] satisfies Rung[])('strips fenced code from a rung %i reply', async (rung) => {
    const mock = mockAnthropic(sseBody(codeReply));
    let output = '';
    await runInterviewTurn({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      request: askRequest({ rung }),
      onText: (text) => {
        output += text;
      },
      fetchImpl: mock.impl,
    });

    expect(output).not.toContain('new Map()');
    expect(output).not.toContain('```');
    expect(output).toContain(WITHHELD_NOTICE.trim());
    expect(output).toContain('Track what you have seen.');
    expect(output).toContain('That is the shape of it.');
  });

  it.each([4, 5] satisfies Rung[])('lets code through at rung %i', async (rung) => {
    const mock = mockAnthropic(sseBody(codeReply));
    let output = '';
    await runInterviewTurn({
      apiKey: 'sk-test',
      model: 'claude-opus-5',
      request: askRequest({ rung }),
      onText: (text) => {
        output += text;
      },
      fetchImpl: mock.impl,
    });

    expect(output).toContain('const seen = new Map();');
    expect(output).toContain('```javascript');
  });

  it('reports a thinking block before any text arrives', async () => {
    const mock = mockAnthropic(sseBody(['hello'], { withThinking: true }));
    const seen: string[] = [];
    await runInterviewTurn({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      request: askRequest(),
      onThinking: () => seen.push('thinking'),
      onText: () => seen.push('text'),
      fetchImpl: mock.impl,
    });
    expect(seen[0]).toBe('thinking');
  });

  it('surfaces an auth failure with something to do about it', async () => {
    const mock = mockAnthropic(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
    await expect(
      runInterviewTurn({
        apiKey: 'sk-bad',
        model: 'claude-sonnet-5',
        request: askRequest(),
        onText: () => undefined,
        fetchImpl: mock.impl,
      }),
    ).rejects.toMatchObject({ code: 'api-auth', remedies: [{ command: expect.stringContaining('dcli read') }] });
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
});
