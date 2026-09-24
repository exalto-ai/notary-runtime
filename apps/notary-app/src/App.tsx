import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  checkForUpdates,
  errorMessage,
  getDesktopState,
  getUpdateState,
  installUpdateAndRestart,
  isTauri,
  setCaptureEnabled,
  startDaemon,
  type DesktopState,
  type DesktopUpdateState,
} from './bridge';
import { HomeView } from './HomeView';
import { LoadingWindow, VaultUnlock } from './LockedState';
import { BuiltinChat } from './BuiltinChat';
import { Onboarding } from './Onboarding';
import {
  pendingFirstProofTarget,
  persistPendingFirstProof,
  viewMeta,
  workspaceRoutes,
  type TraceConstraint,
  type TraceTarget,
  type View,
  type WorkspaceView,
} from './product';
import { Sidebar } from './Shell';
import { SettingsView } from './SettingsView';
import type { DashboardRoute } from '../../../runtime/apps/admin-dashboard/src/routes';
import { exaltoTheme } from '../../../runtime/apps/admin-dashboard/src/theme';

export const SENSITIVE_INPUT_RESET_EVENT = 'exalto:sensitive-input-reset';
export const CAPTURE_STATE_CHANGED_EVENT = 'exalto:capture-state-changed';
export const DISPOSABLE_TEST_STOPPED_MESSAGE = 'The disposable test stopped when setup closed. Prepare it again when you are ready.';

function AppContent() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedView = query.get('view') as View | null;
  const [view, setView] = useState<View>(requestedView && requestedView in viewMeta ? requestedView : 'home');
  const [traceConstraint, setTraceConstraint] = useState<TraceConstraint | null>(null);
  const [traceTarget, setTraceTarget] = useState<TraceTarget | null>(pendingFirstProofTarget);
  const [state, setState] = useState<DesktopState | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureToast, setCaptureToast] = useState<string | null>(null);
  const [serviceStartError, setServiceStartError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const lastWorkspaceRoute = useRef<WorkspaceView | null>(null);
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
    if (state?.running) setServiceStartError(null);
  }, [state?.running]);

  useEffect(() => {
    if (!captureToast) return;
    const timer = window.setTimeout(() => setCaptureToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [captureToast]);

  useEffect(() => {
    if (!state?.onboarding_complete || setupOpen || pendingFirstProofApplied.current) return;
    pendingFirstProofApplied.current = true;
    const target = pendingFirstProofTarget();
    if (!target) return;
    setTraceConstraint(null);
    setTraceTarget(target);
    setView('traces');
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

  // Menu-bar View commands. The desktop tree owns navigation and search.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<string>('exalto:menu', (event) => {
      if (!state?.onboarding_complete || setupOpen) return;
      const target = event.payload;
      if (target === 'home' || target === 'chat' || target === 'traces' || target === 'settings') {
        setTraceConstraint(null);
        setTraceTarget(null);
        setView(target);
      } else if (target === 'new-chat') {
        setTraceConstraint(null);
        setTraceTarget(null);
        setView('chat');
      } else if (target === 'find') {
        const field = document.querySelector<HTMLInputElement>(
          'input[aria-label="Search traces"], input[aria-label="Activity Trace ID"]',
        );
        field?.focus();
        field?.select();
      }
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
    void listen<boolean>(CAPTURE_STATE_CHANGED_EVENT, (event) => {
      setState((current) => current ? {
        ...current,
        running: current.running || event.payload,
        capture_enabled: event.payload,
      } : current);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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

  const runAction = async (
    name: string,
    action: () => Promise<void>,
    success: string,
    handlers: {
      onError?: (message: string) => void;
      onSuccess?: (message: string) => void;
    } = {},
  ) => {
    setBusy(name);
    setNotice(null);
    try {
      await action();
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      await refresh();
      (handlers.onSuccess ?? setNotice)(success);
    } catch (error) {
      (handlers.onError ?? setNotice)(errorMessage(error));
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

  const startLocalServiceFromWorkspace = () => {
    setServiceStartError(null);
    void runAction(
      'service-start',
      startLocalService,
      'Local service is running. Capture remains off.',
      { onError: setServiceStartError },
    );
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
  if (route) lastWorkspaceRoute.current = route;
  const navigate = (next: View) => {
    setTraceConstraint(null);
    setTraceTarget(null);
    setView(next);
  };
  const syncWorkspaceRoute = (next: View, dashboardRoute?: DashboardRoute) => {
    const filters = dashboardRoute?.filters;
    const constraint = next === 'traces'
      ? filters?.state
        ? `state=${filters.state}` as TraceConstraint
        : filters?.status
          ? `status=${filters.status}` as TraceConstraint
          : null
      : null;
    setTraceConstraint(constraint);
    setTraceTarget(next === 'traces' && dashboardRoute?.id
      ? { traceId: dashboardRoute.id, action: dashboardRoute.action }
      : null);
    setView(next);
  };
  const openTraces = (constraint: TraceConstraint) => {
    setTraceConstraint(constraint);
    setTraceTarget(null);
    setView('traces');
  };
  return (
    <div className="native-window" key={`shell-${sensitiveInputGeneration}`}>
      <Sidebar
        state={state}
        view={view}
        onNavigate={navigate}
      />
      <section className="window-content">
        <main className={`native-content ${route ? 'has-workspace' : ''} ${view === 'home' ? 'has-view-toolbar' : ''}`}>
          {view === 'home' && (
            <header className="view-toolbar" data-tauri-drag-region="deep">
              <h1 data-tauri-drag-region>Overview</h1>
            </header>
          )}
          {route && (
            <header className="native-page-header" data-tauri-drag-region="deep">
              <div>
                <h1 data-tauri-drag-region>{viewMeta[view].title}</h1>
                <p>{viewMeta[view].subtitle}</p>
              </div>
              {view === 'providers' && (
                <button className="mac-button is-primary" type="button" onClick={() => setSetupOpen(true)}>
                  Connection setup
                </button>
              )}
            </header>
          )}
          <div className="chat-view-container" hidden={view !== 'chat'}><BuiltinChat state={state} refresh={refresh} onOpenTrace={(id) => { setTraceTarget({ traceId: id }); setTraceConstraint(null); setView('traces'); }} /></div>
          {view === 'home' && (
            <HomeView
              state={state}
              busy={busy}
              notice={notice}
              captureToast={captureToast}
              onNavigate={navigate}
              onOpenTraces={openTraces}
              onStartCapture={() => void runAction('capture-start', startCapturing, 'Capture is on.', { onSuccess: setCaptureToast })}
              onStopCapture={() => void runAction('capture-stop', async () => { await setCaptureEnabled(false); }, 'Capture is off.', { onSuccess: setCaptureToast })}
              onRetryConnections={() => void refresh(true)}
            />
          )}
          {lastWorkspaceRoute.current && <div className="workspace-view-container" hidden={!route}><SettingsView
            route={lastWorkspaceRoute.current}
            constraint={route === 'traces' ? traceConstraint : null}
            traceTarget={route === 'traces' ? traceTarget : null}
            onTraceActionConsumed={(traceId, action) => {
              if (action !== 'first-proof' || traceTarget?.action !== action || traceTarget.traceId !== traceId) return;
              persistPendingFirstProof(null);
              setTraceTarget(null);
            }}
            state={state}
            updateState={updateState}
            busy={busy}
            notice={notice}
            serviceError={serviceStartError ?? state.message}
            onCheckUpdate={() => void checkForDesktopUpdate()}
            onRestartToUpdate={() => void restartToUpdate()}
            onStartService={startLocalServiceFromWorkspace}
            onNavigate={syncWorkspaceRoute}
          /></div>}
        </main>
      </section>
    </div>
  );
}

function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true } },
  }));
  return (
    <MantineProvider theme={exaltoTheme} defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </MantineProvider>
  );
}

export default App;
