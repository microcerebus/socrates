/**
 * Turns a native-host failure into the `AppError` the panel renders.
 *
 * ## The host describes, the panel decides
 *
 * The host is the side that knows what went wrong, so its `message` is quoted as
 * written. Everything the panel *acts* on is derived here from the failure code
 * instead - in particular the remedy command.
 *
 * That matters because `ErrorNotice` renders a remedy in a `<code>` element with
 * a copy-to-clipboard button next to it, in a panel the user trusts. A shell
 * command arriving over the wire and being offered for the user to paste into a
 * terminal is not a thing this extension should be able to do at all, whatever
 * is at the other end of the port today. So `REMEDIES` below is the complete set
 * of commands Socrates will ever show, keyed by a code that has already been
 * checked against the union - a host-supplied `command` string is ignored.
 *
 * `isHostResponse` is the same argument one step earlier: a frame is only a
 * `HostResponse` if it is one of the shapes the union names, not if it merely
 * has an `ok` property.
 */

import { CLAUDE_LOGIN_COMMAND, CLAUDE_STATUS_COMMAND } from '../native-host/claude.ts';
import type { HostFailureCode, HostResponse } from '../native-host/protocol.ts';
import { appError, type AppError, type ErrorCode } from '../shared/types.ts';

const CODE_MAP: Record<HostFailureCode, ErrorCode> = {
  'claude-cli-missing': 'claude-cli-missing',
  'claude-logged-out': 'claude-logged-out',
  'claude-usage-limit': 'claude-usage-limit',
  'claude-cli-failed': 'claude-cli-failed',
  'bad-request': 'claude-cli-failed',
};

export const INSTALL_COMMAND = './bin/install-native-host.sh';

/** Every command the panel may ever offer to copy, and the label it wears. */
const REMEDIES: Partial<Record<HostFailureCode, { label: string; command: string }>> = {
  'claude-logged-out': {
    label: 'Run this in a terminal, then send the message again',
    command: CLAUDE_LOGIN_COMMAND,
  },
  'claude-cli-missing': {
    label: 'Run this from the repo root, then reload the extension',
    command: INSTALL_COMMAND,
  },
  'claude-usage-limit': {
    label: 'Check where your usage window stands',
    command: CLAUDE_STATUS_COMMAND,
  },
  'claude-cli-failed': { label: 'Run this to check', command: CLAUDE_STATUS_COMMAND },
};

/** The frame kinds the panel side of the port knows how to read. */
const OK_KINDS = new Set([
  'pong',
  'claude-ok',
  'claude-started',
  'claude-thinking',
  'claude-delta',
  'claude-done',
]);

const FAILURE_CODES = new Set<string>(Object.keys(CODE_MAP));

export function isHostFailureCode(value: unknown): value is HostFailureCode {
  return typeof value === 'string' && FAILURE_CODES.has(value);
}

export function hostFailureToAppError(response: Extract<HostResponse, { ok: false }>): AppError {
  const remedy = REMEDIES[response.code];
  return appError(CODE_MAP[response.code], response.message, remedy ? [remedy] : []);
}

export function isHostResponse(value: unknown): value is HostResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['ok'] === true)
    return typeof record['kind'] === 'string' && OK_KINDS.has(record['kind']);
  if (record['ok'] === false)
    return isHostFailureCode(record['code']) && typeof record['message'] === 'string';
  return false;
}
