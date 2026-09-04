import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Download, RefreshCw } from 'lucide-react';
import {
  checkForUpdates,
  errorMessage,
  getDesktopState,
  getUpdateState,
  installUpdateAndRestart,
  isTauri,
  openProductLink,
  setCaptureEnabled,
  startDaemon,
  type DesktopState,
  type DesktopUpdateState,
} from './bridge';
import { HomeView } from './HomeView';
import { LoadingWindow, VaultUnlock } from './LockedState';
import { Onboarding } from './Onboarding';
import {
  StatusDot,
  pendingFirstProofTarget,
  persistPendingFirstProof,
  viewMeta,
  workspaceRoutes,
  type TraceConstraint,
  type TraceTarget,
  type View,
} from './product';
import { Sidebar, WorkspaceFrame } from './Shell';
import { SettingsView } from './SettingsView';

export const SENSITIVE_INPUT_RESET_EVENT = 'exalto:sensitive-input-reset';
export const DISPOSABLE_TEST_STOPPED_MESSAGE = 'The disposable test stopped when setup closed. Prepare it again when you are ready.';

function updateChipLabel(update: DesktopUpdateState) {
  if (update.phase === 'checking') return 'Checking for updates';
  if (update.phase === 'downloading') {
    const percent = update.total_bytes
      ? Math.min(100, Math.round((update.downloaded_bytes / update.total_bytes) * 100))
      : 0;
    return `Downloading update${percent ? ` ${percent}%` : ''}`;
  }
  if (update.phase === 'ready') return 'Update ready';
  if (update.phase === 'installing') return 'Installing update';
  if (update.phase === 'error') return 'Update check failed';
  return null;
}

function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedView = query.get('view') as View | null;
  const [view, setView] = useState<View>(requestedView && requestedView in viewMeta ? requestedView : 'home');
  const [traceConstraint, setTraceConstraint] = useState<TraceConstraint | null>(null);
  const [traceTarget, setTraceTarget] = useState<TraceTarget | null>(pendingFirstProofTarget);
  const [state, setState] = useState<DesktopState | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [workspaceNavigationRevision, setWorkspaceNavigationRevision] = useState(0);
  const [sensitiveInputGeneration, setSensitiveInputGeneration] = useState(0);
  const [setupResumeError, setSetupResumeError] = useState<string | null>(null);
  const disposableTestInProgress = useRef(false);
  const pendingFirstProofApplied = useRef(false);

  const refresh = useCallback(async (refreshSealingService = false) => {
    try {
      setState(await getDesktopState(refreshSealingService));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!state?.onboarding_complete || setupOpen || pendingFirstProofApplied.current) return;
    pendingFirstProofApplied.current = true;
    const target = pendingFirstProofTarget();
    if (!target) return;
    setTraceConstraint(null);
    setTraceTarget(target);
    setView('traces');
    setWorkspaceNavigationRevision((current) => current + 1);
  }, [setupOpen, state?.onboarding_complete]);

  useEffect(() => {
    const resetSensitiveInputs = (event: Event) => {
      const detail = (event as CustomEvent<{ resumeDisposableSetup?: boolean }>).detail;
      setSetupResumeError(
        detail?.resumeDisposableSetup ? DISPOSABLE_TEST_STOPPED_MESSAGE : null,
      );
      setSensitiveInputGeneration((current) => current + 1);
    };
    window.addEventListener(SENSITIVE_INPUT_RESET_EVENT, resetSensitiveInputs);
    return () => {
      window.removeEventListener(SENSITIVE_INPUT_RESET_EVENT, resetSensitiveInputs);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<string>('exalto:navigate', (event) => {
      if (event.payload !== 'settings') return;
      if (!state?.onboarding_complete || setupOpen) return;
      setTraceConstraint(null);
      setView('settings');
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setupOpen, state?.onboarding_complete]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<{ window_generation: number; lease_id: string | null }>(
      'exalto:temporary-capture-cancelled',
      (event) => {
        const resumeDisposableSetup = Boolean(event.payload.lease_id)
          || disposableTestInProgress.current;
        disposableTestInProgress.current = false;
        window.dispatchEvent(new CustomEvent(SENSITIVE_INPUT_RESET_EVENT, {
          detail: { resumeDisposableSetup },
        }));
        setState((current) => current ? {
          ...current,
          temporary_capture_generation: Math.max(
            current.temporary_capture_generation,
            event.payload.window_generation,
          ),
        } : current);
      },
    ).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const refreshUpdate = async () => {
      try {
        setUpdateState(await getUpdateState());
      } catch (error) {
        setNotice(errorMessage(error));
      }
    };
    void refreshUpdate();
    const timer = window.setInterval(() => void refreshUpdate(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const runAction = async (name: string, action: () => Promise<void>, success: string) => {
    setBusy(name);
    setNotice(null);
    try {
      await action();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await refresh();
      setNotice(success);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const checkForDesktopUpdate = async () => {
    setBusy('update-check');
    setNotice(null);
    try {
      setUpdateState(await checkForUpdates());
    } catch (error) {
      setNotice(errorMessage(error));
      setUpdateState(await getUpdateState());
    } finally {
      setBusy(null);
    }
  };

  const restartToUpdate = async () => {
    setBusy('update-install');
    setNotice(null);
    try {
      await installUpdateAndRestart();
    } catch (error) {
      setNotice(errorMessage(error));
      setUpdateState(await getUpdateState());
      setBusy(null);
    }
  };

  const startCapturing = async () => {
    if (!state?.running) await startDaemon();
    let currentState: DesktopState | null = null;
    let readinessError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        currentState = await getDesktopState(true);
        setState(currentState);
        readinessError = null;
        if (currentState.sealing_service_readiness.phase === 'ready') break;
        if (
          currentState.sealing_service_readiness.phase === 'unreachable'
          || currentState.sealing_service_readiness.phase === 'trust_unavailable'
        ) break;
      } catch (error) {
        readinessError = error;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    if (currentState?.sealing_service_readiness.phase !== 'ready') {
      throw readinessError ?? new Error(
        'Capture needs a reachable trusted transport. No Exalto Seal account is required. Try the connection again before capturing.',
      );
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await setCaptureEnabled(true);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error('The local capture service did not become ready.');
  };

  const startLocalService = async () => {
    if (!state?.running) await startDaemon();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await setCaptureEnabled(false);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error('The local service did not become ready.');
  };

  if (!state) return <LoadingWindow />;
  if (state.vault_locked) {
    return <VaultUnlock key={`unlock-${sensitiveInputGeneration}`} refresh={refresh} />;
  }
  if (!state.onboarding_complete || setupOpen) {
    return <Onboarding
      key={`onboarding-${sensitiveInputGeneration}`}
      state={state}
      refresh={refresh}
      initialStep={setupOpen || setupResumeError ? 'client' : 'welcome'}
      initialError={setupResumeError}
      onDisposableTestChange={(active) => {
        disposableTestInProgress.current = active;
      }}
      onCancel={setupOpen ? () => {
        setSetupOpen(false);
        setSetupResumeError(null);
      } : undefined}
      onFinish={(next, target) => {
        setSetupOpen(false);
        setSetupResumeError(null);
        setTraceConstraint(null);
        persistPendingFirstProof(target?.action === 'first-proof' ? target : null);
        setTraceTarget(target ?? null);
        setView(next);
      }}
    />;
  }

  const route = workspaceRoutes[view];
  const meta = viewMeta[view];
  const navigate = (next: View) => {
    setTraceConstraint(null);
    setTraceTarget(null);
    setView(next);
    if (workspaceRoutes[next]) {
      setWorkspaceNavigationRevision((current) => current + 1);
    }
  };
  const syncWorkspaceRoute = (next: View) => {
    setTraceConstraint(null);
    setTraceTarget(null);
    setView(next);
  };
  const openTraces = (constraint: TraceConstraint) => {
    setTraceConstraint(constraint);
    setTraceTarget(null);
    setView('traces');
  };
  const allowLegacyWorkspace = Boolean(
    !state.managed_by_desktop
    && state.daemon_build_id
    && state.daemon_build_id !== state.app_build_id,
  );

  return (
    <div className="native-window" key={`shell-${sensitiveInputGeneration}`}>
      <Sidebar
        state={state}
        view={view}
        onNavigate={navigate}
        onOpenPublicTraces={() => void openProductLink('public_traces')}
      />
      <section className="window-content">
        <header className="native-toolbar" data-tauri-drag-region="deep">
          <div className="toolbar-title" data-tauri-drag-region="deep">
            <strong>{meta.title}</strong>
            <span>{meta.subtitle}</span>
          </div>
          <div className="toolbar-spacer" data-tauri-drag-region />
          {updateState && updateChipLabel(updateState) && <button
            type="button"
            className={`update-chip is-${updateState.phase}`}
            onClick={() => setView('settings')}
          >
            {updateState.phase === 'downloading' ? <RefreshCw size={11} className="is-spinning" /> : <Download size={11} />}
            {updateChipLabel(updateState)}
          </button>}
          {view === 'providers' && <button className="mac-button is-small toolbar-setup-button" type="button" onClick={() => setSetupOpen(true)}>Connection setup</button>}
          <div className={`service-chip ${state.running && state.capture_enabled ? 'is-recording' : ''}`}>
            <StatusDot running={state.running && state.capture_enabled} />
            {state.running && state.capture_enabled ? 'REC · Capturing' : 'Capture off'}
          </div>
        </header>

        <main className={`native-content ${route ? 'has-workspace' : ''} ${(view === 'settings' || view === 'providers' || view === 'activity') ? 'has-settings-subnav' : ''}`}>
          {(view === 'settings' || view === 'providers' || view === 'activity') && (
            <nav className="settings-subnav" aria-label="Settings sections">
              <button
                type="button"
                className={view === 'settings' ? 'is-selected' : ''}
                onClick={() => navigate('settings')}
              >
                Preferences
              </button>
              <button
                type="button"
                className={view === 'providers' ? 'is-selected' : ''}
                onClick={() => navigate('providers')}
              >
                AI connections
              </button>
              <button
                type="button"
                className={view === 'activity' ? 'is-selected' : ''}
                onClick={() => navigate('activity')}
              >
                Activity log
              </button>
            </nav>
          )}
          {view === 'home' && (
            <HomeView
              state={state}
              busy={busy}
              notice={notice}
              onNavigate={navigate}
              onOpenTraces={openTraces}
              onStartCapture={() => void runAction('capture-start', startCapturing, 'Capture is on.')}
              onStopCapture={() => void runAction('capture-stop', async () => { await setCaptureEnabled(false); }, 'Capture is off.')}
              onRetryConnections={() => void refresh(true)}
            />
          )}
          {view === 'settings' && <SettingsView
            state={state}
            updateState={updateState}
            busy={busy}
            notice={notice}
            onCheckUpdate={() => void checkForDesktopUpdate()}
            onRestartToUpdate={() => void restartToUpdate()}
            onStartService={() => void runAction('service-start', startLocalService, 'Local service is running. Capture remains off.')}
            onNavigate={syncWorkspaceRoute}
            allowLegacyWorkspace={allowLegacyWorkspace}
          />}
          {route && (
            <WorkspaceFrame
              key={workspaceNavigationRevision}
              route={route}
              constraint={route === 'traces' ? traceConstraint : null}
              traceTarget={route === 'traces' ? traceTarget : null}
              running={state.running}
              onStartService={() => void runAction('service-start', startLocalService, 'Local service is running. Capture remains off.')}
              serviceStarting={busy === 'service-start'}
              onRouteChange={syncWorkspaceRoute}
              onTraceActionConsumed={(traceId, action) => {
                if (
                  action !== 'first-proof'
                  || traceTarget?.action !== action
                  || traceTarget.traceId !== traceId
                ) return;
                persistPendingFirstProof(null);
                setTraceTarget(null);
              }}
              allowLegacyFrameLoadFallback={allowLegacyWorkspace}
            />
          )}
        </main>
      </section>
    </div>
  );
}

export default App;
