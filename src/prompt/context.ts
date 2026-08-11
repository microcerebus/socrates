/**
 * Builds the user turn that carries the live context: problem, page metadata,
 * editor buffer, the last run result and session state.
 *
 * This deliberately does *not* live in the system prompt. The editor buffer and
 * the run result change between every message, so they belong on the freshest
 * turn; keeping the system prompt free of them also makes the prompt a pure
 * function of (rung, language) and therefore stable across a session.
 *
 * Everything here that came off the page goes inside a `PageDataFence` and
 * everything that is Socrates' own instruction stays outside one. That split is
 * the point of the file: see `untrusted.ts` for why a scraped statement sitting
 * unmarked next to `# TASK` is the whole rung ladder's problem.
 *
 * The rule holds for the gleaned context too, and there it does double duty. A
 * run result is the judge echoing the user's own program back at them, so its
 * fields contain whatever that program printed - which makes "the content looks
 * like a delimiter" the ordinary case rather than an attack, and a fence with a
 * fixed delimiter something that would be closed by accident long before anyone
 * closed it on purpose.
 *
 * ## Why the tags are fenced *and* labelled
 *
 * Topic tags need two different things said about them, and they are not the
 * same thing. The fence says the text is page data and cannot instruct. The
 * prose around it - outside the fence, because it is Socrates' own account -
 * says the user has not seen it and it may not be repeated below rung 2.
 * Neither substitutes for the other.
 */

import { languageLabel as languageName } from '../shared/languages.ts';
import type { AskIntent, PageSnapshot, RunResult, Rung } from '../shared/types.ts';
import { TOTAL_HINTS, hintsUsedFor, rungSpec } from './rungs.ts';
import { intentInstruction, languageLabel } from './system-prompt.ts';
import { pageDataFence, type PageDataFence } from './untrusted.ts';

const MAX_STATEMENT_CHARS = 8_000;
const MAX_CODE_CHARS = 12_000;
/** Judge output can be enormous on a big failing case; the shape is what matters. */
const MAX_RESULT_FIELD_CHARS = 1_500;

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated, ${text.length - max} more characters]`;
}

function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * The judge's answer, laid out so the interviewer can reason from the actual
 * failure rather than from a reading of the code.
 *
 * Every value is page data and every value is fenced, one block per field so the
 * model can tell the failing input from the produced output without trusting
 * anything inside either. What is *not* fenced is the line saying which of Run
 * and Submit produced this, because that is Socrates' own reading of the page
 * rather than something the page said.
 *
 * Fields absent from the panel are omitted rather than rendered empty, so "no
 * Expected block" reads as "the page did not show one" instead of "it was blank".
 */
function runSection(run: RunResult, fence: PageDataFence): string {
  const blocks: string[] = [
    `Source: ${run.kind === 'submission' ? 'Submit (full test set)' : 'Run (the testcases in the console)'}`,
    `## Verdict\n${fence.block('run-verdict', run.verdictText)}`,
  ];

  const block = (heading: string, field: string, value: string | null): void => {
    if (value !== null && value.trim() !== '') {
      blocks.push(
        `## ${heading}\n${fence.block(field, clamp(value.trim(), MAX_RESULT_FIELD_CHARS))}`,
      );
    }
  };
  block('Testcases', 'run-testcases', run.testcases);
  block('Failing input', 'run-input', run.input);
  block('Their output', 'run-output', run.output);
  block('Expected output', 'run-expected', run.expected);
  block('Printed to stdout', 'run-stdout', run.stdout);
  block('Error message', 'run-error', run.errorMessage);

  return `# LAST RUN RESULT (from the LeetCode console, visible to the user)\n${blocks.join('\n\n')}`;
}

export interface UserTurnInput {
  snapshot: PageSnapshot;
  rung: Rung;
  intent: AskIntent;
  /** Free-form text from the chat box. May be empty for a pure ladder unlock. */
  message: string;
  elapsedMs: number;
  /** The effective language: LeetCode's editor, or the panel's override. */
  language: string;
  /** Injected only by tests, which need the markers to be predictable. */
  fence?: PageDataFence;
}

export function buildUserTurn({
  snapshot,
  rung,
  intent,
  message,
  elapsedMs,
  language,
  fence = pageDataFence(),
}: UserTurnInput): string {
  const { problem, editor, run } = snapshot;
  const sections: string[] = [fence.preamble];

  // `source` is Socrates' own account of where the text came from, so it stays
  // outside the fence: it is the one line here the page must not be able to write.
  const heading = [
    `Title: ${problem.title}`,
    problem.number ? `Problem number: ${problem.number}` : null,
    problem.difficulty ? `Difficulty: ${problem.difficulty}` : null,
    problem.url ? `URL: ${problem.url}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  sections.push(
    `# PROBLEM\n` +
      `Context source: ${problem.source === 'leetcode' ? 'read from the LeetCode page' : 'pasted by the user'}\n` +
      `${fence.block('heading', heading)}\n\n` +
      `## Statement\n${fence.block('statement', clamp(problem.statement.trim(), MAX_STATEMENT_CHARS))}`,
  );

  if (problem.examples.length > 0) {
    sections.push(`## Examples\n${fence.block('examples', problem.examples.join('\n\n'))}`);
  }
  if (problem.constraints.length > 0) {
    sections.push(
      `## Constraints\n${fence.block('constraints', problem.constraints.map((c) => `- ${c}`).join('\n'))}`,
    );
  }

  if (problem.topicTags.length > 0 || problem.hasEditorial || problem.hasHints) {
    // The booleans are Socrates' own findings rather than page strings, so they
    // stay outside; the tag names came off the page, so they do not.
    const presence = [
      problem.hasEditorial ? 'An editorial exists for this problem.' : null,
      problem.hasHints ? 'LeetCode ships its own hints for this problem.' : null,
    ].filter(Boolean);

    const tags =
      problem.topicTags.length > 0
        ? `\n\n## LeetCode topic tags\n${fence.block('topic-tags', problem.topicTags.join(', '))}`
        : '';

    sections.push(
      `# PAGE METADATA - NOT SHOWN TO THE USER\n` +
        `The user has not seen any of this: the tags sit behind a collapsed toggle and Socrates never displays them. ` +
        `Below rung 2, do not name a tag or paraphrase one so closely that they could recover it. ` +
        `Do not mention the editorial or the hints unless the user raises them first.` +
        tags +
        (presence.length > 0 ? `\n\n${presence.join('\n')}` : ''),
    );
  }

  if (editor.source === 'unavailable' || editor.code.trim() === '') {
    sections.push(
      `# CURRENT EDITOR CODE\n(empty - the user has not written anything yet, or the editor could not be read)`,
    );
  } else {
    // The buffer is fenced by the page-data markers rather than by backticks:
    // it is code, code contains backticks, and a ``` in the buffer would close a
    // Markdown fence and put the rest of the file back in prompt position.
    sections.push(
      `# CURRENT EDITOR CODE${editor.source === 'manual' ? ' (pasted by the user)' : ''}\n` +
        `${fence.block('editor-language', language)}\n` +
        `${fence.block('editor-code', clamp(editor.code, MAX_CODE_CHARS))}`,
    );
  }

  if (run) sections.push(runSection(run, fence));

  sections.push(
    `# SESSION\nUnlocked rung: ${rung} - ${rungSpec(rung).name}\n` +
      `Hints used: ${hintsUsedFor(rung)} of ${TOTAL_HINTS}\n` +
      // Named outside the fence, so it goes through the allowlist and then the
      // same reducer the system prompt uses. See `languageLabel`.
      `Writing in: ${languageLabel(languageName(language))}\n` +
      `Time on this problem: ${formatElapsed(elapsedMs)}`,
  );

  sections.push(`# TASK\n${intentInstruction(intent, rung)}`);

  if (message.trim() !== '') {
    sections.push(`# WHAT THE USER SAID\n${message.trim()}`);
  }

  return sections.join('\n\n');
}
