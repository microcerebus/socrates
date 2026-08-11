/**
 * Streams a reply from the local `claude` CLI through the native host, on
 * whatever subscription that CLI is logged into.
 *
 * `interview.ts` owns everything that makes a reply correct - the gated system
 * prompt, the message list, the spoiler guard - and knows nothing about this
 * transport beyond the `ProviderStream` shape, which is what keeps the guard
 * and the rung discipline independent of it.
 */

import type { ModelId } from '../shared/types.ts';
import { streamClaudeCode, type NativeConnect } from './claude-code.ts';

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  model: ModelId;
  system: string;
  /** Oldest first. The last entry is always the current user turn. */
  messages: ApiMessage[];
  onText(text: string): void;
  /** The CLI has booted and is genuinely about to call the API. */
  onStarted?(): void;
  /** Repeated for as long as the model thinks without producing text. */
  onThinking?(): void;
  signal?: AbortSignal;
}

export type ProviderStream = (request: ProviderRequest) => Promise<void>;

/**
 * Renders the message list as one prompt.
 *
 * The Messages API takes a role-tagged array; the `claude` CLI in print mode
 * takes a single prompt. `--input-format stream-json` looks like the missing
 * piece but is not - feeding it a transcript re-runs the model once per user
 * message rather than priming history, which would bill several turns and let
 * the model answer an old question. Flattening keeps it to one call, and keeps
 * the host stateless: the transcript is resent every time, nothing is resumed.
 */
export function flattenMessages(messages: ApiMessage[]): string {
  const current = messages.at(-1);
  if (current === undefined) return '';
  const earlier = messages.slice(0, -1);
  if (earlier.length === 0) return current.content;

  const transcript = earlier
    .map((message) => `## ${message.role === 'user' ? 'The candidate said' : 'You replied'}\n${message.content}`)
    .join('\n\n');

  return (
    `# CONVERSATION SO FAR\n\n` +
    `Earlier turns of this same interview, oldest first. Continue from here rather than starting over.\n\n` +
    `${transcript}\n\n---\n\n${current.content}`
  );
}

export function claudeCodeProvider(options: { connect?: NativeConnect } = {}): ProviderStream {
  return (request) =>
    streamClaudeCode({
      model: request.model,
      system: request.system,
      prompt: flattenMessages(request.messages),
      onText: request.onText,
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
      ...(request.onThinking ? { onThinking: request.onThinking } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(options.connect ? { connect: options.connect } : {}),
    });
}
