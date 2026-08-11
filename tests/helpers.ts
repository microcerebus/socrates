import type { ProviderRequest, ProviderStream } from '../src/background/providers.ts';
import type { AskRequest } from '../src/shared/protocol.ts';
import type { AskIntent, PageSnapshot, RunResult, Rung } from '../src/shared/types.ts';

export const SNAPSHOT: PageSnapshot = {
  problem: {
    slug: 'two-sum',
    title: '1. Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    number: '1',
    statement:
      'Given an array of integers nums and an integer target, return indices of the two numbers…',
    examples: ['Example 1:\nInput: nums = [2,7,11,15], target = 9\nOutput: [0,1]'],
    constraints: ['2 <= nums.length <= 10^4'],
    topicTags: ['Array', 'Hash Table'],
    hasEditorial: true,
    hasHints: true,
    source: 'leetcode',
  },
  editor: {
    language: 'javascript',
    code: 'var twoSum = function(nums, target) {\n  // TODO\n};',
    source: 'leetcode',
  },
  run: null,
  capturedAt: 1_700_000_000_000,
};

/** A Wrong Answer on example 2, as the console panel would report it. */
export const WRONG_ANSWER: RunResult = {
  kind: 'run',
  verdictText: 'Wrong Answer',
  verdict: 'Wrong Answer',
  testcases: '2 / 3 testcases passed',
  input: 'nums = [3,2,4]\ntarget = 6',
  output: '[]',
  expected: '[1,2]',
  stdout: 'scanning 3 values',
  errorMessage: null,
};

export function askRequest(overrides: Partial<AskRequest> = {}): AskRequest {
  return {
    intent: 'unlock' as AskIntent,
    rung: 1 as Rung,
    message: '',
    snapshot: SNAPSHOT,
    language: 'javascript',
    history: [],
    elapsedMs: 7 * 60_000,
    ...overrides,
  };
}

/**
 * A `ProviderStream` that emits fixed chunks.
 *
 * The API-key transport this used to ride on is gone, and a stub is the better
 * shape anyway: these tests are about what `runInterviewTurn` builds and what
 * the guard lets back out, neither of which should care how the bytes arrive.
 * The real transport is covered end to end in `tests/claude-code.test.ts`.
 */
export function streamOf(chunks: string[]): ProviderStream {
  return async (request) => {
    request.onStarted?.();
    for (const chunk of chunks) request.onText(chunk);
    await Promise.resolve();
  };
}

/** The prompt the last turn actually sent, for asserting on what the model saw. */
export function sentTurn(seen: ProviderRequest[]): string {
  return String(seen.at(-1)?.messages.at(-1)?.content ?? '');
}

/** Records every request a turn makes, and replays `chunks` as the reply. */
export function recordingStream(chunks: string[]): {
  stream: ProviderStream;
  seen: ProviderRequest[];
} {
  const seen: ProviderRequest[] = [];
  const inner = streamOf(chunks);
  return {
    seen,
    stream: (request) => {
      seen.push(request);
      return inner(request);
    },
  };
}
