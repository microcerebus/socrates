/**
 * Isolated-world content script on LeetCode problem pages.
 *
 * Answers a single question from the service worker - "what is on this page?" -
 * by parsing the description, the topic metadata and any run result out of the
 * DOM, and asking the MAIN-world bridge for the Monaco buffer. It never writes
 * to the page.
 */

import {
  PAGE_BRIDGE_REQUEST,
  PAGE_BRIDGE_RESPONSE,
  type ContentRequest,
  type ContentResponse,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '../shared/protocol.ts';
import { normaliseLanguageId } from '../shared/languages.ts';
import type { EditorContext } from '../shared/types.ts';
import { parseEditorLanguage, parseProblem, parseRunResult } from './scrape/parse.ts';
import { isProblemUrl } from './scrape/selectors.ts';

const BRIDGE_TIMEOUT_MS = 1_500;

/**
 * Reads the buffer, and settles the language question.
 *
 * The toolbar label wins over Monaco's language id. They agree on today's
 * LeetCode - it registers its Monaco languages under its own slugs - but only
 * one of the two survives the bridge timing out, and it is the one in this
 * world. Monaco is still consulted, because a toolbar that has drifted out of
 * the selector chain leaves it as the only answer.
 */
function readEditor(scrapedLanguage: string | null): Promise<EditorContext> {
  return new Promise((resolve) => {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const fallback = scrapedLanguage ?? 'plaintext';
    const unavailable: EditorContext = { language: fallback, code: '', source: 'unavailable' };

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

      /*
       * This listener is the trust boundary, and past this line the safety net
       * is gone: the timeout is cancelled and the listener is unsubscribed, so
       * anything that throws here leaves the promise unsettled forever. That is
       * not a crash, it is a hang - `scrape()` never returns, `sendResponse` is
       * never called, and the panel's capture has no timeout of its own, so the
       * user's next click silently does nothing.
       *
       * The page chooses every value below, including their types. So the rule
       * is the shape of the code rather than a list of the fields that happen to
       * need checking today: nothing crossing this boundary may be able to wedge
       * the panel, whatever a future field turns out to be.
       */
      try {
        if (!data.ok || typeof data.code !== 'string') {
          resolve(unavailable);
          return;
        }
        const fromMonaco = normaliseLanguageId(data.language);
        resolve({
          language: scrapedLanguage ?? fromMonaco ?? 'plaintext',
          code: data.code,
          source: 'leetcode',
        });
      } catch {
        resolve(unavailable);
      }
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
  return {
    ok: true,
    problem: parsed.problem,
    editor: await readEditor(parseEditorLanguage(document)),
    run: parseRunResult(document),
  };
}

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
    if (message?.kind !== 'scrape') return undefined;
    void scrape().then(sendResponse);
    return true;
  },
);
