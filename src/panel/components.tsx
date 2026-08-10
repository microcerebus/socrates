import { useEffect, useRef, useState, type ReactNode } from 'react';

import { RUNGS, TOTAL_HINTS, hintsUsedFor, rungSpec } from '../prompt/rungs.ts';
import {
  MODEL_CHOICES,
  PROVIDER_CHOICES,
  type AppError,
  type AttemptRecord,
  type EditorContext,
  type ModelId,
  type PageSnapshot,
  type ProblemContext,
  type ProviderId,
  type Rung,
  type Turn,
} from '../shared/types.ts';
import { Markdown } from './markdown.tsx';
import type { ClaudeAccess, HostInfo } from './port-client.ts';

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function Header({
  problem,
  elapsedMs,
  rung,
  attempts,
  onOpenSettings,
}: {
  problem: ProblemContext | null;
  elapsedMs: number;
  rung: Rung;
  attempts: AttemptRecord[];
  onOpenSettings: () => void;
}): ReactNode {
  const spec = rungSpec(rung);
  return (
    <header className="header">
      <div className="header-row">
        <h1 title={problem?.title ?? ''}>{problem?.title ?? 'No problem loaded'}</h1>
        <button type="button" className="icon-button" onClick={onOpenSettings} aria-label="Settings">
          ⚙
        </button>
      </div>
      <div className="meta">
        {problem?.difficulty ? <span className={`pill diff-${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span> : null}
        <span className="mono">{formatDuration(elapsedMs)}</span>
        <span>
          Rung {spec.id} · {spec.name}
        </span>
        <span>
          {hintsUsedFor(rung)} / {TOTAL_HINTS} hints
        </span>
      </div>
      {attempts.length > 0 ? (
        <p className="past">
          {attempts.length} earlier attempt{attempts.length === 1 ? '' : 's'} ·{' '}
          {attempts
            .slice(-3)
            .reverse()
            .map(
              (attempt) =>
                `${new Date(attempt.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · rung ${attempt.deepestRung} · ${formatDuration(attempt.durationMs)}`,
            )
            .join(' - ')}
        </p>
      ) : null}
    </header>
  );
}

export function ErrorNotice({ error, onDismiss }: { error: AppError; onDismiss: () => void }): ReactNode {
  return (
    <div className="notice notice-error" role="alert">
      <p>{error.message}</p>
      {error.remedies.map((remedy) => (
        <div className="remedy" key={remedy.command}>
          <span>{remedy.label}</span>
          <code>{remedy.command}</code>
          <button type="button" className="link" onClick={() => void navigator.clipboard.writeText(remedy.command)}>
            copy
          </button>
        </div>
      ))}
      <button type="button" className="link" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

export function Transcript({
  turns,
  streaming,
  thinking,
}: {
  turns: Turn[];
  streaming: string | null;
  thinking: boolean;
}): ReactNode {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, streaming, thinking]);

  /*
   * A turn starts with `streaming` set to the empty string, so between the
   * request going out and the first token arriving there is nothing to render.
   * Say so rather than showing an empty bubble - on Claude Code that gap is a
   * couple of seconds of process startup, and a blank bubble reads as broken.
   */
  const awaitingFirstToken = streaming === '' || (thinking && streaming === null);

  return (
    <div className="transcript">
      {turns.length === 0 && streaming === null && !thinking ? (
        <div className="empty">
          <p>
            Read the problem first. When you have a reading of it, start the interview - you will get one rung at a time,
            and nothing above it.
          </p>
          <ol className="ladder-preview">
            {RUNGS.map((spec) => (
              <li key={spec.id}>
                <strong>{spec.name}</strong> - {spec.summary}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {turns.map((turn, index) => (
        <article key={`${index}-${turn.role}`} className={`turn turn-${turn.role}`}>
          {turn.role === 'assistant' ? (
            <div className="rung-tag">rung {turn.rung}</div>
          ) : null}
          <div className="body">
            {turn.role === 'assistant' ? <Markdown source={turn.text} /> : <p>{turn.text}</p>}
          </div>
        </article>
      ))}

      {awaitingFirstToken ? <p className="thinking">thinking…</p> : null}
      {streaming !== null && streaming !== '' ? (
        <article className="turn turn-assistant streaming">
          <div className="body">
            <Markdown source={streaming} />
          </div>
        </article>
      ) : null}
      <div ref={bottom} />
    </div>
  );
}

export function Ladder({
  rung,
  started,
  busy,
  disabled,
  onUnlock,
  onReview,
  onGiveUp,
}: {
  rung: Rung;
  started: boolean;
  busy: boolean;
  disabled: boolean;
  onUnlock: () => void;
  onReview: () => void;
  onGiveUp: () => void;
}): ReactNode {
  const atTop = rung >= 5;
  const nextSpec = started ? RUNGS[Math.min(rung + 1, 5)] : RUNGS[0];
  return (
    <div className="ladder">
      <div className="ladder-row">
        <button type="button" className="primary" disabled={busy || disabled || atTop} onClick={onUnlock}>
          {started ? 'Next hint' : 'Understand the problem'}
        </button>
        <button type="button" disabled={busy || disabled} onClick={onReview}>
          Check my code
        </button>
      </div>
      <div className="ladder-row">
        <button type="button" className="ghost" disabled={busy || disabled || atTop} onClick={onGiveUp}>
          I give up - walk me through it
        </button>
      </div>
      <p className="ladder-hint">
        {atTop ? 'You are at the last rung.' : `Next: ${nextSpec?.name} - ${nextSpec?.summary}`}
      </p>
    </div>
  );
}

export function Composer({
  busy,
  disabled,
  onSend,
  onCancel,
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState('');
  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '' || busy || disabled) return;
    setText('');
    onSend(trimmed);
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={text}
        rows={2}
        placeholder="Talk through your thinking…"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button type="button" className="ghost" onClick={onCancel}>
          Stop
        </button>
      ) : (
        <button type="submit" disabled={disabled || text.trim() === ''}>
          Send
        </button>
      )}
    </form>
  );
}

export type ProbeState = 'unknown' | 'checking' | 'ok' | 'failed';

/**
 * The Claude Code half of Settings.
 *
 * The quota caveat is rendered from `PROVIDER_CHOICES`, not written twice: it is
 * the one thing about this provider a user can be genuinely surprised by, so it
 * sits under the choice whether or not the choice is selected.
 */
function ClaudeCodeAccess({
  state,
  access,
  claudePath,
  onProbe,
}: {
  state: ProbeState;
  access: ClaudeAccess | null;
  claudePath: string | null;
  onProbe: () => void;
}): ReactNode {
  return (
    <>
      <h3>Claude Code access</h3>
      <p className="small">
        Nothing to set up beyond a logged-in CLI. Socrates runs <code>claude</code> through the same native helper
        it uses for the vault, with tools switched off and the interviewer prompt as the entire system prompt.
      </p>
      <p className="small">
        Binary:{' '}
        {access ? (
          <code>{access.claudePath}</code>
        ) : claudePath === null ? (
          <em>not found</em>
        ) : (
          <code>{claudePath}</code>
        )}
        {access?.account ? (
          <>
            <br />
            Signed in as <code>{access.account}</code>
            {access.subscription ? ` on the ${access.subscription} plan` : ''}.
          </>
        ) : null}
      </p>
      <div className="ladder-row">
        <button type="button" onClick={onProbe} disabled={state === 'checking'}>
          {state === 'checking' ? 'Checking…' : 'Test Claude Code access'}
        </button>
        <span className="small">
          {state === 'ok' ? 'Logged in.' : state === 'failed' ? 'See the message above.' : ''}
        </span>
      </div>
    </>
  );
}

function VaultAccess({
  state,
  vaultItemTitle,
  onProbe,
}: {
  state: ProbeState;
  vaultItemTitle: string | null;
  onProbe: () => void;
}): ReactNode {
  return (
    <>
      <h3>API key</h3>
      <p className="small">
        Read from your Dashlane vault at session start through a native helper, and held in the service worker&rsquo;s
        memory only. It is never written to extension storage or to disk.
      </p>
      <p className="small">
        Dashlane item: {vaultItemTitle === null ? <em>checking&hellip;</em> : <code>{vaultItemTitle}</code>}
        <br />
        Change it in <code>~/.config/socrates/native-host.json</code>.
      </p>
      <div className="ladder-row">
        <button type="button" onClick={onProbe} disabled={state === 'checking'}>
          {state === 'checking' ? 'Checking…' : 'Test vault access'}
        </button>
        <span className="small">
          {state === 'ok' ? 'Key loaded.' : state === 'failed' ? 'See the message above.' : ''}
        </span>
      </div>
    </>
  );
}

export function SettingsPanel({
  provider,
  model,
  keyState,
  claudeState,
  claudeAccess,
  hostInfo,
  onSelectProvider,
  onSelectModel,
  onProbeKey,
  onProbeClaude,
  onClose,
}: {
  provider: ProviderId;
  model: ModelId;
  keyState: ProbeState;
  claudeState: ProbeState;
  claudeAccess: ClaudeAccess | null;
  /** What the native host is configured with, or null while unknown. */
  hostInfo: HostInfo | null;
  onSelectProvider: (provider: ProviderId) => void;
  onSelectModel: (model: ModelId) => void;
  onProbeKey: () => void;
  onProbeClaude: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <section className="sheet">
      <div className="header-row">
        <h2>Settings</h2>
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </div>

      <h3>Where replies come from</h3>
      {PROVIDER_CHOICES.map((choice) => (
        <label key={choice.id} className="choice">
          <input
            type="radio"
            name="provider"
            value={choice.id}
            checked={provider === choice.id}
            onChange={() => onSelectProvider(choice.id)}
          />
          <span>
            <strong>{choice.label}</strong>
            <small>{choice.blurb}</small>
            <small className="caveat">{choice.caveat}</small>
          </span>
        </label>
      ))}
      <p className="small">Takes effect on your next message. The hint ladder behaves identically either way.</p>

      <h3>Model</h3>
      {MODEL_CHOICES.map((choice) => (
        <label key={choice.id} className="choice">
          <input
            type="radio"
            name="model"
            value={choice.id}
            checked={model === choice.id}
            onChange={() => onSelectModel(choice.id)}
          />
          <span>
            <strong>{choice.label}</strong>
            <small>{choice.blurb}</small>
          </span>
        </label>
      ))}

      {provider === 'claude-code' ? (
        <ClaudeCodeAccess
          state={claudeState}
          access={claudeAccess}
          claudePath={hostInfo?.claudePath ?? null}
          onProbe={onProbeClaude}
        />
      ) : (
        <VaultAccess state={keyState} vaultItemTitle={hostInfo?.itemTitle ?? null} onProbe={onProbeKey} />
      )}
    </section>
  );
}

export interface PasteResult {
  problem: ProblemContext;
  editor: EditorContext;
}

export function PasteForm({
  reason,
  onSubmit,
  onCancel,
}: {
  reason: string | null;
  onSubmit: (snapshot: PageSnapshot) => void;
  onCancel: (() => void) | null;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('javascript');

  return (
    <section className="sheet">
      <h2>Paste the problem</h2>
      <p className="small">
        {reason
          ? `Socrates could not read this page (${reason}). Paste the problem instead - everything else works the same.`
          : 'Paste the problem and your code. Everything else works the same.'}
      </p>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="1. Two Sum" />
      </label>
      <label className="field">
        <span>Problem statement, examples and constraints</span>
        <textarea rows={8} value={statement} onChange={(event) => setStatement(event.target.value)} />
      </label>
      <label className="field">
        <span>Your code</span>
        <textarea rows={8} value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} />
      </label>
      <label className="field">
        <span>Language</span>
        <input value={language} onChange={(event) => setLanguage(event.target.value)} />
      </label>
      <div className="ladder-row">
        <button
          type="button"
          className="primary"
          disabled={statement.trim() === ''}
          onClick={() =>
            onSubmit({
              problem: {
                slug: title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pasted-problem',
                title: title.trim() || 'Pasted problem',
                url: null,
                difficulty: null,
                statement: statement.trim(),
                examples: [],
                constraints: [],
                source: 'manual',
              },
              editor: { language: language.trim() || 'plaintext', code, source: 'manual' },
              capturedAt: Date.now(),
            })
          }
        >
          Use this
        </button>
        {onCancel ? (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  );
}
