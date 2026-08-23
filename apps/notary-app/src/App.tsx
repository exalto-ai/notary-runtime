import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import {
  checkForUpdates,
  errorMessage,
  getDesktopState,
  getUpdateState,
  installUpdateAndRestart,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type DesktopState,
  type DesktopUpdateState,
} from './bridge';
import { HomeView } from './HomeView';
import { LoadingWindow, VaultUnlock } from './LockedState';
import { Onboarding } from './Onboarding';
import {
  StatusDot,
  viewMeta,
  workspaceRoutes,
  type TraceConstraint,
  type View,
} from './product';
import { Sidebar, WorkspaceFrame } from './Shell';
import { SettingsView } from './SettingsView';

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
  const [state, setState] = useState<DesktopState | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getDesktopState());
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

  if (!state) return <LoadingWindow />;
  if (state.vault_locked) {
    return <VaultUnlock refresh={refresh} />;
  }
  if (!state.onboarding_complete) {
    return <Onboarding state={state} refresh={refresh} onFinish={(next) => setView(next)} />;
  }

  const route = workspaceRoutes[view];
  const meta = viewMeta[view];
  const navigate = (next: View) => {
    setTraceConstraint(null);
    setView(next);
  };
  const openTraces = (constraint: TraceConstraint) => {
    setTraceConstraint(constraint);
    setView('traces');
  };

  return (
    <div className="native-window">
      <Sidebar state={state} view={view} onNavigate={navigate} />
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
          <div className={`service-chip ${state.running ? 'is-running' : ''} ${state.running && !state.capture_enabled ? 'is-direct' : ''}`}>
            <StatusDot running={state.running} warning={!state.running} />
            {state.running ? state.capture_enabled ? 'Ready to capture' : 'Running · Capture off' : 'Service stopped'}
          </div>
        </header>

        <main className={`native-content ${route ? 'has-workspace' : ''}`}>
          {view === 'home' && (
            <HomeView
              state={state}
              busy={busy}
              notice={notice}
              onNavigate={navigate}
              onOpenTraces={openTraces}
              onStart={() => void runAction('start', startDaemon, 'Notary started.')}
              onStop={() => void runAction('stop', stopDaemon, 'Notary stopped.')}
              onRestart={() => void runAction('restart', restartDaemon, 'Notary restarted.')}
            />
          )}
          {view === 'settings' && <SettingsView
            state={state}
            updateState={updateState}
            busy={busy}
            notice={notice}
            onCheckUpdate={() => void checkForDesktopUpdate()}
            onRestartToUpdate={() => void restartToUpdate()}
          />}
          {route && (
            <WorkspaceFrame
              route={route}
              constraint={route === 'traces' ? traceConstraint : null}
              running={state.running}
            />
          )}
        </main>
      </section>
    </div>
  );
}

export default App;
