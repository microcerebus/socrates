/**
 * The native host's decision logic, kept free of Node I/O so it can be tested
 * against a fake `dcli` and a fake `claude`.
 *
 * ## Read first, classify later
 *
 * `dcli` has no machine-readable output mode, so anything we learn by reading
 * its prose is one wording change away from being wrong. The happy path
 * therefore depends on none of it: run `dcli read <path>`, and if it exits 0
 * with non-empty stdout, that is the key. Exit status and stdout are contract,
 * not prose.
 *
 * `dcli status` runs only after a read has already failed, purely to pick the
 * friendliest explanation, and it is parsed as `key: value` lines rather than
 * pattern-matched over concatenated output. If those lines are not there, we say
 * so and hand back dcli's own stderr: a confidently wrong "your vault is locked"
 * is worse than an honest "this is what dcli said".
 *
 * The Claude Code path follows the same rule for the same reason: run the CLI,
 * and only when it has already failed ask `claude auth status --json` why. That
 * one *is* machine-readable, so it is read as JSON fields and a shape we do not
 * recognise means we stop claiming to know the cause.
 *
 * Every failure still returns an actionable message and the exact command to run.
 */

import {
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_STATUS_COMMAND,
  formatResetTime,
  isRateLimited,
  parseAuthStatus,
  type RateLimitState,
} from './claude.ts';
import { resolveClaudePath, type ClaudePathLookup, type HostConfig, vaultPath } from './config.ts';
import type { HostRequest, HostResponse } from './protocol.ts';

export interface CommandResult {
  /** Set when the binary could not be spawned at all. */
  spawnErrorCode?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HostDeps {
  config: HostConfig;
  run(command: string, args: string[]): Promise<CommandResult>;
  /** Injected so binary resolution is testable without touching the filesystem. */
  exists(path: string): boolean;
  home: string;
}

const UNLOCK_COMMAND = 'dcli sync';
const STATUS_COMMAND = 'dcli status';

/**
 * Parses `dcli status` output, which is a short list of `Key: value` lines.
 * Keys and values are lower-cased so callers compare against literals.
 */
export function parseStatusLines(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (key !== '' && !fields.has(key)) fields.set(key, value);
  }
  return fields;
}

/** True when the output still looks like the status format we know how to read. */
export function isRecognisableStatus(fields: Map<string, string>): boolean {
  return fields.has('logged in') || fields.has('locked');
}

function dcliMissing(config: HostConfig): HostResponse {
  return {
    ok: false,
    code: 'dcli-missing',
    message:
      `The Dashlane CLI was not found at ${config.dcliPath}. Socrates reads your Anthropic key from your ` +
      `Dashlane vault at session start and never stores it anywhere. Install dcli, then re-run ` +
      `bin/install-native-host.sh so the recorded path is updated.`,
    command: 'brew install dashlane/tap/dashlane-cli',
  };
}

function spawnFailure(config: HostConfig, code: string): HostResponse {
  return {
    ok: false,
    code: 'key-fetch-failed',
    message: `Could not run ${config.dcliPath}: ${code}.`,
    command: `${config.dcliPath} status`,
  };
}

/** dcli colours its errors; the panel renders text, so the escapes have to go. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** First line of dcli's own complaint, for messages we cannot explain ourselves. */
export function firstMeaningfulLine(text: string): string {
  return (
    text
      .replace(ANSI_SGR, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function itemProblem(config: HostConfig, read: CommandResult): HostResponse {
  const path = vaultPath(config);
  const emptyButPresent = read.exitCode === 0;
  const detail = firstMeaningfulLine(read.stderr);
  return {
    ok: false,
    code: 'vault-item-missing',
    message: emptyButPresent
      ? `The Dashlane item at ${path} is empty. Put your Anthropic API key in it, or edit ` +
        `~/.config/socrates/native-host.json to point at a different item.`
      : `Dashlane could not read ${path}. Create a secure note titled "${config.itemTitle}" whose content is ` +
        `your Anthropic API key, or edit ~/.config/socrates/native-host.json to point at a different item.` +
        (detail === '' ? '' : ` dcli said: ${detail}`),
    command: `dcli read "${path}"`,
  };
}

/**
 * Runs only after a read has failed. Picks the friendliest accurate explanation,
 * and falls back to an honest generic one rather than guessing.
 */
async function classifyReadFailure(read: CommandResult, deps: HostDeps): Promise<HostResponse> {
  const status = await deps.run(deps.config.dcliPath, ['status']);

  if (status.spawnErrorCode === 'ENOENT') return dcliMissing(deps.config);
  if (status.spawnErrorCode) return spawnFailure(deps.config, status.spawnErrorCode);

  const fields = parseStatusLines(status.stdout);

  if (!isRecognisableStatus(fields)) {
    const detail = firstMeaningfulLine(read.stderr) || firstMeaningfulLine(read.stdout);
    return {
      ok: false,
      code: 'key-fetch-failed',
      message:
        `Reading the key from Dashlane failed, and 'dcli status' did not report anything Socrates recognises, ` +
        `so it cannot tell you why. Run the command below and check the vault by hand.` +
        (detail === '' ? '' : ` dcli said: ${detail}`),
      command: STATUS_COMMAND,
    };
  }

  if (fields.get('logged in') === 'no') {
    return {
      ok: false,
      code: 'vault-logged-out',
      message: 'You are not logged in to the Dashlane CLI. Log in, then reopen the panel.',
      command: UNLOCK_COMMAND,
    };
  }

  if (fields.get('locked') === 'yes') {
    return {
      ok: false,
      code: 'vault-locked',
      message: 'Your Dashlane vault is locked. Unlock it in a terminal, then reopen the panel.',
      command: UNLOCK_COMMAND,
    };
  }

  // Logged in and unlocked, so the vault is fine and the item is the problem.
  return itemProblem(deps.config, read);
}

// --- Claude Code -------------------------------------------------------------

const REINSTALL_COMMAND = './bin/install-native-host.sh';

export function findClaude(deps: HostDeps): ClaudePathLookup {
  return resolveClaudePath(deps.config, deps.exists, deps.home);
}

/**
 * The binary moved or was never installed. `claude install` and Homebrew both
 * relocate it, so this names every path tried and the one command that fixes the
 * recorded one, rather than telling the user to look for it themselves.
 */
export function claudeMissing(lookup: ClaudePathLookup): HostResponse {
  return {
    ok: false,
    code: 'claude-cli-missing',
    message:
      `The Claude Code CLI was not found. Socrates looked at ${lookup.tried.join(', ')}. ` +
      `If claude is installed somewhere else, re-run the installer so the recorded path is updated; ` +
      `if it is not installed, install it and then re-run the installer.`,
    command: REINSTALL_COMMAND,
  };
}

export interface ClaudeRunOutcome {
  /** The CLI's own `result` text, which is the only prose worth quoting. */
  message: string;
  apiErrorStatus: number | null;
  rateLimit: RateLimitState | null;
  /** Set when the process could not be spawned at all. */
  spawnErrorCode?: string;
  /** Anything the CLI wrote to stderr, used only when it said nothing else. */
  stderr: string;
}

/**
 * Runs only after a Claude Code turn has already failed. Names a cause only when
 * the CLI's own machine-readable output supports it, and otherwise quotes the
 * CLI verbatim - an honest "this is what claude said" beats a confident guess
 * about someone's account.
 */
export async function classifyClaudeFailure(outcome: ClaudeRunOutcome, deps: HostDeps): Promise<HostResponse> {
  const lookup = findClaude(deps);
  if (outcome.spawnErrorCode === 'ENOENT' || lookup.path === null) return claudeMissing(lookup);
  if (outcome.spawnErrorCode) {
    return {
      ok: false,
      code: 'claude-cli-failed',
      message: `Could not run ${lookup.path}: ${outcome.spawnErrorCode}.`,
      command: CLAUDE_STATUS_COMMAND,
    };
  }

  const status = await deps.run(lookup.path, ['auth', 'status', '--json']);
  const auth = parseAuthStatus(status.stdout);

  if (auth !== null && !auth.loggedIn) {
    return {
      ok: false,
      code: 'claude-logged-out',
      message:
        'The Claude Code CLI is not logged in, so there is no subscription to run hints on. ' +
        'Log in in a terminal, then send the message again.',
      command: CLAUDE_LOGIN_COMMAND,
    };
  }

  if (isRateLimited(outcome.rateLimit, outcome.apiErrorStatus)) {
    const resets = formatResetTime(outcome.rateLimit?.resetsAt ?? null);
    return {
      ok: false,
      code: 'claude-usage-limit',
      message:
        `Your Claude usage window is exhausted, so Claude Code has nothing left to spend on this hint. ` +
        (resets === '' ? '' : `It resets ${resets}. `) +
        `Socrates shares that window with every other Claude Code session on this machine. ` +
        (outcome.message === '' ? '' : `claude said: ${outcome.message}`),
      command: CLAUDE_STATUS_COMMAND,
    };
  }

  const detail = outcome.message || firstMeaningfulLine(outcome.stderr);
  return {
    ok: false,
    code: 'claude-cli-failed',
    message:
      `The Claude Code CLI could not produce a reply, and did not report anything Socrates recognises, so it ` +
      `cannot tell you why. Run the command below to check the CLI by hand.` +
      (detail === '' ? '' : ` claude said: ${detail}`),
    command: CLAUDE_STATUS_COMMAND,
  };
}

async function claudeProbe(deps: HostDeps): Promise<HostResponse> {
  const lookup = findClaude(deps);
  if (lookup.path === null) return claudeMissing(lookup);

  const status = await deps.run(lookup.path, ['auth', 'status', '--json']);
  if (status.spawnErrorCode === 'ENOENT') return claudeMissing(lookup);
  if (status.spawnErrorCode) {
    return {
      ok: false,
      code: 'claude-cli-failed',
      message: `Could not run ${lookup.path}: ${status.spawnErrorCode}.`,
      command: CLAUDE_STATUS_COMMAND,
    };
  }

  const auth = parseAuthStatus(status.stdout);
  if (auth === null) {
    const detail = firstMeaningfulLine(status.stderr) || firstMeaningfulLine(status.stdout);
    return {
      ok: false,
      code: 'claude-cli-failed',
      message:
        `'claude auth status --json' did not return anything Socrates recognises, so it cannot tell whether you ` +
        `are logged in. Run the command below and check by hand.` +
        (detail === '' ? '' : ` claude said: ${detail}`),
      command: CLAUDE_STATUS_COMMAND,
    };
  }
  if (!auth.loggedIn) {
    return {
      ok: false,
      code: 'claude-logged-out',
      message: 'The Claude Code CLI is not logged in. Log in in a terminal, then try again.',
      command: CLAUDE_LOGIN_COMMAND,
    };
  }

  return {
    ok: true,
    kind: 'claude-ok',
    claudePath: lookup.path,
    account: auth.account,
    subscription: auth.subscription,
  };
}

// --- request dispatch --------------------------------------------------------

export async function handleRequest(request: HostRequest, deps: HostDeps): Promise<HostResponse> {
  if (request.kind === 'ping') {
    return { ok: true, kind: 'pong', itemTitle: deps.config.itemTitle, claudePath: findClaude(deps).path };
  }

  if (request.kind === 'claude-probe') return claudeProbe(deps);

  if (request.kind !== 'get-api-key') {
    // `claude-start` and `claude-cancel` are streaming, and are driven by main.ts.
    return { ok: false, code: 'bad-request', message: `${request.kind} is not a request/response call.` };
  }

  const read = await deps.run(deps.config.dcliPath, ['read', vaultPath(deps.config)]);

  if (read.spawnErrorCode === 'ENOENT') return dcliMissing(deps.config);
  if (read.spawnErrorCode) return spawnFailure(deps.config, read.spawnErrorCode);

  const apiKey = read.stdout.trim();
  if (read.exitCode === 0 && apiKey !== '') {
    return { ok: true, kind: 'api-key', apiKey };
  }

  return classifyReadFailure(read, deps);
}
