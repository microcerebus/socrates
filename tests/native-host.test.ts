/**
 * Native messaging host tests: the framing Chrome expects, and every branch of
 * the vault lookup against a fake `dcli`.
 *
 * The shape under test is read-first: the success path must not consult
 * `dcli status` at all, because status is prose and prose drifts. Status is only
 * a post-failure classifier, and when it stops being recognisable the host must
 * say so honestly rather than guess a friendly-sounding cause.
 *
 * `tests/dcli-contract.test.ts` covers the other half: noticing when the real
 * `dcli status` wording actually changes.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, parseConfig, vaultPath } from '../src/native-host/config.ts';
import {
  firstMeaningfulLine,
  handleRequest,
  isRecognisableStatus,
  parseStatusLines,
  type CommandResult,
  type HostDeps,
} from '../src/native-host/handler.ts';
import { MessageDecoder, encodeMessage, isHostRequest } from '../src/native-host/protocol.ts';

const UNLOCKED = 'Logged in: yes\nLogin: someone@example.com\nLocked: no\n';
const LOCKED = 'Logged in: yes\nLogin: someone@example.com\nLocked: yes\n';
const LOGGED_OUT = 'Logged in: no\n';

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fails(stderr: string, exitCode = 1): CommandResult {
  return { exitCode, stdout: '', stderr };
}

const FAKE_HOME = '/home/tester';

function deps(responses: Record<string, CommandResult>, config = DEFAULT_CONFIG): HostDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    config,
    home: FAKE_HOME,
    // The dcli branches never look for `claude`; the Claude Code suite injects
    // its own predicate.
    exists: () => true,
    run: (command, args) => {
      calls.push([command, ...args]);
      const key = args[0] ?? '';
      return Promise.resolve(responses[key] ?? { exitCode: 1, stdout: '', stderr: `unexpected: ${key}` });
    },
  };
}

/** Which subcommands were invoked, in order. */
function subcommands(calls: string[][]): string[] {
  return calls.map((call) => call[1] ?? '');
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
    expect(config.claudePath).toBe(DEFAULT_CONFIG.claudePath);
    expect(vaultPath(config)).toBe('dl://Work Anthropic key/content');
  });

  it('supports credential items as well as secure notes', () => {
    const config = parseConfig(JSON.stringify({ itemTitle: 'anthropic-api-key', itemField: 'password' }));
    expect(vaultPath(config)).toBe('dl://anthropic-api-key/password');
  });
});

describe('status parsing', () => {
  it('reads key: value lines case-insensitively', () => {
    const fields = parseStatusLines('Logged in: YES\nLogin: a@b.com\nLocked: No\n');
    expect(fields.get('logged in')).toBe('yes');
    expect(fields.get('locked')).toBe('no');
    expect(isRecognisableStatus(fields)).toBe(true);
  });

  it('ignores lines that are not key: value', () => {
    const fields = parseStatusLines('some banner\n\nLocked: yes\ntrailing noise');
    expect(fields.size).toBe(1);
    expect(fields.get('locked')).toBe('yes');
  });

  it('keeps the first value when a key repeats', () => {
    expect(parseStatusLines('Locked: no\nLocked: yes').get('locked')).toBe('no');
  });

  it('reports unrecognisable output rather than inventing fields', () => {
    expect(isRecognisableStatus(parseStatusLines('{"loggedIn":true,"locked":false}'))).toBe(false);
    expect(isRecognisableStatus(parseStatusLines(''))).toBe(false);
  });
});

describe('quoting dcli', () => {
  const esc = String.fromCharCode(27);

  it('strips the colour escapes dcli wraps its errors in', () => {
    expect(firstMeaningfulLine(`${esc}[31merror: No matching item found${esc}[0m\n`)).toBe(
      'error: No matching item found',
    );
  });

  it('skips blank leading lines', () => {
    expect(firstMeaningfulLine('\n\n  real message  \nsecond')).toBe('real message');
  });

  it('is empty when there is nothing to quote', () => {
    expect(firstMeaningfulLine('   \n\n')).toBe('');
  });
});

describe('key lookup', () => {
  it('answers ping without touching the vault', async () => {
    const d = deps({});
    await expect(handleRequest({ kind: 'ping' }, d)).resolves.toEqual({
      ok: true,
      kind: 'pong',
      itemTitle: DEFAULT_CONFIG.itemTitle,
      claudePath: DEFAULT_CONFIG.claudePath,
    });
    expect(d.calls).toEqual([]);
  });

  it('returns the key from the read alone, never consulting status', async () => {
    const d = deps({ read: ok('sk-ant-api03-secret\n') });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toEqual({
      ok: true,
      kind: 'api-key',
      apiKey: 'sk-ant-api03-secret',
    });
    // The whole point of read-first: the happy path does not parse any prose.
    expect(subcommands(d.calls)).toEqual(['read']);
    expect(d.calls[0]).toEqual([DEFAULT_CONFIG.dcliPath, 'read', 'dl://Anthropic API Key/content']);
  });

  it('reports a missing dcli with the install command', async () => {
    const d = deps({ read: { spawnErrorCode: 'ENOENT', exitCode: -1, stdout: '', stderr: '' } });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'dcli-missing' });
    expect(response).toHaveProperty('command', expect.stringContaining('brew install'));
    if (!response.ok) expect(response.message).toContain(DEFAULT_CONFIG.dcliPath);
    expect(subcommands(d.calls)).toEqual(['read']);
  });

  it('classifies a failed read as logged out when status says so', async () => {
    const d = deps({ read: fails('Error: not authenticated'), status: ok(LOGGED_OUT) });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'vault-logged-out',
      command: 'dcli sync',
    });
    expect(subcommands(d.calls)).toEqual(['read', 'status']);
  });

  it('classifies a failed read as a locked vault when status says so', async () => {
    const d = deps({ read: fails('Please enter your master password'), status: ok(LOCKED) });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'vault-locked',
      command: 'dcli sync',
    });
    expect(subcommands(d.calls)).toEqual(['read', 'status']);
  });

  it('blames the item when the vault is healthy, quoting dcli', async () => {
    const d = deps({ read: fails('Error: secret not found'), status: ok(UNLOCKED) });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'vault-item-missing' });
    if (!response.ok) {
      expect(response.message).toContain('Anthropic API Key');
      expect(response.message).toContain('secret not found');
      expect(response.command).toBe('dcli read "dl://Anthropic API Key/content"');
    }
  });

  it('treats an empty item as empty rather than returning an empty key', async () => {
    const d = deps({ read: ok('   \n'), status: ok(UNLOCKED) });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'vault-item-missing' });
    if (!response.ok) expect(response.message).toContain('is empty');
  });

  it('stays honest when status output is no longer recognisable', async () => {
    const d = deps({
      read: fails('Error: something new went wrong'),
      // Imagine a future dcli that switches to JSON, or renames its fields.
      status: ok('{"authenticated":true,"vaultLocked":false}'),
    });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'key-fetch-failed', command: 'dcli status' });
    if (!response.ok) {
      // No confident claim about locks or logins, and dcli's own words are passed through.
      expect(response.message).not.toMatch(/locked|logged in/i);
      expect(response.message).toContain('something new went wrong');
    }
  });

  it('does not guess "locked" from the read stderr alone', async () => {
    // Pre-fix, "master password" in stderr was enough to claim a locked vault.
    const d = deps({ read: fails('Please enter your master password'), status: ok('¯\\_(ツ)_/¯') });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'key-fetch-failed',
    });
  });

  it('reports a missing dcli discovered during classification', async () => {
    const d = deps({
      read: fails('Error: boom'),
      status: { spawnErrorCode: 'ENOENT', exitCode: -1, stdout: '', stderr: '' },
    });
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toMatchObject({
      ok: false,
      code: 'dcli-missing',
    });
  });

  it('reports a non-ENOENT spawn failure without pretending to know more', async () => {
    const d = deps({ read: { spawnErrorCode: 'EACCES', exitCode: -1, stdout: '', stderr: '' } });
    const response = await handleRequest({ kind: 'get-api-key' }, d);
    expect(response).toMatchObject({ ok: false, code: 'key-fetch-failed' });
    if (!response.ok) expect(response.message).toContain('EACCES');
  });

  it('honours a custom item from config', async () => {
    const config = parseConfig(JSON.stringify({ itemTitle: 'work-key', itemField: 'password', dcliPath: '/bin/dcli' }));
    const d = deps({ read: ok('sk-work\n') }, config);
    await expect(handleRequest({ kind: 'get-api-key' }, d)).resolves.toEqual({
      ok: true,
      kind: 'api-key',
      apiKey: 'sk-work',
    });
    expect(d.calls[0]).toEqual(['/bin/dcli', 'read', 'dl://work-key/password']);
  });

  it('never logs the key', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const d = deps({ read: ok('sk-ant-secret') });
    await handleRequest({ kind: 'get-api-key' }, d);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
