/**
 * The Claude Code half of the native host: what we ask the CLI for, what we read
 * back, and what we say when it goes wrong.
 *
 * The streaming tests spawn a real child process - `tests/fixtures/fake-claude.mjs`
 * standing in for `claude` - rather than stubbing the runner. That is the point:
 * the argv, the stdin write, the line splitting across chunk boundaries and the
 * kill are all things that only work or fail for real.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ASSISTANT_RESULT_SUBTYPE,
  CLAUDE_ENV,
  CLAUDE_LOGIN_COMMAND,
  LineSplitter,
  claudeArgs,
  formatResetTime,
  isRateLimited,
  parseAuthStatus,
  parseClaudeLine,
} from '../src/native-host/claude.ts';
import {
  CLAUDE_FALLBACK_PATHS,
  DEFAULT_CONFIG,
  parseConfig,
  resolveClaudePath,
} from '../src/native-host/config.ts';
import {
  classifyClaudeFailure,
  handleRequest,
  type CommandResult,
  type HostDeps,
} from '../src/native-host/handler.ts';
import type { HostResponse } from '../src/native-host/protocol.ts';
import { startClaudeRun, type ClaudeRunDeps } from '../src/native-host/runner.ts';

const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const FAKE_HOME = '/home/tester';

const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'someone@example.com',
  subscriptionType: 'max',
});
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

interface FakeDeps extends HostDeps {
  calls: string[][];
}

function hostDeps(
  options: { auth?: CommandResult; claudePath?: string; exists?: boolean } = {},
): FakeDeps {
  const calls: string[][] = [];
  return {
    calls,
    config: parseConfig(
      JSON.stringify({ ...DEFAULT_CONFIG, claudePath: options.claudePath ?? '/opt/bin/claude' }),
    ),
    home: FAKE_HOME,
    exists: () => options.exists ?? true,
    run: (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve(options.auth ?? ok(LOGGED_IN));
    },
  };
}

describe('the invocation', () => {
  const args = claudeArgs({ model: 'claude-sonnet-5', system: 'SYSTEM PROMPT' });
  const flag = (name: string): string | undefined => args[args.indexOf(name) + 1];

  it('runs in print mode with streamed JSON, which is the only way to get text deltas', () => {
    expect(args).toContain('--print');
    expect(flag('--output-format')).toBe('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--verbose');
  });

  it('makes the interviewer prompt the whole system prompt, not an addendum', () => {
    expect(flag('--system-prompt')).toBe('SYSTEM PROMPT');
    // --append-system-prompt would leave Claude Code's coding-agent prompt underneath.
    expect(args).not.toContain('--append-system-prompt');
  });

  it('leaves the session with no tools at all', () => {
    expect(args.indexOf('--tools')).toBeGreaterThan(-1);
    expect(flag('--tools')).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it("keeps the machine's own Claude Code configuration out of an interview", () => {
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(flag('--setting-sources')).toBe('');
  });

  it('does not resume anything - the transcript is resent every call', () => {
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--input-format');
  });

  it('passes the settings model id straight through', () => {
    expect(flag('--model')).toBe('claude-sonnet-5');
    expect(claudeArgs({ model: 'claude-haiku-4-5-20251001', system: '' })).toContain(
      'claude-haiku-4-5-20251001',
    );
  });

  it('suppresses the side calls a headless run does not need', () => {
    expect(CLAUDE_ENV['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
  });
});

describe('reading the CLI stream', () => {
  it('takes text from partial deltas', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: 'text', text: 'hello' });
  });

  it('ignores whole-message frames, which duplicate the deltas', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'the whole reply' }] },
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('ignores the synthesised assistant message an API error arrives as', () => {
    // Reading this one would print "Not logged in" into the panel as a reply.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      },
      is_api_error_message: true,
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('reports a thinking block', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: 'thinking' });
  });

  it('picks up the rate limit window and the terminal result', () => {
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', resetsAt: 12 },
        }),
      ),
    ).toEqual({ kind: 'rate-limit', status: 'allowed', resetsAt: 12 });

    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'boom',
          api_error_status: 429,
        }),
      ),
    ).toEqual({
      kind: 'result',
      isError: true,
      message: 'boom',
      apiErrorStatus: 429,
      subtype: 'success',
    });
  });

  it('keeps the result subtype, which is what says whether `result` is assistant text', () => {
    const at = (subtype: unknown): unknown =>
      parseClaudeLine(JSON.stringify({ type: 'result', subtype, is_error: false, result: 'x' }));

    expect(at('success')).toMatchObject({ subtype: ASSISTANT_RESULT_SUBTYPE });
    expect(at('error_max_turns')).toMatchObject({ subtype: 'error_max_turns' });
    // A CLI that stops sending one must not be read as if it had sent "success".
    expect(at(undefined)).toMatchObject({ subtype: '' });
  });

  it('shrugs off blank lines and anything that is not JSON', () => {
    expect(parseClaudeLine('')).toBeNull();
    expect(parseClaudeLine('  ')).toBeNull();
    expect(parseClaudeLine('not json at all')).toBeNull();
    expect(parseClaudeLine('{"type":"something_new"}')).toBeNull();
  });

  it('reassembles a frame split across reads', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.flush()).toEqual(['{"c"']);
  });
});

describe('auth status', () => {
  it('reads the documented JSON fields', () => {
    expect(parseAuthStatus(LOGGED_IN)).toEqual({
      loggedIn: true,
      account: 'someone@example.com',
      subscription: 'max',
    });
    expect(parseAuthStatus(LOGGED_OUT)?.loggedIn).toBe(false);
  });

  it('returns null rather than guessing when the shape changes', () => {
    expect(parseAuthStatus('Logged in: yes')).toBeNull();
    expect(parseAuthStatus('{"authenticated":true}')).toBeNull();
    expect(parseAuthStatus('')).toBeNull();
  });

  it('treats only "allowed" as room left in the window', () => {
    expect(isRateLimited({ status: 'allowed', resetsAt: null }, null)).toBe(false);
    expect(isRateLimited({ status: 'rejected', resetsAt: null }, null)).toBe(true);
    expect(isRateLimited(null, 429)).toBe(true);
    expect(isRateLimited(null, null)).toBe(false);
  });

  it('formats a reset time, and says nothing when there is not one', () => {
    expect(formatResetTime(null)).toBe('');
    expect(formatResetTime(Number.NaN)).toBe('');
    expect(formatResetTime(1_786_386_000)).not.toBe('');
  });
});

describe('finding the binary', () => {
  it('prefers the recorded path', () => {
    const config = parseConfig(JSON.stringify({ claudePath: '/custom/claude' }));
    expect(resolveClaudePath(config, () => true, FAKE_HOME).path).toBe('/custom/claude');
  });

  it('falls back to the well-known locations when the recorded one has moved', () => {
    const config = parseConfig(JSON.stringify({ claudePath: '/gone/claude' }));
    const lookup = resolveClaudePath(
      config,
      (path) => path === `${FAKE_HOME}/.local/bin/claude`,
      FAKE_HOME,
    );
    expect(lookup.path).toBe(`${FAKE_HOME}/.local/bin/claude`);
  });

  it('resolves the home-relative fallbacks against the real home', () => {
    const lookup = resolveClaudePath(DEFAULT_CONFIG, () => false, FAKE_HOME);
    expect(lookup.tried).toContain(`${FAKE_HOME}/.local/bin/claude`);
    for (const candidate of lookup.tried) expect(candidate.startsWith('/')).toBe(true);
    expect(lookup.tried.length).toBe(new Set(lookup.tried).size);
    expect(lookup.tried).toHaveLength(CLAUDE_FALLBACK_PATHS.length);
  });

  it('names every path it tried, and the command that fixes the recorded one', async () => {
    const deps = hostDeps({ claudePath: '/gone/claude', exists: false });
    const response = await classifyClaudeFailure(
      { message: '', apiErrorStatus: null, rateLimit: null, stderr: '' },
      deps,
    );
    expect(response).toMatchObject({ ok: false, code: 'claude-cli-missing' });
    if (!response.ok) {
      expect(response.message).toContain('/gone/claude');
      expect(response.message).toContain('/.local/bin/claude');
      expect(response.command).toBe('./bin/install-native-host.sh');
    }
    // A binary that is not there is not an auth question; nothing was run.
    expect(deps.calls).toEqual([]);
  });
});

describe('explaining a failed run', () => {
  it('says to log in when the CLI says it is logged out', async () => {
    const deps = hostDeps({ auth: ok(LOGGED_OUT) });
    const response = await classifyClaudeFailure(
      {
        message: 'Not logged in · Please run /login',
        apiErrorStatus: null,
        rateLimit: null,
        stderr: '',
      },
      deps,
    );
    expect(response).toMatchObject({
      ok: false,
      code: 'claude-logged-out',
      command: CLAUDE_LOGIN_COMMAND,
    });
    expect(deps.calls).toEqual([['/opt/bin/claude', 'auth', 'status', '--json']]);
  });

  it('surfaces the usage window, when it resets, and that it is shared', async () => {
    const response = await classifyClaudeFailure(
      {
        message: 'Claude usage limit reached.',
        apiErrorStatus: 429,
        rateLimit: { status: 'rejected', resetsAt: 1_786_386_000 },
        stderr: '',
      },
      hostDeps(),
    );
    expect(response).toMatchObject({ ok: false, code: 'claude-usage-limit' });
    if (!response.ok) {
      expect(response.message).toContain('Claude usage limit reached.');
      expect(response.message).toContain('resets');
      expect(response.message).toContain('every other Claude Code session');
    }
  });

  it('quotes the CLI rather than guessing when the failure is not one it knows', async () => {
    const response = await classifyClaudeFailure(
      { message: '', apiErrorStatus: 500, rateLimit: null, stderr: 'some new failure mode' },
      hostDeps(),
    );
    expect(response).toMatchObject({ ok: false, code: 'claude-cli-failed' });
    if (!response.ok) {
      expect(response.message).toContain('some new failure mode');
      expect(response.message).not.toMatch(/logged out|usage limit/i);
    }
  });

  it('does not claim logged-out when auth status is no longer readable', async () => {
    const response = await classifyClaudeFailure(
      { message: 'something went wrong', apiErrorStatus: null, rateLimit: null, stderr: '' },
      hostDeps({ auth: ok('claude: unrecognised output') }),
    );
    expect(response).toMatchObject({ ok: false, code: 'claude-cli-failed' });
    if (!response.ok) expect(response.message).toContain('something went wrong');
  });
});

describe('the probe', () => {
  it('reports the resolved binary and the account behind it', async () => {
    await expect(handleRequest({ kind: 'claude-probe' }, hostDeps())).resolves.toEqual({
      ok: true,
      kind: 'claude-ok',
      claudePath: '/opt/bin/claude',
      account: 'someone@example.com',
      subscription: 'max',
    });
  });

  it('reports a logged-out CLI with the login command', async () => {
    await expect(
      handleRequest({ kind: 'claude-probe' }, hostDeps({ auth: ok(LOGGED_OUT) })),
    ).resolves.toMatchObject({
      ok: false,
      code: 'claude-logged-out',
      command: CLAUDE_LOGIN_COMMAND,
    });
  });

  it('reports a missing binary without running anything', async () => {
    await expect(
      handleRequest({ kind: 'claude-probe' }, hostDeps({ exists: false })),
    ).resolves.toMatchObject({ ok: false, code: 'claude-cli-missing' });
  });

  it('leaves the streaming kinds to the runner', async () => {
    await expect(
      handleRequest({ kind: 'claude-cancel', requestId: 'r1' }, hostDeps()),
    ).resolves.toMatchObject({ ok: false, code: 'bad-request' });
  });
});

// --- against a real child process --------------------------------------------

describe('streaming a turn against a fake claude binary', { timeout: 30_000 }, () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'socrates-claude-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    delete process.env['FAKE_CLAUDE_PIDFILE'];
  });

  function runDeps(overrides: Partial<ClaudeRunDeps> = {}): ClaudeRunDeps {
    return {
      ...hostDeps({ claudePath: FAKE_CLAUDE }),
      spawn,
      cwd: scratch,
      timeoutMs: 15_000,
      ...overrides,
    };
  }

  /** Drives one run to its terminal frame and hands back everything emitted. */
  function collect(
    scenario: string,
    options: {
      prompt?: string;
      system?: string;
      deps?: ClaudeRunDeps;
      onFrame?(frame: HostResponse): void;
    } = {},
  ): Promise<HostResponse[]> {
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
          system: options.system ?? 'THE INTERVIEWER PROMPT',
          prompt: options.prompt ?? 'the flattened transcript',
        },
        options.deps ?? runDeps(),
        (frame) => {
          frames.push(frame);
          options.onFrame?.(frame);
          const terminal = !frame.ok || frame.kind === 'claude-done';
          if (terminal) {
            clearTimeout(timer);
            resolvePromise(frames);
          }
        },
      );
    });
  }

  const textOf = (frames: HostResponse[]): string =>
    frames.map((frame) => (frame.ok && frame.kind === 'claude-delta' ? frame.text : '')).join('');

  it('streams the reply as deltas and ends with done', async () => {
    const frames = await collect('scenario-reply');
    expect(textOf(frames)).toBe('What do you already know about the input?');
    expect(frames.filter((f) => f.ok && f.kind === 'claude-delta')).toHaveLength(4);
    expect(frames.some((f) => f.ok && f.kind === 'claude-thinking')).toBe(true);
    expect(frames.at(-1)).toEqual({ ok: true, kind: 'claude-done', requestId: 'req-1' });
    for (const frame of frames) expect(frame).toHaveProperty('requestId', 'req-1');
  });

  it('actually passes the flags and the transcript to the process', async () => {
    const frames = await collect('scenario-echo', {
      prompt: 'FLATTENED TRANSCRIPT',
      system: 'RUNG 1 SYSTEM PROMPT',
    });
    const echoed = JSON.parse(textOf(frames)) as { args: string[]; prompt: string };
    expect(echoed.prompt).toBe('FLATTENED TRANSCRIPT');
    expect(echoed.args[echoed.args.indexOf('--system-prompt') + 1]).toBe('RUNG 1 SYSTEM PROMPT');
    expect(echoed.args[echoed.args.indexOf('--tools') + 1]).toBe('');
    expect(echoed.args).toContain('--include-partial-messages');
  });

  it('maps a logged-out CLI onto the login remedy, and never prints the error as a reply', async () => {
    const frames = await collect('scenario-logged-out', {
      deps: runDeps({
        ...hostDeps({ claudePath: FAKE_CLAUDE, auth: ok(LOGGED_OUT) }),
        spawn,
        cwd: scratch,
      }),
    });
    expect(textOf(frames)).toBe('');
    expect(frames.at(-1)).toMatchObject({
      ok: false,
      code: 'claude-logged-out',
      command: CLAUDE_LOGIN_COMMAND,
      requestId: 'req-1',
    });
  });

  it("maps an exhausted usage window onto the CLI's own message", async () => {
    const frames = await collect('scenario-usage-limit');
    const last = frames.at(-1);
    expect(last).toMatchObject({ ok: false, code: 'claude-usage-limit' });
    if (last && !last.ok) expect(last.message).toContain('Claude usage limit reached.');
  });

  it('stays honest about a failure it cannot name', async () => {
    const frames = await collect('scenario-unexplained');
    const last = frames.at(-1);
    expect(last).toMatchObject({ ok: false, code: 'claude-cli-failed' });
    if (last && !last.ok) expect(last.message).toContain('some new failure mode');
  });

  it('falls back to the whole result if a future CLI stops emitting deltas', async () => {
    const frames = await collect('scenario-no-partials');
    expect(textOf(frames)).toBe('the whole answer at once');
    expect(frames.at(-1)).toMatchObject({ ok: true, kind: 'claude-done' });
  });

  it('never passes a CLI diagnostic off as the interviewer, even on a run that did not error', async () => {
    // `is_error: false`, but the subtype says `result` holds the CLI's own
    // complaint rather than anything the model said.
    const frames = await collect('scenario-no-partials-diagnostic');

    expect(textOf(frames)).toBe('');
    expect(frames.some((frame) => frame.ok && frame.kind === 'claude-delta')).toBe(false);
    expect(frames.some((frame) => frame.ok && frame.kind === 'claude-done')).toBe(false);

    // And it is not swallowed either - the diagnostic reaches the user, quoted.
    const last = frames.at(-1);
    expect(last).toMatchObject({ ok: false, code: 'claude-cli-failed', requestId: 'req-1' });
    if (last && !last.ok) {
      expect(last.message).toContain('Reached maximum number of turns.');
      expect(last.message).toContain('claude said:');
    }
  });

  it('reports a missing binary instead of spawning nothing and going quiet', async () => {
    const frames = await collect('scenario-reply', {
      deps: runDeps({
        ...hostDeps({ claudePath: '/gone/claude', exists: false }),
        spawn,
        cwd: scratch,
      }),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, code: 'claude-cli-missing', requestId: 'req-1' });
  });

  it('kills the child when the run is cancelled, and says nothing after', async () => {
    const pidFile = join(scratch, 'child.pid');
    process.env['FAKE_CLAUDE_PIDFILE'] = pidFile;

    const frames: HostResponse[] = [];
    let started: () => void = () => undefined;
    const firstDelta = new Promise<void>((resolveFirst) => {
      started = resolveFirst;
    });

    // `scenario-hang` never exits on its own, so if the process is gone, we killed it.
    const cancel = startClaudeRun(
      {
        kind: 'claude-start',
        requestId: 'req-hang',
        model: 'scenario-hang',
        system: 'system',
        prompt: 'prompt',
      },
      runDeps(),
      (frame) => {
        frames.push(frame);
        if (frame.ok && frame.kind === 'claude-delta') started();
      },
    );
    await firstDelta;

    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    cancel();

    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await sleep(25);
    expect(alive(pid), 'the claude child outlived its cancellation').toBe(false);

    // A cancelled run is not a failure to explain: no error frame, no done frame.
    await sleep(250);
    expect(frames.filter((frame) => !frame.ok || frame.kind === 'claude-done')).toEqual([]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
