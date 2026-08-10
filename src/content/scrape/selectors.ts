/**
 * Every LeetCode DOM selector in the extension lives here.
 *
 * LeetCode ships class-name churn regularly, so each target is a fallback chain,
 * newest-first. When the page drifts, this is the only file that should need to
 * change - and if none of the chains hit, the panel falls back to manual paste
 * rather than guessing.
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
} as const;

export type SelectorGroup = keyof typeof SELECTORS;

export function queryFirst(root: ParentNode, group: SelectorGroup): Element | null {
  for (const selector of SELECTORS[group]) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

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
