/**
 * Native messaging host tests: the framing Chrome expects, and the
 * request/response dispatch that is not specific to the Claude Code path.
 *
 * The Claude Code half - argv, the CLI stream, auth status, and every branch of
 * `classifyClaudeFailure` - lives in `tests/claude-host.test.ts` instead.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, parseConfig } from '../src/native-host/config.ts';
import { handleRequest, type HostDeps } from '../src/native-host/handler.ts';
import { MessageDecoder, encodeMessage, isHostRequest } from '../src/native-host/protocol.ts';

const FAKE_HOME = '/home/tester';

function deps(config = DEFAULT_CONFIG): HostDeps {
  return {
    config,
    home: FAKE_HOME,
    exists: () => true,
    run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

describe('framing', () => {
  it('round-trips a message through the length prefix', () => {
    const decoder = new MessageDecoder();
    const out = decoder.push(encodeMessage({ kind: 'ping' }));
    expect(out).toEqual([{ kind: 'ping' }]);
  });

  it('writes the length as 4 little-endian bytes', () => {
    const encoded = encodeMessage({ kind: 'ping' });
    expect(encoded.readUInt32LE(0)).toBe(encoded.byteLength - 4);
    expect(encoded.subarray(4).toString('utf8')).toBe('{"kind":"ping"}');
  });

  it('reassembles a message split across reads', () => {
    const encoded = encodeMessage({ kind: 'ping' });
    const decoder = new MessageDecoder();
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2, 7))).toEqual([]);
    expect(decoder.push(encoded.subarray(7))).toEqual([{ kind: 'ping' }]);
  });

  it('yields several messages arriving in one read', () => {
    const decoder = new MessageDecoder();
    const buffer = Buffer.concat([encodeMessage({ kind: 'ping' }), encodeMessage({ kind: 'claude-probe' })]);
    expect(decoder.push(buffer)).toEqual([{ kind: 'ping' }, { kind: 'claude-probe' }]);
  });

  it('rejects an absurd declared length instead of allocating', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xff_ff_ff_ff, 0);
    expect(() => new MessageDecoder().push(header)).toThrow(/out of range/);
  });

  it('validates request shapes', () => {
    expect(isHostRequest({ kind: 'ping' })).toBe(true);
    expect(isHostRequest({ kind: 'rm -rf' })).toBe(false);
    expect(isHostRequest(null)).toBe(false);
    expect(isHostRequest('ping')).toBe(false);
  });
});

describe('config', () => {
  it('falls back to defaults on missing or broken json', () => {
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig('{not json')).toEqual(DEFAULT_CONFIG);
    expect(parseConfig('[]')).toEqual(DEFAULT_CONFIG);
  });

  it('takes the fields it recognises and defaults the rest', () => {
    const config = parseConfig(JSON.stringify({ claudePath: '' }));
    expect(config.claudePath).toBe(DEFAULT_CONFIG.claudePath);
  });
});

describe('request dispatch', () => {
  it('answers ping with the resolved claude binary', async () => {
    await expect(handleRequest({ kind: 'ping' }, deps())).resolves.toEqual({
      ok: true,
      kind: 'pong',
      claudePath: DEFAULT_CONFIG.claudePath,
    });
  });

  it('refuses a streaming request kind, which main.ts drives instead', async () => {
    await expect(handleRequest({ kind: 'claude-cancel', requestId: 'r1' }, deps())).resolves.toMatchObject({
      ok: false,
      code: 'bad-request',
    });
  });
});
