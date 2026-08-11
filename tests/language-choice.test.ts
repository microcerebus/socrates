/**
 * A language pick belongs to the problem it was made on.
 *
 * The bug this pins: the override was a bare string, so staying correct meant
 * every path that adopts a problem had to remember to clear it. Navigation
 * remembered. The paste form did not - it installed the new snapshot and set the
 * active slug but skipped the resets - so pasting a *different* problem while an
 * override was live answered the new problem in the old problem's language,
 * silently, with the picker still showing the old pick.
 *
 * Clearing it in one more place would have left the next path to be written just
 * as exposed. Carrying the slug on the override makes a stale one inapplicable
 * by construction, which is what these tests assert: not "the paste handler
 * calls the reset" but "an override cannot apply to a problem it was not chosen
 * for", whichever path got there.
 */

import { describe, expect, it } from 'vitest';

import {
  activeOverride,
  effectiveLanguage,
  isSameProblem,
  type LanguageOverride,
} from '../src/panel/language-choice.ts';
import type { PageSnapshot } from '../src/shared/types.ts';
import { SNAPSHOT } from './helpers.ts';

const DEFAULT = 'javascript';

/** A problem as the panel holds it: a slug and whatever the editor is set to. */
function problem(
  slug: string,
  language: string,
  source: 'leetcode' | 'manual' = 'leetcode',
): PageSnapshot {
  return {
    ...SNAPSHOT,
    problem: { ...SNAPSHOT.problem, slug, source },
    editor: { ...SNAPSHOT.editor, language, source: source === 'manual' ? 'manual' : 'leetcode' },
  };
}

/** What a turn on this snapshot would be written in. See `ask` in `App.tsx`. */
function languageForTurn(override: LanguageOverride | null, snapshot: PageSnapshot): string {
  return effectiveLanguage(override, snapshot.problem.slug, snapshot.editor.language, DEFAULT);
}

describe('mirroring the page', () => {
  it('follows the editor when nothing is overridden', () => {
    expect(languageForTurn(null, problem('two-sum', 'cpp'))).toBe('cpp');
  });

  it('falls back only when there is no page language at all', () => {
    expect(effectiveLanguage(null, 'two-sum', null, DEFAULT)).toBe(DEFAULT);
  });

  it('honours a pick made on the problem on screen', () => {
    const override = { slug: 'two-sum', language: 'rust' };
    expect(languageForTurn(override, problem('two-sum', 'cpp'))).toBe('rust');
    expect(activeOverride(override, 'two-sum')).toBe('rust');
  });
});

describe('an override left behind on another problem', () => {
  const override: LanguageOverride = { slug: 'two-sum', language: 'rust' };

  /**
   * The reported blocker, as the user hits it: override, then paste a different
   * problem, then ask.
   */
  it('does not reach a different problem that was pasted', () => {
    const pasted = problem('lru-cache', 'python3', 'manual');
    expect(languageForTurn(override, pasted)).toBe('python3');
    expect(activeOverride(override, 'lru-cache')).toBeNull();
  });

  it('does not reach a different problem that was navigated to', () => {
    expect(languageForTurn(override, problem('lru-cache', 'python3'))).toBe('python3');
  });

  it('still does not reach it when that problem has no readable editor', () => {
    // The dangerous shape: no page language to lose to, so a stale override
    // would win by default rather than by being chosen.
    expect(effectiveLanguage(override, 'lru-cache', null, DEFAULT)).toBe(DEFAULT);
  });

  it('applies again if the user comes back to the problem it was chosen for', () => {
    expect(languageForTurn(override, problem('two-sum', 'cpp'))).toBe('rust');
  });

  it('is inert once cleared', () => {
    expect(languageForTurn(null, problem('two-sum', 'cpp'))).toBe('cpp');
  });
});

/**
 * Which pastes count as adopting a new problem.
 *
 * The paste form and the navigation follower ask the same question of the same
 * function, so they cannot disagree about it - and a paste therefore carries the
 * same consequences a navigation does.
 */
describe('adopting versus refreshing', () => {
  it('treats a paste of a different problem as an adoption', () => {
    expect(
      isSameProblem(problem('two-sum', 'cpp'), problem('lru-cache', 'python3', 'manual')),
    ).toBe(false);
  });

  it('treats a re-paste of the problem on screen as a refresh', () => {
    // A correction to the text, not a new sitting: the rung, the transcript and
    // the override all survive it.
    const showing = problem('two-sum', 'cpp');
    const repasted = problem('two-sum', 'cpp', 'manual');
    expect(isSameProblem(showing, repasted)).toBe(true);
    expect(languageForTurn({ slug: 'two-sum', language: 'rust' }, repasted)).toBe('rust');
  });

  it('treats the first paste of all as an adoption', () => {
    expect(isSameProblem(null, problem('two-sum', 'cpp', 'manual'))).toBe(false);
  });
});
