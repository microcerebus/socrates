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

## Where the replies come from

Two providers, chosen in Settings. They differ only in transport: the same rung-gated system prompt goes out, the same spoiler guard runs over what comes back, and switching takes effect on your next message.

| Provider | What it uses | What it costs |
| --- | --- | --- |
| **Claude Code (Max plan)** — default | The local `claude` CLI you are already logged into, run headlessly by the native host | Nothing beyond a logged-in CLI. **Shares your Claude usage windows** — see below |
| Anthropic API key (Dashlane) | `api.anthropic.com`, with a key read from your vault at session start | Prepaid API credits on your console account |

**The quota caveat, stated plainly.** On the Claude Code provider, a hint session is not free of your subscription — it draws on the same five-hour and weekly usage windows as every other Claude Code session on the machine. It is one pool. Interview turns are small (a few thousand tokens of problem, code and transcript), so a practice session costs far less than an hour of coding, but a long session while you are also mid-refactor elsewhere will bring the shared window down faster. When the window is exhausted the panel says so and repeats the CLI's own message about when it resets, rather than failing quietly.

Setup for Claude Code mode is a logged-in CLI and nothing else: no key, no vault, no console account. `claude auth status` should report `"loggedIn": true`.

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
                                              │  ▲                       (provider: API key)
                                       port   │  │  deltas
                                              ▼  │
                                          panel.html (React)
                                              │
                          native messaging     │
  Dashlane vault ◀── dcli ◀── socrates-host ◀──┤  sendNativeMessage (API key, once per worker)
                                              │
  Claude Max  ◀── claude -p ◀── socrates-host ◀┘  connectNative port, one per turn
                                                  (provider: Claude Code)
```

The key fetch is one message in, one message out, so it rides `sendNativeMessage`. A model reply cannot: it arrives as hundreds of small frames over tens of seconds, and `sendNativeMessage` gives you exactly one. So the Claude Code provider opens a `connectNative` port instead, one per turn — a port that dies with its request needs no routing, reconnection or staleness rules, and disconnecting is itself the hardest cancellation available.

| Path | Role |
| --- | --- |
| `src/prompt/` | Rung definitions, the system prompt, the context turn, the spoiler guard |
| `src/background/` | Service worker: page capture, both providers, the key fetch, the session log |
| `src/background/providers.ts` | The two transports behind one function type |
| `src/content/` | Isolated-world scraper plus the MAIN-world Monaco bridge |
| `src/content/scrape/selectors.ts` | Every LeetCode DOM selector, in one file, as fallback chains |
| `src/panel/` | The React side panel |
| `src/native-host/` | The native messaging host: runs `dcli` for the key, and `claude` for a reply |
| `src/shared/` | Types and the panel/worker wire protocol |

### Running the Claude Code CLI

`src/native-host/claude.ts` carries the flags and why each one is there; the short version is that the interviewer prompt is passed as `--system-prompt`, which *replaces* Claude Code's own system prompt rather than appending to it, and `--tools ""` leaves the session with no tools at all. So the run is single-turn text generation with the rung rules as the only instruction in force — it cannot read files, run commands, or loop. `--safe-mode`, `--setting-sources ""`, `--strict-mcp-config` and `--disable-slash-commands` keep the machine's own CLAUDE.md files, hooks, MCP servers and skills out of an interview, and the child runs in a temp directory so there is nothing to discover anyway.

Multi-turn is stateless: the transcript is flattened into one prompt and resent every call, and nothing is resumed. `--input-format stream-json` looks like the way to replay a message array but is not — it re-runs the model once per user message rather than priming history.

`tests/claude-cli-contract.test.ts` pins the flags and the `claude auth status --json` shape against the installed CLI, at no token cost, so a rename fails `pnpm check` here instead of surfacing later as a blank panel.

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
- Chrome 116 or newer, or Brave
- Node 20+ and pnpm
- For the default **Claude Code** provider: the [Claude Code CLI](https://claude.com/claude-code), logged in (`claude auth login`)
- For the **API key** provider only: the [Dashlane CLI](https://github.com/Dashlane/dashlane-cli) (`brew install dashlane/tap/dashlane-cli`), logged in, with an Anthropic API key in your vault

## Setup

### 1. Build

```sh
pnpm install
pnpm build
```

`dist/` is the unpacked extension.

### 2. Load it in the browser

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist` folder.

The manifest pins a public key, so the extension id is stable no matter where `dist/` lives.
That is what keeps the native messaging registration valid when you move or rebuild the folder.
Chrome and Brave have each been seen to hand this build a different id, and the installer registers both.

Note that Chrome 151 ignores the `--load-extension` command-line switch, so this has to be the manual **Load unpacked** step.

### 3. Register the native host

```sh
./bin/install-native-host.sh
```

This writes two files, neither of which contains a secret:

- the native messaging manifest, in each installed Chrome and Brave profile directory, pointing at a launcher in `dist/native-host/`
- `~/.config/socrates/native-host.json`, holding the absolute paths to `claude` and `dcli`, and which vault item to read

```json
{
  "dcliPath": "/opt/homebrew/bin/dcli",
  "itemTitle": "Anthropic API Key",
  "itemField": "content",
  "claudePath": "/opt/homebrew/bin/claude"
}
```

Both paths are recorded rather than looked up because the browser starts native hosts with a minimal `PATH` that will not find a Homebrew, nvm or `~/.local/bin` install; the launcher hard-codes the absolute path to `node` for the same reason.
`claudePath` can go stale — `claude install` and Homebrew both move the binary — so the host also probes `~/.local/bin`, Homebrew and `/usr/local/bin` before giving up, and when it does give up it names every path it tried.

Re-running the installer merges rather than clobbers: any extension id already in an installed manifest is kept, so registering Chrome does not deregister Brave.
Re-run it after installing `claude` or `dcli` somewhere new, or with `SOCRATES_ITEM_TITLE="..." SOCRATES_FORCE_CONFIG=1` to rewrite the config.

### 4. If you want the API key provider

Skip this on the default Claude Code provider — it needs no key at all.

Create a secure note in your vault titled **Anthropic API Key** whose content is the key and nothing else, then check it reads back cleanly:

```sh
dcli read "dl://Anthropic API Key/content"
```

A different item works fine.
The item name and field are configuration, not code: edit `itemTitle` above, and `itemField` to `password` if you keep the key in a credential rather than a secure note.

### 5. Use it

Open a LeetCode problem and click the Socrates icon.
The panel opens next to the problem with the title, a session timer, your rung, and any earlier attempts at the same problem.

## Settings

Open the gear in the panel header.

**Where replies come from** is the provider switch described above, with each option's cost stated under it.
It takes effect on your next message, with no reload, because the worker reads settings per turn rather than caching them.
Changing provider and model back to back is safe: each change is a patch against the newest intent rather than a whole object built from stale state, and writes are serialised, so the second change cannot undo the first (`src/panel/settings-writer.ts`).

| Model | When |
| --- | --- |
| `claude-sonnet-5` | Default. Balanced. |
| `claude-opus-5` | Deepest reasoning, slower. |
| `claude-haiku-4-5-20251001` | Fastest and cheapest. |

The same three ids work on both providers: the CLI accepts full model ids, so the picker maps straight through.
On the API-key provider, requests use adaptive thinking at medium effort on the Claude 5 models; Haiku 4.5 predates both parameters and rejects them, so they are omitted for it (`src/background/anthropic.ts`).
Replies stream on both providers, and the panel shows what is actually happening while they do: see below.

The access section below the pickers follows the selected provider.
**Test Claude Code access** reports the resolved binary and which account the CLI is logged in as; **Test vault access** runs the key fetch on its own and names the Dashlane item the host is configured to read.
Either way the panel learns the path from the host rather than hardcoding one.

## Appearance

Dark is the primary scheme, because LeetCode practice usually happens in dark mode; light is the verified secondary.
The panel follows `prefers-color-scheme` with no toggle.
Every colour in `src/panel/styles.css` comes from a token defined in one of the two palette blocks, and every foreground/background pair in use clears WCAG AA in both schemes.
Both schemes were checked visually before shipping, including chat bubbles, ladder states, disabled buttons, error and remedy panels, and code blocks.

### The rungs have colours

Each rung owns a hue, running cool to warm as the assistance escalates.

| Rung | 0 Understand | 1 Pattern smell | 2 Name the technique | 3 Approach outline | 4 Pseudocode | 5 Full walkthrough |
| --- | --- | --- | --- | --- | --- | --- |
| Hue | Sky | Blue | Mauve | Yellow | Peach | Red |

The temperature is the message: you should be able to glance at the footer and know you have moved from being nudged to being told, without reading a word.
The same hue carries the ladder meter, the badge and spine on every interviewer message, the rung pill and hint counter in the header, and the unlock button - which wears the colour of the rung it *would* unlock, so the cost of the next click is visible before it is read.

Rung colour is never used for prose or for a button label.
Catppuccin Latte's warm accents sit around 2.4:1 against Base, so rung colour is confined to bars, borders, dots and washes, and a filled control uses the hue itself in Mocha but a wash of it in Latte.
Motion follows the same rule as colour - it only ever means something - and `prefers-reduced-motion: reduce` drops the paced reveal and every transform.

## How the API key is handled

This is the one hard rule in the project.
It applies to the API-key provider; on Claude Code there is no key involved at all, and the vault is never opened.

- The key is never written to `chrome.storage`, `localStorage`, IndexedDB, or any file the extension controls.
- It is read from your Dashlane vault at session start, over Chrome native messaging, and cached **in service-worker memory only**.
  When Chrome evicts the worker the cache dies with it and the next request re-reads the vault.
- The native host writes nothing but framed JSON on stdout, and never logs the key.
- If `dcli` is missing, the vault is locked, or the item does not exist, the panel shows what went wrong and the exact command to fix it.
  It never fails silently.
- The host reads the key first and only classifies afterwards.
  `dcli` has no machine-readable output, so the success path depends on nothing but the exit code and stdout of `dcli read`.
  `dcli status` is consulted only after a read has already failed, to pick the friendliest accurate message, and it is parsed as `key: value` lines.
  If that output stops being recognisable, the host says so and quotes `dcli`'s own stderr rather than guessing: a confidently wrong "your vault is locked" is worse than an honest "this is what dcli said".
  `tests/dcli-contract.test.ts` runs against the real CLI when it is installed, so a wording change fails `pnpm check` on a dev machine instead of surfacing as a mystery error later.
- `.gitignore` defensively excludes `.env*`, `*.pem`, `*.key`, and `native-host.json`.

Calls to `api.anthropic.com` go out from the service worker with the `anthropic-dangerous-direct-browser-access` header, which the API requires for browser-origin requests.
That header is safe here in a way it is not on a web page: the key never touches disk and never enters a renderer process.

## A turn in flight

The panel distinguishes four states and will not claim more than the events it has received support (`src/panel/turn-progress.ts`).

| State | What it means |
| --- | --- |
| `connecting…` | The request has gone out and not one frame has come back. On Claude Code this is the CLI starting up. |
| `thinking…` | The transport says the turn is under way; no answer text yet. Heartbeats are still arriving. |
| `writing…` | Text is arriving. |
| `still working - long think` | Nothing at all for 25 seconds. The run has not failed, and the panel does not pretend otherwise - it says what it knows. |

An animated glyph and a counting-up elapsed time run alongside the label, and Stop is in the indicator itself as well as the composer.
A hard timeout at six minutes turns an unanswered turn into an actionable error rather than a spinner that never stops; it sits deliberately past the host's own five-minute cap, so the host - which has stderr, the exit code and `claude auth status` - gets to write the message whenever it still can.

## Picking a problem back up

Closing the panel does not throw the session away.
Each problem's transcript, rung, hints and elapsed time are saved in `chrome.storage.local` under its slug, and returning to the problem offers **Resume where you left off** or **Start fresh**.

This is about the usage window rather than convenience.
On the Claude Code provider every turn draws on the same Max pool as your real work, so re-explaining a problem and re-earning three hints you already paid for is the most wasteful thing the panel could do.
Resuming restores the conversation *and* the rung, so nothing is bought twice.

Storage is bounded on four axes - characters per turn, turns per session, characters per session, and number of sessions - and the oldest are pruned first (`src/background/transcript-store.ts`).
The page snapshot is deliberately not saved: it is re-scraped on resume, because a stale editor buffer would make "check my code" worse than useless.

### Navigating with the panel open

LeetCode is a single-page app, so you can move to another problem without the panel noticing on its own.
It watches the tab and follows: the session you were on is written under its own slug, the panel adopts the new problem, and it offers that problem's stored session if there is one.

The new problem starts at rung 0, like any first visit.
Carrying the rung across a navigation would hand you pseudocode for a problem where you had earned nothing, which is the one thing the ladder exists to prevent.

## Session log

Every attempt is recorded in `chrome.storage.local` as date, time spent, deepest rung reached, and hints used, keyed by problem slug.
The record is upserted as you climb, so it stays current without needing to catch the moment the panel closes.
A resumed session keeps the attempt id it started with, so one problem-sitting stays one row with one deepest rung rather than splitting into several shallower-looking attempts.
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
| `tests/native-host.test.ts` | Native messaging framing, config parsing, status parsing, and every vault failure branch against a fake `dcli` |
| `tests/claude-host.test.ts` | The Claude Code half of the host: the arg vector, the stream parser, binary resolution, every failure classification, and a real spawned turn against a fake `claude` |
| `tests/claude-code.test.ts` | The extension half: the streaming port, cancellation, error mapping, transcript flattening, race-safe settings writes, and that both providers redact identically |
| `tests/streaming-ux.test.ts` | The CLI frames a turn in flight is read from, the host's liveness heartbeat against a real child process, the phase machine and stall detector, and the reveal pacer |
| `tests/session-resume.test.ts` | Saving and restoring a session with its rung, surviving junk already on disk, and every storage bound |
| `tests/dcli-contract.test.ts` | That the real `dcli status` still emits the lines the classifier reads. Skipped when `dcli` is not installed |
| `tests/claude-cli-contract.test.ts` | That the real `claude` still takes the flags the host passes and reports auth as JSON. No API calls. Skipped when `claude` is not installed |

The problem bodies in `tests/fixtures/` are the real ones from LeetCode's public GraphQL endpoint; the page markup around them mirrors the live description tab.
`tests/fixtures/fake-claude.mjs` is a stand-in for the CLI whose frames are copied from real `--output-format stream-json` runs, so the streaming tests spawn a real child process without spending a usage window.

### Changing the prompt

Edit `src/prompt/rungs.ts` for what a rung may reveal, and `src/prompt/system-prompt.ts` for how the discipline is stated.
Bump `SYSTEM_PROMPT_VERSION` when a change could alter behaviour.
The gating tests read the rung table directly, so adding a rung or editing a `withholds` line keeps them meaningful rather than stale.

## Out of scope for v1

Mock-interview timer mode, spaced repetition, complexity quizzes, a progress dashboard, and platforms other than LeetCode.
