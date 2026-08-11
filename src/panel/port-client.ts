/**
 * Typed client for the panel↔worker port.
 *
 * One port, request ids, and a per-request handler. Streaming requests get a
 * handler that fires many times; one-shot requests resolve a promise.
 *
 * ## The port is not long-lived, and pretending it is wedges the panel
 *
 * Chrome stops an idle MV3 service worker after 30 seconds with no message on
 * the port, and the panel's port dies with it. That is not an error condition -
 * it is the platform doing what it says it does, and it happens on *every*
 * ordinary use of this panel, because reading a hint takes longer than half a
 * minute.
 *
 * The panel used to connect once in this constructor and never look again, so
 * the first question asked after a pause went into a dead port. Two shapes came
 * out of that, and which one you got was a race with Chrome delivering the
 * disconnect. Posting after it arrived *threw* - and `ask` posts outside any
 * promise, so the throw escaped the click handler after `setBusy(true)` had
 * already run, leaving the spinner up forever. Posting before it arrived was
 * worse: the message was silently dropped, the promise never settled, and the
 * click did nothing at all. Measured end to end, this is issue #10: turn 1 and
 * turn 2 answer in ~5s, then the first turn after a 50s read hangs indefinitely.
 *
 * So the port is treated as what it is - a connection that expires:
 *
 * - `onDisconnect` drops the reference and fails everything in flight. That is
 *   also what covers the silent-drop race, because a dropped message is always
 *   followed by the disconnect that explains it: the request turns into a
 *   prompt, honest error rather than a spinner.
 * - The next `#send` opens a new port, which starts the worker again. Lazily and
 *   *synchronously*, so call order is still wire order - `session-writer.ts`
 *   depends on that for clear-then-save.
 * - A `postMessage` that throws is retried once on a fresh port. That one is
 *   safe to retry because the worker never saw it, so nothing has been spent.
 *
 * A turn is never re-sent automatically. Every turn costs the user's own Max
 * window, and quietly paying for one twice is not the panel's decision to make.
 */

import {
  PORT_NAME,
  type AskRequest,
  type PanelRequest,
  type WorkerFrame,
} from '../shared/protocol.ts';
import {
  appError,
  type AppError,
  type AttemptRecord,
  type PageSnapshot,
  type Settings,
  type StoredSession,
} from '../shared/types.ts';

type FrameHandler = (frame: WorkerFrame) => void;

/** What the native host is configured with. Non-secret; shown in Settings. */
export interface HostInfo {
  claudePath: string | null;
}

export interface ClaudeAccess {
  claudePath: string;
  account: string | null;
  subscription: string | null;
}

export interface AskCallbacks {
  onDelta(text: string): void;
  /** The turn is genuinely under way. Fires once. */
  onStarted(): void;
  /** A liveness heartbeat while the model thinks. Fires repeatedly. */
  onThinking(): void;
  onDone(): void;
  onError(error: AppError): void;
}

/** The slice of `chrome.runtime.Port` this needs, so tests can hand over a fake. */
export interface PanelPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(callback: (frame: WorkerFrame) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

export type PanelConnect = () => PanelPort;

const defaultConnect: PanelConnect = () =>
  chrome.runtime.connect({ name: PORT_NAME }) as unknown as PanelPort;

/**
 * How long a one-shot request waits before giving up.
 *
 * Well past the slowest of them: a `capture` is a round trip through the worker
 * to the content script, which itself waits up to `BRIDGE_TIMEOUT_MS` (1.5s) on
 * the MAIN-world bridge, and may re-inject both worlds first. Nothing here is
 * meant to fire in normal use - it exists so that "no answer" is a message
 * rather than a panel that has quietly stopped responding to clicks.
 */
export const ONE_SHOT_TIMEOUT_MS = 20_000;

/** What an interrupted request is told. Never a silence, and never a spinner. */
function workerRestarted(): AppError {
  return appError(
    'worker-restarted',
    'Chrome stopped Socrates’ background worker while that was running, so the reply was lost. ' +
      'Nothing was spent past what you already saw - send the question again.',
  );
}

export class PortClient {
  /** `null` between the worker going away and the next request reopening. */
  #port: PanelPort | null = null;
  #nextId = 1;
  #handlers = new Map<number, FrameHandler>();
  #connect: PanelConnect;

  constructor(connect: PanelConnect = defaultConnect) {
    this.#connect = connect;
    this.#open();
  }

  /**
   * How many requests are still waiting for a frame. Exposed for tests: "this
   * map does not grow across a long session" is the one unbounded thing in here.
   */
  get inFlight(): number {
    return this.#handlers.size;
  }

  #open(): PanelPort {
    const port = this.#connect();
    this.#port = port;
    port.onMessage.addListener((frame: WorkerFrame) => {
      this.#handlers.get(frame.id)?.(frame);
    });
    port.onDisconnect.addListener(() => {
      // A port superseded by a later `#open` is not the live one; its death says
      // nothing about the requests now riding the new one.
      if (this.#port !== port) return;
      this.#port = null;
      this.#failInFlight();
    });
    return port;
  }

  /**
   * Everything outstanding, told the truth at once.
   *
   * Taken and cleared before any handler runs, because a handler may start a new
   * request - and that one belongs to the fresh port, not to this sweep.
   */
  #failInFlight(): void {
    const outstanding = [...this.#handlers.entries()];
    this.#handlers.clear();
    for (const [id, handler] of outstanding) {
      handler({ id, kind: 'error', error: workerRestarted() });
    }
  }

  #send(build: (id: number) => PanelRequest, handler: FrameHandler): number {
    const id = this.#nextId++;
    this.#handlers.set(id, handler);
    const request = build(id);

    /*
     * Reopening here rather than on the disconnect keeps the worker asleep until
     * there is actually something for it to do, which is the whole point of MV3.
     *
     * Connecting is inside the `try` as well as posting, because `connect` is
     * the call that throws when the extension context has been invalidated -
     * after a reload, say. Nothing below may throw out of this method: `ask`
     * calls it outside any promise, from a click handler that has already set
     * the spinner going, which is exactly how the original bug became a hang
     * rather than an error.
     */
    try {
      (this.#port ?? this.#open()).postMessage(request);
    } catch {
      // Either the disconnect had not been delivered yet or the port could not
      // be opened at all. Nothing reached the worker, so re-sending costs
      // nothing.
      this.#port = null;
      try {
        this.#open().postMessage(request);
      } catch (cause) {
        this.#handlers.delete(id);
        handler({
          id,
          kind: 'error',
          error: appError(
            'api-error',
            `Socrates could not reach its background worker: ${String(cause)}`,
          ),
        });
      }
    }
    return id;
  }

  /**
   * A one-shot request, bounded.
   *
   * The disconnect sweep already covers the failure this panel actually hit, but
   * it only covers what Chrome tells us about. A one-shot that is answered by
   * nothing and disconnected by nothing used to wait forever - and the caller of
   * the slowest one, `capture`, is `snapshotForTurn`, so a single unanswered
   * scrape means the user's click silently does nothing at all, with no spinner
   * to show for it. `content-script.ts` names that hang as the thing its
   * `try/catch` exists to prevent; this is the same guarantee from the other end,
   * where it does not depend on the content script being the one at fault.
   *
   * Streaming is deliberately not bounded here. A turn legitimately runs for
   * minutes and has its own, better-informed backstop in `turn-progress.ts`.
   */
  #once<T>(
    build: (id: number) => PanelRequest,
    extract: (frame: WorkerFrame) => T | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Armed before the request goes out, because `#send` can answer its own
      // handler synchronously when the port cannot be reopened at all.
      let requestId = -1;
      let kind = '';
      const timer = setTimeout(() => {
        this.#handlers.delete(requestId);
        reject(
          appError(
            'api-error',
            `Socrates’ background worker did not answer a ${kind} request within ` +
              `${Math.round(ONE_SHOT_TIMEOUT_MS / 1000)}s. Try that again.`,
          ),
        );
      }, ONE_SHOT_TIMEOUT_MS);

      const settle = (frame: WorkerFrame): void => {
        clearTimeout(timer);
        this.#handlers.delete(frame.id);
      };

      requestId = this.#send(
        (id) => {
          const request = build(id);
          kind = request.kind;
          return request;
        },
        (frame) => {
          if (frame.kind === 'error') {
            settle(frame);
            reject(frame.error);
            return;
          }
          const value = extract(frame);
          if (value !== undefined) {
            settle(frame);
            resolve(value);
          }
        },
      );
    });
  }

  capture(tabId: number): Promise<{ snapshot: PageSnapshot | null; failure?: string }> {
    return this.#once(
      (id) => ({ id, kind: 'capture', tabId }),
      (frame) =>
        frame.kind === 'capture-result'
          ? {
              snapshot: frame.snapshot,
              ...(frame.failure === undefined ? {} : { failure: frame.failure }),
            }
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

  getSession(slug: string): Promise<StoredSession | null> {
    return this.#once(
      (id) => ({ id, kind: 'get-session', slug }),
      // `session` is legitimately null, so `undefined` alone means "not my frame".
      (frame) => (frame.kind === 'session' ? { value: frame.session } : undefined),
    ).then((wrapper) => wrapper.value);
  }

  saveSession(session: StoredSession): Promise<StoredSession | null> {
    return this.#once(
      (id) => ({ id, kind: 'save-session', session }),
      (frame) => (frame.kind === 'session' ? { value: frame.session } : undefined),
    ).then((wrapper) => wrapper.value);
  }

  clearSession(slug: string): Promise<void> {
    return this.#once(
      (id) => ({ id, kind: 'clear-session', slug }),
      (frame) => (frame.kind === 'session' ? true : undefined),
    ).then(() => undefined);
  }

  /**
   * Deletes every saved transcript and the whole session log. Settings survive.
   *
   * `activeFrom` is the identity of the session the panel is starting instead,
   * and it is what lets the worker refuse the writes still in flight for the one
   * being deleted. Pass the `startedAt` generated in the same tick as the click.
   */
  clearAllData(activeFrom: string): Promise<void> {
    return this.#once(
      (id) => ({ id, kind: 'clear-all-data', activeFrom }),
      (frame) => (frame.kind === 'cleared' ? true : undefined),
    ).then(() => undefined);
  }

  hostInfo(): Promise<HostInfo> {
    return this.#once(
      (id) => ({ id, kind: 'host-info' }),
      (frame) => (frame.kind === 'host-info' ? { claudePath: frame.claudePath } : undefined),
    );
  }

  probeClaude(): Promise<ClaudeAccess> {
    return this.#once(
      (id) => ({ id, kind: 'probe-claude' }),
      (frame) =>
        frame.kind === 'claude-ok'
          ? {
              claudePath: frame.claudePath,
              account: frame.account,
              subscription: frame.subscription,
            }
          : undefined,
    );
  }

  /** Returns a cancel function. */
  ask(request: AskRequest, callbacks: AskCallbacks): () => void {
    const id = this.#send(
      (newId) => ({ id: newId, kind: 'ask', request }),
      (frame) => {
        switch (frame.kind) {
          case 'delta':
            callbacks.onDelta(frame.text);
            break;
          case 'started':
            callbacks.onStarted();
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
      },
    );

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
