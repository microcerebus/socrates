/**
 * Runs in the page's MAIN world so it can reach LeetCode's Monaco instance.
 *
 * Why this exists: Monaco virtualises long files - only the lines currently on
 * screen have DOM nodes, so scraping `.view-line` elements silently truncates the
 * buffer. The editor *model* holds the whole document, but it is a page-context
 * JavaScript object that an isolated content script cannot touch. This bridge
 * reads the model and hands the text back over `window.postMessage`.
 *
 * It is strictly read-only: it never types, clicks, or submits.
 */

import {
  PAGE_BRIDGE_REQUEST,
  PAGE_BRIDGE_RESPONSE,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '../shared/protocol.ts';

interface MonacoModel {
  getValue(): string;
  getLanguageId?(): string;
  getModeId?(): string;
  isAttachedToEditor?(): boolean;
  uri?: { path?: string; scheme?: string };
}

interface MonacoCodeEditor {
  getModel(): MonacoModel | null;
  hasTextFocus?(): boolean;
}

interface MonacoGlobal {
  editor?: {
    getModels?(): MonacoModel[];
    getEditors?(): MonacoCodeEditor[];
  };
}

function monacoNamespace(): MonacoGlobal | null {
  const candidate = (window as unknown as { monaco?: unknown }).monaco;
  if (typeof candidate !== 'object' || candidate === null) return null;
  return candidate as MonacoGlobal;
}

function languageOf(model: MonacoModel): string {
  const id = model.getLanguageId?.() ?? model.getModeId?.() ?? '';
  return id === '' ? 'plaintext' : id;
}

const IGNORED_LANGUAGES = new Set(['plaintext', 'markdown', 'html', 'json']);

function pickModel(namespace: MonacoGlobal): MonacoModel | null {
  const editors = namespace.editor?.getEditors?.() ?? [];
  const focused = editors.find((editor) => editor.hasTextFocus?.() === true)?.getModel();
  if (focused) return focused;

  const attached = editors
    .map((editor) => editor.getModel())
    .filter((model): model is MonacoModel => model !== null);
  const models = attached.length > 0 ? attached : (namespace.editor?.getModels?.() ?? []);
  if (models.length === 0) return null;

  const scored = models
    .map((model) => ({ model, language: languageOf(model), size: model.getValue().length }))
    .sort((a, b) => {
      const aIgnored = IGNORED_LANGUAGES.has(a.language) ? 1 : 0;
      const bIgnored = IGNORED_LANGUAGES.has(b.language) ? 1 : 0;
      if (aIgnored !== bIgnored) return aIgnored - bIgnored;
      return b.size - a.size;
    });
  return scored[0]?.model ?? null;
}

function respond(nonce: string): void {
  const namespace = monacoNamespace();
  let response: PageBridgeResponse;

  if (!namespace) {
    response = { type: PAGE_BRIDGE_RESPONSE, nonce, ok: false, detail: 'monaco-namespace-missing' };
  } else {
    const model = pickModel(namespace);
    response = model
      ? {
          type: PAGE_BRIDGE_RESPONSE,
          nonce,
          ok: true,
          language: languageOf(model),
          code: model.getValue(),
        }
      : { type: PAGE_BRIDGE_RESPONSE, nonce, ok: false, detail: 'no-editor-model' };
  }

  window.postMessage(response, window.location.origin);
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window) return;
  const data = event.data as Partial<PageBridgeRequest> | null;
  if (!data || data.type !== PAGE_BRIDGE_REQUEST || typeof data.nonce !== 'string') return;
  try {
    respond(data.nonce);
  } catch (error) {
    window.postMessage(
      {
        type: PAGE_BRIDGE_RESPONSE,
        nonce: data.nonce,
        ok: false,
        detail: String(error),
      } satisfies PageBridgeResponse,
      window.location.origin,
    );
  }
});
