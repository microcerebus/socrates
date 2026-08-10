import type { AskRequest } from '../src/shared/protocol.ts';
import type { AskIntent, PageSnapshot, Rung } from '../src/shared/types.ts';

export const SNAPSHOT: PageSnapshot = {
  problem: {
    slug: 'two-sum',
    title: '1. Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    statement: 'Given an array of integers nums and an integer target, return indices of the two numbers…',
    examples: ['Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]'],
    constraints: ['2 <= nums.length <= 10^4'],
    source: 'leetcode',
  },
  editor: {
    language: 'javascript',
    code: 'var twoSum = function(nums, target) {\n  // TODO\n};',
    source: 'leetcode',
  },
  capturedAt: 1_700_000_000_000,
};

export function askRequest(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    intent: 'unlock' as AskIntent,
    rung: 1 as Rung,
    message: '',
    snapshot: SNAPSHOT,
    history: [],
    elapsedMs: 7 * 60_000,
    ...overrides,
  };
}

/** Serialises text into the SSE frames the Messages API emits. */
export function sseBody(chunks: string[], options: { withThinking?: boolean } = {}): string {
  const events: string[] = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5"}}',
  ];
  if (options.withThinking) {
    events.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    );
  }
  events.push(
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  );
  for (const chunk of chunks) {
    events.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: chunk },
      })}`,
    );
  }
  events.push(
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  );
  return `${events.join('\n\n')}\n\n`;
}

export interface MockCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface MockFetch {
  impl: typeof fetch;
  calls: MockCall[];
}

/** A `fetch` stand-in that streams the given SSE body back one small piece at a time. */
export function mockAnthropic(body: string, init: { status?: number } = {}): MockFetch {
  const calls: MockCall[] = [];

  const impl: typeof fetch = async (input, requestInit) => {
    calls.push({
      url: String(input),
      headers: (requestInit?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(requestInit?.body ?? '{}')) as Record<string, unknown>,
    });

    if (init.status && init.status >= 400) {
      return new Response(body, { status: init.status });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately awkward chunking: split mid-event to exercise the parser.
        for (let i = 0; i < body.length; i += 37) {
          controller.enqueue(encoder.encode(body.slice(i, i + 37)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  return { impl, calls };
}
