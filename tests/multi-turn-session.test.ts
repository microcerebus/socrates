/**
 * A session, not a request.
 *
 * Issue #10 was invisible to every test in this repo because every test asked
 * one question. The bug needed a *second* one, after a pause. So this file
 * drives the interview path the way a sitting actually goes - turn after turn,
 * transcript accumulating, rung climbing, the page changing underneath - and
 * asserts the things that can only go wrong over time:
 *
 * - the per-turn payload stays bounded, however long the session runs;
 * - rung discipline and the tag guard hold on turn 30 as well as turn 1;
 * - what the model was told last turn is what it is shown this turn;
 * - a turn interrupted by the worker restarting leaves the session coherent.
 *
 * The transport half of that last one lives in `tests/panel-transport.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_HISTORY_TURNS,
  MAX_HISTORY_TURN_CHARS,
  runInterviewTurn,
  toApiMessages,
} from '../src/background/interview.ts';
import { flattenMessages } from '../src/background/providers.ts';
import { MAX_TURN_CHARS, TRUNCATION_MARKER } from '../src/background/transcript-store.ts';
import { buildSystemPrompt } from '../src/prompt/system-prompt.ts';
import { TAG_NOTICE } from '../src/prompt/spoiler-guard.ts';
import type { AskRequest } from '../src/shared/protocol.ts';
import type { Rung, Turn } from '../src/shared/types.ts';
import { SNAPSHOT, askRequest, recordingStream } from './helpers.ts';

/** One turn of a sitting: what the panel would send, given the history so far. */
function turnRequest(
  history: Turn[],
  index: number,
  overrides: Partial<AskRequest> = {},
): AskRequest {
  return askRequest({
    intent: index === 0 ? 'unlock' : 'chat',
    rung: Math.min(index, 5) as Rung,
    message: `question ${index}`,
    history,
    elapsedMs: index * 90_000,
    snapshot: { ...SNAPSHOT, capturedAt: SNAPSHOT.capturedAt + index * 1_000 },
    ...overrides,
  });
}

/** Runs `count` turns, returning what each one actually put on the wire. */
async function runSitting(
  count: number,
  reply: (index: number) => string[],
): Promise<{ prompts: string[]; systems: string[]; turns: Turn[] }> {
  const turns: Turn[] = [];
  const prompts: string[] = [];
  const systems: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const chunks = reply(index);
    const { stream, seen } = recordingStream(chunks);
    const request = turnRequest([...turns], index);
    turns.push({ role: 'user', text: request.message, rung: request.rung });

    let text = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request,
      stream,
      onText: (chunk) => void (text += chunk),
    });

    turns.push({ role: 'assistant', text, rung: request.rung });
    prompts.push(flattenMessages(seen[0]!.messages));
    systems.push(seen[0]!.system);
  }

  return { prompts, systems, turns };
}

describe('per-turn payload across a long sitting', () => {
  it('stops growing once the history window is full', async () => {
    const { prompts } = await runSitting(30, () => ['A nudge, roughly this long, and no longer. ']);

    // It grows early, while the window is filling.
    expect(prompts[6]!.length).toBeGreaterThan(prompts[0]!.length);

    // And then it stops. The tail of a long sitting is flat, not a ramp - which
    // is the property that would have ruled out "the prompt got huge" as the
    // cause of the hang without measuring anything.
    const tail = prompts.slice(20);
    const smallest = Math.min(...tail.map((prompt) => prompt.length));
    const largest = Math.max(...tail.map((prompt) => prompt.length));
    expect(largest - smallest).toBeLessThan(200);

    // Never more than the window's worth of history, plus this turn.
    for (const request of prompts) expect(request.length).toBeLessThan(60_000);
  });

  it('sends at most the history window, and always opens on a user message', () => {
    const turns: Turn[] = [];
    for (let index = 0; index < 40; index += 1) {
      turns.push({ role: 'user', text: `q${index}`, rung: 1 });
      turns.push({ role: 'assistant', text: `a${index}`, rung: 1 });
    }

    const messages = toApiMessages(turnRequest(turns, 40));
    // The window, minus any leading assistant turn dropped to satisfy the API,
    // plus the current turn.
    expect(messages.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS + 1);
    expect(messages[0]!.role).toBe('user');
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('clamps one enormous earlier turn rather than resending it whole', () => {
    const huge = 'x'.repeat(MAX_HISTORY_TURN_CHARS * 3);
    const messages = toApiMessages(
      turnRequest(
        [
          { role: 'user', text: 'walk me through it', rung: 3 },
          { role: 'assistant', text: huge, rung: 3 },
        ],
        2,
      ),
    );

    const carried = messages.find((message) => message.content.startsWith('xxx'));
    expect(carried).toBeDefined();
    expect(carried!.content.length).toBeLessThanOrEqual(
      MAX_HISTORY_TURN_CHARS + TRUNCATION_MARKER.length,
    );
    // Same ceiling the store uses, so what the model is shown and what was saved
    // do not quietly diverge.
    expect(MAX_HISTORY_TURN_CHARS).toBe(MAX_TURN_CHARS);
  });

  it('does not accumulate anything in the system prompt', async () => {
    // The system prompt is a pure function of (rung, language). Across a sitting
    // it may only change when the rung does - never because turns went by.
    const { systems } = await runSitting(12, () => ['ok ']);
    for (const [index, system] of systems.entries()) {
      expect(system).toBe(
        buildSystemPrompt({ rung: Math.min(index, 5) as Rung, language: 'javascript' }),
      );
    }
    // Rung 5 is reached at turn 6; every turn after it is byte-identical.
    expect(new Set(systems.slice(5)).size).toBe(1);
  });
});

describe('what the model is shown, turn after turn', () => {
  it('carries the previous reply into the next turn', async () => {
    const { prompts } = await runSitting(3, (index) => [`reply-${index} `]);

    expect(prompts[0]).not.toContain('reply-0');
    expect(prompts[1]).toContain('reply-0');
    expect(prompts[2]).toContain('reply-0');
    expect(prompts[2]).toContain('reply-1');
  });

  it('re-reads the page every turn rather than reusing the first capture', async () => {
    const { prompts } = await runSitting(4, () => ['ok ']);
    // `capturedAt` moves per turn in `turnRequest`; the buffer that reaches the
    // model has to come from the freshest snapshot, not from turn 1's.
    for (const prompt of prompts) expect(prompt).toContain(SNAPSHOT.editor.code);
    expect(prompts.at(-1)).toContain('Hints used');
  });

  it('reports the session clock, so a long sitting reads as one', async () => {
    const { prompts } = await runSitting(3, () => ['ok ']);
    expect(prompts[0]).toContain('under a minute');
    expect(prompts[2]).toContain('3m');
  });
});

describe('rung discipline holds for the whole sitting, not just the first turn', () => {
  it('withholds an unseen topic tag on every low-rung turn', async () => {
    const turns: Turn[] = [];
    for (let index = 0; index < 8; index += 1) {
      const { stream } = recordingStream(['Try a ', 'Hash Table', ' here. ']);
      let text = '';
      await runInterviewTurn({
        model: 'claude-sonnet-5',
        request: turnRequest([...turns], index, { rung: 1 }),
        stream,
        onText: (chunk) => void (text += chunk),
      });
      expect(text).not.toContain('Hash Table');
      expect(text).toContain(TAG_NOTICE);
      turns.push({ role: 'user', text: `question ${index}`, rung: 1 });
      turns.push({ role: 'assistant', text, rung: 1 });
    }
  });

  it('keeps a tag out of the reply even when an earlier turn is quoting it back', async () => {
    // The transcript is resent every turn, so a leaked tag would otherwise be
    // laundered through the history into every later prompt.
    const poisoned: Turn[] = [
      { role: 'user', text: 'is it a Hash Table problem?', rung: 1 },
      { role: 'assistant', text: 'Not saying.', rung: 1 },
    ];
    const { stream } = recordingStream(['Yes - a ', 'Hash Table', '.']);
    let text = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: turnRequest(poisoned, 3, { rung: 1 }),
      stream,
      onText: (chunk) => void (text += chunk),
    });
    expect(text).not.toContain('Hash Table');
  });
});

describe('a turn the worker never finished', () => {
  it('leaves the transcript coherent, so the next turn resumes from what was said', async () => {
    // The panel keeps a partial reply when a turn is cancelled or the worker
    // dies (`settle()` in App.tsx), because the user has already read it. The
    // next turn must therefore be able to carry a half-finished assistant turn.
    const interrupted: Turn[] = [
      { role: 'user', text: 'what am I missing?', rung: 2 },
      { role: 'assistant', text: 'You are scanning the window twice, which', rung: 2 },
    ];
    const messages = toApiMessages(turnRequest(interrupted, 2));

    expect(messages[0]!.role).toBe('user');
    expect(messages[1]!.content).toContain('scanning the window twice');
    expect(messages.at(-1)!.role).toBe('user');
    // The half-reply is presented as something the interviewer said, not as
    // context the candidate wrote.
    expect(flattenMessages(messages)).toContain('You replied');
  });

  it('does not double-count the current message into the history', () => {
    // The panel pushes the user's message into `turns` for display *and* passes
    // the pre-message history to the worker; the message itself rides inside the
    // context block. Sending both would show the model the same question twice.
    const request = turnRequest([{ role: 'user', text: 'earlier', rung: 0 }], 1, {
      message: 'the new question',
    });
    const prompt = flattenMessages(toApiMessages(request));
    expect(prompt.split('the new question')).toHaveLength(2);
  });
});
