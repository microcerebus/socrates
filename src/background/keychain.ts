/**
 * Fetches the Anthropic API key from the user's Dashlane vault through a native
 * messaging host, and caches it **in service-worker memory only**.
 *
 * Hard rule: the key is never written to `chrome.storage`, `localStorage`,
 * IndexedDB, or any file this extension controls. When the service worker is
 * evicted the cache dies with it and the next request re-reads the vault.
 */

import { appError, type AppError } from '../shared/types.ts';
import type { HostFailureCode, HostRequest, HostResponse } from '../native-host/protocol.ts';

export const NATIVE_HOST_NAME = 'com.socrates.keychain';

const INSTALL_COMMAND = './bin/install-native-host.sh <extension-id>';

let cachedKey: string | null = null;
let inflight: Promise<string> | null = null;

/** Exposed for the settings screen and for tests. */
export function clearCachedKey(): void {
  cachedKey = null;
}

export function hasCachedKey(): boolean {
  return cachedKey !== null;
}

function remedyFor(code: HostFailureCode, command: string | undefined): AppError['remedies'] {
  if (!command) return [];
  const label =
    code === 'vault-locked' || code === 'vault-logged-out'
      ? 'Run this in a terminal, then reopen the panel'
      : code === 'dcli-missing'
        ? 'Install the Dashlane CLI'
        : 'Run this to check';
  return [{ label, command }];
}

function hostFailureToAppError(response: Extract<HostResponse, { ok: false }>): AppError {
  const code =
    response.code === 'dcli-missing'
      ? 'dcli-missing'
      : response.code === 'vault-locked' || response.code === 'vault-logged-out'
        ? 'vault-locked'
        : response.code === 'vault-item-missing'
          ? 'vault-item-missing'
          : 'key-fetch-failed';
  return appError(code, response.message, remedyFor(response.code, response.command));
}

export type NativeSend = (name: string, message: HostRequest) => Promise<unknown>;

const defaultSend: NativeSend = (name, message) =>
  chrome.runtime.sendNativeMessage(name, message) as Promise<unknown>;

function isHostResponse(value: unknown): value is HostResponse {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

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
