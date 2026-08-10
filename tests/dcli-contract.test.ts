/**
 * The one test that talks to the real Dashlane CLI.
 *
 * The host no longer depends on `dcli status` wording for the happy path, but it
 * does still use it to turn a failed read into a friendly message. That is the
 * only prose dependency left, so this test pins it: if Dashlane changes the
 * format, `pnpm check` on a machine with dcli installed fails loudly, and we fix
 * the classifier before anyone meets a mystery error.
 *
 * Skipped wherever dcli is not installed (CI, other people's machines), so it
 * never turns into a flaky gate. It reads only status - no vault items, no
 * secrets, and nothing from the output is printed.
 */

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { isRecognisableStatus, parseStatusLines } from '../src/native-host/handler.ts';

function findDcli(): string | null {
  try {
    const path = execFileSync('command', ['-v', 'dcli'], { shell: '/bin/sh', encoding: 'utf8' }).trim();
    return path === '' ? null : path;
  } catch {
    return null;
  }
}

const DCLI = findDcli();

describe.skipIf(DCLI === null)('dcli status contract (integration)', () => {
  const status = (): string =>
    execFileSync(DCLI as string, ['status'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });

  it('still emits the key: value lines the classifier reads', () => {
    const fields = parseStatusLines(status());

    expect(
      isRecognisableStatus(fields),
      'dcli status no longer contains "Logged in:" or "Locked:" lines. The native host classifier in ' +
        'src/native-host/handler.ts needs updating for the new format.',
    ).toBe(true);

    expect(fields.has('logged in'), 'dcli status no longer reports "Logged in:"').toBe(true);
    expect(fields.has('locked'), 'dcli status no longer reports "Locked:"').toBe(true);
  });

  it('still uses yes/no for those fields', () => {
    const fields = parseStatusLines(status());
    expect(fields.get('logged in'), 'expected "Logged in: yes" or "Logged in: no"').toMatch(/^(yes|no)$/);
    expect(fields.get('locked'), 'expected "Locked: yes" or "Locked: no"').toMatch(/^(yes|no)$/);
  });
});
