/**
 * Typed client for the panel↔worker port.
 *
 * One port, request ids, and a per-request handler. Streaming requests get a
 * handler that fires many times; one-shot requests resolve a promise.
 */

import {
  PORT_NAME,
  type AskRequest,
  type PanelRequest,
  type WorkerFrame,
} from '../shared/protocol.ts';
import { appError, type AppError, type AttemptRecord, type PageSnapshot, type Settings } from '../shared/types.ts';

type FrameHandler = (frame: WorkerFrame) => void;

/** What the native host is configured with. Non-secret; shown in Settings. */
export interface HostInfo {
  itemTitle: string;
  claudePath: string | null;
}

export interface ClaudeAccess {
  claudePath: string;
  account: string | null;
  subscription: string | null;
}

export interface AskCallbacks {
  onDelta(text: string): void;
  onThinking(): void;
  onDone(): void;
  onError(error: AppError): void;
}

export class PortClient {
  #port: chrome.runtime.Port;
  #nextId = 1;
  #handlers = new Map<number, FrameHandler>();

  constructor() {
    this.#port = chrome.runtime.connect({ name: PORT_NAME });
    this.#port.onMessage.addListener((frame: WorkerFrame) => {
      this.#handlers.get(frame.id)?.(frame);
    });
  }

  #send(build: (id: number) => PanelRequest, handler: FrameHandler): number {
    const id = this.#nextId++;
    this.#handlers.set(id, handler);
    this.#port.postMessage(build(id));
    return id;
  }

  #once<T>(build: (id: number) => PanelRequest, extract: (frame: WorkerFrame) => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.#send(build, (frame) => {
        if (frame.kind === 'error') {
          this.#handlers.delete(id);
          reject(frame.error);
          return;
        }
        const value = extract(frame);
        if (value !== undefined) {
          this.#handlers.delete(id);
          resolve(value);
        }
      });
    });
  }

  capture(tabId: number): Promise<{ snapshot: PageSnapshot | null; failure?: string }> {
    return this.#once(
      (id) => ({ id, kind: 'capture', tabId }),
      (frame) =>
        frame.kind === 'capture-result'
          ? { snapshot: frame.snapshot, ...(frame.failure === undefined ? {} : { failure: frame.failure }) }
          : undefined,
    );
  }

  getSettings(): Promise<Settings> {
    return this.#once(
      (id) => ({ id, kind: 'get-settings' }),
      (frame) => (frame.kind === 'settings' ? frame.settings : undefined),
    );
  }

  setSettings(settings: Settings): Promise<Settings> {
    return this.#once(
      (id) => ({ id, kind: 'set-settings', settings }),
      (frame) => (frame.kind === 'settings' ? frame.settings : undefined),
    );
  }

  getAttempts(slug: string): Promise<AttemptRecord[]> {
    return this.#once(
      (id) => ({ id, kind: 'get-attempts', slug }),
      (frame) => (frame.kind === 'attempts' ? frame.attempts : undefined),
    );
  }

  recordAttempt(attempt: AttemptRecord): Promise<AttemptRecord[]> {
    return this.#once(
      (id) => ({ id, kind: 'record-attempt', attempt }),
      (frame) => (frame.kind === 'attempts' ? frame.attempts : undefined),
    );
  }

  hostInfo(): Promise<HostInfo> {
    return this.#once(
      (id) => ({ id, kind: 'host-info' }),
      (frame) =>
        frame.kind === 'host-info' ? { itemTitle: frame.itemTitle, claudePath: frame.claudePath } : undefined,
    );
  }

  probeKey(): Promise<true> {
    return this.#once(
      (id) => ({ id, kind: 'probe-key' }),
      (frame) => (frame.kind === 'key-ok' ? true : undefined),
    );
  }

  probeClaude(): Promise<ClaudeAccess> {
    return this.#once(
      (id) => ({ id, kind: 'probe-claude' }),
      (frame) =>
        frame.kind === 'claude-ok'
          ? { claudePath: frame.claudePath, account: frame.account, subscription: frame.subscription }
          : undefined,
    );
  }

  /** Returns a cancel function. */
  ask(request: AskRequest, callbacks: AskCallbacks): () => void {
    const id = this.#send((newId) => ({ id: newId, kind: 'ask', request }), (frame) => {
      switch (frame.kind) {
        case 'delta':
          callbacks.onDelta(frame.text);
          break;
        case 'thinking':
          callbacks.onThinking();
          break;
        case 'done':
          this.#handlers.delete(frame.id);
          callbacks.onDone();
          break;
        case 'error':
          this.#handlers.delete(frame.id);
          callbacks.onError(frame.error);
          break;
        default:
          break;
      }
    });

    return () => {
      this.#handlers.delete(id);
      const cancelId = this.#send(
        (newId) => ({ id: newId, kind: 'cancel', targetId: id }),
        () => this.#handlers.delete(cancelId),
      );
      callbacks.onError(appError('aborted', 'Cancelled.'));
    };
  }
}
