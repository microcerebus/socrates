/**
 * Entry point for the Chrome native-messaging host.
 *
 * Chrome spawns this process, writes length-prefixed JSON on stdin and reads
 * length-prefixed JSON from stdout. Nothing may be written to stdout except
 * framed messages - a stray `console.log` corrupts the stream, so diagnostics go
 * to stderr.
 *
 * Two request shapes share the one binary. `ping`, `get-api-key` and
 * `claude-probe` are request/response and answer once, over
 * `sendNativeMessage`. `claude-start` streams a model reply over a
 * `connectNative` port and `claude-cancel` kills that run; both are delegated to
 * `runner.ts`. See `protocol.ts`.
 *
 * This file is wiring only. The decisions live in `handler.ts` and `runner.ts`,
 * which are testable because they take their I/O as arguments.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { type HostConfig, parseConfig } from './config.ts';
import { handleRequest, type CommandResult } from './handler.ts';
import { MessageDecoder, encodeMessage, isHostRequest, type HostResponse } from './protocol.ts';
import { startClaudeRun, type ClaudeRunDeps } from './runner.ts';

/** `SOCRATES_HOST_CONFIG` overrides the location; used by the smoke test. */
const CONFIG_PATH =
  process.env['SOCRATES_HOST_CONFIG'] ?? join(homedir(), '.config', 'socrates', 'native-host.json');
const COMMAND_TIMEOUT_MS = 20_000;

function loadConfig(): HostConfig {
  try {
    return parseConfig(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return parseConfig(null);
  }
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        spawnErrorCode: error.code ?? 'SPAWN_FAILED',
        exitCode: -1,
        stdout,
        stderr: String(error),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function send(message: HostResponse): void {
  process.stdout.write(encodeMessage(message));
}

/** Cancel functions for the runs still going, keyed by request id. */
const running = new Map<string, () => void>();

function cancel(requestId: string): void {
  running.get(requestId)?.();
  running.delete(requestId);
}

function main(): void {
  const deps: ClaudeRunDeps = {
    config: loadConfig(),
    run,
    exists: existsSync,
    home: homedir(),
    spawn,
    // No CLAUDE.md to discover, no project settings, and no chance of an
    // interview inheriting whatever cwd Chrome handed us.
    cwd: tmpdir(),
  };
  const decoder = new MessageDecoder();

  process.stdin.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      process.stderr.write(`socrates-host: framing error: ${String(error)}\n`);
      process.exit(1);
      return;
    }
    for (const message of messages) {
      if (!isHostRequest(message)) {
        send({ ok: false, code: 'bad-request', message: 'Unrecognised request.' });
        continue;
      }
      if (message.kind === 'claude-start') {
        running.set(
          message.requestId,
          startClaudeRun(message, deps, (response) => {
            send(response);
            if (response.ok && response.kind === 'claude-done') running.delete(message.requestId);
            if (!response.ok) running.delete(message.requestId);
          }),
        );
        continue;
      }
      if (message.kind === 'claude-cancel') {
        cancel(message.requestId);
        continue;
      }
      void handleRequest(message, deps)
        .then(send)
        .catch((error: unknown) => {
          send({ ok: false, code: 'claude-cli-failed', message: String(error) });
        });
    }
  });

  // Chrome closes the port when the panel or the worker goes away. Whatever the
  // CLI is doing at that point is nobody's reply, so it dies with the host.
  const stopEverything = (): void => {
    for (const requestId of [...running.keys()]) cancel(requestId);
  };
  process.stdin.on('end', () => {
    stopEverything();
    process.exit(0);
  });
  process.on('exit', stopEverything);
}

main();
