import { useEffect, useRef, useState, type ReactNode } from 'react';

import { RUNGS, TOTAL_HINTS, hintsUsedFor, rungSpec } from '../prompt/rungs.ts';
import {
  MODEL_CHOICES,
  type AppError,
  type AttemptRecord,
  type EditorContext,
  type ModelId,
  type PageSnapshot,
  type ProblemContext,
  type Rung,
  type Turn,
} from '../shared/types.ts';
import { Markdown } from './markdown.tsx';

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

      {thinking && streaming === null ? <p className="thinking">thinking…</p> : null}
      {streaming !== null ? (
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

export function SettingsPanel({
  model,
  keyState,
  vaultItemTitle,
  onSelectModel,
  onProbeKey,
  onClose,
}: {
  model: ModelId;
  keyState: 'unknown' | 'checking' | 'ok' | 'failed';
  /** Which Dashlane item the native host reads, or null while unknown. */
  vaultItemTitle: string | null;
  onSelectModel: (model: ModelId) => void;
  onProbeKey: () => void;
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

      <h3>API key</h3>
      <p className="small">
        Read from your Dashlane vault at session start through a native helper, and held in the service worker&rsquo;s
        memory only. It is never written to extension storage or to disk.
      </p>
      <p className="small">
        Dashlane item:{' '}
        {vaultItemTitle === null ? (
          <em>checking&hellip;</em>
        ) : (
          <code>{vaultItemTitle}</code>
        )}
        <br />
        Change it in <code>~/.config/socrates/native-host.json</code>.
      </p>
      <div className="ladder-row">
        <button type="button" onClick={onProbeKey} disabled={keyState === 'checking'}>
          {keyState === 'checking' ? 'Checking…' : 'Test vault access'}
        </button>
        <span className="small">
          {keyState === 'ok' ? 'Key loaded.' : keyState === 'failed' ? 'See the message above.' : ''}
        </span>
      </div>
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
