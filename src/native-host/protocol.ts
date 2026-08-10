/**
 * Chrome native-messaging framing: a 4-byte native-endian length prefix followed
 * by that many bytes of UTF-8 JSON. Chrome refuses messages larger than 1 MB in
 * either direction.
 */

export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type HostRequest = { kind: 'ping' } | { kind: 'get-api-key' };

export type HostFailureCode =
  | 'dcli-missing'
  | 'vault-locked'
  | 'vault-logged-out'
  | 'vault-item-missing'
  | 'key-fetch-failed'
  | 'bad-request';

export type HostResponse =
  | { ok: true; kind: 'pong'; itemTitle: string }
  | { ok: true; kind: 'api-key'; apiKey: string }
  | { ok: false; code: HostFailureCode; message: string; command?: string };

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

export function isHostRequest(value: unknown): value is HostRequest {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'ping' || kind === 'get-api-key';
}
