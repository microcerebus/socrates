/**
 * @vitest-environment jsdom
 *
 * Scraper tests against saved LeetCode markup. The problem bodies in the
 * fixtures are the real ones (fetched from LeetCode's public GraphQL endpoint);
 * the page chrome around them mirrors the live description tab, plus one drifted
 * variant and one that is unrecognisable on purpose.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseProblem, splitSections } from '../src/content/scrape/parse.ts';
import { isProblemUrl, queryFirst, slugFromUrl } from '../src/content/scrape/selectors.ts';

function fixture(name: string): Document {
  const html = readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('url helpers', () => {
  it('recognises problem pages and nothing else', () => {
    expect(isProblemUrl('https://leetcode.com/problems/two-sum/')).toBe(true);
    expect(isProblemUrl('https://leetcode.com/problems/two-sum/description/')).toBe(true);
    // Only hosts the manifest actually injects into.
    expect(isProblemUrl('https://leetcode.cn/problems/two-sum/')).toBe(false);
    expect(isProblemUrl('https://leetcode.com/problemset/all/')).toBe(false);
    expect(isProblemUrl('https://example.com/problems/two-sum/')).toBe(false);
    expect(isProblemUrl('not a url')).toBe(false);
  });

  it('pulls the slug out of the path', () => {
    expect(slugFromUrl('https://leetcode.com/problems/valid-parentheses/submissions/')).toBe('valid-parentheses');
    expect(slugFromUrl('https://leetcode.com/contest/')).toBeNull();
  });
});

describe('current LeetCode layout', () => {
  const doc = fixture('two-sum.current.html');
  const result = parseProblem(doc, 'https://leetcode.com/problems/two-sum/description/');

  it('parses title, slug and difficulty', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.title).toBe('1. Two Sum');
    expect(result.problem.slug).toBe('two-sum');
    expect(result.problem.difficulty).toBe('Easy');
    expect(result.problem.source).toBe('leetcode');
  });

  it('separates statement, examples and constraints', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { statement, examples, constraints } = result.problem;

    expect(statement).toContain('return indices of the two numbers such that they add up to target');
    expect(statement).not.toContain('Input: nums = [2,7,11,15]');
    expect(statement).not.toContain('-109 <= nums[i] <= 109');

    expect(examples.length).toBeGreaterThanOrEqual(3);
    expect(examples[0]).toContain('Example 1:');
    expect(examples[0]).toContain('Output: [0,1]');

    expect(constraints.length).toBeGreaterThanOrEqual(4);
    expect(constraints.some((c) => c.includes('nums.length'))).toBe(true);
  });

  it('keeps the follow-up with the statement', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.statement).toMatch(/Follow-?up/i);
  });

  it('does not read code out of the virtualised editor DOM', () => {
    // Monaco only renders visible lines, so `.view-line` scraping would silently
    // truncate. The parser must ignore the editor entirely.
    expect(doc.querySelectorAll('.view-line').length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.statement).not.toContain('only the visible lines');
  });
});

describe('drifted layout', () => {
  const doc = fixture('longest-substring.drifted.html');

  it('still finds the description through the fallback chain', () => {
    const result = parseProblem(doc, 'https://leetcode.com/problems/longest-substring-without-repeating-characters/');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.title).toBe('3. Longest Substring Without Repeating Characters');
    expect(result.problem.slug).toBe('longest-substring-without-repeating-characters');
    expect(result.problem.difficulty).toBe('Medium');
    expect(result.problem.statement).toContain('longest substring');
    expect(result.problem.examples.length).toBeGreaterThan(0);
    expect(result.problem.constraints.length).toBeGreaterThan(0);
  });

  it('resolves selectors through the group, not a single hard-coded query', () => {
    expect(doc.querySelector('[data-track-load="description_content"]')).toBeNull();
    expect(queryFirst(doc, 'descriptionRoot')).not.toBeNull();
  });
});

describe('unrecognisable page', () => {
  it('fails cleanly so the panel can offer paste mode', () => {
    const result = parseProblem(fixture('unrecognised.html'), 'https://leetcode.com/problems/mystery/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-problem-markup');
    expect(result.detail).toBeTruthy();
  });

  it('fails when the container is present but empty', () => {
    const doc = new DOMParser().parseFromString(
      '<div data-track-load="description_content"></div>',
      'text/html',
    );
    const result = parseProblem(doc, 'https://leetcode.com/problems/mystery/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no-statement');
  });
});

describe('section splitting', () => {
  it('groups each example with the block that follows its heading', () => {
    const doc = new DOMParser().parseFromString(
      `<div id="r">
         <p>Do the thing.</p>
         <p><strong>Example 1:</strong></p>
         <pre>Input: a\nOutput: b</pre>
         <p><strong>Example 2:</strong></p>
         <pre>Input: c\nOutput: d</pre>
         <p><strong>Constraints:</strong></p>
         <ul><li>1 &lt;= n &lt;= 10</li><li>n is odd</li></ul>
       </div>`,
      'text/html',
    );
    const sections = splitSections(doc.getElementById('r')!);
    expect(sections.statement).toBe('Do the thing.');
    expect(sections.examples).toEqual(['Example 1:\nInput: a\nOutput: b', 'Example 2:\nInput: c\nOutput: d']);
    expect(sections.constraints).toEqual(['1 <= n <= 10', 'n is odd']);
  });

  it('drops non-breaking-space spacers', () => {
    const doc = new DOMParser().parseFromString('<div id="r"><p>&nbsp;</p><p>Real text.</p></div>', 'text/html');
    expect(splitSections(doc.getElementById('r')!).statement).toBe('Real text.');
  });
});
