/**
 * Builds the user turn that carries the live context: problem, editor buffer and
 * session state.
 *
 * This deliberately does *not* live in the system prompt. The editor buffer
 * changes between every message, so it belongs on the freshest turn; keeping the
 * system prompt free of it also makes the prompt a pure function of
 * (rung, language) and therefore stable across a session.
 *
 * Everything here that came off the page goes inside a `PageDataFence` and
 * everything that is Socrates' own instruction stays outside one. That split is
 * the point of the file: see `untrusted.ts` for why a scraped statement sitting
 * unmarked next to `# TASK` is the whole rung ladder's problem.
 */

import type { AskIntent, PageSnapshot, Rung } from '../shared/types.ts';
import { TOTAL_HINTS, hintsUsedFor, rungSpec } from './rungs.ts';
import { intentInstruction } from './system-prompt.ts';
import { pageDataFence, type PageDataFence } from './untrusted.ts';

const MAX_STATEMENT_CHARS = 8_000;
const MAX_CODE_CHARS = 12_000;

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

export interface UserTurnInput {
  snapshot: PageSnapshot;
  rung: Rung;
  intent: AskIntent;
  /** Free-form text from the chat box. May be empty for a pure ladder unlock. */
  message: string;
  elapsedMs: number;
  /** Injected only by tests, which need the markers to be predictable. */
  fence?: PageDataFence;
}

export function buildUserTurn({
  snapshot,
  rung,
  intent,
  message,
  elapsedMs,
  fence = pageDataFence(),
}: UserTurnInput): string {
  const { problem, editor } = snapshot;
  const sections: string[] = [fence.preamble];

  // `source` is Socrates' own account of where the text came from, so it stays
  // outside the fence: it is the one line here the page must not be able to write.
  const heading = [
    `Title: ${problem.title}`,
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
        `${fence.block('editor-language', editor.language)}\n` +
        `${fence.block('editor-code', clamp(editor.code, MAX_CODE_CHARS))}`,
    );
  }

  sections.push(
    `# SESSION\nUnlocked rung: ${rung} - ${rungSpec(rung).name}\n` +
      `Hints used: ${hintsUsedFor(rung)} of ${TOTAL_HINTS}\n` +
      `Time on this problem: ${formatElapsed(elapsedMs)}`,
  );

  sections.push(`# TASK\n${intentInstruction(intent, rung)}`);

  if (message.trim() !== '') {
    sections.push(`# WHAT THE USER SAID\n${message.trim()}`);
  }

  return sections.join('\n\n');
}
