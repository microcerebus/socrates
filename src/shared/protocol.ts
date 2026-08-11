/**
 * The wire protocol between the side panel and the service worker.
 *
 * Everything goes over a single long-lived `chrome.runtime.Port` so that
 * streaming replies and one-shot replies share one code path. Every request
 * carries an `id`; every frame the worker sends back echoes it.
 */

import type {
  AppError,
  AskIntent,
  AttemptRecord,
  EditorContext,
  PageSnapshot,
  ProblemContext,
  Rung,
  Settings,
  StoredSession,
  Turn,
} from './types.ts';

export const PORT_NAME = 'socrates';

/** Sent by the panel to ask the model something. */
export interface AskRequest {
  intent: AskIntent;
  /** The rung that is unlocked for this reply. Never exceeded. */
  rung: Rung;
  /** Free-form user message. Empty for pure ladder unlocks. */
  message: string;
  snapshot: PageSnapshot;
  /** Prior turns, oldest first. */
  history: Turn[];
  /** Milliseconds since the session started, for the model's sense of pacing. */
  elapsedMs: number;
}

export type PanelRequest =
  | { id: number; kind: 'capture'; tabId: number }
  | { id: number; kind: 'ask'; request: AskRequest }
  | { id: number; kind: 'cancel'; targetId: number }
  | { id: number; kind: 'get-settings' }
  | { id: number; kind: 'set-settings'; settings: Settings }
  | { id: number; kind: 'get-attempts'; slug: string }
  | { id: number; kind: 'record-attempt'; attempt: AttemptRecord }
  | { id: number; kind: 'get-session'; slug: string }
  | { id: number; kind: 'save-session'; session: StoredSession }
  | { id: number; kind: 'clear-session'; slug: string }
  | { id: number; kind: 'probe-claude' }
  | { id: number; kind: 'host-info' };

export type WorkerFrame =
  | { id: number; kind: 'capture-result'; snapshot: PageSnapshot | null; failure?: string }
  | { id: number; kind: 'delta'; text: string }
  /** The turn is genuinely under way. Ends the panel's "connecting" phase. */
  | { id: number; kind: 'started' }
  /** A liveness heartbeat while the model thinks. Repeated, and text-free by design. */
  | { id: number; kind: 'thinking' }
  | { id: number; kind: 'done' }
  | { id: number; kind: 'settings'; settings: Settings }
  | { id: number; kind: 'attempts'; attempts: AttemptRecord[] }
  /** `null` when there is nothing stored for that slug. */
  | { id: number; kind: 'session'; session: StoredSession | null }
  | { id: number; kind: 'claude-ok'; claudePath: string; account: string | null; subscription: string | null }
  | { id: number; kind: 'host-info'; claudePath: string | null }
  | { id: number; kind: 'ack' }
  | { id: number; kind: 'error'; error: AppError };

/** `Omit` over a union collapses it to the shared keys; this keeps the members apart. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A worker frame before the request id is attached. */
export type WorkerFrameBody = DistributiveOmit<WorkerFrame, 'id'>;

/** Messages exchanged between the content script and the service worker. */
export type ContentRequest = { kind: 'scrape' };

export type ContentResponse =
  | { ok: true; problem: ProblemContext; editor: EditorContext }
  | { ok: false; reason: string; detail?: string };

/** Messages exchanged between the isolated content script and the MAIN-world bridge. */
export const PAGE_BRIDGE_REQUEST = 'socrates:read-editor:request';
export const PAGE_BRIDGE_RESPONSE = 'socrates:read-editor:response';

export interface PageBridgeRequest {
  type: typeof PAGE_BRIDGE_REQUEST;
  nonce: string;
}

export interface PageBridgeResponse {
  type: typeof PAGE_BRIDGE_RESPONSE;
  nonce: string;
  ok: boolean;
  language?: string;
  code?: string;
  detail?: string;
}
