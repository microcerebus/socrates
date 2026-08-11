/**
 * The snapshot a pasted problem turns into.
 *
 * This lives outside `src/panel/` on purpose. The paste form is the one place in
 * the panel that has to *build* a `ProblemContext`, which means naming every
 * field on it - `topicTags` included - and the panel is precisely where that
 * field must never appear (see the spoiler boundary in
 * `src/prompt/system-prompt.ts`, and the test in `tests/prompt-gating.test.ts`
 * that enforces it by reading the panel's own source). Keeping the constructor
 * here means the invariant can stay absolute rather than carrying an exception
 * that a later reader would have to re-derive.
 *
 * The values are also the honest ones for a paste: there is no page to glean
 * from, so there are no tags, no editorial, no hints and no run result. Inventing
 * any of them would put context in the prompt that no scrape supports.
 */

import type { PageSnapshot } from './types.ts';

export interface PastedProblem {
  title: string;
  statement: string;
  code: string;
  /** A language id from `languages.ts`. */
  language: string;
}

function slugify(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'pasted-problem'
  );
}

export function pastedSnapshot(
  { title, statement, code, language }: PastedProblem,
  capturedAt: number,
): PageSnapshot {
  return {
    problem: {
      slug: slugify(title),
      title: title.trim() || 'Pasted problem',
      url: null,
      difficulty: null,
      number: null,
      statement: statement.trim(),
      examples: [],
      constraints: [],
      topicTags: [],
      hasEditorial: false,
      hasHints: false,
      source: 'manual',
    },
    editor: { language, code, source: 'manual' },
    run: null,
    capturedAt,
  };
}
