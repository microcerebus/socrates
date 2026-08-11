/**
 * The languages LeetCode compiles, and nothing else.
 *
 * ## Where this list comes from
 *
 * It is LeetCode's own, read off leetcode.com rather than remembered: the
 * `languageList { id name }` GraphQL query returns exactly these 25 slugs, in
 * this order, and opening the editor's language dropdown on a live problem page
 * prints the same names in the same order (minus the DB/shell entries, which
 * only appear on the problems that use them). Both were checked together, so
 * order here is dropdown order there.
 *
 * ## Why `id` is both the LeetCode slug and the Monaco language id
 *
 * LeetCode registers its Monaco languages under its own slugs, which is not the
 * usual Monaco naming: selecting Go leaves `model.getLanguageId() === 'golang'`,
 * Python3 leaves `'python3'`, C# leaves `'csharp'`. That was measured one
 * language at a time against the live editor, so the page bridge's Monaco read
 * and the toolbar label resolve to the same `id` without a translation table.
 *
 * `normaliseLanguageId` exists anyway, because a *pasted* language ("js", "c++",
 * "golang") and a future Monaco rename both arrive as free text, and one
 * unknown string should not silently become a language the user is not writing.
 */

export interface LeetCodeLanguage {
  /** LeetCode's slug for the language. Also the Monaco language id it registers. */
  id: string;
  /** Exactly the label LeetCode prints in its editor dropdown. */
  label: string;
  /**
   * `algorithm` languages appear on ordinary problems; `database` and `shell`
   * only on the problems that use them. Kept so the dropdown can group them
   * rather than burying JavaScript under five SQL dialects.
   */
  family: 'algorithm' | 'database' | 'shell';
}

export const LEETCODE_LANGUAGES: readonly LeetCodeLanguage[] = [
  { id: 'cpp', label: 'C++', family: 'algorithm' },
  { id: 'java', label: 'Java', family: 'algorithm' },
  { id: 'python3', label: 'Python3', family: 'algorithm' },
  { id: 'python', label: 'Python', family: 'algorithm' },
  { id: 'javascript', label: 'JavaScript', family: 'algorithm' },
  { id: 'typescript', label: 'TypeScript', family: 'algorithm' },
  { id: 'csharp', label: 'C#', family: 'algorithm' },
  { id: 'c', label: 'C', family: 'algorithm' },
  { id: 'golang', label: 'Go', family: 'algorithm' },
  { id: 'kotlin', label: 'Kotlin', family: 'algorithm' },
  { id: 'swift', label: 'Swift', family: 'algorithm' },
  { id: 'rust', label: 'Rust', family: 'algorithm' },
  { id: 'ruby', label: 'Ruby', family: 'algorithm' },
  { id: 'php', label: 'PHP', family: 'algorithm' },
  { id: 'dart', label: 'Dart', family: 'algorithm' },
  { id: 'scala', label: 'Scala', family: 'algorithm' },
  { id: 'elixir', label: 'Elixir', family: 'algorithm' },
  { id: 'erlang', label: 'Erlang', family: 'algorithm' },
  { id: 'racket', label: 'Racket', family: 'algorithm' },
  { id: 'bash', label: 'Bash', family: 'shell' },
  { id: 'mysql', label: 'MySQL', family: 'database' },
  { id: 'mssql', label: 'MS SQL Server', family: 'database' },
  { id: 'postgresql', label: 'PostgreSQL', family: 'database' },
  { id: 'oraclesql', label: 'Oracle', family: 'database' },
  { id: 'pythondata', label: 'Pandas', family: 'database' },
];

/** What the panel writes in when it has no idea, and what the paste form starts on. */
export const DEFAULT_LANGUAGE_ID = 'javascript';

const BY_ID = new Map(LEETCODE_LANGUAGES.map((language) => [language.id, language]));
const BY_LABEL = new Map(
  LEETCODE_LANGUAGES.map((language) => [language.label.toLowerCase(), language]),
);

/**
 * Spellings that are not LeetCode's but arrive anyway: a pasted language, a
 * Monaco build that renamed one, a `data-mode-id` from an older page. Only
 * unambiguous aliases belong here - `python` is a real LeetCode language, so it
 * must never be folded into `python3`.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'c++': 'cpp',
  cplusplus: 'cpp',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'typescript',
  go: 'golang',
  'c#': 'csharp',
  cs: 'csharp',
  'objective-c': 'c',
  py: 'python3',
  py3: 'python3',
  python2: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  sh: 'bash',
  shell: 'bash',
  sql: 'mysql',
  postgres: 'postgresql',
  pandas: 'pythondata',
  oracle: 'oraclesql',
  'ms sql server': 'mssql',
};

export function languageById(id: string): LeetCodeLanguage | null {
  return BY_ID.get(id) ?? null;
}

/** Resolves the label LeetCode prints in its toolbar back to a language. */
export function languageByLabel(label: string): LeetCodeLanguage | null {
  return BY_LABEL.get(label.trim().toLowerCase()) ?? null;
}

/**
 * Best effort at turning free text into one of our ids. Returns `null` rather
 * than guessing, so callers can decide whether to keep the raw string (which is
 * still useful in a prompt) or fall back to a default.
 *
 * It takes `unknown` on purpose. This is the allowlist that stands between the
 * page and the prompt, and its inputs are page-controlled: the toolbar's text,
 * a `data-mode-id` attribute, and whatever the MAIN-world bridge posts back for
 * `language` - which a hostile page can make any type it likes. An allowlist
 * that throws on hostile input is not an allowlist, and here it did worse than
 * throw: the exception surfaced inside the bridge listener after the timeout had
 * been cleared, so the capture promise never settled and the panel hung
 * silently. Being total is the property that matters, not the parameter type.
 */
export function normaliseLanguageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (BY_ID.has(trimmed)) return trimmed;
  const byLabel = BY_LABEL.get(trimmed);
  if (byLabel) return byLabel.id;
  return ALIASES[trimmed] ?? null;
}

/**
 * What to call the language in front of a human or a model. Unknown ids are
 * passed through rather than replaced: "plaintext" is more honest than
 * "JavaScript" when the editor could not be read.
 */
export function languageLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}
