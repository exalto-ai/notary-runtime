import { FileCheck2, MessageSquare, Radio, Settings, Unplug } from 'lucide-react';
import type { DesktopState } from './bridge';
import notaryMark from './notary-mark.svg';
import { Symbol } from './Symbol';
import {
  DISPLAY_NAME,
  type View,
} from './product';

export function Sidebar({ state, view, onNavigate }: {
  state: DesktopState;
  view: View;
  onNavigate: (view: View) => void;
}) {
  const traceCount = state.counts.captured + state.counts.notarized + state.counts.capturing + state.counts.capture_failed;
  const items: Array<{ view: View; label: string; icon: typeof Radio; symbol: string; count?: number }> = [
    { view: 'home', label: 'Overview', icon: Radio, symbol: 'dot.radiowaves.left.and.right' },
    { view: 'chat', label: 'Chat', icon: MessageSquare, symbol: 'bubble.left' },
    {
      view: 'traces',
      label: 'Traces',
      icon: FileCheck2,
      symbol: 'doc.text',
      count: traceCount,
    },
    { view: 'providers', label: 'Connections', icon: Unplug, symbol: 'point.3.connected.trianglepath.dotted' },
    { view: 'settings', label: 'Preferences', icon: Settings, symbol: 'gearshape' },
  ];

  return <aside className="native-sidebar">
    <div className="sidebar-drag-region" data-tauri-drag-region />
    <div className="sidebar-brand">
      <img src={notaryMark} alt="" />
      <strong>Capture</strong>
    </div>
    <nav aria-label={DISPLAY_NAME}>
      <div className="sidebar-group">
        {items.map(({ view: itemView, label, icon: Icon, symbol, count }) => <button
          key={itemView}
          type="button"
          className={view === itemView ? 'is-selected' : ''}
          onClick={() => onNavigate(itemView)}
        >
          <Symbol name={symbol} fallback={Icon} size={16} />
          <span>{label}</span>
          {count ? <b>{count}</b> : null}
        </button>)}
      </div>
    </nav>
  </aside>;
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
