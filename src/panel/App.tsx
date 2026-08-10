import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { TOTAL_HINTS, hintsUsedFor } from '../prompt/rungs.ts';
import type { AskRequest } from '../shared/protocol.ts';
import {
  DEFAULT_SETTINGS,
  appError,
  type AppError,
  type AskIntent,
  type AttemptRecord,
  type ModelId,
  type PageSnapshot,
  type ProviderId,
  type Rung,
  type Settings,
  type StoredSession,
  type Turn,
} from '../shared/types.ts';
import {
  Composer,
  ErrorNotice,
  Header,
  Ladder,
  PasteForm,
  ResumeOffer,
  SettingsPanel,
  Transcript,
  type ProbeState,
} from './components.tsx';
import { PortClient, type ClaudeAccess, type HostInfo } from './port-client.ts';
import { createSettingsWriter } from './settings-writer.ts';
import { IDLE_PROGRESS, TIMEOUT_AFTER_MS, applyEvent, beginTurn, type TurnProgress } from './turn-progress.ts';
import { REVEAL_WINDOW_MS, createTypewriter, type Typewriter } from './typewriter.ts';

/** How often the clock the panel renders from advances. */
const TICK_MS = 1000;

function nowIso(at: number): string {
  return new Date(at).toISOString();
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * The one piece of chrome the panel reads directly. Motion here is decorative -
 * a spinner, a caret, a paced reveal - so honouring the preference costs nothing
 * and the state stays just as readable without it.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const listener = (): void => setReduced(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);
  return reduced;
}

export function App(): ReactNode {
  const client = useMemo(() => new PortClient(), []);
  const reducedMotion = usePrefersReducedMotion();

  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [captureFailure, setCaptureFailure] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [rung, setRung] = useState<Rung>(0);
  const [deepestRung, setDeepestRung] = useState<Rung>(0);
  const [started, setStarted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [progress, setProgress] = useState<TurnProgress>(IDLE_PROGRESS);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  /*
   * The session clock is state, not a module constant, because resuming rebases
   * it: a session picked up after lunch shows the twenty minutes already spent
   * on the problem, not zero. `attemptStartedAt` is the identity of the attempt
   * and stays fixed across resumes, so the session log keeps one row per attempt
   * with one deepest rung rather than one row per sitting.
   */
  const [sessionStart, setSessionStart] = useState(() => Date.now());
  const [attemptStartedAt, setAttemptStartedAt] = useState(() => nowIso(Date.now()));
  const [resumable, setResumable] = useState<StoredSession | null>(null);

  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<AppError | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyState, setKeyState] = useState<ProbeState>('unknown');
  const [claudeState, setClaudeState] = useState<ProbeState>('unknown');
  const [claudeAccess, setClaudeAccess] = useState<ClaudeAccess | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [allAttempts, setAllAttempts] = useState<AttemptRecord[]>([]);

  // Holds the settings intent across renders, so a change is a patch against the
  // newest one rather than against whatever this render closed over.
  const settingsWriter = useMemo(
    () => createSettingsWriter({ save: (next) => client.setSettings(next), onSettings: setSettings, onError: setError }),
    [client],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const elapsedMs = Math.max(0, now - sessionStart);

  // The live attempt is upserted as the user climbs, so it is already in the
  // stored list; showing it back as "an earlier attempt" would be a lie.
  const attempts = useMemo(
    () => allAttempts.filter((record) => record.startedAt !== attemptStartedAt),
    [allAttempts, attemptStartedAt],
  );

  const loadAttempts = useCallback(
    (slug: string) => {
      void client.getAttempts(slug).then(setAllAttempts).catch(() => undefined);
    },
    [client],
  );

  /** Offers a resume when there is a transcript worth resuming, and nothing else. */
  const offerResume = useCallback(
    (slug: string) => {
      void client
        .getSession(slug)
        .then((session) => {
          if (session && session.turns.length > 0) setResumable(session);
        })
        .catch(() => undefined);
    },
    [client],
  );

  useEffect(() => {
    void client
      .getSettings()
      .then((stored) => settingsWriter.adopt(stored))
      .catch(() => undefined);

    void (async () => {
      const tabId = await activeTabId();
      if (tabId === null) {
        setCaptureFailure('no-active-tab');
        setShowPaste(true);
        return;
      }
      const result = await client.capture(tabId);
      if (result.snapshot) {
        setSnapshot(result.snapshot);
        loadAttempts(result.snapshot.problem.slug);
        offerResume(result.snapshot.problem.slug);
      } else {
        setCaptureFailure(result.failure ?? 'unknown');
        setShowPaste(true);
      }
    })();
  }, [client, loadAttempts, offerResume, settingsWriter]);

  // ---- saving the session -------------------------------------------------

  const buildSession = useCallback(
    (overrides: Partial<StoredSession> = {}): StoredSession | null => {
      if (!snapshot) return null;
      return {
        slug: snapshot.problem.slug,
        title: snapshot.problem.title,
        startedAt: attemptStartedAt,
        updatedAt: Date.now(),
        elapsedMs: Date.now() - sessionStart,
        rung,
        deepestRung,
        turns,
        ...overrides,
      };
    },
    [attemptStartedAt, deepestRung, rung, sessionStart, snapshot, turns],
  );

  const saveSession = useCallback(
    (overrides: Partial<StoredSession> = {}) => {
      const session = buildSession(overrides);
      if (session === null || session.turns.length === 0) return;
      void client.saveSession(session).catch(() => undefined);
    },
    [buildSession, client],
  );

  /*
   * The panel is a document Chrome throws away when the side panel closes, and
   * it gets no reliable async time on the way out. Every turn already saves, so
   * this only catches the minutes spent reading after the last reply - worth one
   * best-effort write, not worth a heartbeat that churns storage all session.
   */
  useEffect(() => {
    const onHide = (): void => saveSession();
    globalThis.addEventListener('pagehide', onHide);
    return () => globalThis.removeEventListener('pagehide', onHide);
  }, [saveSession]);

  /** Re-reads the page so the model always sees the current editor buffer. */
  const freshSnapshot = useCallback(async (): Promise<PageSnapshot | null> => {
    if (!snapshot) return null;
    if (snapshot.problem.source === 'manual') return snapshot;
    const tabId = await activeTabId();
    if (tabId === null) return snapshot;
    try {
      const result = await client.capture(tabId);
      if (result.snapshot && result.snapshot.problem.slug === snapshot.problem.slug) {
        setSnapshot(result.snapshot);
        return result.snapshot;
      }
    } catch {
      /* fall back to the snapshot we already have */
    }
    return snapshot;
  }, [client, snapshot]);

  const persistAttempt = useCallback(
    (deepest: Rung, current: PageSnapshot) => {
      const attempt: AttemptRecord = {
        slug: current.problem.slug,
        title: current.problem.title,
        startedAt: attemptStartedAt,
        durationMs: Date.now() - sessionStart,
        deepestRung: deepest,
        hintsUsed: hintsUsedFor(deepest),
      };
      void client.recordAttempt(attempt).then(setAllAttempts).catch(() => undefined);
    },
    [attemptStartedAt, client, sessionStart],
  );

  // ---- pacing the reply onto the screen -----------------------------------

  const writerRef = useRef<Typewriter | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  const stopPacing = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /*
   * The CLI hands over ~150 characters at a time; this spreads each block across
   * the following frames so it reads as writing rather than pasting. It is a
   * deadline rather than a rate (see `typewriter.ts`), so the screen cannot drift
   * behind the model however fast the text arrives.
   */
  const pace = useCallback(() => {
    if (frameRef.current !== null) return;
    lastFrameRef.current = 0;
    const step = (stamp: number): void => {
      frameRef.current = null;
      const writer = writerRef.current;
      if (writer === null) return;
      const frameMs = lastFrameRef.current === 0 ? 16 : stamp - lastFrameRef.current;
      lastFrameRef.current = stamp;
      setStreaming(writer.tick(frameMs));
      if (!writer.settled) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => stopPacing, [stopPacing]);

  // ---- asking -------------------------------------------------------------

  const ask = useCallback(
    async (intent: AskIntent, targetRung: Rung, message: string) => {
      const current = await freshSnapshot();
      if (!current) {
        setShowPaste(true);
        return;
      }

      const deepest = Math.max(deepestRung, targetRung) as Rung;
      setError(null);
      setBusy(true);
      setStreaming('');
      setProgress(beginTurn(Date.now()));
      setNow(Date.now());
      setRung(targetRung);
      setDeepestRung(deepest);
      setStarted(true);

      // The new message rides inside the context block, so history holds only the
      // turns before it - otherwise the model sees the same text twice.
      const withUser: Turn[] =
        message.trim() === '' ? turns : [...turns, { role: 'user', text: message, rung: targetRung }];
      if (withUser !== turns) setTurns(withUser);

      const request: AskRequest = {
        intent,
        rung: targetRung,
        message,
        snapshot: current,
        history: turns,
        elapsedMs: Date.now() - sessionStart,
      };

      const writer = createTypewriter(reducedMotion ? 0 : REVEAL_WINDOW_MS);
      writerRef.current = writer;

      const settle = (): Turn[] => {
        stopPacing();
        const text = writer.finish();
        setStreaming(null);
        setBusy(false);
        setProgress(IDLE_PROGRESS);
        cancelRef.current = null;
        writerRef.current = null;
        if (text.trim() === '') return withUser;
        const next: Turn[] = [...withUser, { role: 'assistant', text, rung: targetRung }];
        setTurns(next);
        return next;
      };

      cancelRef.current = client.ask(request, {
        onStarted: () => setProgress((prev) => applyEvent(prev, 'started', Date.now())),
        onThinking: () => setProgress((prev) => applyEvent(prev, 'thinking', Date.now())),
        onDelta: (text) => {
          setProgress((prev) => applyEvent(prev, 'delta', Date.now()));
          writer.push(text);
          pace();
        },
        onDone: () => {
          const finalTurns = settle();
          persistAttempt(deepest, current);
          saveSession({ turns: finalTurns, rung: targetRung, deepestRung: deepest });
        },
        onError: (failure) => {
          const finalTurns = settle();
          if (failure.code !== 'aborted') setError(failure);
          // A cancelled or failed turn still cost the user something; keeping the
          // partial reply is what makes resuming after one honest.
          saveSession({ turns: finalTurns, rung: targetRung, deepestRung: deepest });
        },
      });
    },
    [client, deepestRung, freshSnapshot, pace, persistAttempt, reducedMotion, saveSession, sessionStart, stopPacing, turns],
  );

  /*
   * The backstop against an infinite spinner. `progress` changes on every frame
   * from the worker, so the timer is rescheduled on every event and only ever
   * fires after a genuinely silent window. It sits past the host's own
   * five-minute cap so the host - which has stderr, the exit code and
   * `claude auth status` - gets to write the error whenever it still can.
   */
  useEffect(() => {
    if (progress.phase === 'idle') return;
    const timer = setTimeout(() => {
      cancelRef.current?.();
      setError(
        appError(
          'claude-cli-failed',
          `No response for ${Math.round(TIMEOUT_AFTER_MS / 60_000)} minutes, so Socrates stopped waiting. ` +
            `Nothing was lost - the same question can be sent again. If it keeps happening, check the CLI runs on its own.`,
          [{ label: 'Check the CLI answers at all', command: 'claude -p "say ok"' }],
        ),
      );
    }, TIMEOUT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [progress]);

  const nextRung = (): Rung => (started ? (Math.min(rung + 1, 5) as Rung) : 0);

  // Each change is a patch against the writer's own newest intent, not against
  // this render's `settings` - switching provider and then model is faster than
  // a round trip, and a whole-object write built from stale state undoes the
  // change before it. See `settings-writer.ts`.
  const onSelectModel = (model: ModelId): void => settingsWriter.patch({ model });
  const onSelectProvider = (provider: ProviderId): void => settingsWriter.patch({ provider });

  const onResume = (session: StoredSession): void => {
    setTurns(session.turns);
    setRung(session.rung);
    setDeepestRung(session.deepestRung);
    setStarted(session.turns.length > 0);
    setSessionStart(Date.now() - session.elapsedMs);
    setAttemptStartedAt(session.startedAt);
    setNow(Date.now());
    setResumable(null);
  };

  const onStartFresh = (session: StoredSession): void => {
    void client.clearSession(session.slug).catch(() => undefined);
    setResumable(null);
  };

  // Loaded when Settings opens, so the panel can name the configured Dashlane
  // item and the resolved claude binary instead of hardcoding either.
  const openSettings = (): void => {
    const opening = !showSettings;
    setShowSettings(opening);
    if (opening && hostInfo === null) {
      void client
        .hostInfo()
        .then(setHostInfo)
        .catch(() => setHostInfo({ itemTitle: 'unknown (the native helper did not answer)', claudePath: null }));
    }
  };

  const onProbeKey = (): void => {
    setKeyState('checking');
    client
      .probeKey()
      .then(() => setKeyState('ok'))
      .catch((failure: AppError) => {
        setKeyState('failed');
        setError(failure);
      });
  };

  const onProbeClaude = (): void => {
    setClaudeState('checking');
    client
      .probeClaude()
      .then((access) => {
        setClaudeAccess(access);
        setClaudeState('ok');
      })
      .catch((failure: AppError) => {
        setClaudeState('failed');
        setError(failure);
      });
  };

  // Until the user has answered the resume offer, asking anything would burn a
  // turn re-earning what is sitting one click away.
  const disabled = snapshot === null || resumable !== null;

  return (
    <div className="app" data-rung={rung}>
      <Header
        problem={snapshot?.problem ?? null}
        elapsedMs={elapsedMs}
        rung={rung}
        attempts={attempts}
        onOpenSettings={openSettings}
      />

      {error ? <ErrorNotice error={error} onDismiss={() => setError(null)} /> : null}

      {snapshot?.editor.source === 'unavailable' ? (
        <p className="notice notice-warn">
          Your editor buffer could not be read, so code review is off. Paste your code instead if you want it reviewed.{' '}
          <button type="button" className="link" onClick={() => setShowPaste(true)}>
            paste
          </button>
        </p>
      ) : null}

      {/*
        A sheet takes over the column rather than sitting on top of the
        transcript. Settings is taller than it was once the provider choice and
        its caveats are on it, and half a sheet with the transcript bleeding out
        from under it reads as a rendering bug rather than a layer.
      */}
      {showSettings ? (
        <SettingsPanel
          provider={settings.provider}
          model={settings.model}
          keyState={keyState}
          claudeState={claudeState}
          claudeAccess={claudeAccess}
          hostInfo={hostInfo}
          onSelectProvider={onSelectProvider}
          onSelectModel={onSelectModel}
          onProbeKey={onProbeKey}
          onProbeClaude={onProbeClaude}
          onClose={() => setShowSettings(false)}
        />
      ) : showPaste ? (
        <PasteForm
          reason={captureFailure}
          onSubmit={(pasted) => {
            setSnapshot(pasted);
            setShowPaste(false);
            setCaptureFailure(null);
            loadAttempts(pasted.problem.slug);
            offerResume(pasted.problem.slug);
          }}
          onCancel={snapshot ? () => setShowPaste(false) : null}
        />
      ) : (
        <>
          {resumable ? (
            <ResumeOffer
              session={resumable}
              onResume={() => onResume(resumable)}
              onStartFresh={() => onStartFresh(resumable)}
            />
          ) : null}
          <Transcript
            turns={turns}
            streaming={streaming}
            progress={progress}
            now={now}
            rung={rung}
            reducedMotion={reducedMotion}
            onCancel={() => cancelRef.current?.()}
          />
          <footer className="footer">
            <Ladder
              rung={rung}
              started={started}
              busy={busy}
              disabled={disabled}
              onUnlock={() => void ask('unlock', nextRung(), '')}
              onReview={() => void ask('review', rung, '')}
              onGiveUp={() => void ask('giveup', 5, '')}
            />
            <Composer
              busy={busy}
              disabled={disabled}
              onSend={(text) => void ask('chat', rung, text)}
              onCancel={() => cancelRef.current?.()}
            />
            <p className="small footnote">
              {hintsUsedFor(rung)} of {TOTAL_HINTS} hints used · replies never go past the rung you unlocked
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
