/**
 * What the panel is allowed to claim about a turn in flight.
 *
 * ## Why this is a module and not three `useState` calls
 *
 * The old panel had one boolean, `thinking`, and it lied in both directions: it
 * was true during CLI process startup, when nothing was thinking yet, and it
 * stayed true and motionless through a sixty-second think, which is
 * indistinguishable from a hang. The fix is not a nicer spinner, it is knowing
 * which of four different things is actually happening. That is a state machine,
 * and a state machine that decides whether to tell the user something is wrong
 * is worth testing, so it lives here as pure functions over a plain record.
 *
 * ## The phases, and what each one is evidence of
 *
 * - `connecting` - the request has gone out and not one frame has come back. On
 *   the Claude Code provider this is the ~1.7s the `claude` CLI takes to boot,
 *   measured; on the API-key provider it is the HTTP round trip.
 * - `thinking` - the transport said the turn is under way (`started`) but no
 *   answer text exists yet. Heartbeats keep arriving.
 * - `streaming` - text is arriving. This is the only phase with anything to read.
 *
 * ## Honesty about silence
 *
 * `liveness` is deliberately separate from `phase`, because it answers a
 * different question: not "what is happening" but "how sure are we that anything
 * is". Both providers pulse at least every ~700ms while thinking, so silence is
 * real evidence rather than an absent feature - but it is weak evidence. A
 * `stalled` panel therefore says the run is still going and has been quiet,
 * which is exactly what is known. It does not say "failed", because nothing has
 * failed, and it does not keep pretending, because it has been 25 seconds.
 *
 * The hard timeout sits *past* the host's own 5-minute cap on purpose. The host
 * writes a better error than this module ever could - it has stderr, the exit
 * code and `claude auth status` - so it should be the one to speak. This is only
 * the backstop that guarantees the spinner cannot spin forever if the host dies
 * without saying anything.
 */

export type TurnPhase = 'idle' | 'connecting' | 'thinking' | 'streaming';

/** How much the panel trusts that the turn is still alive. */
export type Liveness = 'live' | 'stalled' | 'timed-out';

/**
 * Generous by design. Both providers heartbeat every ~700ms, and the widest gap
 * seen in a measured healthy run was ~3s, so 25s of nothing is well outside
 * normal without being trigger-happy on a slow machine or a cold CLI start.
 */
export const STALL_AFTER_MS = 25_000;

/** Past `CLAUDE_TIMEOUT_MS` (5 min) so the host's own, better error wins the race. */
export const TIMEOUT_AFTER_MS = 6 * 60_000;

export interface TurnProgress {
  phase: TurnPhase;
  /** When the request went out. Drives the elapsed counter the user sees. */
  startedAt: number;
  /** When the last frame of any kind arrived. Drives `liveness`. */
  lastEventAt: number;
}

export const IDLE_PROGRESS: TurnProgress = { phase: 'idle', startedAt: 0, lastEventAt: 0 };

export function beginTurn(now: number): TurnProgress {
  return { phase: 'connecting', startedAt: now, lastEventAt: now };
}

/**
 * Every frame from the worker, folded in.
 *
 * Phases only ever move forward. A `started` frame arriving after text has begun
 * flowing must not drag the panel back to "thinking" - out-of-order frames are
 * cheap to guard against here and expensive to debug in a live session.
 */
export type TurnEvent = 'started' | 'thinking' | 'delta';

export function applyEvent(progress: TurnProgress, event: TurnEvent, now: number): TurnProgress {
  if (progress.phase === 'idle') return progress;

  const phase: TurnPhase =
    event === 'delta'
      ? 'streaming'
      : progress.phase === 'streaming'
        ? 'streaming'
        : event === 'started' || event === 'thinking'
          ? 'thinking'
          : progress.phase;

  return { ...progress, phase, lastEventAt: now };
}

export function livenessAt(progress: TurnProgress, now: number): Liveness {
  if (progress.phase === 'idle') return 'live';
  const silentFor = now - progress.lastEventAt;
  if (silentFor >= TIMEOUT_AFTER_MS) return 'timed-out';
  if (silentFor >= STALL_AFTER_MS) return 'stalled';
  return 'live';
}

/**
 * The words on screen. Kept here rather than in the component so the phrasing is
 * covered by the same tests that fix the state machine - the whole point of the
 * machine is that the label is true.
 */
export function progressLabel(progress: TurnProgress, liveness: Liveness): string {
  if (liveness === 'timed-out') return 'no response';
  if (liveness === 'stalled') {
    return progress.phase === 'streaming'
      ? 'still working - the reply paused'
      : 'still working - long think';
  }
  switch (progress.phase) {
    case 'connecting':
      return 'connecting…';
    case 'thinking':
      return 'thinking…';
    case 'streaming':
      return 'writing…';
    case 'idle':
      return '';
  }
}

/** Whole seconds since the request went out, for the counter beside the label. */
export function elapsedSeconds(progress: TurnProgress, now: number): number {
  if (progress.phase === 'idle') return 0;
  return Math.max(0, Math.floor((now - progress.startedAt) / 1000));
}
