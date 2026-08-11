/**
 * Turns a LeetCode problem page into a `PageSnapshot`.
 *
 * Pure DOM in, plain data out - no extension APIs - so it can be exercised
 * against saved HTML fixtures in `tests/fixtures/`.
 *
 * Everything past the description is *optional by construction*: the language
 * toolbar, the topic tags, the hints disclosure and the run-result panel each
 * parse to `null`/`[]` when they are not on screen, and none of them can fail
 * the scrape. Only the description is load-bearing, because only the
 * description is what the panel cannot work without.
 */

import { languageByLabel, normaliseLanguageId } from '../../shared/languages.ts';
import type { ProblemContext, RunResult, RunVerdict, ScrapeFailure } from '../../shared/types.ts';
import {
  RESULT_LABELS,
  RESULT_VERDICTS,
  VERDICTS_WITH_ERROR_TEXT,
  queryAll,
  queryFirst,
  slugFromUrl,
} from './selectors.ts';

const EXAMPLE_HEADING = /^example\s*\d*\s*:?$/i;
const CONSTRAINTS_HEADING = /^constraints?\s*:?$/i;
const FOLLOWUP_HEADING = /^follow[\s-]?up\s*:?/i;

export function normaliseText(node: Node): string {
  return (node.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

/**
 * The element's own leading text, ignoring anything a child contributes.
 *
 * Needed because LeetCode hangs decoration off the elements whose text is the
 * thing we want: the language button carries a chevron `div`, and the "Last
 * Executed Input" heading carries an "Open Testcase" link. `textContent` would
 * return "C++" and "Last Executed InputOpen Testcase" respectively.
 */
function ownText(element: Element): string {
  const first = element.firstChild;
  if (first?.nodeType === 3 /* Node.TEXT_NODE */)
    return (first.nodeValue ?? '').replace(/\u00a0/g, ' ').trim();
  return '';
}

function difficultyFrom(root: ParentNode): string | null {
  const element = queryFirst(root, 'difficulty');
  if (!element) return null;

  const attr = element.getAttribute('data-difficulty') ?? element.getAttribute('diff');
  if (attr) return capitalise(attr);

  const classMatch = /text-difficulty-(easy|medium|hard)/i.exec(element.className);
  if (classMatch?.[1]) return capitalise(classMatch[1]);

  const text = normaliseText(element);
  return /^(easy|medium|hard)$/i.test(text) ? capitalise(text) : null;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

interface Sections {
  statement: string;
  examples: string[];
  constraints: string[];
}

/** Walks the description in document order and splits it into its three parts. */
export function splitSections(root: Element): Sections {
  const statementLines: string[] = [];
  const examples: string[] = [];
  const constraints: string[] = [];

  let mode: 'statement' | 'example' | 'constraints' | 'followup' = 'statement';
  let currentExample: string[] = [];

  const flushExample = (): void => {
    const joined = currentExample.join('\n').trim();
    if (joined !== '') examples.push(joined);
    currentExample = [];
  };

  for (const child of Array.from(root.children)) {
    const text = normaliseText(child);
    if (text === '') continue;

    if (EXAMPLE_HEADING.test(text)) {
      flushExample();
      mode = 'example';
      currentExample.push(text.replace(/:?$/, ':'));
      continue;
    }
    if (CONSTRAINTS_HEADING.test(text)) {
      flushExample();
      mode = 'constraints';
      continue;
    }
    if (FOLLOWUP_HEADING.test(text)) {
      flushExample();
      mode = 'followup';
      statementLines.push(text);
      continue;
    }

    switch (mode) {
      case 'statement':
        statementLines.push(text);
        break;
      case 'example':
        currentExample.push(text);
        break;
      case 'constraints': {
        const items = Array.from(child.querySelectorAll('li'));
        if (items.length > 0) {
          for (const item of items) {
            const itemText = normaliseText(item);
            if (itemText !== '') constraints.push(itemText);
          }
        } else {
          constraints.push(text);
        }
        break;
      }
      case 'followup':
        statementLines.push(text);
        break;
    }
  }
  flushExample();

  return {
    statement: statementLines.join('\n\n').trim(),
    examples,
    constraints,
  };
}

// ---------------------------------------------------------------- language --

/**
 * The language the LeetCode editor is currently set to, as a language id.
 *
 * The toolbar label leads because it is isolated-world DOM and therefore
 * readable even when the MAIN-world Monaco bridge is not answering; the
 * `data-mode-id` attribute is the fallback. Unrecognised text yields `null`
 * rather than a guess - the caller would rather know it does not know.
 */
export function parseEditorLanguage(doc: Document): string | null {
  for (const button of queryAll(doc, 'editorLanguageButton')) {
    const label = ownText(button) || normaliseText(button);
    const byLabel = languageByLabel(label);
    if (byLabel) return byLabel.id;
    const normalised = normaliseLanguageId(label);
    if (normalised !== null) return normalised;
  }

  for (const element of queryAll(doc, 'editorLanguageMode')) {
    const mode = element.getAttribute('data-mode-id');
    if (mode === null || mode === 'plaintext') continue;
    const normalised = normaliseLanguageId(mode);
    if (normalised !== null) return normalised;
  }

  return null;
}

// ------------------------------------------------------------ page context --

/**
 * LeetCode's topic tags.
 *
 * Read even though the "Topics" disclosure is collapsed - the anchors are in the
 * DOM either way - and precisely because of that they are model context only.
 * See the spoiler boundary in `src/prompt/system-prompt.ts`.
 */
export function parseTopicTags(doc: Document): string[] {
  const seen = new Set<string>();
  for (const anchor of queryAll(doc, 'topicTag')) {
    const text = normaliseText(anchor);
    if (text !== '' && text.length < 60) seen.add(text);
  }
  return Array.from(seen);
}

const HINT_HEADING = /^hints?(\s+\d+)?$/i;

/**
 * Whether the page offers hints, as a boolean and nothing more.
 *
 * Matched on the disclosure heading rather than a class, because the hint
 * accordion is the least marked-up part of the description column. Their
 * *content* is deliberately never read: it is LeetCode's own ladder, written to
 * a different discipline than this one, and mixing the two would hand out rung-2
 * material at rung 1.
 */
export function parseHasHints(doc: Document): boolean {
  const root = doc.getElementById('qd-content') ?? doc.body ?? doc;
  for (const element of Array.from(root.querySelectorAll('div, button, summary, h3'))) {
    if (HINT_HEADING.test(ownText(element))) return true;
  }
  return false;
}

/** Whether an editorial exists. Presence only, for the same reason as hints. */
export function parseHasEditorial(doc: Document): boolean {
  if (queryFirst(doc, 'editorialTab') !== null) return true;
  const root = doc.getElementById('qd-content') ?? doc.body ?? doc;
  for (const element of Array.from(root.querySelectorAll('div, a, button'))) {
    if (ownText(element).toLowerCase() === 'editorial') return true;
  }
  return false;
}

/** "1. Two Sum" -> "1". */
export function parseProblemNumber(title: string): string | null {
  return /^\s*(\d+)\s*\./.exec(title)?.[1] ?? null;
}

// ------------------------------------------------------------- run results --

const TESTCASES_PASSED = /(\d+)\s*\/\s*(\d+)\s*testcases passed/i;

function verdictFor(text: string): RunVerdict {
  const match = RESULT_VERDICTS.find(
    (verdict) => verdict.toLowerCase() === text.trim().toLowerCase(),
  );
  return match ?? 'other';
}

/**
 * The container that holds the whole result, starting from the verdict line.
 *
 * The wrapper LeetCode renders is a bare Tailwind `div` with no hook of its own,
 * so the flexlayout tab it sits in is the nearest thing to a landmark: the
 * result gets its own tab (`/c1/ts1/t1`), separate from the testcase editor's,
 * which is exactly the scope wanted. Where there is no flexlayout - an older
 * page, or a fixture of one panel on its own - the fallback climbs until it
 * finds an ancestor that actually contains part of a result, which is the
 * operational definition of "the result" here.
 */
function resultRootFor(verdictElement: Element): Element {
  const tab = verdictElement.closest('[data-layout-path]');
  if (tab) return tab;

  let node: Element | null = verdictElement.parentElement;
  for (let step = 0; step < 6 && node !== null; step += 1) {
    if (holdsResultDetail(node)) return node;
    node = node.parentElement;
  }
  return verdictElement.parentElement ?? verdictElement;
}

function holdsResultDetail(node: Element): boolean {
  if (queryFirst(node, 'runError') !== null) return true;
  return Object.values(RESULT_LABELS).some((labels) => findLabelled(node, labels) !== null);
}

const INLINE_TAGS = new Set([
  'SPAN',
  'A',
  'CODE',
  'EM',
  'STRONG',
  'B',
  'I',
  'SUP',
  'SUB',
  'SMALL',
  'SVG',
  'PATH',
]);

/**
 * Text with the block structure kept as newlines.
 *
 * `textContent` is wrong for the result values specifically: LeetCode renders a
 * multi-parameter input as one `div` per line (`nums =`, `[3,2,4]`, `target =`,
 * `6`), and concatenating those gives `nums =[3,2,4]target =6`, which is not
 * something to hand a model as "the failing input".
 */
function blockText(root: Element): string {
  const lines: string[] = [];
  let current = '';

  const flush = (): void => {
    const text = current.replace(/\u00a0/g, ' ').trim();
    if (text !== '') lines.push(text);
    current = '';
  };

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* text */) {
        current += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;
      const element = child as Element;
      if (INLINE_TAGS.has(element.tagName)) {
        walk(element);
        continue;
      }
      flush();
      walk(element);
      flush();
    }
  };

  walk(root);
  flush();
  return lines.join('\n');
}

/**
 * The content that belongs to a heading element.
 *
 * The heading and its value are siblings, but not always at the same depth:
 * "Output" is a bare `div`, while "Stdout" is a `span` inside one. So the search
 * climbs - strictly while the node is everything its parent contains, which is
 * what stops the climb from escaping into a neighbouring block and returning the
 * next section's text as this section's value.
 */
function valueAfter(label: Element): string | null {
  let node: Element | null = label;
  while (node !== null) {
    const sibling = node.nextElementSibling;
    if (sibling) {
      const value = blockText(sibling);
      if (value !== '') return value;
    }
    const parent: Element | null = node.parentElement;
    if (
      parent === null ||
      parent.children.length !== 1 ||
      normaliseText(parent) !== normaliseText(node)
    )
      break;
    node = parent;
  }

  // The variant where heading and value share one element.
  const parent = label.parentElement;
  if (parent) {
    const value = normaliseText(parent).slice(normaliseText(label).length).trim();
    if (value !== '') return value;
  }
  return null;
}

/** The value under a heading whose own text is one of `labels`. */
function findLabelled(root: ParentNode, labels: readonly string[]): string | null {
  const wanted = labels.map((label) => label.toLowerCase());
  for (const element of Array.from(root.querySelectorAll('div, span, h3, label'))) {
    if (!wanted.includes(ownText(element).toLowerCase())) continue;
    const value = valueAfter(element);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The run or submission result panel, when one is on screen.
 *
 * Returns `null` far more often than not - the console shows the testcase editor
 * until something has been run - and that is the normal case, not a failure.
 */
export function parseRunResult(doc: Document): RunResult | null {
  const verdictElement = queryFirst(doc, 'runVerdict');
  if (!verdictElement) return null;

  const verdictText = normaliseText(verdictElement);
  if (verdictText === '') return null;

  const verdict = verdictFor(verdictText);
  const root = resultRootFor(verdictElement);
  const rootText = normaliseText(root);

  const errorMessage = VERDICTS_WITH_ERROR_TEXT.has(verdict)
    ? (queryFirst(root, 'runError')?.textContent ?? null)
    : null;

  return {
    kind: queryFirst(doc, 'submissionVerdict') === null ? 'run' : 'submission',
    verdictText,
    verdict,
    testcases: TESTCASES_PASSED.exec(rootText)?.[0] ?? null,
    input:
      findLabelled(root, RESULT_LABELS.input) ??
      findLabelled(root, RESULT_LABELS.lastExecutedInput),
    output: findLabelled(root, RESULT_LABELS.output),
    expected: findLabelled(root, RESULT_LABELS.expected),
    stdout: findLabelled(root, RESULT_LABELS.stdout),
    errorMessage:
      errorMessage === null ? null : errorMessage.replace(/\u00a0/g, ' ').trim() || null,
  };
}

// ------------------------------------------------------------------ parsing --

export type ParseResult =
  { ok: true; problem: ProblemContext } | { ok: false; reason: ScrapeFailure; detail?: string };

export function parseProblem(doc: Document, url: string): ParseResult {
  const root = queryFirst(doc, 'descriptionRoot');
  if (!root) {
    return {
      ok: false,
      reason: 'no-problem-markup',
      detail: 'No description container matched any known selector.',
    };
  }

  const sections = splitSections(root);
  if (sections.statement === '') {
    return {
      ok: false,
      reason: 'no-statement',
      detail: 'Found the description container but it was empty.',
    };
  }

  const titleElement = queryFirst(doc, 'title');
  const titleText = titleElement ? normaliseText(titleElement) : '';
  const href = titleElement?.getAttribute('href') ?? null;
  const slug =
    slugFromUrl(url) ??
    (href ? slugFromUrl(new URL(href, 'https://leetcode.com').toString()) : null);
  const title =
    titleText !== ''
      ? titleText
      : doc.title.replace(/\s*-\s*LeetCode\s*$/i, '').trim() || 'Untitled problem';

  return {
    ok: true,
    problem: {
      slug: slug ?? 'unknown-problem',
      title,
      url,
      difficulty: difficultyFrom(doc),
      number: parseProblemNumber(title),
      statement: sections.statement,
      examples: sections.examples,
      constraints: sections.constraints,
      topicTags: parseTopicTags(doc),
      hasEditorial: parseHasEditorial(doc),
      hasHints: parseHasHints(doc),
      source: 'leetcode',
    },
  };
}
