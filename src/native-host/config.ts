/**
 * Non-secret configuration for the native host.
 *
 * Lives at `~/.config/socrates/native-host.json` and is written by
 * `bin/install-native-host.sh`. It contains *no* secrets - only where to find
 * `dcli` and which Dashlane item holds the key.
 */

export interface HostConfig {
  /**
   * Absolute path to the Dashlane CLI. Chrome launches native hosts with a
   * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), so a Homebrew
   * `dcli` is not on it - the installer resolves and records the real path.
   */
  dcliPath: string;
  /** Title of the Dashlane item that holds the key. */
  itemTitle: string;
  /** Field on that item: `content` for a secure note, `password` for a credential. */
  itemField: string;
}

export const DEFAULT_CONFIG: HostConfig = {
  dcliPath: '/opt/homebrew/bin/dcli',
  itemTitle: 'Anthropic API Key',
  itemField: 'content',
};

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
    dcliPath: typeof record['dcliPath'] === 'string' && record['dcliPath'] ? record['dcliPath'] : DEFAULT_CONFIG.dcliPath,
    itemTitle:
      typeof record['itemTitle'] === 'string' && record['itemTitle'] ? record['itemTitle'] : DEFAULT_CONFIG.itemTitle,
    itemField:
      typeof record['itemField'] === 'string' && record['itemField'] ? record['itemField'] : DEFAULT_CONFIG.itemField,
  };
}

/** `dl://<title>/<field>` - the path form `dcli read` expects. */
export function vaultPath(config: HostConfig): string {
  return `dl://${config.itemTitle}/${config.itemField}`;
}
