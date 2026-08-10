/**
 * Isolated-world content script on LeetCode problem pages.
 *
 * Answers a single question from the service worker - "what is on this page?" -
 * by parsing the description out of the DOM and asking the MAIN-world bridge for
 * the Monaco buffer. It never writes to the page.
 */

import {
  PAGE_BRIDGE_REQUEST,
  PAGE_BRIDGE_RESPONSE,
  type ContentRequest,
  type ContentResponse,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '../shared/protocol.ts';
import type { EditorContext } from '../shared/types.ts';
import { parseProblem } from './scrape/parse.ts';
import { isProblemUrl } from './scrape/selectors.ts';

const BRIDGE_TIMEOUT_MS = 1_500;

function readEditor(): Promise<EditorContext> {
  return new Promise((resolve) => {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const unavailable: EditorContext = { language: 'plaintext', code: '', source: 'unavailable' };

    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(unavailable);
    }, BRIDGE_TIMEOUT_MS);

    function onMessage(event: MessageEvent<unknown>): void {
      if (event.source !== window) return;
      const data = event.data as Partial<PageBridgeResponse> | null;
      if (!data || data.type !== PAGE_BRIDGE_RESPONSE || data.nonce !== nonce) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(
        data.ok && typeof data.code === 'string'
          ? { language: data.language ?? 'plaintext', code: data.code, source: 'leetcode' }
          : unavailable,
      );
    }

    window.addEventListener('message', onMessage);
    const request: PageBridgeRequest = { type: PAGE_BRIDGE_REQUEST, nonce };
    window.postMessage(request, window.location.origin);
  });
}

async function scrape(): Promise<ContentResponse> {
  if (!isProblemUrl(window.location.href)) {
    return { ok: false, reason: 'not-a-problem-page' };
  }
  const parsed = parseProblem(document, window.location.href);
  if (!parsed.ok) {
    return parsed.detail === undefined
      ? { ok: false, reason: parsed.reason }
      : { ok: false, reason: parsed.reason, detail: parsed.detail };
  }
  return { ok: true, problem: parsed.problem, editor: await readEditor() };
}

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
    if (message?.kind !== 'scrape') return undefined;
    void scrape().then(sendResponse);
    return true;
  },
);
