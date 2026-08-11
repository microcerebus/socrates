/**
 * The one test that talks to the real Claude Code CLI.
 *
 * The host depends on two things the CLI could change under us: the flags that
 * make a run headless, single-turn and prompt-controlled, and the JSON shape of
 * `claude auth status`. Both are pinned here, so a rename fails `pnpm check` on
 * a dev machine instead of surfacing later as a blank panel or a wrong
 * explanation.
 *
 * It costs nothing: `--help` and `auth status` are local, and neither calls the
 * API or spends a usage window. The streaming frame shapes are covered by
 * `tests/fixtures/fake-claude.mjs` instead, for exactly that reason.
 *
 * Skipped wherever `claude` is not installed, so it never becomes a flaky gate.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { CLAUDE_LOGIN_COMMAND, claudeArgs, parseAuthStatus } from '../src/native-host/claude.ts';

function findClaude(): string | null {
  try {
    const path = execFileSync('command', ['-v', 'claude'], {
      shell: '/bin/sh',
      encoding: 'utf8',
    }).trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

const CLAUDE = findClaude();

const capture = (args: string[]): string =>
  execFileSync(CLAUDE as string, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Runs the CLI expecting it to fail, and returns everything it said. */
function captureFailure(args: string[]): string {
  try {
    return capture(args);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
}

/** `--help` does not list this one, so it is pinned by invocation instead. */
const UNDOCUMENTED_FLAGS = ['--system-prompt-file'];

describe.skipIf(CLAUDE === null)('claude CLI contract (integration)', () => {
  it('still accepts every flag the host passes', () => {
    const help = capture(['--help']);
    const flags = claudeArgs({ model: 'claude-sonnet-5', systemPromptPath: '/tmp/x' }).filter(
      (arg) => arg.startsWith('--') && !UNDOCUMENTED_FLAGS.includes(arg),
    );

    for (const flag of flags) {
      expect(
        help,
        `claude --help no longer mentions ${flag}; src/native-host/claude.ts needs updating`,
      ).toContain(flag);
    }
  });

  it('still reads the system prompt from a file, which is how the host keeps it off argv', () => {
    // Aimed at a path that cannot exist: the CLI reports the missing file
    // without calling the API, which proves it parsed the flag and tried to read
    // it. An unrecognised flag says "unknown option" instead - a different
    // message, so this really does distinguish the two.
    const said = captureFailure(['--print', '--system-prompt-file', '/nonexistent-socrates-probe']);
    expect(said, 'claude no longer accepts --system-prompt-file').not.toContain('unknown option');
    expect(said).toContain('/nonexistent-socrates-probe');
  });

  it('still documents --system-prompt as replacing the prompt, not appending to it', () => {
    const help = capture(['--help']);
    // Both exist; the host must be on the replacing family, or the coding-agent
    // system prompt would sit underneath the rung rules.
    expect(help).toContain('--system-prompt <prompt>');
    expect(help).toContain('--append-system-prompt');
  });

  it('still offers the login command the host tells users to run', () => {
    expect(capture(['auth', '--help'])).toContain('login');
    expect(CLAUDE_LOGIN_COMMAND).toBe('claude auth login');
  });

  it('still reports auth status as JSON with a loggedIn boolean', () => {
    const status = parseAuthStatus(capture(['auth', 'status', '--json']));
    expect(
      status,
      "'claude auth status --json' is no longer the shape parseAuthStatus reads. The classifier in " +
        'src/native-host/handler.ts will stop being able to explain a logged-out CLI.',
    ).not.toBeNull();
    expect(typeof status?.loggedIn).toBe('boolean');
  });
});
