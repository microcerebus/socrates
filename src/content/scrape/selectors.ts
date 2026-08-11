/**
 * Every LeetCode DOM selector in the extension lives here.
 *
 * LeetCode ships class-name churn regularly, so each target is a fallback chain,
 * newest-first. When the page drifts, this is the only file that should need to
 * change - and if none of the chains hit, the panel falls back to manual paste
 * rather than guessing.
 *
 * Two kinds of hook show up below, and they are not equally durable:
 *
 * - `data-e2e-locator` attributes (`console-result`, `console-submit-button`)
 *   are LeetCode's own test hooks. They survive redesigns that rewrite every
 *   class name, so they lead the chains they appear in.
 * - Tailwind class fragments (`text-difficulty-`, the red error wash) are the
 *   last resort and are matched by substring, never in full.
 *
 * `RESULT_LABELS` is not a selector but belongs with them: the run-result panel
 * labels its blocks with translated strings rather than marking them up, so the
 * English wording is a drift surface exactly like a class name is. It is taken
 * verbatim from LeetCode's shipped `console` i18n bundle.
 */

export const SELECTORS = {
  /** The rendered problem description. */
  descriptionRoot: [
    '[data-track-load="description_content"]',
    'div.elfjS',
    '.question-content',
    '.content__u3I1.question-content__JfgR',
    '[class*="description__"]',
  ],
  /** The "1. Two Sum" heading link. */
  title: [
    '.text-title-large a[href^="/problems/"]',
    'a.truncate[href^="/problems/"]',
    '.question-title a[href^="/problems/"]',
    '[class*="text-title"] a[href^="/problems/"]',
    'a[href^="/problems/"][class*="truncate"]',
  ],
  /** The Easy/Medium/Hard pill. */
  difficulty: ['[class*="text-difficulty-"]', '[data-difficulty]', '[diff]'],
  /** Presence of the Monaco editor, used to decide whether to try the page bridge. */
  monacoRoot: ['.monaco-editor', '[data-mode-id]', '#editor'],
  /**
   * The language button in the editor toolbar, whose text is the label LeetCode
   * prints for the currently selected language ("C++", "Python3").
   *
   * This is read *as well as* the Monaco language id rather than instead of it:
   * the button is plain DOM in the isolated world, so it still answers when the
   * MAIN-world bridge cannot reach Monaco at all.
   */
  editorLanguageButton: [
    '#editor button[aria-haspopup="dialog"]',
    '#editor button[aria-haspopup="listbox"]',
    'button[data-cy="lang-select"]',
    '#lang-select',
  ],
  /** Monaco's own view of the language, as an attribute rather than a live object. */
  editorLanguageMode: ['#editor [data-mode-id]', '[data-mode-id]'],
  /**
   * Topic tags. Present in the DOM even while the "Topics" disclosure is
   * collapsed, which is exactly why the panel must never render them - the user
   * has almost certainly not opened it.
   */
  topicTag: ['a[href^="/tag/"]', 'a[href^="https://leetcode.com/tag/"]'],
  /** The verdict line of the run/submission result. LeetCode's own test hook. */
  runVerdict: ['[data-e2e-locator="console-result"]', '[data-e2e-locator="submission-result"]'],
  /** Distinguishes a Submit result from a Run one, when it is on screen. */
  submissionVerdict: ['[data-e2e-locator="submission-result"]'],
  /**
   * The compiler/runtime error wash. Only consulted on verdicts that carry an
   * error message, so the `font-menlo` fallback cannot swallow an output block.
   */
  runError: [
    '[class*="rgba(246,54,54"]',
    '[class*="rgba(248,97,92"]',
    'div[class*="font-menlo"][class*="whitespace-pre-wrap"]',
  ],
  /** The Editorial tab in the description tabstrip. Presence only. */
  editorialTab: ['[id*="editorial"]', 'a[href*="/editorial"]', '[data-layout-path$="/tb1"]'],
} as const;

export type SelectorGroup = keyof typeof SELECTORS;

export function queryFirst(root: ParentNode, group: SelectorGroup): Element | null {
  for (const selector of SELECTORS[group]) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** The first selector in the chain that matches anything, and everything it matches. */
export function queryAll(root: ParentNode, group: SelectorGroup): Element[] {
  for (const selector of SELECTORS[group]) {
    const found = Array.from(root.querySelectorAll(selector));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * The block headings inside the result panel, verbatim from LeetCode's `console`
 * i18n bundle. The panel renders them as plain text in an unmarked `div`, so
 * matching the wording is the only way in - which makes this a drift surface,
 * and the reason it sits in this file rather than in the parser.
 */
export const RESULT_LABELS = {
  input: ['Input'],
  lastExecutedInput: ['Last Executed Input'],
  output: ['Output'],
  expected: ['Expected'],
  stdout: ['Stdout'],
} as const;

/** Verdict wording, also verbatim from the `console` bundle. */
export const RESULT_VERDICTS = [
  'Accepted',
  'Wrong Answer',
  'Time Limit Exceeded',
  'Memory Limit Exceeded',
  'Output Limit Exceeded',
  'Runtime Error',
  'Compile Error',
  'Internal Error',
  'Invalid Testcase',
  'Finished',
] as const;

/** Verdicts whose panel carries a compiler or runtime message. */
export const VERDICTS_WITH_ERROR_TEXT = new Set<string>([
  'Runtime Error',
  'Compile Error',
  'Internal Error',
]);

const PROBLEM_PATH = /^\/problems\/([^/?#]+)/;

/** Kept in step with the `content_scripts` match patterns in the manifest. */
export function isProblemUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /(^|\.)leetcode\.com$/.test(parsed.hostname) && PROBLEM_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function slugFromUrl(url: string): string | null {
  try {
    const match = PROBLEM_PATH.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
