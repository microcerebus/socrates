/**
 * The extension's service worker: the only place with the API key, and the only
 * place that talks to Anthropic.
 *
 * It owns three jobs - capture page context, run a guarded model turn, and read
 * or write the session log. The panel drives all three over one port.
 */

import {
  PORT_NAME,
  type AskRequest,
  type ContentRequest,
  type ContentResponse,
  type PanelRequest,
  type WorkerFrameBody,
} from '../shared/protocol.ts';
import { appError, type AppError, type PageSnapshot } from '../shared/types.ts';
import { runInterviewTurn } from './interview.ts';
import { getApiKey } from './keychain.ts';
import { getAttempts, getSettings, recordAttempt, setSettings } from './session-store.ts';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && 'code' in value && 'remedies' in value;
}

function toAppError(value: unknown): AppError {
  return isAppError(value) ? value : appError('api-error', String(value));
}

async function askTab(tabId: number): Promise<ContentResponse> {
  const request: ContentRequest = { kind: 'scrape' };
  return (await chrome.tabs.sendMessage(tabId, request)) as ContentResponse;
}

/**
 * Tabs opened before the extension was installed or reloaded have no content
 * script. Inject both worlds once, then retry.
 */
async function injectAndRetry(tabId: number): Promise<ContentResponse> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page-bridge.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'], world: 'ISOLATED' });
  return askTab(tabId);
}

async function capture(tabId: number): Promise<{ snapshot: PageSnapshot | null; failure?: string }> {
  let response: ContentResponse;
  try {
    response = await askTab(tabId);
  } catch {
    try {
      response = await injectAndRetry(tabId);
    } catch (cause) {
      return { snapshot: null, failure: `no-content-script: ${String(cause)}` };
    }
  }
  if (!response.ok) {
    return { snapshot: null, failure: response.detail ? `${response.reason}: ${response.detail}` : response.reason };
  }
  return {
    snapshot: { problem: response.problem, editor: response.editor, capturedAt: Date.now() },
  };
}

async function runAsk(
  request: AskRequest,
  emit: (frame: WorkerFrameBody) => void,
  signal: AbortSignal,
): Promise<void> {
  const [apiKey, settings] = await Promise.all([getApiKey(), getSettings()]);
  await runInterviewTurn({
    apiKey,
    model: settings.model,
    request,
    signal,
    onThinking: () => emit({ kind: 'thinking' }),
    onText: (text) => emit({ kind: 'delta', text }),
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const inFlight = new Map<number, AbortController>();

  port.onDisconnect.addListener(() => {
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
  });

  port.onMessage.addListener((message: PanelRequest) => {
    const send = (frame: WorkerFrameBody): void => {
      try {
        port.postMessage({ ...frame, id: message.id });
      } catch {
        /* the panel closed mid-stream */
      }
    };
    const fail = (error: unknown): void => send({ kind: 'error', error: toAppError(error) });

    switch (message.kind) {
      case 'capture':
        void capture(message.tabId)
          .then(({ snapshot, failure }) =>
            send(failure === undefined ? { kind: 'capture-result', snapshot } : { kind: 'capture-result', snapshot, failure }),
          )
          .catch(fail);
        break;

      case 'ask': {
        const controller = new AbortController();
        inFlight.set(message.id, controller);
        void runAsk(message.request, send, controller.signal)
          .then(() => send({ kind: 'done' }))
          .catch(fail)
          .finally(() => inFlight.delete(message.id));
        break;
      }

      case 'cancel':
        inFlight.get(message.targetId)?.abort();
        send({ kind: 'ack' });
        break;

      case 'get-settings':
        void getSettings()
          .then((settings) => send({ kind: 'settings', settings }))
          .catch(fail);
        break;

      case 'set-settings':
        void setSettings(message.settings)
          .then((settings) => send({ kind: 'settings', settings }))
          .catch(fail);
        break;

      case 'get-attempts':
        void getAttempts(message.slug)
          .then((attempts) => send({ kind: 'attempts', attempts }))
          .catch(fail);
        break;

      case 'record-attempt':
        void recordAttempt(message.attempt)
          .then((attempts) => send({ kind: 'attempts', attempts }))
          .catch(fail);
        break;

      case 'probe-key':
        void getApiKey()
          .then(() => send({ kind: 'key-ok' }))
          .catch(fail);
        break;
    }
  });
});
