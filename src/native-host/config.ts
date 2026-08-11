/**
 * Non-secret configuration for the native host.
 *
 * Lives at `~/.config/socrates/native-host.json` and is written by
 * `bin/install-native-host.sh`. It contains *no* secrets - only where to find
 * the `claude` binary the host shells out to.
 */

export interface HostConfig {
  /**
   * Absolute path to the Claude Code CLI, recorded by the installer because
   * Chrome launches native hosts with a minimal PATH
   * (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), so a Homebrew or `claude
   * install` binary is not on it. It can also go stale - `claude install` and
   * Homebrew both move the binary - so the host also probes the well-known
   * locations below before giving up, and says which ones it tried.
   */
  claudePath: string;
}

export const DEFAULT_CONFIG: HostConfig = {
  claudePath: '/opt/homebrew/bin/claude',
};

/**
 * Where `claude` ends up when the recorded path misses. Newest-first, same
 * fallback-chain idea as the LeetCode selectors: `~/.local/bin` is where the
 * native installer puts it, then Homebrew, then a manual /usr/local install.
 */
export const CLAUDE_FALLBACK_PATHS = [
  '.local/bin/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

export function parseConfig(raw: string | null): HostConfig {
  if (!raw) return { ...DEFAULT_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_CONFIG };
  const record = parsed as Record<string, unknown>;
  return {
    claudePath: readString(record, 'claudePath', DEFAULT_CONFIG.claudePath),
  };
}

export interface ClaudePathLookup {
  /** The first candidate that exists, or `null` when none do. */
  path: string | null;
  /** Every candidate tried, in order. Quoted back to the user when none hit. */
  tried: string[];
}

/**
 * Resolves the `claude` binary: the recorded path first, then the well-known
 * locations. Pure apart from the injected `exists`, so a moved binary is a test
 * rather than a manual experiment.
 */
export function resolveClaudePath(
  config: HostConfig,
  exists: (path: string) => boolean,
  home: string,
): ClaudePathLookup {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    const absolute = candidate.startsWith('/')
      ? candidate
      : `${home.replace(/\/$/, '')}/${candidate}`;
    if (!candidates.includes(absolute)) candidates.push(absolute);
  };

  add(config.claudePath);
  for (const fallback of CLAUDE_FALLBACK_PATHS) add(fallback);

  return { path: candidates.find(exists) ?? null, tried: candidates };
}
