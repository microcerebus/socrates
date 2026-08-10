import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { TOTAL_HINTS, hintsUsedFor } from '../prompt/rungs.ts';
import type { AskRequest } from '../shared/protocol.ts';
import {
  DEFAULT_SETTINGS,
  type AppError,
  type AskIntent,
  type AttemptRecord,
  type ModelId,
  type PageSnapshot,
  type ProviderId,
  type Rung,
  type Settings,
  type Turn,
} from '../shared/types.ts';
import {
  Composer,
  ErrorNotice,
  Header,
  Ladder,
  PasteForm,
  SettingsPanel,
  Transcript,
  type ProbeState,
} from './components.tsx';
import { PortClient, type ClaudeAccess, type HostInfo } from './port-client.ts';
import { createSettingsWriter } from './settings-writer.ts';

/**
 * The panel document is created fresh each time the side panel opens, so module
 * load time is the session start. Reading the clock here keeps render pure.
 */
const SESSION_STARTED_AT = Date.now();

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export function App(): ReactNode {
  const client = useMemo(() => new PortClient(), []);

  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [captureFailure, setCaptureFailure] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [rung, setRung] = useState<Rung>(0);
  const [started, setStarted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  const [error, setError] = useState<AppError | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [keyState, setKeyState] = useState<ProbeState>('unknown');
  const [claudeState, setClaudeState] = useState<ProbeState>('unknown');
  const [claudeAccess, setClaudeAccess] = useState<ClaudeAccess | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Holds the settings intent across renders, so a change is a patch against the
  // newest one rather than against whatever this render closed over.
  const settingsWriter = useMemo(
    () => createSettingsWriter({ save: (next) => client.setSettings(next), onSettings: setSettings, onError: setError }),
    [client],
  );

  useEffect(() => {
    const timer = setInterval(() => setElapsedMs(Date.now() - SESSION_STARTED_AT), 1000);
    return () => clearInterval(timer);
  }, []);

  const loadAttempts = useCallback(
    (slug: string) => {
      void client
        .getAttempts(slug)
        .then((records) => setAttempts(records.filter((r) => r.startedAt !== new Date(SESSION_STARTED_AT).toISOString())))
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
      } else {
        setCaptureFailure(result.failure ?? 'unknown');
        setShowPaste(true);
      }
    })();
  }, [client, loadAttempts, settingsWriter]);

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
        startedAt: new Date(SESSION_STARTED_AT).toISOString(),
        durationMs: Date.now() - SESSION_STARTED_AT,
        deepestRung: deepest,
        hintsUsed: hintsUsedFor(deepest),
      };
      void client.recordAttempt(attempt).catch(() => undefined);
    },
    [client],
  );

  const ask = useCallback(
    async (intent: AskIntent, targetRung: Rung, message: string) => {
      const current = await freshSnapshot();
      if (!current) {
        setShowPaste(true);
        return;
      }

      setError(null);
      setBusy(true);
      setThinking(false);
      setStreaming('');
      setRung(targetRung);
      setStarted(true);

      // The new message rides inside the context block, so history holds only the
      // turns before it - otherwise the model sees the same text twice.
      if (message.trim() !== '') {
        setTurns([...turns, { role: 'user', text: message, rung: targetRung }]);
      }

      const request: AskRequest = {
        intent,
        rung: targetRung,
        message,
        snapshot: current,
        history: turns,
        elapsedMs: Date.now() - SESSION_STARTED_AT,
      };

      let buffer = '';
      const finish = (): void => {
        setBusy(false);
        setThinking(false);
        cancelRef.current = null;
      };

      cancelRef.current = client.ask(request, {
        onThinking: () => setThinking(true),
        onDelta: (text) => {
          buffer += text;
          setThinking(false);
          setStreaming(buffer);
        },
        onDone: () => {
          setStreaming(null);
          if (buffer.trim() !== '') {
            setTurns((prev) => [...prev, { role: 'assistant', text: buffer, rung: targetRung }]);
          }
          persistAttempt(targetRung, current);
          finish();
        },
        onError: (failure) => {
          setStreaming(null);
          if (buffer.trim() !== '') {
            setTurns((prev) => [...prev, { role: 'assistant', text: buffer, rung: targetRung }]);
          }
          if (failure.code !== 'aborted') setError(failure);
          finish();
        },
      });
    },
    [client, freshSnapshot, persistAttempt, turns],
  );

  const nextRung = (): Rung => (started ? (Math.min(rung + 1, 5) as Rung) : 0);

  // Each change is a patch against the writer's own newest intent, not against
  // this render's `settings` - switching provider and then model is faster than
  // a round trip, and a whole-object write built from stale state undoes the
  // change before it. See `settings-writer.ts`.
  const onSelectModel = (model: ModelId): void => settingsWriter.patch({ model });
  const onSelectProvider = (provider: ProviderId): void => settingsWriter.patch({ provider });

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

  const disabled = snapshot === null;

  return (
    <div className="app">
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
          }}
          onCancel={snapshot ? () => setShowPaste(false) : null}
        />
      ) : (
        <>
          <Transcript turns={turns} streaming={streaming} thinking={thinking} />
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
