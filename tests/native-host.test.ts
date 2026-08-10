/**
 * Native messaging host tests: the framing Chrome expects, and every branch of
 * the vault lookup against a fake `dcli`.
 *
 * The failure branches matter more than the happy path - a locked vault must
 * produce an actionable message with the exact command to run, never a silent
 * empty result.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, parseConfig, vaultPath } from '../src/native-host/config.ts';
import { handleRequest, type CommandResult, type HostDeps } from '../src/native-host/handler.ts';
import { MessageDecoder, encodeMessage, isHostRequest } from '../src/native-host/protocol.ts';

const UNLOCKED = 'Logged in: yes\nLogin: someone@example.com\nLocked: no\n';
const LOCKED = 'Logged in: yes\nLogin: someone@example.com\nLocked: yes\n';
const LOGGED_OUT = 'Logged in: no\n';

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function deps(responses: Record<string, CommandResult>, config = DEFAULT_CONFIG): HostDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    config,
    run: (command, args) => {
      calls.push([command, ...args]);
      const key = args[0] ?? '';
      return Promise.resolve(responses[key] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${key}` });
    },
  };
}

describe('framing', () => {
  it('round-trips a message through the length prefix', () => {
    const decoder = new MessageDecoder();
    const out = decoder.push(encodeMessage({ kind: 'get-api-key' }));
    expect(out).toEqual([{ kind: 'get-api-key' }]);
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
    const buffer = Buffer.concat([encodeMessage({ kind: 'ping' }), encodeMessage({ kind: 'get-api-key' })]);
    expect(decoder.push(buffer)).toEqual([{ kind: 'ping' }, { kind: 'get-api-key' }]);
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
    const config = parseConfig(JSON.stringify({ itemTitle: 'Work Anthropic key', dcliPath: '' }));
    expect(config.itemTitle).toBe('Work Anthropic key');
    expect(config.dcliPath).toBe(DEFAULT_CONFIG.dcliPath);
    expect(vaultPath(config)).toBe('dl://Work Anthropic key/content');
  });

  it('supports credential items as well as secure notes', () => {
    const config = parseConfig(JSON.stringify({ itemTitle: 'anthropic-api-key', itemField: 'password' }));
    expect(vaultPath(config)).toBe('dl://anthropic-api-key/password');
  });
});

describe('key lookup', () => {
  it('answers ping without touching the vault', async () => {
    const d = deps({});
    await expect(handleRequest({ kind: 'ping' }, d)).resolves.toEqual({
      ok: true,
      kind: 'pong',
      itemTitle: DEFAULT_CONFIG.itemTitle,
    });
    expect(d.calls).toEqual([]);
  });

  it('returns the key when the vault is unlocked', async () => {
    const d = deps({ status: ok(UNLOCKED), read: ok('sk-ant-api03-secret\n') });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toEqual({
      ok: true,
      kind: 'api-key',
      apiKey: 'sk-ant-api03-secret',
    });
    expect(d.calls[1]).toEqual([DEFAULT_CONFIG.dcliPath, 'read', 'dl://Anthropic API Key/content']);
  });

  it('reports a missing dcli with the install command', async () => {
    const d = deps({ status: { spawnErrorCode: 'ENOENT', exitCode: -1, stdout: '', stderr: '' } });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'dcli-missing' });
    expect(response).toHaveProperty('command', expect.stringContaining('brew install'));
    if (!response.ok) expect(response.message).toContain(DEFAULT_CONFIG.dcliPath);
  });

  it('reports a locked vault with the unlock command, and never a silent empty key', async () => {
    const d = deps({ status: ok(LOCKED) });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'vault-locked', command: 'dcli sync' });
    // It must not have attempted the read.
    expect(d.calls).toHaveLength(1);
  });

  it('distinguishes logged out from locked', async () => {
    const d = deps({ status: ok(LOGGED_OUT) });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'vault-logged-out',
    });
  });

  it('names the item when the vault has no such entry', async () => {
    const d = deps({ status: ok(UNLOCKED), read: { exitCode: 1, stdout: '', stderr: 'Error: secret not found' } });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'vault-item-missing' });
    if (!response.ok) expect(response.message).toContain('Anthropic API Key');
  });

  it('treats an empty item as missing rather than returning an empty key', async () => {
    const d = deps({ status: ok(UNLOCKED), read: ok('   \n') });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'vault-item-missing',
    });
  });

  it('re-reports a master-password prompt during read as a locked vault', async () => {
    const d = deps({
      status: ok(UNLOCKED),
      read: { exitCode: 1, stdout: '', stderr: 'Please enter your master password' },
    });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'vault-locked',
      command: 'dcli sync',
    });
  });

  it('honours a custom item from config', async () => {
    const config = parseConfig(JSON.stringify({ itemTitle: 'work-key', itemField: 'password', dcliPath: '/bin/dcli' }));
    const d = deps({ status: ok(UNLOCKED), read: ok('sk-work\n') }, config);
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toEqual({
      ok: true,
      kind: 'api-key',
      apiKey: 'sk-work',
    });
    expect(d.calls[1]).toEqual(['/bin/dcli', 'read', 'dl://work-key/password']);
  });

  it('never logs the key', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const d = deps({ status: ok(UNLOCKED), read: ok('sk-ant-secret') });
    await handleRequest({ kind: 'get-api-key' }, d);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
