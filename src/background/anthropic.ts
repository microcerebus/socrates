/**
 * A small streaming client for the Anthropic Messages API, called directly from
 * the extension service worker.
 *
 * Calling the API from an extension origin requires the
 * `anthropic-dangerous-direct-browser-access` header; without it the request is
 * rejected by CORS preflight. That is safe here in a way it is not on a web page:
 * the key never touches disk, never enters a renderer, and lives only in this
 * worker's memory (see `keychain.ts`).
 */

import { appError, type AppError, type ModelId } from '../shared/types.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 16_000;

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ThinkingConfig {
  type: 'adaptive';
}

export interface OutputConfig {
  effort: 'low' | 'medium' | 'high';
}

export interface MessagesRequestBody {
  model: ModelId;
  max_tokens: number;
  stream: true;
  system: SystemBlock[];
  messages: ApiMessage[];
  thinking?: ThinkingConfig;
  output_config?: OutputConfig;
}

/**
 * Haiku 4.5 predates the `effort` parameter and adaptive thinking; sending
 * either returns a 400. The Claude 5 models take both.
 */
export function buildRequestBody(model: ModelId, system: string, messages: ApiMessage[]): MessagesRequestBody {
  const body: MessagesRequestBody = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (model !== 'claude-haiku-4-5-20251001') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: 'medium' };
  }
  return body;
}

export interface StreamHandlers {
  onText(text: string): void;
  /** Fired once when the model starts an (unsurfaced) thinking block. */
  onThinking?(): void;
}

export interface StreamOptions extends StreamHandlers {
  apiKey: string;
  model: ModelId;
  system: string;
  messages: ApiMessage[];
  signal?: AbortSignal;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

interface ApiErrorBody {
  error?: { type?: string; message?: string };
}

function mapHttpError(status: number, body: string): AppError {
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body) as ApiErrorBody;
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    /* keep the raw body */
  }
  if (status === 401 || status === 403) {
    // The Dashlane item is configurable in the native host's config, so the
    // extension must not name a path here. Settings shows which item is in use.
    return appError(
      'api-auth',
      `Anthropic rejected the API key (${status}). Check that the Dashlane item shown in Settings holds a current ` +
        `key. If you rotated it recently, sync your local vault first, then reload the extension. ${detail}`,
      [{ label: 'Refresh your local vault copy', command: 'dcli sync' }],
    );
  }
  if (status === 429) {
    return appError('api-rate-limit', `Rate limited by Anthropic. ${detail}`);
  }
  return appError('api-error', `Anthropic API error ${status}. ${detail}`);
}

interface StreamEvent {
  type: string;
  delta?: { type?: string; text?: string };
  content_block?: { type?: string };
  error?: { type?: string; message?: string };
}

/** Splits an SSE byte stream into `data:` payloads. */
export function* parseSseChunk(buffer: string): Generator<string, void, void> {
  for (const block of buffer.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

export async function streamMessage(options: StreamOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const body = buildRequestBody(options.model, options.system, options.messages);

  let response: Response;
  try {
    response = await doFetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (options.signal?.aborted) throw appError('aborted', 'Cancelled.');
    throw appError('network', `Could not reach api.anthropic.com: ${String(cause)}`);
  }

  if (!response.ok) {
    throw mapHttpError(response.status, await response.text());
  }
  if (!response.body) {
    throw appError('api-error', 'Anthropic returned an empty response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let sawThinking = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    // Keep the trailing partial event in the buffer.
    const lastBreak = pending.lastIndexOf('\n\n');
    if (lastBreak === -1) continue;
    const complete = pending.slice(0, lastBreak);
    pending = pending.slice(lastBreak + 2);

    for (const payload of parseSseChunk(complete)) {
      if (payload === '' || payload === '[DONE]') continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(payload) as StreamEvent;
      } catch {
        continue;
      }
      if (event.type === 'error') {
        throw appError('api-error', event.error?.message ?? 'The Anthropic stream reported an error.');
      }
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking' && !sawThinking) {
        sawThinking = true;
        options.onThinking?.();
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        options.onText(event.delta.text);
      }
    }
  }
}
