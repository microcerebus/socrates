/**
 * The extension half of the Claude Code provider: a streaming conversation with
 * the native host over `chrome.runtime.connectNative`.
 *
 * The key fetch is one message in, one message out, so it rides
 * `sendNativeMessage` and always will. A model reply cannot: it arrives as
 * hundreds of small frames over tens of seconds, and `sendNativeMessage` gives
 * you exactly one. So this opens a port instead.
 *
 * One port per turn, deliberately. A port that outlives a request has to grow
 * routing, reconnection and staleness rules to be trustworthy; a port that dies
 * with its request has none of that, and disconnecting is itself the hardest
 * cancellation available - Chrome kills the host process, which kills the CLI
 * with it. The explicit `claude-cancel` still goes first so the host can stop
 * the child cleanly rather than being shot out from under it.
 */

import { NATIVE_HOST_NAME } from './keychain.ts';
import { hostFailureToAppError, isHostResponse } from './host-errors.ts';
import type { HostRequest } from '../native-host/protocol.ts';
import { appError, type ModelId } from '../shared/types.ts';

/** The slice of `chrome.runtime.Port` this needs, so tests can hand over a fake. */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export type NativeConnect = (name: string) => NativePort;

const defaultConnect: NativeConnect = (name) => chrome.runtime.connectNative(name) as NativePort;

function newRequestId(): string {
  return crypto.randomUUID();
}

export interface ClaudeCodeStreamOptions {
  model: ModelId;
  system: string;
  /** The whole transcript, already flattened into one turn. */
  prompt: string;
  onText(text: string): void;
  onThinking?(): void;
  signal?: AbortSignal;
  /** Injected in tests. */
  connect?: NativeConnect;
  /** Injected in tests. */
  requestId?: string;
}

export async function streamClaudeCode(options: ClaudeCodeStreamOptions): Promise<void> {
  const connect = options.connect ?? defaultConnect;
  const requestId = options.requestId ?? newRequestId();

  let port: NativePort;
  try {
    port = connect(NATIVE_HOST_NAME);
  } catch (cause) {
    throw nativeHostMissing(cause);
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let sawThinking = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      outcome();
    };

    function onAbort(): void {
      // Ask the host to kill the child before the port goes, so the CLI stops
      // even in the window before Chrome reaps the host process.
      try {
        port.postMessage({ kind: 'claude-cancel', requestId } satisfies HostRequest);
      } catch {
        /* the port is already gone, which kills the child anyway */
      }
      finish(() => reject(appError('aborted', 'Cancelled.')));
    }

    if (options.signal?.aborted) {
      finish(() => reject(appError('aborted', 'Cancelled.')));
      return;
    }
    options.signal?.addEventListener('abort', onAbort);

    port.onMessage.addListener((message: unknown) => {
      if (settled) return;
      if (!isHostResponse(message)) {
        finish(() => reject(appError('claude-cli-failed', 'The native helper returned something unexpected.')));
        return;
      }
      if (!message.ok) {
        finish(() => reject(hostFailureToAppError(message)));
        return;
      }
      switch (message.kind) {
        case 'claude-delta':
          if (message.requestId === requestId) options.onText(message.text);
          break;
        case 'claude-thinking':
          if (message.requestId === requestId && !sawThinking) {
            sawThinking = true;
            options.onThinking?.();
          }
          break;
        case 'claude-done':
          if (message.requestId === requestId) finish(resolve);
          break;
        default:
          // A frame from the request/response half of the protocol; not ours.
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message ?? '';
      finish(() =>
        reject(
          detail === ''
            ? appError('claude-cli-failed', 'The native helper stopped before the reply finished.')
            : nativeHostMissing(detail),
        ),
      );
    });

    port.postMessage({
      kind: 'claude-start',
      requestId,
      model: options.model,
      system: options.system,
      prompt: options.prompt,
    } satisfies HostRequest);
  });
}

function nativeHostMissing(cause: unknown): ReturnType<typeof appError> {
  return appError(
    'native-host-missing',
    `Socrates could not reach its native helper (${NATIVE_HOST_NAME}). On the Claude Code provider that helper ` +
      `is what runs the claude CLI, so nothing works without it. Install it once, then reload the extension. ` +
      `(${String(cause)})`,
    [{ label: 'Run this from the repo root', command: './bin/install-native-host.sh' }],
  );
}
