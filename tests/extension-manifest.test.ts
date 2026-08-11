/**
 * The two manifests, and the one link between them.
 *
 * `allowed_origins` in the native-messaging host manifest is the whole of the
 * host's access control: an extension listed there can run the user's `claude`
 * CLI with any system prompt it likes, read every token of the reply, and ask
 * `claude auth status --json` which account is paying. So the id registered
 * there has to be *this* extension and nothing else, and the only way to be sure
 * of that is to derive it from the key the extension manifest pins rather than
 * to keep a list by hand. These tests pin that derivation, and pin that a
 * re-install withdraws whatever it did not derive.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveExtensionId, readExtensionId } from '../scripts/extension-id.ts';
import { buildHostManifest, originOf, writeHostManifest } from '../scripts/native-host-manifest.ts';
import { NATIVE_HOST_NAME } from '../src/background/native-host-client.ts';

const REPO = resolve(import.meta.dirname, '..');
const MANIFEST = join(REPO, 'public/manifest.json');
const INSTALLER = join(REPO, 'bin/install-native-host.sh');

/**
 * The id Chromium hands this build. Written out rather than computed so the test
 * fails if the derivation changes, not just if the key does.
 */
const SOCRATES_ID = 'lbhnejceegeplldfheefbalbfnhdafnb';

/** Registered by an older installer, derivable from no key we own. */
const FOREIGN_ID = 'aplbkajcnpggamonmlebeaenjhhnjpdp';

const extensionManifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  key: string;
  permissions: string[];
  host_permissions: string[];
};

describe('the extension id', () => {
  it('is a pure function of the pinned key, and is the id this build gets', () => {
    expect(deriveExtensionId(extensionManifest.key)).toBe(SOCRATES_ID);
    expect(readExtensionId(MANIFEST)).toBe(SOCRATES_ID);
  });

  it('is what the installer script computes, with no id written by hand', () => {
    const installer = readFileSync(INSTALLER, 'utf8');
    expect(installer).toContain('scripts/extension-id.ts');
    // A literal id in the installer is how the wrong one survived for so long.
    expect(installer.match(/\b[a-p]{32}\b/g)).toBeNull();
    expect(
      execFileSync('node', [join(REPO, 'scripts/extension-id.ts')], { encoding: 'utf8' }).trim(),
    ).toBe(SOCRATES_ID);
  });
});

describe('the extension manifest', () => {
  it('asks for no host permission the code has any use for beyond LeetCode', () => {
    // The API-key provider is gone, so the Anthropic origin grants a credentialed
    // request path to nothing at all. There is no fetch anywhere in src/.
    expect(extensionManifest.host_permissions).toEqual([
      'https://leetcode.com/*',
      'https://*.leetcode.com/*',
    ]);
  });

  it('still asks for the permissions the extension actually uses', () => {
    expect(extensionManifest.permissions.sort()).toEqual(
      ['nativeMessaging', 'scripting', 'sidePanel', 'storage', 'tabs'].sort(),
    );
  });
});

describe('the native-messaging host manifest', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'socrates-hostmanifest-'));
    file = join(dir, `${NATIVE_HOST_NAME}.json`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const input = { hostName: NATIVE_HOST_NAME, launcher: '/repo/dist/native-host/socrates-host' };

  it('grants exactly the ids the install resolved', () => {
    const manifest = buildHostManifest({ ...input, extensionIds: [SOCRATES_ID] });
    expect(manifest.allowed_origins).toEqual([originOf(SOCRATES_ID)]);
    expect(manifest.name).toBe(NATIVE_HOST_NAME);
    expect(manifest.path).toBe(input.launcher);
  });

  it('withdraws an id a previous install granted, instead of keeping it forever', () => {
    writeFileSync(
      file,
      JSON.stringify({ allowed_origins: [originOf(SOCRATES_ID), originOf(FOREIGN_ID)] }),
    );

    const result = writeHostManifest(file, { ...input, extensionIds: [SOCRATES_ID] });

    expect(result.removed).toEqual([originOf(FOREIGN_ID)]);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { allowed_origins: string[] };
    expect(written.allowed_origins).toEqual([originOf(SOCRATES_ID)]);
  });

  it('converges: running it twice leaves the same allowlist', () => {
    writeFileSync(file, JSON.stringify({ allowed_origins: [originOf(FOREIGN_ID)] }));
    writeHostManifest(file, { ...input, extensionIds: [SOCRATES_ID] });
    const second = writeHostManifest(file, { ...input, extensionIds: [SOCRATES_ID] });
    expect(second.removed).toEqual([]);
    expect(second.allowed).toEqual([originOf(SOCRATES_ID)]);
  });

  it('starts from nothing when there is no previous manifest, or an unreadable one', () => {
    expect(writeHostManifest(file, { ...input, extensionIds: [SOCRATES_ID] }).removed).toEqual([]);
    writeFileSync(file, 'not json {');
    expect(writeHostManifest(file, { ...input, extensionIds: [SOCRATES_ID] }).removed).toEqual([]);
  });

  it('refuses to write an allowlist it cannot vouch for', () => {
    expect(() => buildHostManifest({ ...input, extensionIds: [] })).toThrow(/no ids/);
    expect(() => buildHostManifest({ ...input, extensionIds: ['not-an-id'] })).toThrow(
      /extension id/,
    );
    expect(() => buildHostManifest({ ...input, extensionIds: [`${SOCRATES_ID}z`] })).toThrow(
      /extension id/,
    );
  });
});
