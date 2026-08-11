/**
 * The panel↔worker transport, across the life of a session.
 *
 * This file exists because of issue #10, and the shape of that bug is the reason
 * it is worth a file of its own. Nothing was wrong with any single request. The
 * panel worked, then a user read a hint for fifty seconds, and every request
 * after that fell into a hole - because Chrome had stopped the idle MV3 service
 * worker in the meantime and `PortClient` held exactly one port and never looked
 * at it again. A test of one request could not have caught it; what these tests
 * assert is that the transport survives *time* and *repetition*.
 *
 * So the two failure modes of a dead port are both driven here, because which
 * one the panel gets is a race with Chrome delivering the disconnect:
 *
 * - the disconnect arrives first, and the next `postMessage` throws;
 * - the message is dropped first, and the disconnect explains it afterwards.
 *
 * Before the fix the first wedged the spinner forever (the throw escapes `ask`,
 * which posts outside any promise) and the second left a promise that never
 * settled. Both now end in a frame the panel can act on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ONE_SHOT_TIMEOUT_MS, PortClient, type PanelPort } from '../src/panel/port-client.ts';
import type { PanelRequest, WorkerFrame } from '../src/shared/protocol.ts';
import { DEFAULT_SETTINGS, type AppError } from '../src/shared/types.ts';
import { askRequest } from './helpers.ts';

/**
 * A port that can be told to die the way Chrome kills them.
 *
 * `stopWorker` is the ordinary case - the disconnect is delivered, and only then
 * does a post throw. `stopWorkerSilently` is the race: the channel is already
 * gone but the panel has not been told, so the post is swallowed.
 */
class FakePanelPort implements PanelPort {
  readonly sent: PanelRequest[] = [];
  live = true;
  /** True once the panel has been told. Until then a post is dropped, not thrown. */
  announced = false;
  #onMessage: ((frame: WorkerFrame) => void)[] = [];
  #onDisconnect: (() => void)[] = [];

  readonly onMessage = {
    addListener: (callback: (frame: WorkerFrame) => void): void =>
      void this.#onMessage.push(callback),
  };
  readonly onDisconnect = {
    addListener: (callback: () => void): void => void this.#onDisconnect.push(callback),
  };

  postMessage(message: unknown): void {
    if (!this.live && this.announced)
      throw new Error('Attempting to use a disconnected port object');
    if (!this.live) return; // dropped on the floor, exactly as Chrome does
    this.sent.push(message as PanelRequest);
  }

  emit(frame: WorkerFrame): void {
    for (const listener of [...this.#onMessage]) listener(frame);
  }

  /** Chrome stops the idle worker and tells the panel. */
  stopWorker(): void {
    this.live = false;
    this.announced = true;
    for (const listener of [...this.#onDisconnect]) listener();
  }

  /** Chrome stops the idle worker; the panel has not heard yet. */
  stopWorkerSilently(): void {
    this.live = false;
  }

  /** The disconnect finally lands. */
  announce(): void {
    this.announced = true;
    for (const listener of [...this.#onDisconnect]) listener();
  }

  get last(): PanelRequest | undefined {
    return this.sent.at(-1);
  }
}

/** A `PortClient` over ports this test can kill, plus every port it ever opened. */
function clientOverFakes(): { client: PortClient; ports: FakePanelPort[] } {
  const ports: FakePanelPort[] = [];
  const client = new PortClient(() => {
    const port = new FakePanelPort();
    ports.push(port);
    return port;
  });
  return { client, ports };
}

/** Answers whatever one-shot request is outstanding on the newest live port. */
function answerSettings(port: FakePanelPort): void {
  const request = port.last;
  if (request === undefined) throw new Error('nothing was sent');
  port.emit({ id: request.id, kind: 'settings', settings: DEFAULT_SETTINGS });
}

describe('the panel keeps talking to a worker Chrome keeps stopping', () => {
  it('opens exactly one port for a session that never goes quiet', async () => {
    const { client, ports } = clientOverFakes();

    for (let turn = 0; turn < 5; turn += 1) {
      const pending = client.getSettings();
      answerSettings(ports[0]!);
      await expect(pending).resolves.toEqual(DEFAULT_SETTINGS);
    }

    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent).toHaveLength(5);
  });

  it('reconnects for the next request after the idle worker is stopped', async () => {
    const { client, ports } = clientOverFakes();

    const first = client.getSettings();
    answerSettings(ports[0]!);
    await expect(first).resolves.toEqual(DEFAULT_SETTINGS);

    // The user reads the answer for longer than Chrome's 30s idle timeout.
    ports[0]!.stopWorker();

    // This is the request that used to disappear.
    const second = client.getSettings();
    expect(ports).toHaveLength(2);
    answerSettings(ports[1]!);
    await expect(second).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('reconnects when the disconnect has not been delivered yet', async () => {
    const { client, ports } = clientOverFakes();
    // Silent death: the post is dropped and nothing throws, which is the shape
    // that used to leave a promise pending forever.
    ports[0]!.stopWorkerSilently();

    const pending = client.getSettings();
    // Nothing reached the dead port, and the panel has not yet been told.
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent).toHaveLength(0);

    // Chrome delivers the disconnect a moment later. That is what rescues it.
    ports[0]!.announce();
    await expect(pending).rejects.toMatchObject({ code: 'worker-restarted' });

    // And the panel is usable again immediately afterwards.
    const next = client.getSettings();
    expect(ports).toHaveLength(2);
    answerSettings(ports[1]!);
    await expect(next).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('retries on a fresh port when the post throws, rather than losing the request', async () => {
    const { client, ports } = clientOverFakes();
    // Killed *and* announced, but with the client's disconnect listener never
    // having run - the state a torn-down channel leaves between IPC hops.
    ports[0]!.live = false;
    ports[0]!.announced = true;

    const pending = client.getSettings();
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent).toHaveLength(1);
    answerSettings(ports[1]!);
    await expect(pending).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('reports an unreachable worker rather than throwing out of the click handler', () => {
    // `chrome.runtime.connect` throws once the extension context is invalidated -
    // after a reload, say. `ask` calls `#send` outside any promise, so a throw
    // escaping here lands in a click handler that has already started the
    // spinner, which is precisely how the original bug became a hang.
    const ports: FakePanelPort[] = [];
    let refuse = false;
    const client = new PortClient(() => {
      if (refuse) throw new Error('Extension context invalidated.');
      const port = new FakePanelPort();
      ports.push(port);
      return port;
    });
    // The worker goes away, and then reconnecting is refused too.
    ports[0]!.stopWorker();
    refuse = true;

    let failure: AppError | null = null;
    expect(() =>
      client.ask(askRequest(), {
        onDelta: () => undefined,
        onStarted: () => undefined,
        onThinking: () => undefined,
        onDone: () => undefined,
        onError: (error) => void (failure = error),
      }),
    ).not.toThrow();
    expect(failure).not.toBeNull();
    expect(client.inFlight).toBe(0);
  });

  it('does not leak a handler per turn across a long session', async () => {
    const { client, ports } = clientOverFakes();

    for (let turn = 0; turn < 30; turn += 1) {
      if (turn % 3 === 0) ports.at(-1)!.stopWorker();
      const pending = client.getSettings().catch(() => DEFAULT_SETTINGS);
      const port = ports.at(-1)!;
      if (port.last !== undefined) answerSettings(port);
      await pending;
    }

    // Nothing outstanding once the session settles: the map is the only thing
    // in this class that could grow without bound.
    expect(client.inFlight).toBe(0);
  });
});

describe('a turn interrupted by the worker stopping', () => {
  it('fails the ask instead of leaving the spinner up', () => {
    const { client, ports } = clientOverFakes();
    const seen: string[] = [];
    let failure: AppError | null = null;

    client.ask(askRequest(), {
      onDelta: (text) => void seen.push(text),
      onStarted: () => undefined,
      onThinking: () => undefined,
      onDone: () => void seen.push('<done>'),
      onError: (error) => void (failure = error),
    });

    const request = ports[0]!.last!;
    ports[0]!.emit({ id: request.id, kind: 'started' });
    ports[0]!.emit({ id: request.id, kind: 'delta', text: 'Consider the ' });

    // Chrome stops the worker mid-stream. The `claude` child dies with it, so
    // there is no reply coming and the panel has to be told.
    ports[0]!.stopWorker();

    expect(seen).toEqual(['Consider the ']);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe('worker-restarted');
    // Not `aborted`: the panel shows aborted silently, and this was not the
    // user's doing.
    expect(failure!.code).not.toBe('aborted');
  });

  it('never re-sends the turn on its own', () => {
    const { client, ports } = clientOverFakes();
    client.ask(askRequest(), {
      onDelta: () => undefined,
      onStarted: () => undefined,
      onThinking: () => undefined,
      onDone: () => undefined,
      onError: () => undefined,
    });
    ports[0]!.stopWorker();

    // A turn costs the user's own Max window. Reconnecting is the panel's call;
    // spending again is not.
    expect(ports).toHaveLength(1);
    const resent = ports.flatMap((port) => port.sent).filter((sent) => sent.kind === 'ask');
    expect(resent).toHaveLength(1);
  });

  it('lets the very next turn through on a fresh port', () => {
    const { client, ports } = clientOverFakes();
    const failures: AppError[] = [];
    const callbacks = {
      onDelta: () => undefined,
      onStarted: () => undefined,
      onThinking: () => undefined,
      onDone: () => undefined,
      onError: (error: AppError) => void failures.push(error),
    };

    client.ask(askRequest(), callbacks);
    ports[0]!.stopWorker();
    expect(failures).toHaveLength(1);

    client.ask(askRequest(), callbacks);
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent.filter((sent) => sent.kind === 'ask')).toHaveLength(1);
  });

  it('ignores the death of a port that has already been replaced', () => {
    const { client, ports } = clientOverFakes();
    ports[0]!.stopWorker();

    const pending = client.getSettings().catch((error: AppError) => error);
    expect(ports).toHaveLength(2);

    // The old port's disconnect fires again (Chrome is entitled to). It must not
    // take down a request riding the new one.
    ports[0]!.stopWorker();
    answerSettings(ports[1]!);
    return expect(pending).resolves.toEqual(DEFAULT_SETTINGS);
  });
});

describe('a one-shot request that is answered by nothing at all', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up rather than leaving the panel unable to answer a click', async () => {
    const { client } = clientOverFakes();
    // No answer, no disconnect: the content script wedged, or a frame was lost
    // somewhere Chrome does not report. `snapshotForTurn` awaits this, so an
    // unbounded wait means the user's click silently does nothing.
    const pending = client.capture(7);
    const settled = expect(pending).rejects.toMatchObject({ code: 'api-error' });
    await vi.advanceTimersByTimeAsync(ONE_SHOT_TIMEOUT_MS + 1);
    await settled;
  });

  it('does not fire for a request that was answered in time', async () => {
    const { client, ports } = clientOverFakes();
    const pending = client.getSettings();
    answerSettings(ports[0]!);
    await expect(pending).resolves.toEqual(DEFAULT_SETTINGS);
    await vi.advanceTimersByTimeAsync(ONE_SHOT_TIMEOUT_MS * 2);
    expect(client.inFlight).toBe(0);
  });

  it('does not bound a streaming turn, which legitimately runs for minutes', async () => {
    const { client, ports } = clientOverFakes();
    let done = false;
    let failed: AppError | null = null;
    client.ask(askRequest(), {
      onDelta: () => undefined,
      onStarted: () => undefined,
      onThinking: () => undefined,
      onDone: () => void (done = true),
      onError: (error) => void (failed = error),
    });

    const request = ports[0]!.last!;
    await vi.advanceTimersByTimeAsync(ONE_SHOT_TIMEOUT_MS * 3);
    expect(failed).toBeNull();

    ports[0]!.emit({ id: request.id, kind: 'done' });
    expect(done).toBe(true);
  });
});
