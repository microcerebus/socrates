/**
 * The extension half of the Claude Code provider.
 *
 * The load-bearing claim in this file is that the provider is *only* a
 * transport: the same gated system prompt goes out, the same spoiler guard runs
 * over what comes back, and the same settings switch flips between the two
 * without anything else changing. Each of those is asserted against both
 * providers rather than trusted.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiMessage } from '../src/background/anthropic.ts';
import { streamClaudeCode, type NativePort } from '../src/background/claude-code.ts';
import { hostFailureToAppError } from '../src/background/host-errors.ts';
import { runInterviewTurn } from '../src/background/interview.ts';
import { apiKeyProvider, claudeCodeProvider, flattenMessages } from '../src/background/providers.ts';
import { getSettings, setSettings } from '../src/background/session-store.ts';
import { createSettingsWriter } from '../src/panel/settings-writer.ts';
import { WITHHELD_NOTICE } from '../src/prompt/spoiler-guard.ts';
import type { HostResponse } from '../src/native-host/protocol.ts';
import { DEFAULT_SETTINGS, appError, type AppError, type Rung, type Settings } from '../src/shared/types.ts';
import { askRequest, mockAnthropic, sseBody } from './helpers.ts';

// --- a native port that never leaves the process -----------------------------

class FakePort implements NativePort {
  readonly sent: unknown[] = [];
  disconnected = false;
  #onMessage: ((message: unknown) => void)[] = [];
  #onDisconnect: (() => void)[] = [];

  readonly onMessage = { addListener: (callback: (message: unknown) => void): void => void this.#onMessage.push(callback) };
  readonly onDisconnect = { addListener: (callback: () => void): void => void this.#onDisconnect.push(callback) };

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(message: HostResponse): void {
    for (const listener of [...this.#onMessage]) listener(message);
  }

  drop(): void {
    for (const listener of [...this.#onDisconnect]) listener();
  }

  /** The `claude-start` the extension opened with. */
  get start(): { model: string; system: string; prompt: string; requestId: string } {
    return this.sent[0] as { model: string; system: string; prompt: string; requestId: string };
  }
}

/** `claude-code.ts` reads `chrome.runtime.lastError` on disconnect. */
function stubChrome(): { store: Record<string, unknown>; setLastError(message: string | null): void } {
  const store: Record<string, unknown> = {};
  const runtime: { lastError?: { message: string } } = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime,
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (values: Record<string, unknown>) => {
          Object.assign(store, values);
          return Promise.resolve();
        },
      },
    },
  };
  return {
    store,
    setLastError: (message) => {
      if (message === null) delete runtime.lastError;
      else runtime.lastError = { message };
    },
  };
}

let chromeStub: ReturnType<typeof stubChrome>;
beforeEach(() => {
  chromeStub = stubChrome();
});

function stream(port: FakePort, overrides: Record<string, unknown> = {}): Promise<void> {
  return streamClaudeCode({
    model: 'claude-sonnet-5',
    system: 'SYSTEM',
    prompt: 'PROMPT',
    onText: () => undefined,
    connect: () => port,
    requestId: 'req-1',
    ...overrides,
  });
}

const failure = (promise: Promise<unknown>): Promise<AppError | null> =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

describe('flattening a transcript', () => {
  const messages: ApiMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: '# SESSION\nUnlocked rung: 2' },
  ];

  it('leaves a single turn exactly as it is', () => {
    expect(flattenMessages([{ role: 'user', content: 'just this' }])).toBe('just this');
  });

  it('keeps every earlier turn, labelled by who said it, with the live turn last', () => {
    const flat = flattenMessages(messages);
    expect(flat).toContain('first question');
    expect(flat).toContain('first reply');
    expect(flat.indexOf('first question')).toBeLessThan(flat.indexOf('first reply'));
    expect(flat.endsWith('# SESSION\nUnlocked rung: 2')).toBe(true);
    expect(flat).toContain('The candidate said');
    expect(flat).toContain('You replied');
  });

  it('is empty for an empty conversation rather than throwing', () => {
    expect(flattenMessages([])).toBe('');
  });
});

describe('the streaming port', () => {
  it('opens with the model, the system prompt and the flattened transcript', async () => {
    const port = new FakePort();
    const running = stream(port);
    expect(port.start).toMatchObject({
      kind: 'claude-start',
      requestId: 'req-1',
      model: 'claude-sonnet-5',
      system: 'SYSTEM',
      prompt: 'PROMPT',
    });
    port.emit({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    await expect(running).resolves.toBeUndefined();
    expect(port.disconnected).toBe(true);
  });

  it('surfaces deltas in order and reports thinking once', async () => {
    const port = new FakePort();
    const chunks: string[] = [];
    let thinking = 0;
    const running = stream(port, { onText: (text: string) => chunks.push(text), onThinking: () => (thinking += 1) });

    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'one ' });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'two' });
    port.emit({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    await running;

    expect(chunks.join('')).toBe('one two');
    expect(thinking).toBe(1);
  });

  it('ignores frames belonging to another request', async () => {
    const port = new FakePort();
    const chunks: string[] = [];
    const running = stream(port, { onText: (text: string) => chunks.push(text) });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'someone-else', text: 'not mine' });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'mine' });
    port.emit({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    await running;
    expect(chunks.join('')).toBe('mine');
  });

  it('rejects with the host\'s own message and remedy', async () => {
    const port = new FakePort();
    const running = stream(port);
    port.emit({
      ok: false,
      code: 'claude-logged-out',
      message: 'The Claude Code CLI is not logged in.',
      command: 'claude auth login',
      requestId: 'req-1',
    });

    const error = await failure(running);
    expect(error).toMatchObject({
      code: 'claude-logged-out',
      message: 'The Claude Code CLI is not logged in.',
      remedies: [{ command: 'claude auth login' }],
    });
    expect(port.disconnected).toBe(true);
  });

  it('does not sit on a spinner when the helper dies mid-stream', async () => {
    const port = new FakePort();
    const running = stream(port);
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'half a sen' });
    port.drop();
    expect(await failure(running)).toMatchObject({ code: 'claude-cli-failed' });
  });

  it('blames the missing helper when Chrome says why the port closed', async () => {
    const port = new FakePort();
    chromeStub.setLastError('Specified native messaging host not found.');
    const running = stream(port);
    port.drop();
    const error = await failure(running);
    expect(error).toMatchObject({ code: 'native-host-missing' });
    expect(error?.remedies[0]?.command).toBe('./bin/install-native-host.sh');
  });

  describe('cancelling', () => {
    it('tells the host to kill the child, then drops the port', async () => {
      const port = new FakePort();
      const controller = new AbortController();
      const running = stream(port, { signal: controller.signal });

      controller.abort();
      expect(await failure(running)).toMatchObject({ code: 'aborted' });
      expect(port.sent[1]).toEqual({ kind: 'claude-cancel', requestId: 'req-1' });
      expect(port.disconnected).toBe(true);
    });

    it('never starts a run that was cancelled before it began', async () => {
      const port = new FakePort();
      const controller = new AbortController();
      controller.abort();
      expect(await failure(stream(port, { signal: controller.signal }))).toMatchObject({ code: 'aborted' });
      expect(port.sent).toEqual([]);
    });

    it('ignores frames that arrive after the cancel', async () => {
      const port = new FakePort();
      const controller = new AbortController();
      const chunks: string[] = [];
      const running = stream(port, { signal: controller.signal, onText: (t: string) => chunks.push(t) });

      port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'before' });
      controller.abort();
      port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'after' });
      port.drop();

      await failure(running);
      expect(chunks.join('')).toBe('before');
    });
  });
});

describe('host failures the panel has to act on', () => {
  it.each([
    ['claude-cli-missing', 'claude-cli-missing'],
    ['claude-logged-out', 'claude-logged-out'],
    ['claude-usage-limit', 'claude-usage-limit'],
    ['claude-cli-failed', 'claude-cli-failed'],
    ['vault-logged-out', 'vault-locked'],
    ['bad-request', 'key-fetch-failed'],
  ] as const)('maps %s onto %s', (hostCode, appCode) => {
    const error = hostFailureToAppError({ ok: false, code: hostCode, message: 'because', command: 'do-this' });
    expect(error.code).toBe(appCode);
    expect(error.remedies).toHaveLength(1);
  });

  it('offers no remedy when the host had no command to give', () => {
    expect(hostFailureToAppError({ ok: false, code: 'claude-cli-failed', message: 'x' }).remedies).toEqual([]);
  });
});

describe('the two providers are interchangeable', () => {
  const codeReply = ['Here it is.\n\n```js\n', 'const seen = new Map();\n', '```\n\nThat is the shape.'];

  /** Runs one turn on Claude Code, replaying `chunks` as the CLI's deltas. */
  async function viaClaudeCode(rung: Rung, chunks: string[]): Promise<{ output: string; port: FakePort }> {
    const port = new FakePort();
    let output = '';
    const running = runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung }),
      stream: claudeCodeProvider({ connect: () => port }),
      onText: (text) => {
        output += text;
      },
    });
    // The port is opened synchronously inside the provider.
    await Promise.resolve();
    for (const text of chunks) port.emit({ ok: true, kind: 'claude-delta', requestId: port.start.requestId, text });
    port.emit({ ok: true, kind: 'claude-done', requestId: port.start.requestId });
    await running;
    return { output, port };
  }

  it('sends the rung-gated system prompt to the CLI, not a Claude Code one', async () => {
    const { port } = await viaClaudeCode(1, ['ok']);
    expect(port.start.system).toContain('You are at rung 1 - Pattern smell');
    expect(port.start.system).toContain('Rung 2 (Name the technique) is LOCKED');
    expect(port.start.prompt).toContain('# SESSION');
    expect(port.start.prompt).toContain('Unlocked rung: 1');
  });

  it.each([0, 1, 2, 3] satisfies Rung[])('runs the spoiler guard over a rung %i Claude Code reply', async (rung) => {
    const { output } = await viaClaudeCode(rung, codeReply);
    expect(output).not.toContain('new Map()');
    expect(output).not.toContain('```');
    expect(output).toContain(WITHHELD_NOTICE.trim());
    expect(output).toContain('Here it is.');
    expect(output).toContain('That is the shape.');
  });

  it.each([4, 5] satisfies Rung[])('lets code through at rung %i on Claude Code too', async (rung) => {
    const { output } = await viaClaudeCode(rung, codeReply);
    expect(output).toContain('const seen = new Map();');
  });

  it('redacts identically on both providers, byte for byte', async () => {
    const mock = mockAnthropic(sseBody(codeReply));
    let viaApi = '';
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 2 }),
      stream: apiKeyProvider({ apiKey: 'sk-test', fetchImpl: mock.impl }),
      onText: (text) => {
        viaApi += text;
      },
    });
    const { output: viaCli } = await viaClaudeCode(2, codeReply);
    expect(viaCli).toBe(viaApi);
  });

  it('sends the same system prompt to both', async () => {
    const mock = mockAnthropic(sseBody(['ok']));
    await runInterviewTurn({
      model: 'claude-sonnet-5',
      request: askRequest({ rung: 3 }),
      stream: apiKeyProvider({ apiKey: 'sk-test', fetchImpl: mock.impl }),
      onText: () => undefined,
    });
    const viaApi = (mock.calls[0]!.body['system'] as { text: string }[])[0]!.text;
    const { port } = await viaClaudeCode(3, ['ok']);
    expect(port.start.system).toBe(viaApi);
  });

  it('never reaches the vault on the Claude Code path', async () => {
    const { port } = await viaClaudeCode(1, ['ok']);
    for (const message of port.sent) {
      expect((message as { kind: string }).kind).not.toBe('get-api-key');
    }
  });
});

describe('the provider setting', () => {
  it('defaults to Claude Code', async () => {
    expect(DEFAULT_SETTINGS.provider).toBe('claude-code');
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a switch back to the API key', async () => {
    await expect(setSettings({ provider: 'api-key', model: 'claude-opus-5' })).resolves.toEqual({
      provider: 'api-key',
      model: 'claude-opus-5',
    });
    await expect(getSettings()).resolves.toEqual({ provider: 'api-key', model: 'claude-opus-5' });
  });

  it('keeps the model when reading settings written before providers existed', async () => {
    chromeStub.store['socrates:settings'] = { model: 'claude-opus-5' };
    await expect(getSettings()).resolves.toEqual({ provider: 'claude-code', model: 'claude-opus-5' });
  });

  it('refuses a provider or model it does not know', async () => {
    const stored = { provider: 'chatgpt', model: 'gpt-9' } as unknown as Parameters<typeof setSettings>[0];
    await expect(setSettings(stored)).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('saving a settings change', () => {
  /**
   * A worker stand-in that answers writes only when told to, and in whatever
   * order it is told to - the two ways this used to go wrong.
   */
  function fakeWorker() {
    const pending: { settings: Settings; resolve(): void; reject(error: AppError): void }[] = [];
    const shown: Settings[] = [];
    const errors: AppError[] = [];
    /** What the worker's storage holds, written in the order writes arrive. */
    let stored: Settings = { ...DEFAULT_SETTINGS };

    const writer = createSettingsWriter({
      save: (settings) =>
        new Promise<Settings>((resolvePromise, rejectPromise) => {
          pending.push({
            settings,
            resolve: () => {
              stored = settings;
              resolvePromise(settings);
            },
            reject: rejectPromise,
          });
        }),
      onSettings: (settings) => shown.push(settings),
      onError: (error) => errors.push(error),
    });

    return {
      writer,
      pending,
      shown,
      errors,
      get stored(): Settings {
        return stored;
      },
      get displayed(): Settings | undefined {
        return shown.at(-1);
      },
      /** Let the microtask queue - and therefore the write chain - run on. */
      settle: () => new Promise<void>((r) => setTimeout(r, 0)),
    };
  }

  it('keeps both changes when provider and model are switched back to back', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ provider: 'claude-code', model: 'claude-sonnet-5' });

    // Faster than a round trip: the second handler used to read the state as it
    // was before the first, and write a whole object that undid it.
    worker.writer.patch({ provider: 'api-key' });
    worker.writer.patch({ model: 'claude-opus-5' });

    expect(worker.displayed).toEqual({ provider: 'api-key', model: 'claude-opus-5' });

    await worker.settle();
    worker.pending[0]?.resolve();
    await worker.settle();
    worker.pending[1]?.resolve();
    await worker.settle();

    expect(worker.stored).toEqual({ provider: 'api-key', model: 'claude-opus-5' });
    expect(worker.displayed).toEqual({ provider: 'api-key', model: 'claude-opus-5' });
  });

  it('serialises writes, so the worker sees them in the order they were made', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ provider: 'claude-code', model: 'claude-sonnet-5' });

    worker.writer.patch({ provider: 'api-key' });
    worker.writer.patch({ model: 'claude-opus-5' });
    await worker.settle();

    // The second write is not even issued until the first has answered, so the
    // worker cannot apply them out of order.
    expect(worker.pending).toHaveLength(1);
    expect(worker.pending[0]?.settings).toEqual({ provider: 'api-key', model: 'claude-sonnet-5' });

    worker.pending[0]?.resolve();
    await worker.settle();

    expect(worker.pending).toHaveLength(2);
    expect(worker.pending[1]?.settings).toEqual({ provider: 'api-key', model: 'claude-opus-5' });
  });

  it('ignores a reply that a later change has already superseded', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ provider: 'claude-code', model: 'claude-sonnet-5' });

    worker.writer.patch({ provider: 'api-key' });
    await worker.settle();
    worker.writer.patch({ provider: 'claude-code' });

    // The first write answers after the user has already changed their mind.
    worker.pending[0]?.resolve();
    await worker.settle();

    expect(worker.displayed?.provider).toBe('claude-code');
  });

  it('undoes the optimistic value when the write fails, and says why', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ provider: 'claude-code', model: 'claude-sonnet-5' });

    worker.writer.patch({ provider: 'api-key' });
    expect(worker.displayed?.provider).toBe('api-key');

    await worker.settle();
    worker.pending[0]?.reject(appError('api-error', 'storage is full'));
    await worker.settle();

    expect(worker.displayed).toEqual({ provider: 'claude-code', model: 'claude-sonnet-5' });
    expect(worker.errors).toHaveLength(1);
    expect(worker.errors[0]?.message).toBe('storage is full');
  });

  it('does not undo anything when a newer change is already on its way', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ provider: 'claude-code', model: 'claude-sonnet-5' });

    worker.writer.patch({ provider: 'api-key' });
    await worker.settle();
    worker.writer.patch({ model: 'claude-opus-5' });

    worker.pending[0]?.reject(appError('api-error', 'transient'));
    await worker.settle();

    // The newer intent stands; only the failure is reported.
    expect(worker.displayed).toEqual({ provider: 'api-key', model: 'claude-opus-5' });
    expect(worker.errors).toHaveLength(1);
  });
});
