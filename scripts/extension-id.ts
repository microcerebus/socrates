/**
 * Derives the Chrome extension id from the public key pinned in the manifest.
 *
 * A Chromium extension id is a pure function of the packed public key: the first
 * 16 bytes of `SHA-256(DER key)`, hex, with `0-9a-f` mapped onto `a-p`. Because
 * `public/manifest.json` pins `key`, the id is the same in Chrome, Chrome Beta,
 * Brave and Chromium, and it does not change when `dist/` moves.
 *
 * That matters because `allowed_origins` in the native-messaging host manifest
 * is the *entire* access-control mechanism for the host - the list of extensions
 * Chrome will let run the user's `claude` CLI. Registering an id that is not
 * this build hands that capability to some other principal, so the installer
 * derives the id here rather than carrying a hard-coded list that can drift.
 *
 * Run directly to print it:
 *
 *     node scripts/extension-id.ts [public/manifest.json]
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/** `0-9a-f` -> `a-p`, which is the alphabet Chromium prints ids in. */
function toMpdecimal(hex: string): string {
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

export function deriveExtensionId(publicKeyBase64: string): string {
  const der = Buffer.from(publicKeyBase64, 'base64');
  if (der.byteLength === 0) throw new Error('manifest key is empty or not base64');
  return toMpdecimal(createHash('sha256').update(der).digest('hex').slice(0, 32));
}

export function extensionIdFromManifest(manifestJson: string): string {
  const manifest = JSON.parse(manifestJson) as { key?: unknown };
  if (typeof manifest.key !== 'string' || manifest.key === '') {
    throw new Error('manifest has no pinned "key", so the extension id is not stable');
  }
  return deriveExtensionId(manifest.key);
}

export function readExtensionId(manifestPath: string): string {
  return extensionIdFromManifest(readFileSync(manifestPath, 'utf8'));
}

const DEFAULT_MANIFEST = resolve(import.meta.dirname, '../public/manifest.json');

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(readExtensionId(process.argv[2] ?? DEFAULT_MANIFEST));
}
