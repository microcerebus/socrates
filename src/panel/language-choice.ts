/**
 * Which language the panel is answering in, and who chose it.
 *
 * ## Why the override carries a slug
 *
 * The panel mirrors LeetCode's editor unless the user picks a language from the
 * dropdown. That pick is scoped to the problem they made it on: it says "for
 * *this* question, answer in Rust", not "answer in Rust from now on". A pick
 * carried onto a different problem answers against an editor that is not set to
 * it, which is the panel disagreeing with the page it is sitting next to.
 *
 * The override was a bare `string`, which made that correctness depend on every
 * path that adopts a problem remembering to clear it. Navigation remembered;
 * the paste form did not, so pasting a different problem while an override was
 * live answered the new problem in the old problem's language. Fixing that one
 * call site would have left the next one to be written just as exposed.
 *
 * So the override carries the slug it was chosen for, and `effectiveLanguage`
 * only honours it on that problem. Clearing it on adoption is now tidiness
 * rather than the thing that makes it correct - a stale override cannot apply
 * to a problem it was not chosen for, whichever path adopted it.
 *
 * It is deliberately session-scoped and never persisted: a language you picked
 * once should not follow you back weeks later.
 */

import type { PageSnapshot } from '../shared/types.ts';

export interface LanguageOverride {
  /** The problem this pick was made on. It applies to no other. */
  slug: string;
  /** A language id from `shared/languages.ts`. */
  language: string;
}

/** The override, if it belongs to the problem currently on screen. */
export function activeOverride(
  override: LanguageOverride | null,
  slug: string | null,
): string | null {
  if (override === null || slug === null) return null;
  return override.slug === slug ? override.language : null;
}

/**
 * What replies are written in: the user's pick for this problem, else whatever
 * LeetCode's editor is set to, else a default for when the page is unreadable.
 */
export function effectiveLanguage(
  override: LanguageOverride | null,
  problemSlug: string | null,
  pageLanguage: string | null,
  fallback: string,
): string {
  return activeOverride(override, problemSlug) ?? pageLanguage ?? fallback;
}

/**
 * Whether a snapshot is the problem already on screen.
 *
 * The one place that decides it, so the paste form and the navigation follower
 * cannot disagree about what counts as adopting a *different* problem - and so
 * a paste gets the same consequences a navigation does: the ladder back to rung
 * 0, the old transcript written under its own slug, the override dropped. A
 * re-paste of the same problem is a correction to the text, not a new sitting,
 * and keeps all three.
 */
export function isSameProblem(showing: PageSnapshot | null, next: PageSnapshot): boolean {
  return showing !== null && showing.problem.slug === next.problem.slug;
}
