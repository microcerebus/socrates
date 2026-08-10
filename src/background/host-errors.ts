/**
 * Turns a native-host failure into the `AppError` the panel renders.
 *
 * The host already wrote the message and picked the command to run - it is the
 * side that actually knows what went wrong. This only maps its code onto the
 * panel's vocabulary and gives the command a label, so neither the keychain path
 * nor the Claude Code path has to reinvent it.
 */

import type { HostFailureCode, HostResponse } from '../native-host/protocol.ts';
import { appError, type AppError, type ErrorCode } from '../shared/types.ts';

const CODE_MAP: Record<HostFailureCode, ErrorCode> = {
  'dcli-missing': 'dcli-missing',
  'vault-locked': 'vault-locked',
  'vault-logged-out': 'vault-locked',
  'vault-item-missing': 'vault-item-missing',
  'key-fetch-failed': 'key-fetch-failed',
  'claude-cli-missing': 'claude-cli-missing',
  'claude-logged-out': 'claude-logged-out',
  'claude-usage-limit': 'claude-usage-limit',
  'claude-cli-failed': 'claude-cli-failed',
  'bad-request': 'key-fetch-failed',
};

const REMEDY_LABELS: Partial<Record<HostFailureCode, string>> = {
  'vault-locked': 'Run this in a terminal, then reopen the panel',
  'vault-logged-out': 'Run this in a terminal, then reopen the panel',
  'dcli-missing': 'Install the Dashlane CLI',
  'claude-logged-out': 'Run this in a terminal, then send the message again',
  'claude-cli-missing': 'Run this from the repo root, then reload the extension',
  'claude-usage-limit': 'Check where your usage window stands',
};

export function hostFailureToAppError(response: Extract<HostResponse, { ok: false }>): AppError {
  const remedies = response.command
    ? [{ label: REMEDY_LABELS[response.code] ?? 'Run this to check', command: response.command }]
    : [];
  return appError(CODE_MAP[response.code], response.message, remedies);
}

export function isHostResponse(value: unknown): value is HostResponse {
  return typeof value === 'object' && value !== null && 'ok' in value;
}
