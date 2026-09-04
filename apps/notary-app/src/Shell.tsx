import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, FileCheck2, Radio, RefreshCw, Settings, Square } from 'lucide-react';
import type { DesktopState } from './bridge';
import notaryMark from './notary-mark.svg';
import {
  DISPLAY_NAME,
  viewMeta,
  type TraceTarget,
  type TraceConstraint,
  type View,
  type WorkspaceView,
} from './product';

export function Sidebar({ state, view, onNavigate, onOpenPublicTraces }: {
  state: DesktopState;
  view: View;
  onNavigate: (view: View) => void;
  onOpenPublicTraces: () => void;
}) {
  const traceCount = state.counts.captured + state.counts.notarized + state.counts.capturing + state.counts.capture_failed;
  const items: Array<{ view: View; label: string; icon: typeof Radio; count?: number }> = [
    { view: 'home', label: 'Capture', icon: Radio },
    {
      view: 'traces',
      label: 'Traces',
      icon: FileCheck2,
      count: traceCount,
    },
    { view: 'settings', label: 'Settings', icon: Settings },
  ];

  return <aside className="native-sidebar">
    <div className="sidebar-drag-region" data-tauri-drag-region />
    <div className="sidebar-brand">
      <img src={notaryMark} alt="" />
      <span><strong>Exalto</strong><small>Capture</small></span>
    </div>
    <nav aria-label={DISPLAY_NAME}>
      <div className="sidebar-group">
        {items.map(({ view: itemView, label, icon: Icon, count }) => <button
          key={itemView}
          type="button"
          className={view === itemView || (itemView === 'settings' && (view === 'providers' || view === 'activity')) ? 'is-selected' : ''}
          onClick={() => onNavigate(itemView)}
        >
          <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{label}</span>
          {count ? <b>{count}</b> : null}
        </button>)}
      </div>
      <button type="button" className="public-traces-link" onClick={onOpenPublicTraces}>
        <ExternalLink size={15} strokeWidth={1.7} aria-hidden="true" />
        <span>Public Traces</span>
      </button>
    </nav>
    <div className="sidebar-footer">
      <span className={`rec-indicator ${state.running && state.capture_enabled ? 'is-recording' : ''}`} aria-hidden="true" />
      <span>{state.running && state.capture_enabled ? 'REC · Capturing' : 'Capture off'}</span>
    </div>
  </aside>;
}

export function WorkspaceFrame({
  route,
  constraint = null,
  traceTarget = null,
  running,
  serviceError = null,
  desktopSettings,
  onDesktopSettingsAction,
  onRouteChange,
  onTraceActionConsumed,
  onStartService,
  serviceStarting = false,
  loadTimeoutMs = 7000,
  workspaceSource,
  allowLegacyFrameLoadFallback = false,
}: {
  route: WorkspaceView;
  constraint?: TraceConstraint | null;
  traceTarget?: TraceTarget | null;
  running: boolean;
  serviceError?: string | null;
  desktopSettings?: DesktopSettingsPayload;
  onDesktopSettingsAction?: (action: DesktopSettingsAction) => void;
  onRouteChange?: (view: View) => void;
  onTraceActionConsumed?: (traceId: string, action: 'first-proof') => void;
  onStartService?: () => void;
  serviceStarting?: boolean;
  loadTimeoutMs?: number;
  workspaceSource?: string;
  allowLegacyFrameLoadFallback?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const embeddedRoute = useRef<View | null>(null);
  const workspaceOrigin = 'http://127.0.0.1:8788';
  const traceDestination = route === 'traces' && traceTarget
    ? `${route}/${encodeURIComponent(traceTarget.traceId)}${traceTarget.action ? `?action=${traceTarget.action}` : ''}`
    : `${route}${constraint ? `?${constraint}` : ''}`;
  const requestedSource = workspaceSource
    ?? `${workspaceOrigin}/dashboard?embedded=desktop#/${traceDestination}`;
  const lastParentRequest = useRef({ route, source: requestedSource });
  const [navigation, setNavigation] = useState({ source: requestedSource, revision: 0 });

  const sendDesktopSettings = () => {
    if (!desktopSettings) return;
    frame.current?.contentWindow?.postMessage(
      { type: 'notary:desktop-settings', payload: desktopSettings },
      workspaceOrigin,
    );
  };

  useEffect(() => {
    if (
      lastParentRequest.current.route === route
      && lastParentRequest.current.source === requestedSource
      && embeddedRoute.current === null
    ) {
      return;
    }
    lastParentRequest.current = { route, source: requestedSource };
    if (embeddedRoute.current === route) {
      embeddedRoute.current = null;
      return;
    }
    embeddedRoute.current = null;
    setNavigation((current) => ({
      source: requestedSource,
      revision: current.source === requestedSource ? current.revision + 1 : current.revision,
    }));
  }, [requestedSource, route]);
  useEffect(() => {
    setLoaded(false);
    setFrameLoaded(false);
    setLoadFailed(false);
  }, [navigation, running]);
  useEffect(() => {
    if (!allowLegacyFrameLoadFallback || !running || !frameLoaded || loaded || loadFailed) return;
    const delay = Math.min(1500, Math.max(100, Math.floor(loadTimeoutMs / 2)));
    const timeout = window.setTimeout(() => setLoaded(true), delay);
    return () => window.clearTimeout(timeout);
  }, [allowLegacyFrameLoadFallback, frameLoaded, loadFailed, loaded, loadTimeoutMs, running]);
  useEffect(() => {
    if (!running || loaded || loadFailed) return;
    const timeout = window.setTimeout(() => setLoadFailed(true), loadTimeoutMs);
    return () => window.clearTimeout(timeout);
  }, [loadFailed, loaded, loadTimeoutMs, navigation, running]);
  useEffect(sendDesktopSettings, [desktopSettings]);
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== workspaceOrigin ||
        event.source !== frame.current?.contentWindow
      ) {
        return;
      }
      setLoaded(true);
      setLoadFailed(false);
      if (event.data?.type === 'notary:desktop-settings-ready') sendDesktopSettings();
      if (
        onDesktopSettingsAction &&
        event.data?.type === 'notary:desktop-settings-action' &&
        isDesktopSettingsAction(event.data.payload)
      ) {
        onDesktopSettingsAction(event.data.payload);
      }
      if (event.data?.type === 'notary:desktop-route-change' && onRouteChange) {
        const nextView = desktopViewFromDashboardRoute(event.data.payload);
        if (!nextView || nextView === route) return;
        embeddedRoute.current = nextView;
        onRouteChange(nextView);
      }
      if (
        event.data?.type === 'notary:desktop-trace-action-consumed'
        && isConsumedTraceAction(event.data.payload)
        && onTraceActionConsumed
      ) {
        embeddedRoute.current = route;
        onTraceActionConsumed(event.data.payload.traceId, event.data.payload.action);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [desktopSettings, onDesktopSettingsAction, onRouteChange, onTraceActionConsumed, route]);

  if (!running) {
    return <EmptyPanel
      icon={<Square size={26} />}
      title="Local service is off"
      copy="Start the local service to inspect private traces and connections. Capture remains off."
      notice={serviceError}
      action={onStartService && <button className="mac-button is-primary" type="button" onClick={onStartService} disabled={serviceStarting}>
        {serviceStarting ? 'Starting local service…' : 'Start local service'}
      </button>}
    />;
  }

  if (loadFailed) {
    return <EmptyPanel
      icon={<Square size={26} />}
      title="Local workspace didn't respond"
      copy="The local service is running, but its workspace did not answer. Retry now. If this continues, restart the local service."
      action={<button
        className="mac-button is-primary"
        type="button"
        onClick={() => setNavigation((current) => ({
          source: current.source,
          revision: current.revision + 1,
        }))}
      >
        <RefreshCw size={14} /> Retry local workspace
      </button>}
    />;
  }

  return <div className="workspace-frame">
    {!loaded && <div className="workspace-loading"><span className="spinner" />Loading local workspace…</div>}
    <iframe
      ref={frame}
      key={`${navigation.source}:${navigation.revision}`}
      src={navigation.source}
      title={`${viewMeta[route].title} workspace`}
      onError={() => setLoadFailed(true)}
      onLoad={() => {
        setFrameLoaded(true);
        frame.current?.contentWindow?.postMessage(
          { type: 'notary:desktop-ready-request' },
          workspaceOrigin,
        );
        sendDesktopSettings();
      }}
    />
  </div>;
}

export type DesktopSettingsPayload = {
  launch_at_login: boolean;
  launch_ready: boolean;
  vault_label: string;
  vault_detail: string;
  app_version: string;
  app_build_id: string;
  update: {
    enabled: boolean;
    phase: string;
    current_build_id: string;
    latest_build_id: string | null;
    downloaded_bytes: number;
    total_bytes: number | null;
    message: string | null;
  } | null;
  update_busy: boolean;
  restart_block_reason: string | null;
  notice: string | null;
};

export type DesktopSettingsAction =
  | { action: 'set_launch_at_login'; enabled: boolean }
  | { action: 'check_for_updates' }
  | { action: 'restart_to_update' };

function isDesktopSettingsAction(value: unknown): value is DesktopSettingsAction {
  if (!value || typeof value !== 'object' || !('action' in value)) return false;
  const action = (value as { action?: unknown }).action;
  if (action === 'check_for_updates' || action === 'restart_to_update') return true;
  return action === 'set_launch_at_login' && typeof (value as { enabled?: unknown }).enabled === 'boolean';
}

function desktopViewFromDashboardRoute(value: unknown): View | null {
  if (!value || typeof value !== 'object' || !('view' in value)) return null;
  const view = (value as { view?: unknown }).view;
  if (view === 'overview') return 'home';
  if (view === 'traces' || view === 'activity' || view === 'providers' || view === 'settings') {
    return view;
  }
  return null;
}

function isConsumedTraceAction(
  value: unknown,
): value is { traceId: string; action: 'first-proof' } {
  if (!value || typeof value !== 'object') return false;
  const payload = value as { traceId?: unknown; action?: unknown };
  return typeof payload.traceId === 'string'
    && payload.traceId.startsWith('trc-')
    && payload.traceId.length <= 256
    && payload.action === 'first-proof';
}

function EmptyPanel({ icon, title, copy, notice, action }: { icon: ReactNode; title: string; copy: string; notice?: string | null; action?: ReactNode }) {
  return <div className="empty-panel">
    <span>{icon}</span>
    <h2>{title}</h2>
    <p>{copy}</p>
    {notice && <div className="native-notice service-start-notice" role="alert">{notice}</div>}
    {action}
  </div>;
}
