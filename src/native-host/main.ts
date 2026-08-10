/**
 * Entry point for the Chrome native-messaging host.
 *
 * Chrome spawns this process, writes length-prefixed JSON on stdin and reads
 * length-prefixed JSON from stdout. Nothing may be written to stdout except
 * framed messages - a stray `console.log` corrupts the stream, so diagnostics go
 * to stderr.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { type HostConfig, parseConfig } from './config.ts';
import { handleRequest, type CommandResult } from './handler.ts';
import { MessageDecoder, encodeMessage, isHostRequest } from './protocol.ts';

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
      resolve({ spawnErrorCode: error.code ?? 'SPAWN_FAILED', exitCode: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function send(message: unknown): void {
  process.stdout.write(encodeMessage(message));
}

function main(): void {
  const config = loadConfig();
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
      void handleRequest(message, { config, run })
        .then(send)
        .catch((error: unknown) => {
          send({ ok: false, code: 'key-fetch-failed', message: String(error) });
        });
    }
  });

  process.stdin.on('end', () => process.exit(0));
}

main();
