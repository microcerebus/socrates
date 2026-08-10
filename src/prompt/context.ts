/**
 * Builds the user turn that carries the live context: problem, editor buffer and
 * session state.
 *
 * This deliberately does *not* live in the system prompt. The editor buffer
 * changes between every message, so it belongs on the freshest turn; keeping the
 * system prompt free of it also makes the prompt a pure function of
 * (rung, language) and therefore stable across a session.
 */

import type { AskIntent, PageSnapshot, Rung } from '../shared/types.ts';
import { TOTAL_HINTS, hintsUsedFor, rungSpec } from './rungs.ts';
import { intentInstruction } from './system-prompt.ts';

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
}

export function buildUserTurn({ snapshot, rung, intent, message, elapsedMs }: UserTurnInput): string {
  const { problem, editor } = snapshot;
  const sections: string[] = [];

  const heading = [
    `Title: ${problem.title}`,
    problem.difficulty ? `Difficulty: ${problem.difficulty}` : null,
    problem.url ? `URL: ${problem.url}` : null,
    `Context source: ${problem.source === 'leetcode' ? 'read from the LeetCode page' : 'pasted by the user'}`,
  ]
    .filter(Boolean)
    .join('\n');

  sections.push(`# PROBLEM\n${heading}\n\n## Statement\n${clamp(problem.statement.trim(), MAX_STATEMENT_CHARS)}`);

  if (problem.examples.length > 0) {
    sections.push(`## Examples\n${problem.examples.join('\n\n')}`);
  }
  if (problem.constraints.length > 0) {
    sections.push(`## Constraints\n${problem.constraints.map((c) => `- ${c}`).join('\n')}`);
  }

  if (editor.source === 'unavailable' || editor.code.trim() === '') {
    sections.push(
      `# CURRENT EDITOR CODE\n(empty - the user has not written anything yet, or the editor could not be read)`,
    );
  } else {
    sections.push(
      `# CURRENT EDITOR CODE (${editor.language}${editor.source === 'manual' ? ', pasted by the user' : ''})\n` +
        `\`\`\`${editor.language}\n${clamp(editor.code, MAX_CODE_CHARS)}\n\`\`\``,
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
