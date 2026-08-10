#!/usr/bin/env node
/**
 * A stand-in for the `claude` CLI, so the streaming host can be tested end to
 * end without spending a real usage window.
 *
 * The frames below are copied from real `claude -p --output-format stream-json
 * --include-partial-messages` runs against version 2.1.226, trimmed to the
 * fields the host reads. `tests/claude-cli-contract.test.ts` is what notices if
 * the real CLI stops emitting them.
 *
 * The scenario is taken from `--model`, because the host controls that argument
 * and nothing else has to be plumbed through to reach here.
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { setInterval } from 'node:timers';

const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] ?? '';
const pidFile = process.env.FAKE_CLAUDE_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

const say = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const delta = (text) => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const thinking = () => say({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
// A thinking delta carries text in the real CLI. It is dropped here deliberately:
// nothing downstream is allowed to read it, so nothing needs to see it.
const thinkingDelta = () => say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'drafting the answer' } } });
const init = () => say({ type: 'system', subtype: 'init', cwd: '/tmp', tools: [], model, claude_code_version: '2.1.226' });
const result = ({ subtype = 'success', ...extra } = {}) => say({ type: 'result', subtype, num_turns: 1, ...extra });

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
  });
}

const prompt = await readStdin();

switch (model) {
  case 'scenario-reply': {
    init();
    thinking();
    // Deliberately split across frames, the way real token deltas arrive.
    for (const piece of ['What ', 'do you ', 'already know', ' about the input?']) delta(piece);
    result({ is_error: false, result: 'What do you already know about the input?' });
    break;
  }

  case 'scenario-echo': {
    // Proves the real argv and the real stdin reached the process.
    delta(JSON.stringify({ args, prompt }));
    result({ is_error: false, result: 'echoed' });
    break;
  }

  case 'scenario-fenced-code': {
    for (const piece of ['Here it is.\n\n```js\n', 'const seen = new Map();\n', '```\n\nDone.']) delta(piece);
    result({ is_error: false, result: 'code' });
    break;
  }

  case 'scenario-logged-out': {
    // The CLI synthesises an assistant message for API errors. Reading those
    // would print the error into the panel as though the interviewer said it.
    say({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      error: 'authentication_failed',
      is_api_error_message: true,
    });
    result({ is_error: true, result: 'Not logged in · Please run /login', api_error_status: null });
    break;
  }

  case 'scenario-usage-limit': {
    say({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1786386000, rateLimitType: 'five_hour' },
    });
    result({ is_error: true, result: 'Claude usage limit reached.', api_error_status: 429 });
    break;
  }

  case 'scenario-unexplained': {
    process.stderr.write('some new failure mode\n');
    result({ is_error: true, result: '', api_error_status: 500 });
    break;
  }

  case 'scenario-no-partials': {
    // A future CLI that stops emitting deltas but still returns assistant text.
    result({ is_error: false, result: 'the whole answer at once' });
    break;
  }

  case 'scenario-no-partials-diagnostic': {
    // Terminates without is_error, but the subtype says `result` holds a CLI
    // diagnostic rather than anything the model said. Nothing to show.
    result({ subtype: 'error_max_turns', is_error: false, result: 'Reached maximum number of turns.' });
    break;
  }

  case 'scenario-long-think': {
    // The shape of a real slow turn: the CLI comes up, thinks for a while
    // producing nothing but thinking deltas, and only then starts answering.
    init();
    thinking();
    for (let i = 0; i < 40; i += 1) thinkingDelta();
    delta('Finally, an answer.');
    result({ is_error: false, result: 'Finally, an answer.' });
    break;
  }

  case 'scenario-hang': {
    delta('starting…');
    // Never finishes on its own: if this process goes away, something killed it.
    setInterval(() => undefined, 1_000);
    break;
  }

  default:
    result({ is_error: true, result: `fake-claude: no scenario for model '${model}'` });
}
