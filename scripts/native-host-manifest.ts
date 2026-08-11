/**
 * Writes one native-messaging host manifest, and converges it.
 *
 * ## Why this replaces rather than merges
 *
 * `allowed_origins` is the only thing standing between another extension and the
 * user's `claude` CLI: any id listed here can open a port to the host, run the
 * CLI with an arbitrary system prompt as often as it likes, read every token of
 * the reply, and ask `claude auth status --json` for the account it is billed to.
 *
 * An earlier installer unioned the incoming ids with whatever the file already
 * held, so an id written once could never be withdrawn - and a stale id from
 * before the manifest key was pinned did in fact survive that way. Merging was
 * never needed: the script writes a separate file per browser, and the id is
 * derived from the pinned key, so it is the same in every Chromium flavour.
 * This writer therefore states the whole allowlist every run, and reports what
 * it removed rather than quietly keeping it.
 *
 * Run directly by `bin/install-native-host.sh`:
 *
 *     node scripts/native-host-manifest.ts <file> <host-name> <launcher> <id>...
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EXTENSION_ID_PATTERN } from './extension-id.ts';

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

export interface HostManifestInput {
  hostName: string;
  launcher: string;
  extensionIds: readonly string[];
}

export function originOf(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

export function buildHostManifest({
  hostName,
  launcher,
  extensionIds,
}: HostManifestInput): HostManifest {
  if (extensionIds.length === 0) throw new Error('refusing to write a host manifest with no ids');
  for (const id of extensionIds) {
    if (!EXTENSION_ID_PATTERN.test(id)) {
      throw new Error(`'${id}' is not a Chrome extension id (32 letters a-p)`);
    }
  }
  return {
    name: hostName,
    description: 'Runs the Claude Code CLI for Socrates, headlessly.',
    path: launcher,
    type: 'stdio',
    allowed_origins: [...new Set(extensionIds)].map(originOf),
  };
}

function previousOrigins(file: string): string[] {
  try {
    const previous = JSON.parse(readFileSync(file, 'utf8')) as { allowed_origins?: unknown };
    return Array.isArray(previous.allowed_origins)
      ? previous.allowed_origins.filter((origin): origin is string => typeof origin === 'string')
      : [];
  } catch {
    /* no manifest yet, or an unreadable one we are about to replace */
    return [];
  }
}

export interface WriteResult {
  allowed: string[];
  /** Origins the previous manifest granted that this run withdrew. */
  removed: string[];
}

export function writeHostManifest(file: string, input: HostManifestInput): WriteResult {
  const manifest = buildHostManifest(input);
  const before = previousOrigins(file);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    allowed: manifest.allowed_origins,
    removed: before.filter((origin) => !manifest.allowed_origins.includes(origin)),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, hostName, launcher, ...extensionIds] = process.argv.slice(2);
  if (file === undefined || hostName === undefined || launcher === undefined) {
    console.error('usage: native-host-manifest.ts <file> <host-name> <launcher> <id>...');
    process.exit(2);
  }
  const { allowed, removed } = writeHostManifest(file, { hostName, launcher, extensionIds });
  const dropped = removed.length === 0 ? '' : `, removed ${removed.join(' ')}`;
  console.log(`${allowed.length} origin(s)${dropped}`);
}
