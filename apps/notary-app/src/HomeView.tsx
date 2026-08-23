import { ChevronRight, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { DesktopState } from './bridge';
import {
  StatusDot,
  vaultProtection,
  type TraceConstraint,
  type View,
} from './product';

export function HomeView({ state, busy, notice, onNavigate, onOpenTraces, onStart, onStop, onRestart }: {
  state: DesktopState;
  busy: string | null;
  notice: string | null;
  onNavigate: (view: View) => void;
  onOpenTraces: (constraint: TraceConstraint) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const vault = vaultProtection(state.vault_mode);
  return <div className="native-page home-page">
    <section className={`status-hero ${state.running ? 'is-running' : ''} ${state.running && !state.capture_enabled ? 'is-direct' : ''}`}>
      <div className="status-orb"><StatusDot running={state.running} warning={!state.running} /></div>
      <div>
        <h1>{state.running ? state.capture_enabled ? 'Ready to capture' : 'Service running with capture off' : 'Notary is stopped'}</h1>
        <p>{state.running
          ? state.capture_enabled
            ? 'Your local proxy is ready. Provider credentials stay in the client that sends each request.'
            : 'Provider requests still pass through this Mac, but go directly to the provider and create no evidence.'
          : 'Start the local service before sending a model request.'}</p>
      </div>
      <div className="hero-actions">
        {state.running ? <>
          <button className="mac-button" onClick={onRestart} disabled={!state.managed_by_desktop || busy !== null}>
            <RefreshCw size={14} /> {busy === 'restart' ? 'Restarting…' : 'Restart'}
          </button>
          <button className="mac-button" onClick={onStop} disabled={!state.managed_by_desktop || busy !== null}>
            <Square size={12} /> {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        </> : <button className="mac-button is-primary" onClick={onStart} disabled={busy !== null}>
          <Play size={14} /> {busy === 'start' ? 'Starting…' : 'Start Notary'}
        </button>}
      </div>
    </section>

    {(notice || state.message) && <div className="native-notice">{notice ?? state.message}</div>}

    <section className="home-grid">
      <div className="native-card capture-card">
        <header><div><span className="section-label">Trace workspace</span><h2>Private evidence</h2></div><span>{state.counts.captured + state.counts.notarized + state.counts.capturing + state.counts.capture_failed} total</span></header>
        <div className="capture-counts">
          <button onClick={() => onOpenTraces('state=captured')}><b>{state.counts.captured}</b><span>Captured</span><ChevronRight size={14} /></button>
          <button onClick={() => onOpenTraces('status=notarizing')}><b>{state.counts.notarizing}</b><span>Notarizing</span><ChevronRight size={14} /></button>
          <button onClick={() => onOpenTraces('state=notarized')}><b>{state.counts.notarized}</b><span>Notarized</span><ChevronRight size={14} /></button>
          <button onClick={() => onOpenTraces('status=needs_attention')}><b>{state.counts.needs_attention}</b><span>Needs attention</span><ChevronRight size={14} /></button>
        </div>
        <button className="card-action" onClick={() => onNavigate(state.counts.captured ? 'traces' : 'providers')}>
          {state.counts.captured ? 'Review traces' : 'Connect a model client'} <ChevronRight size={15} />
        </button>
      </div>

      <div className="native-card protection-card">
        <header><div><span className="section-label">Protection</span><h2>{vault.label}</h2></div><ShieldCheck size={20} /></header>
        <p>{vault.detail}</p>
        <dl>
          <div><dt>Provider proxy</dt><dd>{state.proxy_listener}</dd></div>
          <div><dt>Registry</dt><dd>{state.notary === 'registry' ? 'Pinned Registry' : state.notary ?? 'Unavailable'}</dd></div>
          <div><dt>Service version</dt><dd>{state.version ?? 'Not running'}</dd></div>
        </dl>
      </div>
    </section>

    <section className="native-card route-card">
      <header><div><span className="section-label">Authenticated route</span><h2>What each part can see</h2></div></header>
      <div className="native-route">
        <RouteStop title="Your client" detail="API key and plaintext" active={state.running} />
        <RouteStop title="This Mac" detail={state.capture_enabled ? 'Plaintext and private capture' : 'Direct HTTPS passthrough'} active={state.running} />
        <RouteStop title="Remote notary" detail={state.capture_enabled ? 'Encrypted protocol only' : 'Bypassed for new requests'} active={state.running && state.capture_enabled} />
        <RouteStop title="Provider" detail="Normal model request" active={state.running} />
      </div>
    </section>
  </div>;
}

export function RouteStop({ title, detail, active }: { title: string; detail: string; active: boolean }) {
  return <div className="native-route-stop"><span className={active ? 'is-active' : ''} /><strong>{title}</strong><small>{detail}</small></div>;
}
