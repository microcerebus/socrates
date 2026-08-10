/**
 * The native host's decision logic, kept free of Node I/O so it can be tested
 * against a fake `dcli`.
 *
 * Every failure path returns an actionable message plus the exact command the
 * user should run. Failing silently here would strand the side panel with a
 * spinner and no way forward.
 */

import { type HostConfig, vaultPath } from './config.ts';
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
}

const UNLOCK_COMMAND = 'dcli sync';

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

export async function handleRequest(request: HostRequest, deps: HostDeps): Promise<HostResponse> {
  if (request.kind === 'ping') {
    return { ok: true, kind: 'pong', itemTitle: deps.config.itemTitle };
  }

  const status = await deps.run(deps.config.dcliPath, ['status']);
  if (status.spawnErrorCode === 'ENOENT') {
    return dcliMissing(deps.config);
  }
  if (status.spawnErrorCode) {
    return {
      ok: false,
      code: 'key-fetch-failed',
      message: `Could not run ${deps.config.dcliPath}: ${status.spawnErrorCode}.`,
      command: `${deps.config.dcliPath} status`,
    };
  }

  const statusText = `${status.stdout}\n${status.stderr}`;
  if (/Logged in:\s*no/i.test(statusText)) {
    return {
      ok: false,
      code: 'vault-logged-out',
      message: 'You are not logged in to the Dashlane CLI. Log in, then reopen the panel.',
      command: 'dcli sync',
    };
  }
  if (/Locked:\s*yes/i.test(statusText)) {
    return {
      ok: false,
      code: 'vault-locked',
      message: 'Your Dashlane vault is locked. Unlock it in a terminal, then reopen the panel.',
      command: UNLOCK_COMMAND,
    };
  }

  const path = vaultPath(deps.config);
  const read = await deps.run(deps.config.dcliPath, ['read', path]);
  if (read.spawnErrorCode === 'ENOENT') {
    return dcliMissing(deps.config);
  }

  const readText = `${read.stdout}\n${read.stderr}`;
  if (read.exitCode !== 0 || /not found|no matching|cannot find/i.test(readText)) {
    if (/master password|locked/i.test(readText)) {
      return {
        ok: false,
        code: 'vault-locked',
        message: 'Dashlane asked for your master password. Unlock the vault in a terminal, then reopen the panel.',
        command: UNLOCK_COMMAND,
      };
    }
    return {
      ok: false,
      code: 'vault-item-missing',
      message:
        `Dashlane has no item at ${path}. Create a secure note titled "${deps.config.itemTitle}" whose content is ` +
        `your Anthropic API key, or edit ~/.config/socrates/native-host.json to point at a different item.`,
      command: `dcli read "${path}"`,
    };
  }

  const apiKey = read.stdout.trim();
  if (apiKey === '') {
    return {
      ok: false,
      code: 'vault-item-missing',
      message: `The Dashlane item at ${path} is empty.`,
      command: `dcli read "${path}"`,
    };
  }

  return { ok: true, kind: 'api-key', apiKey };
}
