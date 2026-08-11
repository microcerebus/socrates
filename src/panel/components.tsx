import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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
  type StoredSession,
  type Turn,
} from '../shared/types.ts';
import { Markdown } from './markdown.tsx';
import type { ClaudeAccess, HostInfo } from './port-client.ts';
import { elapsedSeconds, livenessAt, progressLabel, type TurnProgress } from './turn-progress.ts';

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The ladder as six bars, coloured cool-to-warm by rung.
 *
 * The colours are the point rather than decoration: the whole product is a
 * negotiation about how much help you are willing to spend, and a number
 * ("rung 3") does not make that felt. A bar that has just gone from blue to
 * yellow does. Locked rungs keep their hue but drop to an outline, so the shape
 * of what is still available is visible without competing with what is spent.
 *
 * Every colour is a `--rung-N` token in `styles.css`; the mapping from rung to
 * token is the `data-rung` attribute and nothing else, so there is one place to
 * change it and it cannot drift between the meter, the bubbles and the buttons.
 */
export type RungState = 'spent' | 'current' | 'next' | 'locked';

/** The one place that decides what a rung looks like, so nothing can disagree. */
export function rungStateFor(id: Rung, rung: Rung, started: boolean): RungState {
  if (!started) return id === 0 ? 'next' : 'locked';
  if (id < rung) return 'spent';
  if (id === rung) return 'current';
  return id === rung + 1 ? 'next' : 'locked';
}

export function RungMeter({ rung, started }: { rung: Rung; started: boolean }): ReactNode {
  return (
    <ol className="rung-meter" aria-label={`Hint ladder, at rung ${rung} of 5`}>
      {RUNGS.map((spec) => {
        const state = rungStateFor(spec.id, rung, started);
        return (
          <li
            key={spec.id}
            data-rung={spec.id}
            data-state={state}
            title={`Rung ${spec.id} · ${spec.name} - ${spec.summary}`}
          >
            <span className="sr-only">{`${spec.name} (${state})`}</span>
          </li>
        );
      })}
    </ol>
  );
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
        <button
          type="button"
          className="icon-button"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
      {/*
        The rung badge and the hint counter carry the rung's colour, so the two
        readings of "how much help have I taken" - a name and a number - agree
        with each other and with the ladder below without being read.
      */}
      <div className="meta">
        {problem?.difficulty ? (
          <span className={`pill diff-${problem.difficulty.toLowerCase()}`}>
            {problem.difficulty}
          </span>
        ) : null}
        <span className="mono">{formatDuration(elapsedMs)}</span>
        <span className="pill rung-pill" data-rung={rung}>
          Rung {spec.id} · {spec.name}
        </span>
        <span className="hint-count" data-rung={rung}>
          <strong className="mono">{hintsUsedFor(rung)}</strong> / {TOTAL_HINTS} hints
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

export function ErrorNotice({
  error,
  onDismiss,
}: {
  error: AppError;
  onDismiss: () => void;
}): ReactNode {
  return (
    <div className="notice notice-error" role="alert">
      <p>{error.message}</p>
      {error.remedies.map((remedy) => (
        <div className="remedy" key={remedy.command}>
          <span>{remedy.label}</span>
          <code>{remedy.command}</code>
          <button
            type="button"
            className="link"
            onClick={() => void navigator.clipboard.writeText(remedy.command)}
          >
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

/**
 * What the panel is doing right now, while it is doing it.
 *
 * Three things are on screen because three different questions were being asked
 * of a motionless "thinking…": is it alive (the glyph moves), how long has it
 * been (the counter), and what is it actually doing (the label, which comes from
 * `turn-progress.ts` so it cannot claim more than the events support). Stop sits
 * inside the indicator rather than only in the composer, because the moment you
 * want to cancel is the moment you are looking at this.
 */
export function ThinkingIndicator({
  progress,
  now,
  rung,
  onCancel,
}: {
  progress: TurnProgress;
  now: number;
  rung: Rung;
  onCancel: () => void;
}): ReactNode {
  const liveness = livenessAt(progress, now);
  const seconds = elapsedSeconds(progress, now);
  return (
    <div
      className="thinking"
      data-rung={rung}
      data-phase={progress.phase}
      data-liveness={liveness}
      role="status"
    >
      <span className="thinking-glyph" aria-hidden="true">
        ✳
      </span>
      <span className="thinking-label">{progressLabel(progress, liveness)}</span>
      <span className="thinking-elapsed mono">{seconds}s</span>
      <button type="button" className="link thinking-stop" onClick={onCancel}>
        stop
      </button>
    </div>
  );
}

/**
 * Sticks to the bottom while the reply grows, and stops sticking the moment the
 * user scrolls up.
 *
 * The old version called `scrollIntoView` on every delta unconditionally, which
 * meant scrolling back to re-read the rung-2 hint during a long rung-4 reply
 * yanked you to the bottom several times a second. Being pinned is a state the
 * user sets by scrolling, not something the panel decides.
 */
const PIN_TOLERANCE_PX = 48;

function useStickToBottom(deps: readonly unknown[]): {
  scroller: React.RefObject<HTMLDivElement | null>;
  pinned: boolean;
  onScroll: () => void;
  jumpToLatest: () => void;
} {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_TOLERANCE_PX;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    pinnedRef.current = true;
    setPinned(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  // Layout effect, so the scroll lands in the same frame the text does and the
  // panel never shows a half-scrolled position.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller owns what counts as new content
  }, deps);

  return { scroller, pinned, onScroll, jumpToLatest };
}

export function Transcript({
  turns,
  streaming,
  progress,
  now,
  rung,
  reducedMotion,
  onCancel,
}: {
  turns: Turn[];
  streaming: string | null;
  progress: TurnProgress;
  now: number;
  rung: Rung;
  reducedMotion: boolean;
  onCancel: () => void;
}): ReactNode {
  const busy = progress.phase !== 'idle';
  const { scroller, pinned, onScroll, jumpToLatest } = useStickToBottom([
    turns.length,
    streaming,
    progress.phase,
  ]);

  /*
   * A turn starts with `streaming` set to the empty string, so between the
   * request going out and the first token arriving there is nothing to render.
   * Say so rather than showing an empty bubble - on Claude Code that gap is a
   * couple of seconds of process startup, and a blank bubble reads as broken.
   */
  const awaitingFirstToken = busy && (streaming === null || streaming === '');

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {turns.length === 0 && !busy ? (
          <div className="empty">
            <p>
              Read the problem first. When you have a reading of it, start the interview - you will
              get one rung at a time, and nothing above it.
            </p>
            <ol className="ladder-preview">
              {RUNGS.map((spec) => (
                <li key={spec.id} data-rung={spec.id}>
                  <strong>{spec.name}</strong> - {spec.summary}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <article
            key={`${index}-${turn.role}`}
            className={`turn turn-${turn.role}`}
            data-rung={turn.rung}
          >
            {turn.role === 'assistant' ? (
              <div className="rung-tag">
                rung {turn.rung} · {rungSpec(turn.rung).name}
              </div>
            ) : null}
            <div className="body">
              {turn.role === 'assistant' ? <Markdown source={turn.text} /> : <p>{turn.text}</p>}
            </div>
          </article>
        ))}

        {awaitingFirstToken ? (
          <ThinkingIndicator progress={progress} now={now} rung={rung} onCancel={onCancel} />
        ) : null}
        {streaming !== null && streaming !== '' ? (
          <article
            className={reducedMotion ? 'turn turn-assistant' : 'turn turn-assistant streaming'}
            data-rung={rung}
          >
            <div className="rung-tag">
              rung {rung} · {rungSpec(rung).name}
            </div>
            <div className="body">
              <Markdown source={streaming} />
            </div>
          </article>
        ) : null}
      </div>

      {pinned ? null : (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
    </div>
  );
}

/**
 * The offer to pick a problem back up.
 *
 * Framed around what resuming saves rather than what it restores, because that
 * is the decision being made: starting fresh means paying the same Max window
 * again for hints already earned. The counts are shown so the choice is
 * informed rather than a guess.
 */
export function ResumeOffer({
  session,
  onResume,
  onStartFresh,
}: {
  session: StoredSession;
  onResume: () => void;
  onStartFresh: () => void;
}): ReactNode {
  const exchanges = session.turns.filter((turn) => turn.role === 'assistant').length;
  const hints = hintsUsedFor(session.deepestRung);
  return (
    <section className="resume" data-rung={session.deepestRung}>
      <h2>You were here before</h2>
      <p className="small">
        {exchanges} {exchanges === 1 ? 'reply' : 'replies'} · reached{' '}
        <strong>rung {session.deepestRung}</strong> ({rungSpec(session.deepestRung).name}) · {hints}{' '}
        of {TOTAL_HINTS} hints · {formatDuration(session.elapsedMs)} spent
      </p>
      <p className="small">
        Resuming restores the conversation and the rung you had unlocked. Starting fresh means
        earning those hints again, which costs another turn each.
      </p>
      <div className="ladder-row">
        <button type="button" className="primary" onClick={onResume}>
          Resume where you left off
        </button>
        <button type="button" className="ghost" onClick={onStartFresh}>
          Start fresh
        </button>
      </div>
    </section>
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
  const nextRung = (started ? Math.min(rung + 1, 5) : 0) as Rung;
  const nextSpec = RUNGS[nextRung];
  return (
    <div className="ladder">
      <RungMeter rung={rung} started={started} />
      {/*
        The unlock button wears the colour of the rung it would unlock, not the
        one you are on. You should be able to see the button turn from blue to
        orange and know, before reading anything, that the next click is a
        bigger concession than the last one.
      */}
      <div className="ladder-row">
        <button
          type="button"
          className="primary"
          data-rung={nextRung}
          disabled={busy || disabled || atTop}
          onClick={onUnlock}
        >
          {started ? 'Next hint' : 'Understand the problem'}
        </button>
        <button type="button" data-rung={rung} disabled={busy || disabled} onClick={onReview}>
          Check my code
        </button>
      </div>
      <div className="ladder-row">
        <button
          type="button"
          className="ghost give-up"
          data-rung={5}
          disabled={busy || disabled || atTop}
          onClick={onGiveUp}
        >
          I give up - walk me through it
        </button>
      </div>
      <p className="ladder-hint">
        {atTop ? (
          'You are at the last rung.'
        ) : (
          <>
            Next:{' '}
            <strong data-rung={nextRung} className="rung-name">
              {nextSpec?.name}
            </strong>{' '}
            - {nextSpec?.summary}
          </>
        )}
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
 * The one thing about hints a user can be genuinely surprised by: they draw on
 * the same Max usage windows as every other Claude Code session on this
 * machine. Shown unconditionally, not tucked behind a probe.
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
        Nothing to set up beyond a logged-in CLI. Socrates runs <code>claude</code> through a native
        helper, with tools switched off and the interviewer prompt as the entire system prompt.
      </p>
      <p className="small">
        Hints draw on the same Max usage windows as every other Claude Code session on this machine
        - it is one pool, and interview sessions are small but not free of it.
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

type ClearState = 'idle' | 'confirming' | 'clearing' | 'cleared';

/**
 * Says what is kept, and offers the only way to get rid of all of it.
 *
 * Transcripts hold the problem statement, every hint and the user's own editor
 * buffer, unencrypted in `chrome.storage.local`, for up to 24 problems. Until
 * now the only way to remove one was "Start fresh" on a resume offer, one
 * problem at a time, which is not an answer to "get this off my machine".
 *
 * The click is deliberately two-step: the button says what it will do, and the
 * confirmation is a second, differently-labelled control. There is no undo.
 */
function SavedData({ onClear }: { onClear: () => Promise<void> }): ReactNode {
  const [state, setState] = useState<ClearState>('idle');

  return (
    <>
      <h3>Saved data</h3>
      <p className="small">
        Socrates keeps one transcript per problem (statement, hints and your editor buffer) and a
        log of past attempts, in this browser&apos;s local storage on this machine. Nothing is sent
        anywhere except to your own <code>claude</code> CLI when you ask for a hint.
      </p>
      <div className="ladder-row saved-data">
        {state === 'confirming' ? (
          <>
            <button
              type="button"
              className="destructive"
              onClick={() => {
                setState('clearing');
                onClear().then(
                  () => setState('cleared'),
                  () => setState('idle'),
                );
              }}
            >
              Delete everything
            </button>
            <button type="button" className="ghost" onClick={() => setState('idle')}>
              Keep it
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="destructive"
              disabled={state === 'clearing'}
              onClick={() => setState('confirming')}
            >
              Clear all saved data
            </button>
            <span className="small">
              {state === 'cleared'
                ? 'Deleted. Your model choice is kept.'
                : 'Transcripts and attempt history. No undo.'}
            </span>
          </>
        )}
      </div>
    </>
  );
}

export function SettingsPanel({
  model,
  claudeState,
  claudeAccess,
  hostInfo,
  onSelectModel,
  onProbeClaude,
  onClearAllData,
  onClose,
}: {
  model: ModelId;
  claudeState: ProbeState;
  claudeAccess: ClaudeAccess | null;
  /** What the native host is configured with, or null while unknown. */
  hostInfo: HostInfo | null;
  onSelectModel: (model: ModelId) => void;
  onProbeClaude: () => void;
  onClearAllData: () => Promise<void>;
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

      <ClaudeCodeAccess
        state={claudeState}
        access={claudeAccess}
        claudePath={hostInfo?.claudePath ?? null}
        onProbe={onProbeClaude}
      />

      <SavedData onClear={onClearAllData} />
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
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="1. Two Sum"
        />
      </label>
      <label className="field">
        <span>Problem statement, examples and constraints</span>
        <textarea
          rows={8}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Your code</span>
        <textarea
          rows={8}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          spellCheck={false}
        />
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
                slug:
                  title
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '') || 'pasted-problem',
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
