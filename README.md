# socrates

A Chrome side-panel interviewer for LeetCode practice.
It sits next to the problem, reads the statement and your live editor buffer, and gives you one rung of help at a time.
It will not hand you the answer, and it will not leak the answer while pretending not to.

Built for a JS/TS engineer who is rusty on algorithms and preparing for interviews.

## The hint ladder

Six rungs. You unlock them one at a time with a button; nothing above the unlocked rung may appear in a reply.

| Rung | Name | What it may reveal | Counts as a hint |
| --- | --- | --- | --- |
| 0 | Understand | Restate the problem, surface edge cases, agree the contract | No |
| 1 | Pattern smell | One Socratic question pointing at the family of technique, never naming it | Yes |
| 2 | Name the technique | The technique or data structure, and why this problem invites it | Yes |
| 3 | Approach outline | Three to five plain-English steps, no code | Yes |
| 4 | Pseudocode | Structure, state and invariants, in your language idioms | Yes |
| 5 | Full walkthrough | Working solution, complexity, and a review of your own code against it | Yes |

The header counts hints out of five, not six, because rung 0 is free: understanding the problem is not a hint.

Alongside the ladder there is a chat box for talking through your thinking.
Chat replies are gated at the currently unlocked rung, so you cannot talk your way up the ladder.
"Check my code" reviews your editor buffer at the current rung's depth, and "I give up" jumps to rung 5.

## How spoiler discipline is enforced

Two layers, in this order.

**The prompt** (`src/prompt/system-prompt.ts`) is the primary control, and it is a versioned source file with the reasoning written out in its header comment.
Every rung carries an explicit list of what it may reveal and what it must still withhold (`src/prompt/rungs.ts`), because in practice a model follows "do not say X" far more reliably than it infers X from the absence of permission.
Rung 1 enumerates the technique names it may not use rather than gesturing at the category, and the prompt names the specific ways models leak: naming a technique by description, stacking questions until they amount to an outline, and answering a direct "is it a hash map?" honestly.
It also always offers a legal alternative to leaking, which is to say that the honest answer lives above the unlocked rung.

**The spoiler guard** (`src/prompt/spoiler-guard.ts`) is a deterministic backstop over the response stream.
Below rung 4 it strips fenced code blocks and replaces them with a notice, holding text back at a fence boundary rather than letting a partial block reach the panel and then retracting it.
It only enforces the one rule that is unambiguous enough to enforce mechanically; softer rules are left to the prompt, because pattern-matching them against prose produces false positives that mangle legitimate replies.

Both layers are covered by `tests/prompt-gating.test.ts`, which asserts on the request payload sent to a mocked Anthropic API and on what comes back out of the guard.

## Architecture

```
LeetCode problem page                 Extension                         Anthropic
─────────────────────                 ─────────                         ─────────
page-bridge.js  (MAIN world)
  reads the Monaco model  ─┐
                           │ window.postMessage
content-script.js  (ISOLATED world)
  parses the description  ─┴─────────▶ service-worker.js
                            sendMessage   builds the gated prompt  ────▶ POST /v1/messages
                                          runs the spoiler guard   ◀──── SSE stream
                                              │  ▲
                                       port   │  │  deltas
                                              ▼  │
                                          panel.html (React)
                                              │
                          native messaging     │
  Dashlane vault ◀── dcli ◀── socrates-host ◀──┘  (API key, once per worker lifetime)
```

| Path | Role |
| --- | --- |
| `src/prompt/` | Rung definitions, the system prompt, the context turn, the spoiler guard |
| `src/background/` | Service worker: page capture, the Anthropic client, the key fetch, the session log |
| `src/content/` | Isolated-world scraper plus the MAIN-world Monaco bridge |
| `src/content/scrape/selectors.ts` | Every LeetCode DOM selector, in one file, as fallback chains |
| `src/panel/` | The React side panel |
| `src/native-host/` | The Chrome native messaging host that runs `dcli` |
| `src/shared/` | Types and the panel/worker wire protocol |

### Reading the editor

LeetCode uses Monaco, which virtualises long files: only the lines currently on screen exist in the DOM.
Scraping `.view-line` elements therefore truncates silently, which is worse than failing.
So a MAIN-world content script reads the editor *model* (`monaco.editor.getModels()`), which holds the whole buffer, and posts it back to the isolated content script.
The extension is read-only on the page: it never types, clicks, or submits.

### When the page drifts

LeetCode reshuffles class names regularly.
Every selector is a newest-first fallback chain in one module, so drift is a one-file change.
If none of the chains hit, the panel says so and offers a paste box for the problem and your code, and everything else works the same.

## Requirements

- macOS (the installer supports Linux too; it is only tested on macOS)
- Chrome 116 or newer
- Node 20+ and pnpm
- [Dashlane CLI](https://github.com/Dashlane/dashlane-cli) (`brew install dashlane/tap/dashlane-cli`), logged in
- An Anthropic API key stored in your Dashlane vault

## Setup

### 1. Build

```sh
pnpm install
pnpm build
```

`dist/` is the unpacked extension.

### 2. Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/` folder.

The manifest pins a public key, so the extension id is always `lbhnejceegeplldfheefbalbfnhdafnb` no matter where `dist/` lives.
That is what keeps the native messaging registration valid when you move or rebuild the folder.

Note that Chrome 151 ignores the `--load-extension` command-line switch, so this has to be the manual **Load unpacked** step.

### 3. Put the key in Dashlane

Create a secure note in your vault titled **Anthropic API Key** whose content is the key and nothing else.
Check it reads back cleanly:

```sh
dcli read "dl://Anthropic API Key/content"
```

A different item works fine.
The item name and field are configuration, not code: see `~/.config/socrates/native-host.json` below.

### 4. Register the native host

```sh
./bin/install-native-host.sh
```

This writes two files, neither of which contains a secret:

- the Chrome native messaging manifest, in each installed Chrome profile directory, pointing at a launcher in `dist/native-host/`
- `~/.config/socrates/native-host.json`, holding the absolute path to `dcli` and which vault item to read

```json
{
  "dcliPath": "/opt/homebrew/bin/dcli",
  "itemTitle": "Anthropic API Key",
  "itemField": "content"
}
```

Edit `itemTitle` to point at a different item, and `itemField` to `password` if you keep the key in a credential rather than a secure note.
Re-run the installer after installing `dcli` somewhere new, or with `SOCRATES_ITEM_TITLE="..." SOCRATES_FORCE_CONFIG=1` to rewrite the config.

The launcher hard-codes the absolute path to `node` on purpose: Chrome starts native hosts with a minimal `PATH` that will not find a Homebrew or nvm install.

### 5. Use it

Open a LeetCode problem and click the Socrates icon.
The panel opens next to the problem with the title, a session timer, your rung, and any earlier attempts at the same problem.

## Settings

Open the gear in the panel header.

| Model | When |
| --- | --- |
| `claude-sonnet-5` | Default. Balanced. |
| `claude-opus-5` | Deepest reasoning, slower. |
| `claude-haiku-4-5-20251001` | Fastest and cheapest. |

Requests use adaptive thinking at medium effort on the Claude 5 models.
Haiku 4.5 predates both parameters and rejects them, so they are omitted for it (`src/background/anthropic.ts`).
Replies stream token by token; while the model is thinking, the panel says so rather than sitting blank.

**Test vault access** in the settings sheet runs the key fetch on its own, so you can check the Dashlane path without starting a session.

## How the API key is handled

This is the one hard rule in the project.

- The key is never written to `chrome.storage`, `localStorage`, IndexedDB, or any file the extension controls.
- It is read from your Dashlane vault at session start, over Chrome native messaging, and cached **in service-worker memory only**.
  When Chrome evicts the worker the cache dies with it and the next request re-reads the vault.
- The native host writes nothing but framed JSON on stdout, and never logs the key.
- If `dcli` is missing, the vault is locked, or the item does not exist, the panel shows what went wrong and the exact command to fix it.
  It never fails silently.
- `.gitignore` defensively excludes `.env*`, `*.pem`, `*.key`, and `native-host.json`.

Calls to `api.anthropic.com` go out from the service worker with the `anthropic-dangerous-direct-browser-access` header, which the API requires for browser-origin requests.
That header is safe here in a way it is not on a web page: the key never touches disk and never enters a renderer process.

## Session log

Every attempt is recorded in `chrome.storage.local` as date, time spent, deepest rung reached, and hints used, keyed by problem slug.
The record is upserted as you climb, so it stays current without needing to catch the moment the panel closes.
Past attempts at the current problem appear under the header.
There is no dashboard in v1.

## Development

```sh
pnpm check        # typecheck, lint, tests
pnpm build        # five vite passes into dist/
pnpm test:watch
pnpm icons        # regenerate the extension icons
```

`pnpm build` runs five passes because MV3 surfaces disagree about module format.
The panel and the service worker are ES modules; content scripts must be self-contained IIFEs, and rollup emits one IIFE per build, hence a pass each.
The native host is a sixth artefact built for Node.

### Tests

| File | Covers |
| --- | --- |
| `tests/prompt-gating.test.ts` | Rung gating in the prompt, the request body, and code redaction end to end against a mocked Anthropic API |
| `tests/scraper.test.ts` | The scraper against saved LeetCode HTML: current layout, a drifted layout, and an unrecognisable one |
| `tests/native-host.test.ts` | Native messaging framing, config parsing, and every vault failure branch against a fake `dcli` |

The problem bodies in `tests/fixtures/` are the real ones from LeetCode's public GraphQL endpoint; the page markup around them mirrors the live description tab.

### Changing the prompt

Edit `src/prompt/rungs.ts` for what a rung may reveal, and `src/prompt/system-prompt.ts` for how the discipline is stated.
Bump `SYSTEM_PROMPT_VERSION` when a change could alter behaviour.
The gating tests read the rung table directly, so adding a rung or editing a `withholds` line keeps them meaningful rather than stale.

## Out of scope for v1

Mock-interview timer mode, spaced repetition, complexity quizzes, a progress dashboard, and platforms other than LeetCode.
