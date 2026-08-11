/**
 * One interviewer turn: build the gated prompt, stream the reply, and run the
 * spoiler guard over it on the way out.
 *
 * Kept separate from `service-worker.ts` (which touches `chrome.*` at module
 * scope) so the whole path - prompt construction through redaction - can be
 * exercised against a mocked provider.
 *
 * Nothing here knows which provider is in use. The system prompt, the message
 * list and the guard are built the same way whichever transport is passed in,
 * which is the single reason rung discipline cannot drift between providers.
 */

import { buildUserTurn } from '../prompt/context.ts';
import { createSpoilerGuard } from '../prompt/spoiler-guard.ts';
import { buildSystemPrompt } from '../prompt/system-prompt.ts';
import type { AskRequest } from '../shared/protocol.ts';
import type { ModelId } from '../shared/types.ts';
import type { ApiMessage, ProviderStream } from './providers.ts';

const MAX_HISTORY_TURNS = 12;

export function toApiMessages(request: AskRequest): ApiMessage[] {
  const history = request.history.slice(-MAX_HISTORY_TURNS).map<ApiMessage>((turn) => ({
    role: turn.role,
    content: turn.text,
  }));

  // The API requires the first message to be `user`.
  while (history.length > 0 && history[0]?.role === 'assistant') history.shift();

  history.push({
    role: 'user',
    content: buildUserTurn({
      snapshot: request.snapshot,
      rung: request.rung,
      intent: request.intent,
      message: request.message,
      elapsedMs: request.elapsedMs,
      language: request.language,
    }),
  });
  return history;
}

export interface InterviewTurnOptions {
  model: ModelId;
  request: AskRequest;
  /** Where the tokens come from. See `providers.ts`. */
  stream: ProviderStream;
  onText(text: string): void;
  onStarted?(): void;
  onThinking?(): void;
  signal?: AbortSignal;
}

export async function runInterviewTurn(options: InterviewTurnOptions): Promise<void> {
  const { request } = options;
  /*
   * The tags reach the guard as well as the prompt: they are the one piece of
   * context the user has not seen, so the reply is checked against them rather
   * than trusted to have left them alone.
   *
   * The problem text goes with them, because "not seen" is the whole premise.
   * LeetCode tags a problem `Array` and `String` as readily as `Hash Table`, and
   * withholding a word the statement opens with protects nothing while turning
   * the reply into "you scan the [withheld] twice". See `spoiler-guard.ts`.
   */
  const { problem } = request.snapshot;
  const guard = createSpoilerGuard(request.rung, {
    topicTags: problem.topicTags,
    visibleText: [
      problem.title,
      problem.statement,
      ...problem.examples,
      ...problem.constraints,
    ].join('\n'),
  });

  await options.stream({
    model: options.model,
    system: buildSystemPrompt({ rung: request.rung, language: request.language }),
    messages: toApiMessages(request),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onStarted ? { onStarted: options.onStarted } : {}),
    ...(options.onThinking ? { onThinking: options.onThinking } : {}),
    onText: (text) => {
      const safe = guard.push(text);
      if (safe !== '') options.onText(safe);
    },
  });

  const tail = guard.flush();
  if (tail !== '') options.onText(tail);
}
