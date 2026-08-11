/**
 * Turns a LeetCode problem page into a `ProblemContext`.
 *
 * Pure DOM in, plain data out - no extension APIs - so it can be exercised
 * against saved HTML fixtures in `tests/fixtures/`.
 */

import type { ProblemContext, ScrapeFailure } from '../../shared/types.ts';
import { queryFirst, slugFromUrl } from './selectors.ts';

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

  return {
    ok: true,
    problem: {
      slug: slug ?? 'unknown-problem',
      title:
        titleText !== ''
          ? titleText
          : doc.title.replace(/\s*-\s*LeetCode\s*$/i, '').trim() || 'Untitled problem',
      url,
      difficulty: difficultyFrom(doc),
      statement: sections.statement,
      examples: sections.examples,
      constraints: sections.constraints,
      source: 'leetcode',
    },
  };
}
