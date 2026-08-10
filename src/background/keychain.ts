/**
 * Fetches the Anthropic API key from the user's Dashlane vault through a native
 * messaging host, and caches it **in service-worker memory only**.
 *
 * Hard rule: the key is never written to `chrome.storage`, `localStorage`,
 * IndexedDB, or any file this extension controls. When the service worker is
 * evicted the cache dies with it and the next request re-reads the vault.
 */

import { appError } from '../shared/types.ts';
import type { HostRequest, HostResponse } from '../native-host/protocol.ts';
import { hostFailureToAppError, isHostResponse } from './host-errors.ts';

export const NATIVE_HOST_NAME = 'com.socrates.keychain';

const INSTALL_COMMAND = './bin/install-native-host.sh';

let cachedKey: string | null = null;
let inflight: Promise<string> | null = null;

/** Exposed for the settings screen and for tests. */
export function clearCachedKey(): void {
  cachedKey = null;
}

export function hasCachedKey(): boolean {
  return cachedKey !== null;
}

export type NativeSend = (name: string, message: HostRequest) => Promise<unknown>;

const defaultSend: NativeSend = (name, message) =>
  chrome.runtime.sendNativeMessage(name, message) as Promise<unknown>;

async function fetchFromVault(send: NativeSend): Promise<string> {
  let raw: unknown;
  try {
    raw = await send(NATIVE_HOST_NAME, { kind: 'get-api-key' });
  } catch (cause) {
    throw appError(
      'native-host-missing',
      `Socrates could not reach its native helper (${NATIVE_HOST_NAME}). That helper is what reads your ` +
        `Anthropic key out of Dashlane. Install it once, then reload the extension. (${String(cause)})`,
      [{ label: 'Run from the repo root', command: INSTALL_COMMAND }],
    );
  }

  if (!isHostResponse(raw)) {
    throw appError('key-fetch-failed', 'The native helper returned something unexpected.');
  }
  if (!raw.ok) {
    throw hostFailureToAppError(raw);
  }
  if (raw.kind !== 'api-key') {
    throw appError('key-fetch-failed', 'The native helper did not return a key.');
  }
  return raw.apiKey;
}

async function ask(send: NativeSend, request: HostRequest): Promise<Extract<HostResponse, { ok: true }>> {
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
  if (!isHostResponse(raw)) throw appError('key-fetch-failed', 'The native helper returned something unexpected.');
  if (!raw.ok) throw hostFailureToAppError(raw);
  return raw;
}

export interface HostInfo {
  /** Which Dashlane item the host reads for the API-key provider. */
  itemTitle: string;
  /** The resolved `claude` binary, or null when the host could not find one. */
  claudePath: string | null;
}

/**
 * What the host is configured with, for the settings sheet. Non-secret, and the
 * only reason the panel can talk about "the item in Settings" or name the CLI it
 * will run without the extension hardcoding either.
 */
export async function getHostInfo(send: NativeSend = defaultSend): Promise<HostInfo> {
  const response = await ask(send, { kind: 'ping' });
  if (response.kind !== 'pong') throw appError('key-fetch-failed', 'The native helper did not identify itself.');
  return { itemTitle: response.itemTitle, claudePath: response.claudePath };
}

export interface ClaudeAccess {
  claudePath: string;
  account: string | null;
  subscription: string | null;
}

/** The Claude Code analogue of "Test vault access": is the CLI there, and logged in? */
export async function probeClaudeAccess(send: NativeSend = defaultSend): Promise<ClaudeAccess> {
  const response = await ask(send, { kind: 'claude-probe' });
  if (response.kind !== 'claude-ok') {
    throw appError('claude-cli-failed', 'The native helper did not report on the Claude Code CLI.');
  }
  return { claudePath: response.claudePath, account: response.account, subscription: response.subscription };
}

/**
 * Returns the API key, reading the vault at most once per worker lifetime.
 * Concurrent callers share one in-flight vault read.
 */
export function getApiKey(send: NativeSend = defaultSend): Promise<string> {
  if (cachedKey !== null) return Promise.resolve(cachedKey);
  if (inflight) return inflight;

  inflight = fetchFromVault(send)
    .then((key) => {
      cachedKey = key;
      return key;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
