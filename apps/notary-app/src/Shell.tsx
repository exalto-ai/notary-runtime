import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, FileCheck2, Gauge, Settings, SlidersHorizontal, Square } from 'lucide-react';
import type { DesktopState } from './bridge';
import notaryMark from './notary-mark.svg';
import {
  StatusDot,
  viewMeta,
  type TraceConstraint,
  type View,
  type WorkspaceView,
} from './product';

export function Sidebar({ state, view, onNavigate }: { state: DesktopState; view: View; onNavigate: (view: View) => void }) {
  const items: Array<{ view: View; label: string; icon: typeof Gauge; count?: number }> = [
    { view: 'home', label: 'Home', icon: Gauge },
    {
      view: 'traces',
      label: 'Traces',
      icon: FileCheck2,
      count: state.counts.captured,
    },
    { view: 'activity', label: 'Activity', icon: Activity },
    { view: 'providers', label: 'Providers', icon: SlidersHorizontal },
    { view: 'settings', label: 'Settings', icon: Settings },
  ];

  return <aside className="native-sidebar">
    <div className="sidebar-drag-region" data-tauri-drag-region />
    <div className="sidebar-brand">
      <img src={notaryMark} alt="" />
      <span>Notary</span>
    </div>
    <nav aria-label="Notary">
      <div className="sidebar-group">
        {items.map(({ view: itemView, label, icon: Icon, count }) => <button
          key={itemView}
          type="button"
          className={view === itemView ? 'is-selected' : ''}
          onClick={() => onNavigate(itemView)}
        >
          <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>{label}</span>
          {count ? <b>{count}</b> : null}
        </button>)}
      </div>
    </nav>
    <div className="sidebar-footer">
      <StatusDot running={state.running} warning={!state.running} />
      <span>{state.running ? state.capture_enabled ? `Ready on ${state.proxy_listener}` : `Capture off · ${state.proxy_listener}` : 'Service stopped'}</span>
    </div>
  </aside>;
}

export function WorkspaceFrame({
  route,
  constraint = null,
  running,
  desktopSettings,
  onDesktopSettingsAction,
}: {
  route: WorkspaceView;
  constraint?: TraceConstraint | null;
  running: boolean;
  desktopSettings?: DesktopSettingsPayload;
  onDesktopSettingsAction?: (action: DesktopSettingsAction) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const source = `http://127.0.0.1:8788/dashboard?embedded=desktop#/${route}${constraint ? `?${constraint}` : ''}`;

  const sendDesktopSettings = () => {
    if (!desktopSettings) return;
    frame.current?.contentWindow?.postMessage(
      { type: 'notary:desktop-settings', payload: desktopSettings },
      'http://127.0.0.1:8788',
    );
  };

  useEffect(() => setLoaded(false), [source]);
  useEffect(sendDesktopSettings, [desktopSettings]);
  useEffect(() => {
    if (!onDesktopSettingsAction) return;
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== 'http://127.0.0.1:8788' ||
        event.source !== frame.current?.contentWindow
      ) {
        return;
      }
      if (event.data?.type === 'notary:desktop-settings-ready') sendDesktopSettings();
      if (
        event.data?.type === 'notary:desktop-settings-action' &&
        isDesktopSettingsAction(event.data.payload)
      ) {
        onDesktopSettingsAction(event.data.payload);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [desktopSettings, onDesktopSettingsAction]);

  if (!running) {
    return <EmptyPanel
      icon={<Square size={26} />}
      title="The capture service is stopped"
      copy="Open Home to start Notary. Nothing is sent anywhere while the service is stopped."
    />;
  }

  return <div className="workspace-frame">
    {!loaded && <div className="workspace-loading"><span className="spinner" />Loading local workspace…</div>}
    <iframe
      ref={frame}
      key={source}
      src={source}
      title={`${viewMeta[route].title} workspace`}
      onLoad={() => {
        setLoaded(true);
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

function EmptyPanel({ icon, title, copy, action }: { icon: ReactNode; title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-panel"><span>{icon}</span><h2>{title}</h2><p>{copy}</p>{action}</div>;
}
