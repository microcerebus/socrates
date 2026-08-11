/**
 * Request/response calls to the native messaging host: is it reachable, and is
 * the `claude` CLI it runs installed and logged in.
 *
 * Streaming a reply is a separate path (`claude-code.ts`, over
 * `connectNative`) because one request can produce hundreds of frames, which
 * `sendNativeMessage` cannot do.
 */

import { appError } from '../shared/types.ts';
import type { HostRequest, HostResponse } from '../native-host/protocol.ts';
import { hostFailureToAppError, isHostResponse } from './host-errors.ts';

export const NATIVE_HOST_NAME = 'com.socrates.keychain';

const INSTALL_COMMAND = './bin/install-native-host.sh';

export type NativeSend = (name: string, message: HostRequest) => Promise<unknown>;

const defaultSend: NativeSend = (name, message) =>
  chrome.runtime.sendNativeMessage(name, message) as Promise<unknown>;

async function ask(
  send: NativeSend,
  request: HostRequest,
): Promise<Extract<HostResponse, { ok: true }>> {
  let raw: unknown;
  try {
    raw = await send(NATIVE_HOST_NAME, request);
  } catch (cause) {
    throw appError(
      'native-host-missing',
      `Socrates could not reach its native helper (${NATIVE_HOST_NAME}). (${String(cause)})`,
      [{ label: 'Run this from the repo root', command: INSTALL_COMMAND }],
    );
  }
  if (!isHostResponse(raw))
    throw appError('claude-cli-failed', 'The native helper returned something unexpected.');
  if (!raw.ok) throw hostFailureToAppError(raw);
  return raw;
}

export interface HostInfo {
  /** The resolved `claude` binary, or null when the host could not find one. */
  claudePath: string | null;
}

/**
 * What the host is configured with, for the settings sheet. Non-secret, and the
 * only reason the panel can name the CLI it will run without the extension
 * hardcoding a path.
 */
export async function getHostInfo(send: NativeSend = defaultSend): Promise<HostInfo> {
  const response = await ask(send, { kind: 'ping' });
  if (response.kind !== 'pong')
    throw appError('claude-cli-failed', 'The native helper did not identify itself.');
  return { claudePath: response.claudePath };
}

export interface ClaudeAccess {
  claudePath: string;
  account: string | null;
  subscription: string | null;
}

/** Is the CLI there, and logged in? */
export async function probeClaudeAccess(send: NativeSend = defaultSend): Promise<ClaudeAccess> {
  const response = await ask(send, { kind: 'claude-probe' });
  if (response.kind !== 'claude-ok') {
    throw appError('claude-cli-failed', 'The native helper did not report on the Claude Code CLI.');
  }
  return {
    claudePath: response.claudePath,
    account: response.account,
    subscription: response.subscription,
  };
}
