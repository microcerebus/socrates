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

