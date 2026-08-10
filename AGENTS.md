# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

Start with `README.md`; it carries the architecture, setup and security model.
The notes below are the things that are not obvious from reading the code.

## Commands

- `pnpm check` is the gate: typecheck, lint, tests. Run it before claiming anything works.
- `pnpm build` runs five separate vite passes (`SOCRATES_TARGET=...`). They are not interchangeable and the first one empties `dist/`, so run the whole script rather than a single pass unless you know why.

## Sharp edges

- **Content scripts cannot be ES modules.** That is the only reason `vite.config.ts` is target-switched instead of one build. Do not "simplify" it into a single pass.
- **TypeScript is pinned to 6.x** because typescript-eslint refuses to run against TS 7. Bumping TypeScript without checking `pnpm lint` will break the gate.
- **Chrome 151 ignores `--load-extension`.** The extension cannot be loaded from the command line, so there is no automated end-to-end browser test; loading is a manual "Load unpacked" step. A minimal control extension fails the same way, so this is the platform, not the manifest.
- **The extension id is pinned** by the public `key` in `public/manifest.json` (`lbhnejceegeplldfheefbalbfnhdafnb`). It is what makes the native messaging registration survive rebuilds and moves. Changing the key means re-running `bin/install-native-host.sh` with the new id.
- **The native host runs under Chrome's minimal PATH.** Both `node` and `dcli` are referenced by absolute path (the launcher, and `~/.config/socrates/native-host.json`). Do not switch either to a bare command name.
- **`SOCRATES_HOST_CONFIG`** overrides the host config path; it exists so the host can be driven against the real vault without touching `~/.config`.

## Product invariants

- The API key must never reach `chrome.storage`, `localStorage`, or any file the extension writes. Service-worker memory only. See `src/background/keychain.ts`.
- Replies must never exceed the unlocked rung. The prompt is the primary control (`src/prompt/`), the spoiler guard is the deterministic backstop, and `tests/prompt-gating.test.ts` covers both. Changes to rung content belong in `src/prompt/rungs.ts`, which the tests read directly.
- The extension is read-only on leetcode.com: no typing, clicking, or submitting.
- All LeetCode selectors live in `src/content/scrape/selectors.ts` as fallback chains. DOM drift should be a one-file change, and when it is not, the paste fallback keeps the tool usable.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
