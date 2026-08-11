/**
 * Chrome native-messaging framing: a 4-byte native-endian length prefix followed
 * by that many bytes of UTF-8 JSON. Chrome refuses messages larger than 1 MB in
 * either direction.
 *
 * ## Two shapes over one host
 *
 * The key fetch is request/response and rides `chrome.runtime.sendNativeMessage`:
 * one message in, one message out, host exits. Streaming a Claude Code reply
 * cannot work that way, so it rides a `chrome.runtime.connectNative` port
 * instead - the same framing and the same binary, but many frames come back for
 * one request. Every streaming frame carries the `requestId` it belongs to, so a
 * frame that outlives its request is discardable rather than confusing.
 */

export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type HostRequest =
  | { kind: 'ping' }
  /** Checks the `claude` CLI is present and logged in. */
  | { kind: 'claude-probe' }
  | { kind: 'claude-start'; requestId: string; model: string; system: string; prompt: string }
  | { kind: 'claude-cancel'; requestId: string };

export type HostFailureCode =
  | 'claude-cli-missing'
  | 'claude-logged-out'
  | 'claude-usage-limit'
  | 'claude-cli-failed'
  | 'bad-request';

export type HostResponse =
  | { ok: true; kind: 'pong'; claudePath: string | null }
  | {
      ok: true;
      kind: 'claude-ok';
      claudePath: string;
      account: string | null;
      subscription: string | null;
    }
  /** Sent once, when the CLI is up and about to call the API. */
  | { ok: true; kind: 'claude-started'; requestId: string }
  /**
   * A liveness pulse, repeated while the model thinks and throttled by the
   * runner. It carries no text and never will: thinking content is a draft of
   * the answer, which the rung ladder exists to withhold. See `claude.ts`.
   */
  | { ok: true; kind: 'claude-thinking'; requestId: string }
  | { ok: true; kind: 'claude-delta'; requestId: string; text: string }
  | { ok: true; kind: 'claude-done'; requestId: string }
  | { ok: false; code: HostFailureCode; message: string; command?: string; requestId?: string };

export function encodeMessage(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`Native message too large: ${json.byteLength} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder: feed it whatever arrives on stdin, take whole messages out.
 */
export class MessageDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.#buffer.byteLength < 4) return out;
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        throw new Error(`Native message length out of range: ${length}`);
      }
      if (this.#buffer.byteLength < 4 + length) return out;
      const json = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      out.push(JSON.parse(json));
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

export function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record['kind']) {
    case 'ping':
    case 'claude-probe':
      return true;
    case 'claude-start':
      return (
        isNonEmptyString(record['requestId']) &&
        isNonEmptyString(record['model']) &&
        typeof record['system'] === 'string' &&
        typeof record['prompt'] === 'string'
      );
    case 'claude-cancel':
      return isNonEmptyString(record['requestId']);
    default:
      return false;
  }
}
