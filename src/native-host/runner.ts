/**
 * Runs one `claude` turn and forwards it frame by frame.
 *
 * Split out of `main.ts` for the same reason `handler.ts` is: `main.ts` reads
 * real stdin and writes real stdout at module scope, so nothing in it can be
 * exercised by a test. Here the child process and the output sink are both
 * injected, which is what lets `tests/claude-host.test.ts` drive the whole path
 * - argv, stdin, streaming, cancellation - against a fake `claude` binary.
 */

import type { spawn as nodeSpawn, ChildProcess } from 'node:child_process';

import {
  ASSISTANT_RESULT_SUBTYPE,
  CLAUDE_ENV,
  LineSplitter,
  claudeArgs,
  parseClaudeLine,
  type RateLimitState,
} from './claude.ts';
import { classifyClaudeFailure, claudeMissing, findClaude, type HostDeps } from './handler.ts';
import type { HostRequest, HostResponse } from './protocol.ts';

/** A model turn is not a `dcli read`; Opus at rung 5 can legitimately take minutes. */
export const CLAUDE_TIMEOUT_MS = 5 * 60_000;
/** How long a cancelled child gets to exit on its own before SIGKILL. */
export const KILL_GRACE_MS = 2_000;

export interface ClaudeRunDeps extends HostDeps {
  spawn: typeof nodeSpawn;
  /** Where the child runs. A directory with none of the user's config in it. */
  cwd: string;
  timeoutMs?: number;
}

export type ClaudeStartRequest = Extract<HostRequest, { kind: 'claude-start' }>;

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const hard = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  hard.unref();
  child.once('close', () => clearTimeout(hard));
}

/**
 * Starts a turn. Returns the cancel function for it - calling that kills the
 * child and suppresses any further frames, because a killed run is not a
 * failure to explain, it is a run the user called off.
 */
export function startClaudeRun(
  request: ClaudeStartRequest,
  deps: ClaudeRunDeps,
  emit: (response: HostResponse) => void,
): () => void {
  const { requestId } = request;
  const lookup = findClaude(deps);
  if (lookup.path === null) {
    emit({ ...claudeMissing(lookup), requestId } as HostResponse);
    return () => undefined;
  }

  const child = deps.spawn(lookup.path, claudeArgs({ model: request.model, system: request.system }), {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: deps.cwd,
    env: { ...process.env, ...CLAUDE_ENV },
  });

  const splitter = new LineSplitter();
  let rateLimit: RateLimitState | null = null;
  let result: { isError: boolean; message: string; apiErrorStatus: number | null; subtype: string } | null = null;
  let sawText = false;
  let sawThinking = false;
  let cancelled = false;
  let stderr = '';
  let spawnErrorCode: string | undefined;

  const timeoutMs = deps.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  const timer = setTimeout(() => {
    stderr += `\nSocrates gave up waiting after ${Math.round(timeoutMs / 1000)}s.`;
    killChild(child);
  }, timeoutMs);
  timer.unref?.();

  const consume = (line: string): void => {
    const event = parseClaudeLine(line);
    if (event === null) return;
    switch (event.kind) {
      case 'text':
        sawText = true;
        emit({ ok: true, kind: 'claude-delta', requestId, text: event.text });
        break;
      case 'thinking':
        if (!sawThinking) {
          sawThinking = true;
          emit({ ok: true, kind: 'claude-thinking', requestId });
        }
        break;
      case 'rate-limit':
        rateLimit = { status: event.status, resetsAt: event.resetsAt };
        break;
      case 'result':
        result = {
          isError: event.isError,
          message: event.message,
          apiErrorStatus: event.apiErrorStatus,
          subtype: event.subtype,
        };
        break;
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of splitter.push(chunk.toString('utf8'))) consume(line);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnErrorCode = error.code ?? 'SPAWN_FAILED';
  });

  child.on('close', () => {
    clearTimeout(timer);
    for (const line of splitter.flush()) consume(line);
    if (cancelled) return;

    const outcome = result;
    /*
     * The deltas are the reply. The fallback exists only for a future CLI that
     * stops emitting partial messages, where a whole answer at once beats a
     * blank panel - and it is allowed only when the result frame says the field
     * holds assistant text. Every other subtype puts a CLI diagnostic there, and
     * forwarding one would print the CLI's complaint as though the interviewer
     * had said it. `is_error: false` is not enough on its own: it has been seen
     * alongside subtypes that carry no reply at all.
     */
    const fallbackText =
      !sawText && outcome !== null && outcome.subtype === ASSISTANT_RESULT_SUBTYPE ? outcome.message : '';
    const haveReply = sawText || fallbackText !== '';

    if (spawnErrorCode === undefined && outcome !== null && !outcome.isError && haveReply) {
      if (fallbackText !== '') emit({ ok: true, kind: 'claude-delta', requestId, text: fallbackText });
      emit({ ok: true, kind: 'claude-done', requestId });
      return;
    }

    // Falling through means there is no reply to show. Saying nothing at all
    // would be the silent spinner this project refuses; the diagnostic still
    // reaches the user, quoted as claude's words rather than passed off as one.

    void classifyClaudeFailure(
      {
        message: outcome?.message ?? '',
        apiErrorStatus: outcome?.apiErrorStatus ?? null,
        rateLimit,
        ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
        stderr,
      },
      deps,
    )
      .then((failure) => emit({ ...failure, requestId } as HostResponse))
      .catch((error: unknown) => {
        emit({ ok: false, code: 'claude-cli-failed', message: String(error), requestId });
      });
  });

  // The transcript goes on stdin rather than argv: it carries the problem
  // statement and the whole editor buffer, which argv is the wrong size for.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(request.prompt, 'utf8');

  return () => {
    cancelled = true;
    clearTimeout(timer);
    killChild(child);
  };
}
