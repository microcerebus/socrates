/**
 * Driving the local `claude` CLI headlessly, and reading what comes back.
 *
 * ## Why these flags
 *
 * Every flag here was verified against the installed CLI rather than
 * remembered, because the ones that matter are the ones that fail silently.
 *
 * - `--print` with `--output-format stream-json --include-partial-messages
 *   --verbose` is the only combination that emits token-level `text_delta`
 *   frames. Without `--include-partial-messages` you get whole messages and the
 *   panel sits blank until the reply is finished.
 * - `--system-prompt` *replaces* Claude Code's own system prompt rather than
 *   appending to it. That was checked empirically (a replacement persona took
 *   over completely, and the request dropped from ~5.5k prompt tokens to ~250),
 *   and it is what makes the rung discipline the only instruction in force.
 *   `--append-system-prompt` would leave the coding-agent prompt underneath it.
 * - `--tools ""` leaves the session with an empty tool list, so the interviewer
 *   cannot read files, run commands, or loop. Combined with a single prompt this
 *   is single-turn generation: the CLI reports `num_turns: 1`.
 * - `--safe-mode`, `--setting-sources ""`, `--strict-mcp-config` and
 *   `--disable-slash-commands` keep the machine's own Claude Code configuration
 *   - CLAUDE.md files, hooks, MCP servers, skills - out of an interview.
 * - `--no-session-persistence` because the transcript is resent every call; the
 *   CLI's own session store would be a second, divergent copy.
 *
 * ## Multi-turn is flattened, not resumed
 *
 * `--input-format stream-json` looks like a way to replay a message array, but
 * it does not prime history: it re-runs the model once per user message in the
 * stream. So the transcript is flattened into one prompt (see
 * `flattenMessages` in `src/background/interview.ts`) and sent on stdin, which
 * is one model call and keeps the host stateless.
 *
 * ## What the frames actually look like, measured
 *
 * Timed against CLI 2.1.226 with exactly the flags below (see the PR that added
 * this note). One turn, ~150 words out of Sonnet 5:
 *
 * ```
 *  1650ms  system/init          <- the CLI has booted and is about to call the API
 *  1917ms  content_block_start:thinking
 *  ...     thinking_delta       <- every 25-300ms, occasionally a ~3s gap
 *  2358ms  text_delta  126 chars
 *  2987ms  text_delta  166 chars
 *  ...                          <- ~150 chars every ~500ms, not per token
 *  5559ms  result
 * ```
 *
 * Two things follow, and both shape the events below.
 *
 * First, `--include-partial-messages` is doing its job: text really does arrive
 * incrementally. What it does *not* do is arrive per token - the CLI coalesces
 * deltas into ~150-character blocks. Rendering each block the moment it lands
 * looks like paste, not typing, so the panel paces them out (`typewriter.ts`).
 * That is a rendering choice over text that has genuinely arrived, not a fake.
 *
 * Second, the first ~1.7s is process startup with no frames at all, and thinking
 * can run for a long time after that. So the host reports liveness rather than a
 * single "it started thinking" edge: `started` when the init frame lands, and a
 * throttled `thinking` pulse for as long as frames keep coming without text.
 *
 * ## Thinking text never leaves this process
 *
 * The `thinking` event deliberately carries no text, and nothing downstream can
 * ask for it. Extended thinking drafts the *answer* - in a measured run at rung 1
 * the thinking block contained a complete, word-counted draft of the reply. Piping
 * that to the panel would be the worst spoiler leak in the product, and it would
 * bypass the rung ladder entirely. Thinking is a heartbeat here and nothing else.
 *
 * ## Run first, classify later
 *
 * The happy path reads nothing but
 * the CLI's own JSON frames. `claude auth status --json` is consulted only after
 * a run has already failed, and only its documented JSON fields are read - when
 * a failure is not one we can name, the host quotes the CLI's own words instead
 * of guessing.
 */

/** The CLI accepts full model ids as well as aliases; the settings ids pass straight through. */
export interface ClaudeInvocation {
  model: string;
  system: string;
}

export function claudeArgs({ model, system }: ClaudeInvocation): string[] {
  return [
    '--print',
    '--model',
    model,
    '--system-prompt',
    system,
    // An empty tool list. The interviewer generates text and nothing else.
    '--tools',
    '',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--safe-mode',
    '--disable-slash-commands',
  ];
}

/** Keeps the run to the one API call the interview needs, with no telemetry side calls. */
export const CLAUDE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

export const CLAUDE_LOGIN_COMMAND = 'claude auth login';
export const CLAUDE_STATUS_COMMAND = 'claude auth status';

/**
 * The only `result` subtype whose `result` field is the model's own text.
 *
 * Every other subtype (`error_max_turns`, `error_during_execution`, whatever
 * gets added next) puts a CLI diagnostic there instead. They are not
 * interchangeable, and treating them as such would print the CLI's complaint
 * into the panel as though the interviewer had said it.
 */
export const ASSISTANT_RESULT_SUBTYPE = 'success';

export type ClaudeEvent =
  /** The CLI has booted and is about to call the API. Ends the "connecting" phase. */
  | { kind: 'started' }
  | { kind: 'text'; text: string }
  /** A liveness pulse while the model thinks. Carries no text, ever - see the header. */
  | { kind: 'thinking' }
  | { kind: 'rate-limit'; status: string; resetsAt: number | null }
  | {
      kind: 'result';
      isError: boolean;
      message: string;
      apiErrorStatus: number | null;
      /** `''` when the CLI did not say, which is never treated as assistant text. */
      subtype: string;
    };

interface StreamFrame {
  type?: unknown;
  event?: { type?: unknown; delta?: { type?: unknown; text?: unknown }; content_block?: { type?: unknown } };
  rate_limit_info?: { status?: unknown; resetsAt?: unknown };
  is_error?: unknown;
  result?: unknown;
  api_error_status?: unknown;
  subtype?: unknown;
}

/**
 * Turns one line of the CLI's NDJSON into an event, or `null` for the many
 * frames an interview does not care about.
 *
 * Text is taken only from `stream_event` deltas, never from the whole-message
 * `assistant` frames that arrive alongside them. That is not just
 * de-duplication: when the CLI cannot reach the API it synthesises an `assistant`
 * message carrying the error prose, and reading those would print "Not logged in
 * · Please run /login" into the panel as though the interviewer had said it.
 *
 * A `thinking_delta` maps to the same empty `thinking` event as the block start,
 * because what the caller needs from it is "still alive", not its content. The
 * content is a draft of the answer and must not leave this process.
 */
export function parseClaudeLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let frame: StreamFrame;
  try {
    frame = JSON.parse(trimmed) as StreamFrame;
  } catch {
    return null;
  }

  if (frame.type === 'stream_event') {
    const event = frame.event;
    if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      return { kind: 'thinking' };
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      return { kind: 'thinking' };
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = event.delta.text;
      if (typeof text === 'string' && text !== '') return { kind: 'text', text };
    }
    return null;
  }

  // The init frame is the CLI saying it is up and about to call the API. It is
  // the only `system` subtype that means anything to an interview.
  if (frame.type === 'system') {
    return frame.subtype === 'init' ? { kind: 'started' } : null;
  }

  if (frame.type === 'rate_limit_event') {
    const info = frame.rate_limit_info;
    const status = typeof info?.status === 'string' ? info.status : '';
    if (status === '') return null;
    return { kind: 'rate-limit', status, resetsAt: typeof info?.resetsAt === 'number' ? info.resetsAt : null };
  }

  if (frame.type === 'result') {
    return {
      kind: 'result',
      isError: frame.is_error === true,
      message: typeof frame.result === 'string' ? frame.result : '',
      apiErrorStatus: typeof frame.api_error_status === 'number' ? frame.api_error_status : null,
      subtype: typeof frame.subtype === 'string' ? frame.subtype : '',
    };
  }

  return null;
}

/** Splits a byte stream into whole lines, keeping the trailing partial back. */
export class LineSplitter {
  #pending = '';

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split('\n');
    this.#pending = lines.pop() ?? '';
    return lines;
  }

  flush(): string[] {
    const rest = this.#pending;
    this.#pending = '';
    return rest === '' ? [] : [rest];
  }
}

export interface AuthStatus {
  loggedIn: boolean;
  account: string | null;
  subscription: string | null;
}

/**
 * Reads `claude auth status --json`. Returns `null` when the output is not the
 * shape we know how to read, so callers fall back to quoting the CLI rather than
 * claiming a cause.
 */
export function parseAuthStatus(stdout: string): AuthStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record['loggedIn'] !== 'boolean') return null;
  return {
    loggedIn: record['loggedIn'],
    account: typeof record['email'] === 'string' ? record['email'] : null,
    subscription: typeof record['subscriptionType'] === 'string' ? record['subscriptionType'] : null,
  };
}

export interface RateLimitState {
  status: string;
  resetsAt: number | null;
}

/** `allowed` is the only status that means the window still has room in it. */
export function isRateLimited(state: RateLimitState | null, apiErrorStatus: number | null): boolean {
  if (apiErrorStatus === 429) return true;
  return state !== null && state.status !== 'allowed';
}

/** Epoch seconds to something a person can act on, in their own timezone. */
export function formatResetTime(resetsAt: number | null): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return '';
  return new Date(resetsAt * 1000).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
