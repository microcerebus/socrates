/**
 * That a turn in flight is legible: what the CLI's frames mean, what the host
 * forwards, what the panel is allowed to claim about it, and how arrived text
 * gets onto the screen.
 *
 * The load-bearing claim here is that every statement the panel makes about a
 * running turn is backed by an event it actually received. The old panel had one
 * boolean and made three claims with it, two of which were wrong. So the
 * assertions below are mostly about what the panel refuses to say.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseClaudeLine } from '../src/native-host/claude.ts';
import { DEFAULT_CONFIG, parseConfig } from '../src/native-host/config.ts';
import type { HostResponse } from '../src/native-host/protocol.ts';
import {
  THINKING_PULSE_MS,
  startClaudeRun,
  type ClaudeRunDeps,
} from '../src/native-host/runner.ts';
import {
  IDLE_PROGRESS,
  STALL_AFTER_MS,
  TIMEOUT_AFTER_MS,
  applyEvent,
  beginTurn,
  elapsedSeconds,
  livenessAt,
  progressLabel,
} from '../src/panel/turn-progress.ts';
import { REVEAL_WINDOW_MS, charsToReveal, createTypewriter } from '../src/panel/typewriter.ts';

const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');

// --- reading the CLI's frames ------------------------------------------------

describe('parsing the stream the CLI actually emits', () => {
  const frame = (value: unknown): string => JSON.stringify(value);

  it('treats the init frame as the end of the connecting phase', () => {
    expect(
      parseClaudeLine(frame({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' })),
    ).toEqual({
      kind: 'started',
    });
  });

  it('ignores system frames that are not init, rather than guessing at them', () => {
    expect(parseClaudeLine(frame({ type: 'system', subtype: 'something_new' }))).toBeNull();
  });

  it('reads a thinking delta as liveness', () => {
    expect(
      parseClaudeLine(
        frame({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'the answer is 42' },
          },
        }),
      ),
    ).toEqual({ kind: 'thinking' });
  });

  /*
   * The one that matters most in this file. Extended thinking drafts the answer
   * - in a measured run at rung 1 the thinking block contained a complete draft
   * of the reply - so a `thinking` event carrying its text would route the whole
   * answer around the rung ladder.
   */
  it('never carries thinking text out of the parser', () => {
    const event = parseClaudeLine(
      frame({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'use a hash map' },
        },
      }),
    );
    expect(event).toEqual({ kind: 'thinking' });
    expect(JSON.stringify(event)).not.toContain('hash map');
  });

  it('still reads text deltas as the reply', () => {
    expect(
      parseClaudeLine(
        frame({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        }),
      ),
    ).toEqual({ kind: 'text', text: 'hi' });
  });
});

// --- what the host forwards --------------------------------------------------

describe('liveness from a real child process', { timeout: 30_000 }, () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'socrates-live-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function runDeps(overrides: Partial<ClaudeRunDeps> = {}): ClaudeRunDeps {
    return {
      config: parseConfig(JSON.stringify({ ...DEFAULT_CONFIG, claudePath: FAKE_CLAUDE })),
      home: '/home/tester',
      exists: () => true,
      run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
      spawn,
      cwd: scratch,
      timeoutMs: 15_000,
      ...overrides,
    };
  }

  function collect(scenario: string, deps: ClaudeRunDeps): Promise<HostResponse[]> {
    return new Promise((resolvePromise, rejectPromise) => {
      const frames: HostResponse[] = [];
      const timer = setTimeout(
        () => rejectPromise(new Error(`${scenario} never finished`)),
        20_000,
      );
      startClaudeRun(
        {
          kind: 'claude-start',
          requestId: 'req-1',
          model: scenario,
          system: 'SYSTEM',
          prompt: 'PROMPT',
        },
        deps,
        (frame) => {
          frames.push(frame);
          if (!frame.ok || frame.kind === 'claude-done') {
            clearTimeout(timer);
            resolvePromise(frames);
          }
        },
      );
    });
  }

  const kinds = (frames: HostResponse[]): string[] =>
    frames.map((frame) => (frame.ok ? frame.kind : `failure:${frame.code}`));

  it('announces the CLI is up before it announces it is thinking', async () => {
    const frames = await collect('scenario-long-think', runDeps());
    const order = kinds(frames);
    expect(order[0]).toBe('claude-started');
    expect(order.indexOf('claude-thinking')).toBeGreaterThan(0);
    expect(order.indexOf('claude-delta')).toBeGreaterThan(order.indexOf('claude-thinking'));
    expect(order.at(-1)).toBe('claude-done');
  });

  /*
   * Forty thinking deltas arrive in a burst here, as they do on a fast machine.
   * Forwarding one native-messaging frame and one React render per delta is pure
   * waste; the panel only needs to know the run is alive often enough that 25
   * seconds of silence still means something.
   */
  it('throttles the heartbeat instead of forwarding every thinking delta', async () => {
    let clock = 0;
    const frames = await collect(
      'scenario-long-think',
      runDeps({ now: () => (clock += 100), pulseMs: 700 }),
    );
    const pulses = frames.filter((frame) => frame.ok && frame.kind === 'claude-thinking');
    expect(pulses.length).toBeGreaterThan(0);
    expect(pulses.length).toBeLessThan(10);
  });

  it('keeps pulsing when the clock really moves, so a long think never looks frozen', async () => {
    let clock = 0;
    const frames = await collect(
      'scenario-long-think',
      runDeps({ now: () => (clock += 5_000), pulseMs: 700 }),
    );
    const pulses = frames.filter((frame) => frame.ok && frame.kind === 'claude-thinking');
    expect(pulses.length).toBeGreaterThan(5);
  });

  it('stops pulsing once there is text to look at instead', async () => {
    let clock = 0;
    const frames = await collect('scenario-long-think', runDeps({ now: () => (clock += 5_000) }));
    const firstDelta = frames.findIndex((frame) => frame.ok && frame.kind === 'claude-delta');
    const after = frames.slice(firstDelta);
    expect(after.some((frame) => frame.ok && frame.kind === 'claude-thinking')).toBe(false);
  });

  it("has a pulse floor that is well inside the panel's stall window", () => {
    expect(THINKING_PULSE_MS).toBeLessThan(STALL_AFTER_MS / 10);
  });
});

// --- what the panel is allowed to claim --------------------------------------

describe('the phases of a turn', () => {
  const T0 = 1_000_000;

  it('starts by admitting it has heard nothing back yet', () => {
    const progress = beginTurn(T0);
    expect(progress.phase).toBe('connecting');
    expect(progressLabel(progress, 'live')).toBe('connecting…');
  });

  it('only says "thinking" once the transport says the turn is under way', () => {
    const progress = applyEvent(beginTurn(T0), 'started', T0 + 1_700);
    expect(progress.phase).toBe('thinking');
    expect(progressLabel(progress, 'live')).toBe('thinking…');
  });

  it('moves to streaming on the first delta', () => {
    const progress = applyEvent(applyEvent(beginTurn(T0), 'started', T0 + 1), 'delta', T0 + 2_400);
    expect(progress.phase).toBe('streaming');
    expect(progressLabel(progress, 'live')).toBe('writing…');
  });

  /*
   * The CLI emits `rate_limit_event` and other frames after the text has begun,
   * and a heartbeat can race a delta. Dragging the panel back to "thinking"
   * while words are visibly appearing would be an obvious lie.
   */
  it('never falls back from streaming to thinking on a late heartbeat', () => {
    const streaming = applyEvent(beginTurn(T0), 'delta', T0 + 100);
    expect(applyEvent(streaming, 'thinking', T0 + 200).phase).toBe('streaming');
    expect(applyEvent(streaming, 'started', T0 + 200).phase).toBe('streaming');
  });

  it('ignores stray events once the turn is over', () => {
    expect(applyEvent(IDLE_PROGRESS, 'delta', T0)).toBe(IDLE_PROGRESS);
  });

  it('counts elapsed seconds from the request, not from the first frame', () => {
    const progress = applyEvent(beginTurn(T0), 'started', T0 + 9_000);
    expect(elapsedSeconds(progress, T0 + 12_400)).toBe(12);
  });
});

describe('the stall detector', () => {
  const T0 = 1_000_000;
  const thinkingSince = (at: number): ReturnType<typeof beginTurn> =>
    applyEvent(beginTurn(T0), 'thinking', at);

  it('calls a normal gap between heartbeats live', () => {
    const progress = thinkingSince(T0 + 1_000);
    expect(livenessAt(progress, T0 + 4_000)).toBe('live');
  });

  it('says so, honestly, once the run has gone quiet', () => {
    const progress = thinkingSince(T0 + 1_000);
    const at = T0 + 1_000 + STALL_AFTER_MS;
    expect(livenessAt(progress, at)).toBe('stalled');
    expect(progressLabel(progress, 'stalled')).toBe('still working - long think');
  });

  it('does not claim failure while stalled - the run is still going', () => {
    const progress = thinkingSince(T0);
    expect(progressLabel(progress, 'stalled')).toContain('still working');
  });

  it('distinguishes a paused reply from a long think', () => {
    const streaming = applyEvent(beginTurn(T0), 'delta', T0 + 500);
    expect(progressLabel(streaming, 'stalled')).toBe('still working - the reply paused');
  });

  it('recovers the moment another frame arrives', () => {
    const stalled = thinkingSince(T0);
    const at = T0 + STALL_AFTER_MS + 5_000;
    expect(livenessAt(stalled, at)).toBe('stalled');
    expect(livenessAt(applyEvent(stalled, 'thinking', at), at)).toBe('live');
  });

  it('escalates to a timeout only after the host has had its own chance to explain', () => {
    const progress = thinkingSince(T0);
    expect(livenessAt(progress, T0 + TIMEOUT_AFTER_MS - 1)).toBe('stalled');
    expect(livenessAt(progress, T0 + TIMEOUT_AFTER_MS)).toBe('timed-out');
    // The host's own five-minute cap fires first, so its better-worded failure
    // reaches the panel before this backstop ever does.
    expect(TIMEOUT_AFTER_MS).toBeGreaterThan(5 * 60_000);
  });

  it('never reports a stall when nothing is running', () => {
    expect(livenessAt(IDLE_PROGRESS, Date.now())).toBe('live');
  });
});

// --- getting arrived text onto the screen ------------------------------------

describe('pacing the reply', () => {
  it('scales the step to the backlog rather than using a fixed rate', () => {
    // A 150-character block is what the CLI actually hands over. A block ten
    // times the size has to move ten times as fast, or the display falls behind.
    const small = charsToReveal(150, 16, REVEAL_WINDOW_MS);
    const large = charsToReveal(1_500, 16, REVEAL_WINDOW_MS);
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(150);
    expect(large).toBeGreaterThan(small * 5);
  });

  it('always moves at least one character, so a tail cannot stick', () => {
    expect(charsToReveal(1, 1, 10_000)).toBe(1);
  });

  it('reveals everything at once when the window is zero, for reduced motion', () => {
    expect(charsToReveal(500, 16, 0)).toBe(500);
  });

  it('never reveals more than has arrived', () => {
    expect(charsToReveal(4, 1_000, REVEAL_WINDOW_MS)).toBe(4);
  });

  it('shows only text the model has actually sent', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    writer.push('sliding window');
    writer.tick(16);
    expect(writer.full.startsWith(writer.visible)).toBe(true);
    expect(writer.visible.length).toBeLessThan('sliding window'.length);
  });

  /*
   * The property that makes this pacing rather than lying: replayed against the
   * arrival pattern measured from the real CLI - a ~150-character block roughly
   * every 500ms - the display settles a fixed short distance behind the model
   * and stays there. A fixed characters-per-second would drift further behind
   * with every block until the panel was minutes out of date.
   */
  it('holds a bounded lag behind a realistic arrival pattern instead of drifting', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    const FRAME_MS = 16;
    const FRAMES_PER_BLOCK = Math.round(500 / FRAME_MS);
    let worstLag = 0;

    for (let block = 0; block < 40; block += 1) {
      writer.push('x'.repeat(150));
      for (let frame = 0; frame < FRAMES_PER_BLOCK; frame += 1) {
        writer.tick(FRAME_MS);
        worstLag = Math.max(worstLag, writer.full.length - writer.visible.length);
      }
    }

    // Roughly one reveal window of text, and crucially not a function of how
    // many blocks have gone by.
    expect(worstLag).toBeLessThan(200);
  });

  it('empties a burst quickly once the model stops producing', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    for (let i = 0; i < 8; i += 1) writer.push('x'.repeat(150));
    for (let i = 0; i < 120; i += 1) writer.tick(16);
    expect(writer.settled).toBe(true);
  });

  it('settles exactly on what arrived, with nothing invented', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    writer.push('one ');
    writer.push('two');
    expect(writer.finish()).toBe('one two');
    expect(writer.settled).toBe(true);
  });

  it('finishes instantly at the end of a turn instead of animating the tail', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    writer.push('a'.repeat(4_000));
    expect(writer.finish()).toHaveLength(4_000);
    expect(writer.settled).toBe(true);
  });

  it('is a no-op on an empty stream', () => {
    const writer = createTypewriter(REVEAL_WINDOW_MS);
    expect(writer.tick(16)).toBe('');
    expect(writer.settled).toBe(true);
  });
});
