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

import {
  parseEditorLanguage,
  parseProblem,
  parseRunResult,
  parseTopicTags,
  splitSections,
} from '../src/content/scrape/parse.ts';
import { isProblemUrl, queryFirst, slugFromUrl } from '../src/content/scrape/selectors.ts';
import {
  LEETCODE_LANGUAGES,
  languageByLabel,
  normaliseLanguageId,
} from '../src/shared/languages.ts';

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
    expect(slugFromUrl('https://leetcode.com/problems/valid-parentheses/submissions/')).toBe(
      'valid-parentheses',
    );
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

    expect(statement).toContain(
      'return indices of the two numbers such that they add up to target',
    );
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

  it('reads the id off the title', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.number).toBe('1');
  });

  it('gleans the topic tags even though the disclosure is collapsed', () => {
    // The container is `height: 0px` on the live page, which is exactly why the
    // panel must never render what comes out of here.
    expect(doc.querySelector('[style*="height: 0px"]')).not.toBeNull();
    expect(parseTopicTags(doc)).toEqual(['Array', 'Hash Table']);
    // The "Junior" pill in the same row is not a tag link and must not come along.
    expect(parseTopicTags(doc)).not.toContain('Junior');
  });

  it('reports editorial and hints as booleans, never their content', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.hasEditorial).toBe(true);
    expect(result.problem.hasHints).toBe(true);
    // Nothing anywhere in the parsed problem quotes a hint or the editorial.
    expect(JSON.stringify(result.problem)).not.toContain('Hint 1');
  });

  it('reads the selected language off the toolbar button, past its chevron', () => {
    expect(parseEditorLanguage(doc)).toBe('python3');
  });

  it('has no run result until something has been run', () => {
    expect(parseRunResult(doc)).toBeNull();
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
    const result = parseProblem(
      doc,
      'https://leetcode.com/problems/longest-substring-without-repeating-characters/',
    );
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

  it('omits every optional section rather than failing on it', () => {
    const result = parseProblem(
      doc,
      'https://leetcode.com/problems/longest-substring-without-repeating-characters/',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problem.topicTags).toEqual([]);
    expect(result.problem.hasEditorial).toBe(false);
    expect(result.problem.hasHints).toBe(false);
    expect(result.problem.number).toBe('3');
    expect(parseRunResult(doc)).toBeNull();
  });

  it("falls back to Monaco's attribute when there is no language toolbar", () => {
    expect(queryFirst(doc, 'editorLanguageButton')).toBeNull();
    expect(parseEditorLanguage(doc)).toBe('golang');
  });
});

describe('the run result panel', () => {
  it('reads a Wrong Answer with the failing case and both outputs', () => {
    const run = parseRunResult(fixture('run-result.wrong-answer.html'));
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.kind).toBe('run');
    expect(run.verdict).toBe('Wrong Answer');
    expect(run.verdictText).toBe('Wrong Answer');
    expect(run.testcases).toBe('2 / 3 testcases passed');
    // One div per parameter on the page: joined with newlines, not concatenated.
    expect(run.input).toBe('nums =\n[3,2,4]\ntarget =\n6');
    expect(run.output).toBe('[]');
    expect(run.expected).toBe('[1,2]');
    expect(run.stdout).toBe('scanning 3 values');
    expect(run.errorMessage).toBeNull();
  });

  it('does not reach into the testcase editor next door for its input', () => {
    // The Testcase tab holds `[3,2,4]` too; scoping to the result tab is what
    // keeps the two apart.
    const run = parseRunResult(fixture('run-result.wrong-answer.html'));
    expect(run?.input).not.toContain('Case 1');
  });

  it('reads an Accepted run without inventing an Expected block', () => {
    const run = parseRunResult(fixture('run-result.accepted.html'));
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.verdict).toBe('Accepted');
    expect(run.input).toBe('nums =\n[2,7,11,15]\ntarget =\n9');
    expect(run.output).toBe('[0,1]');
    expect(run.expected).toBeNull();
    expect(run.testcases).toBeNull();
  });

  it('reads a Runtime Error with no flexlayout to scope to', () => {
    const doc = fixture('run-result.runtime-error.html');
    expect(doc.querySelector('[data-layout-path]')).toBeNull();
    const run = parseRunResult(doc);
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.verdict).toBe('Runtime Error');
    expect(run.errorMessage).toBe('Line 6: IndexError: list index out of range');
    expect(run.stdout).toBe('i = 0');
    // The heading also carries an "Open Testcase" link, which must not be read
    // as part of either the label or the value.
    expect(run.input).toBe('nums =\n[]\ntarget =\n0');
    expect(run.output).toBeNull();
  });

  it('tells a submission apart from a run', () => {
    const run = parseRunResult(fixture('submission-result.html'));
    expect(run).not.toBeNull();
    if (!run) return;
    expect(run.kind).toBe('submission');
    expect(run.verdict).toBe('Wrong Answer');
    expect(run.testcases).toBe('35 / 57 testcases passed');
    expect(run.expected).toBe('[0,1]');
    // No error verdict, so the red-wash selector is never consulted.
    expect(run.errorMessage).toBeNull();
  });
});

describe('the language list', () => {
  it("is LeetCode's own, in LeetCode's own order", () => {
    // Checked against `languageList { id name }` and against the live editor
    // dropdown; both agree on these 25 in this order.
    expect(LEETCODE_LANGUAGES).toHaveLength(25);
    expect(LEETCODE_LANGUAGES.slice(0, 6).map((entry) => entry.id)).toEqual([
      'cpp',
      'java',
      'python3',
      'python',
      'javascript',
      'typescript',
    ]);
    expect(LEETCODE_LANGUAGES.at(-1)?.id).toBe('pythondata');
    expect(new Set(LEETCODE_LANGUAGES.map((entry) => entry.id)).size).toBe(
      LEETCODE_LANGUAGES.length,
    );
  });

  it('resolves the label LeetCode prints back to the id Monaco reports', () => {
    expect(languageByLabel('C++')?.id).toBe('cpp');
    expect(languageByLabel('Go')?.id).toBe('golang');
    expect(languageByLabel('  python3 ')?.id).toBe('python3');
    expect(languageByLabel('Klingon')).toBeNull();
  });

  it("normalises the spellings that are not LeetCode's, and refuses the rest", () => {
    expect(normaliseLanguageId('js')).toBe('javascript');
    expect(normaliseLanguageId('go')).toBe('golang');
    expect(normaliseLanguageId('C#')).toBe('csharp');
    // `python` is a real LeetCode language and must never be folded into python3.
    expect(normaliseLanguageId('python')).toBe('python');
    expect(normaliseLanguageId('plaintext')).toBeNull();
    expect(normaliseLanguageId('')).toBeNull();
  });

  /**
   * It is the allowlist between the page and the prompt, and the page picks the
   * *type* as well as the value: the MAIN-world bridge runs in page context. An
   * allowlist that throws on hostile input is not an allowlist - and this one
   * threw somewhere fatal, inside a listener whose timeout had already been
   * cleared, so the capture promise never settled and the panel hung.
   */
  it('is total: nothing the page can send makes it throw', () => {
    const hostile: unknown[] = [
      12_345,
      null,
      undefined,
      true,
      ['python'],
      { toString: 'not a function' },
      { trim: undefined },
      Symbol('python'),
      () => 'python',
      Object.create(null),
    ];
    for (const value of hostile) {
      expect(() => normaliseLanguageId(value)).not.toThrow();
      expect(normaliseLanguageId(value)).toBeNull();
    }
  });
});

describe('unrecognisable page', () => {
  it('fails cleanly so the panel can offer paste mode', () => {
    const result = parseProblem(
      fixture('unrecognised.html'),
      'https://leetcode.com/problems/mystery/',
    );
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
    expect(sections.examples).toEqual([
      'Example 1:\nInput: a\nOutput: b',
      'Example 2:\nInput: c\nOutput: d',
    ]);
    expect(sections.constraints).toEqual(['1 <= n <= 10', 'n is odd']);
  });

  it('drops non-breaking-space spacers', () => {
    const doc = new DOMParser().parseFromString(
      '<div id="r"><p>&nbsp;</p><p>Real text.</p></div>',
      'text/html',
    );
    expect(splitSections(doc.getElementById('r')!).statement).toBe('Real text.');
  });
});
