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
  type Rung,
  type Settings,
  type Turn,
} from '../shared/types.ts';
import { Composer, ErrorNotice, Header, Ladder, PasteForm, SettingsPanel, Transcript } from './components.tsx';
import { PortClient } from './port-client.ts';

type KeyState = 'unknown' | 'checking' | 'ok' | 'failed';

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
  const [keyState, setKeyState] = useState<KeyState>('unknown');
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);

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
    void client.getSettings().then(setSettings).catch(() => undefined);

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
  }, [client, loadAttempts]);

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

  const onSelectModel = (model: ModelId): void => {
    void client
      .setSettings({ model })
      .then(setSettings)
      .catch((failure: AppError) => setError(failure));
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

  const disabled = snapshot === null;

  return (
    <div className="app">
      <Header
        problem={snapshot?.problem ?? null}
        elapsedMs={elapsedMs}
        rung={rung}
        attempts={attempts}
        onOpenSettings={() => setShowSettings((open) => !open)}
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

      {showSettings ? (
        <SettingsPanel
          model={settings.model}
          keyState={keyState}
          onSelectModel={onSelectModel}
          onProbeKey={onProbeKey}
          onClose={() => setShowSettings(false)}
        />
      ) : null}

      {showPaste ? (
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
