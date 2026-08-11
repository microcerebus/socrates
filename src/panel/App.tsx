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
import { classifyCapture } from './problem-switch.ts';
import { createSessionWriter, type Current } from './session-writer.ts';
import { createSettingsWriter } from './settings-writer.ts';
import {
  IDLE_PROGRESS,
  TIMEOUT_AFTER_MS,
  applyEvent,
  beginTurn,
  type TurnProgress,
} from './turn-progress.ts';
import { REVEAL_WINDOW_MS, createTypewriter, type Typewriter } from './typewriter.ts';

/** How often the clock the panel renders from advances. */
const TICK_MS = 1000;

/**
 * How many times the navigation follower will re-read the page before giving up
 * and waiting for the next tab event. Each step needs a real navigation to have
 * happened, so this only bounds a pathological page that never settles.
 */
const MAX_FOLLOW_STEPS = 5;

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
  const [claudeState, setClaudeState] = useState<ProbeState>('unknown');
  const [claudeAccess, setClaudeAccess] = useState<ClaudeAccess | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [allAttempts, setAllAttempts] = useState<AttemptRecord[]>([]);

  // Holds the settings intent across renders, so a change is a patch against the
  // newest one rather than against whatever this render closed over.
  const settingsWriter = useMemo(
    () =>
      createSettingsWriter({
        save: (next) => client.setSettings(next),
        onSettings: setSettings,
        onError: setError,
      }),
    [client],
  );

  // Holds the discard decision outside React, so a `pagehide` between the click
  // and the re-render cannot write a thrown-away session back. See
  // `session-writer.ts`.
  const sessionWriter = useMemo(
    () =>
      createSessionWriter({
        save: (next) => client.saveSession(next),
        clear: (slug) => client.clearSession(slug),
      }),
    [client],
  );

  /**
   * The only way to read the page.
   *
   * The raw read is deliberately anonymous and lives inside this call: there is
   * no unguarded capture to reach for, so "stamp the navigation epoch at
   * initiation, drop the result if it is no longer current at resolution" is a
   * property of the one function rather than a rule three call sites have to
   * remember. The three that exist - first load, a turn, and the navigation
   * follower - all go through here.
   */
  const capturePage = useCallback(
    (): Promise<Current<{ snapshot: PageSnapshot | null; failure?: string }>> =>
      sessionWriter.ifStillCurrent(async () => {
        const tabId = await activeTabId();
        if (tabId === null) return { snapshot: null, failure: 'no-active-tab' };
        try {
          return await client.capture(tabId);
        } catch (cause) {
          return { snapshot: null, failure: String(cause) };
        }
      }),
    [client, sessionWriter],
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
      void sessionWriter
        .ifStillCurrent(() => client.getAttempts(slug))
        .then((result) => {
          if (result.current) setAllAttempts(result.value);
        })
        .catch(() => undefined);
    },
    [client, sessionWriter],
  );

  /** Offers a resume when there is a transcript worth resuming, and nothing else. */
  const offerResume = useCallback(
    (slug: string) => {
      void sessionWriter
        .ifStillCurrent(() => client.getSession(slug))
        .then((result) => {
          if (result.current && result.value && result.value.turns.length > 0)
            setResumable(result.value);
        })
        .catch(() => undefined);
    },
    [client, sessionWriter],
  );

  useEffect(() => {
    void client
      .getSettings()
      .then((stored) => settingsWriter.adopt(stored))
      .catch(() => undefined);

    void (async () => {
      // Guarded like every other read: a slow first capture must not overwrite a
      // problem the follower has already adopted while it was in flight.
      const capture = await capturePage();
      if (!capture.current) return;
      const { snapshot: page, failure } = capture.value;
      if (page) {
        setSnapshot(page);
        sessionWriter.setActive(page.problem.slug);
        loadAttempts(page.problem.slug);
        offerResume(page.problem.slug);
      } else {
        setCaptureFailure(failure ?? 'unknown');
        setShowPaste(true);
      }
    })();
  }, [capturePage, client, loadAttempts, offerResume, sessionWriter, settingsWriter]);

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
    (overrides: Partial<StoredSession> = {}) => sessionWriter.save(buildSession(overrides)),
    [buildSession, sessionWriter],
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

  /**
   * Follow the page onto a different problem.
   *
   * The old session is closed and written under its own slug *before* the writer
   * is told what is on screen now, because from that moment it refuses writes
   * for anything else - which is what stops a turn that finishes mid-navigation
   * from landing in the wrong session. Everything the panel holds then resets,
   * rung included: see `problem-switch.ts` for why carrying the rung across a
   * switch would give away hints nobody earned.
   */
  const adoptProblem = useCallback(
    (next: PageSnapshot): void => {
      // Whatever is streaming belongs to the problem being left.
      cancelRef.current?.();

      // Built explicitly rather than from state that is about to be reset.
      if (snapshot !== null && turns.length > 0) {
        sessionWriter.save({
          slug: snapshot.problem.slug,
          title: snapshot.problem.title,
          startedAt: attemptStartedAt,
          updatedAt: Date.now(),
          elapsedMs: Date.now() - sessionStart,
          rung,
          deepestRung,
          turns,
        });
      }
      sessionWriter.setActive(next.problem.slug);

      const startedAt = Date.now();
      setSnapshot(next);
      setTurns([]);
      setRung(0);
      setDeepestRung(0);
      setStarted(false);
      setStreaming(null);
      setProgress(IDLE_PROGRESS);
      setBusy(false);
      setError(null);
      setResumable(null);
      setSessionStart(startedAt);
      setAttemptStartedAt(nowIso(startedAt));
      setNow(startedAt);

      loadAttempts(next.problem.slug);
      offerResume(next.problem.slug);
    },
    [
      attemptStartedAt,
      deepestRung,
      loadAttempts,
      offerResume,
      rung,
      sessionStart,
      sessionWriter,
      snapshot,
      turns,
    ],
  );

  /**
   * Re-reads the page so the model always sees the current editor buffer.
   * Returns `null` when this turn must not run - either there is nothing to work
   * from, or the page has moved to a different problem and the panel has just
   * followed it, which resets the ladder and is not a turn.
   */
  const snapshotForTurn = useCallback(async (): Promise<PageSnapshot | null> => {
    /*
     * The capture is guarded at resolution, not at initiation. If the panel
     * followed the page while it was outstanding, `snapshot` and everything else
     * this callback closed over describe a problem the user has left - and
     * classifying a stale capture of that problem against that stale snapshot
     * reads as an ordinary refresh, which would drag the panel back to it and
     * then run and stream a turn there. The turn is abandoned instead; the panel
     * has already adopted the new problem.
     */
    const capture = await capturePage();
    if (!capture.current) return null;

    const outcome = classifyCapture(snapshot, capture.value.snapshot);
    switch (outcome.kind) {
      case 'unchanged':
        return snapshot;
      case 'refreshed':
        setSnapshot(outcome.snapshot);
        return outcome.snapshot;
      case 'switched':
        adoptProblem(outcome.snapshot);
        return null;
    }
  }, [adoptProblem, capturePage, snapshot]);

  /*
   * Notice the navigation when it happens rather than at the next click, so the
   * panel is never visibly describing a problem the user has already left. The
   * `active` check makes a repeat harmless: LeetCode is a single-page app and
   * fires several updates per navigation, and React state has not caught up
   * between them.
   */
  useEffect(() => {
    /*
     * Settle on whatever the page actually is, rather than on whichever capture
     * happened to land first.
     *
     * Discarding stale reads is necessary but not sufficient here. Navigating
     * A -> B -> C leaves two reads in flight; if B's lands first the panel
     * adopts B, which bumps the epoch and invalidates C's read - correctly, but
     * that would strand the panel on B while the page shows C. So after every
     * adoption it reads again, in the new epoch, and keeps going until the page
     * and the panel agree. That converges because a capture matching what was
     * just adopted classifies as `refreshed`, not `switched`.
     */
    const follow = (): void => {
      void (async () => {
        let showing = snapshot;
        for (let step = 0; step < MAX_FOLLOW_STEPS; step += 1) {
          const capture = await capturePage();
          if (!capture.current) return; // a newer adoption already superseded this read
          const outcome = classifyCapture(showing, capture.value.snapshot);
          if (outcome.kind !== 'switched') return;
          adoptProblem(outcome.snapshot);
          showing = outcome.snapshot;
        }
      })();
    };
    const onUpdated = (tabId: number, change: chrome.tabs.OnUpdatedInfo): void => {
      if (change.url === undefined && change.status !== 'complete') return;
      void activeTabId().then((active) => {
        if (active === tabId) follow();
      });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(follow);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(follow);
    };
  }, [adoptProblem, capturePage, snapshot]);

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
      void client
        .recordAttempt(attempt)
        .then(setAllAttempts)
        .catch(() => undefined);
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
      const current = await snapshotForTurn();
      if (!current) {
        // Either there is nothing to work from at all, or the page moved to a
        // different problem and the panel has just followed it. A switch resets
        // the ladder, so this click is not a turn - the user is now looking at a
        // fresh problem and can start it deliberately.
        if (snapshot === null) setShowPaste(true);
        return;
      }

      // Whatever the panel holds from here on is new work, not the remains of a
      // session the user discarded, so saving is meaningful again.
      sessionWriter.beginTurn(current.problem.slug);

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
        message.trim() === ''
          ? turns
          : [...turns, { role: 'user', text: message, rung: targetRung }];
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
          saveSession({
            slug: current.problem.slug,
            title: current.problem.title,
            turns: finalTurns,
            rung: targetRung,
            deepestRung: deepest,
          });
        },
        onError: (failure) => {
          const finalTurns = settle();
          if (failure.code !== 'aborted') setError(failure);
          // A cancelled or failed turn still cost the user something; keeping the
          // partial reply is what makes resuming after one honest.
          saveSession({
            slug: current.problem.slug,
            title: current.problem.title,
            turns: finalTurns,
            rung: targetRung,
            deepestRung: deepest,
          });
        },
      });
    },
    [
      client,
      deepestRung,
      pace,
      persistAttempt,
      reducedMotion,
      saveSession,
      sessionStart,
      sessionWriter,
      snapshot,
      snapshotForTurn,
      stopPacing,
      turns,
    ],
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

  // A patch against the writer's own newest intent, not against this render's
  // `settings` - a whole-object write built from stale state would undo a
  // change still in flight. See `settings-writer.ts`.
  const onSelectModel = (model: ModelId): void => settingsWriter.patch({ model });

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

  /*
   * Starting over has to clear memory and storage together, or it does not
   * really clear anything: the panel still holds the old transcript, and the
   * next save - a finished turn, or just closing the panel - writes it back over
   * the storage that was cleared a moment ago.
   *
   * The writer's `discard` is what makes it atomic. Every `setState` below is
   * scheduled rather than applied, so a `pagehide` in the meantime would still
   * read the old values out of this render's closure; `discard` refuses that
   * write synchronously, in this same tick, and keeps refusing until a new turn
   * begins for the slug.
   */
  const onStartFresh = (session: StoredSession): void => {
    sessionWriter.discard(session.slug);
    const startedAt = Date.now();
    setTurns([]);
    setRung(0);
    setDeepestRung(0);
    setStarted(false);
    setStreaming(null);
    setSessionStart(startedAt);
    setAttemptStartedAt(nowIso(startedAt));
    setNow(startedAt);
    setResumable(null);
  };

  // Loaded when Settings opens, so the panel can name the resolved claude
  // binary instead of hardcoding it.
  const openSettings = (): void => {
    const opening = !showSettings;
    setShowSettings(opening);
    if (opening && hostInfo === null) {
      void client
        .hostInfo()
        .then(setHostInfo)
        .catch(() => setHostInfo({ claudePath: null }));
    }
  };

  /*
   * Clearing is not just a storage call: the panel is holding a view of what was
   * just deleted. The attempt strip and any resume offer have to go with it, or
   * the user is told their history is gone while still looking at it.
   */
  const onClearAllData = (): Promise<void> =>
    client
      .clearAllData()
      .then(() => {
        setAllAttempts([]);
        setResumable(null);
      })
      .catch((failure: AppError) => {
        setError(failure);
        throw failure;
      });

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
          Your editor buffer could not be read, so code review is off. Paste your code instead if
          you want it reviewed.{' '}
          <button type="button" className="link" onClick={() => setShowPaste(true)}>
            paste
          </button>
        </p>
      ) : null}

      {/*
        A sheet takes over the column rather than sitting on top of the
        transcript, so it never reads as a rendering bug half-covering it.
      */}
      {showSettings ? (
        <SettingsPanel
          model={settings.model}
          claudeState={claudeState}
          claudeAccess={claudeAccess}
          hostInfo={hostInfo}
          onSelectModel={onSelectModel}
          onProbeClaude={onProbeClaude}
          onClearAllData={onClearAllData}
          onClose={() => setShowSettings(false)}
        />
      ) : showPaste ? (
        <PasteForm
          reason={captureFailure}
          onSubmit={(pasted) => {
            setSnapshot(pasted);
            sessionWriter.setActive(pasted.problem.slug);
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
              {hintsUsedFor(rung)} of {TOTAL_HINTS} hints used · replies never go past the rung you
              unlocked
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
