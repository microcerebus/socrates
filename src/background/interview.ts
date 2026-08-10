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
import type { ApiMessage } from './anthropic.ts';
import type { ProviderStream } from './providers.ts';

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
  const guard = createSpoilerGuard(request.rung);

  await options.stream({
    model: options.model,
    system: buildSystemPrompt({ rung: request.rung, language: request.snapshot.editor.language }),
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
