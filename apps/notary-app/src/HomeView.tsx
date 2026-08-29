import { ChevronRight, FileCheck2, Play, Plug, ShieldCheck, Square } from 'lucide-react';
import type { DesktopState } from './bridge';
import {
  vaultProtection,
  type TraceConstraint,
  type View,
} from './product';

export function HomeView({
  state,
  busy,
  notice,
  onNavigate,
  onOpenTraces,
  onStartCapture,
  onStopCapture,
  onRetryConnections,
}: {
  state: DesktopState;
  busy: string | null;
  notice: string | null;
  onNavigate: (view: View) => void;
  onOpenTraces: (constraint: TraceConstraint) => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onRetryConnections: () => void;
}) {
  const vault = vaultProtection(state.vault_mode);
  const recording = state.running && state.capture_enabled;
  const traceTotal = state.counts.captured
    + state.counts.notarized
    + state.counts.capturing
    + state.counts.capture_failed;
  const hasCapturedTrace = traceTotal > 0;
  const hasSealedTrace = state.counts.notarized > 0;
  const sealingServiceName = state.sealing_service?.name ?? 'Exalto Seal';
  const sealingPhase = state.sealing_service_readiness.phase;
  const sealingReady = sealingPhase === 'ready';
  const captureCanStart = sealingReady || (!state.running && sealingPhase === 'off');
  const sealingStarting = sealingPhase === 'starting';
  const sealingNeedsAttention = sealingPhase === 'unreachable'
    || sealingPhase === 'trust_unavailable';
  const sealingStatus = sealingReady
    ? 'Ready'
    : sealingStarting
      ? 'Starting'
      : sealingPhase === 'unreachable'
        ? 'Unreachable'
        : sealingPhase === 'trust_unavailable'
          ? 'Trust unavailable'
          : 'Service off';

  return <div className="native-page capture-page">
    <section className={`capture-console ${recording ? 'is-recording' : ''}`}>
      <div className="capture-console-state">
        <span className="capture-rec-dot" aria-hidden="true" />
        <div>
          <span className="section-label">Local recorder</span>
          <h1>{recording ? 'Capturing' : 'Capture is off'}</h1>
          <p>{recording
            ? 'Make a request in a connected AI client. New traces stay private on this Mac.'
            : 'Start capturing before your next request. Requests sent while capture is off cannot be sealed later.'}</p>
        </div>
      </div>
      {recording
        ? <button className="mac-button capture-button is-stop" onClick={onStopCapture} disabled={busy !== null}>
          <Square size={12} /> {busy === 'capture-stop' ? 'Stopping…' : 'Stop capturing'}
        </button>
        : <button
          className="mac-button capture-button is-primary"
          onClick={onStartCapture}
          disabled={busy !== null || !captureCanStart}
          title={sealingReady
            ? 'Start capturing'
            : captureCanStart
              ? 'Start the local service and connect its trusted capture transport.'
            : 'Capture requires a reachable trusted transport. No Exalto Seal account is required.'}
        >
          <Play size={14} /> {busy === 'capture-start' ? 'Starting…' : 'Start capturing'}
        </button>}
    </section>

    {(notice || state.message) && <div className="native-notice">{notice ?? state.message}</div>}

    {sealingStarting && <div className="capture-warning is-starting" role="status">
      <div className="capture-warning-copy">
        <strong>{sealingServiceName} is starting</strong>
        <span>Checking the trusted capture transport. Capture will be available when this check succeeds. An Exalto Seal account is not required.</span>
      </div>
    </div>}

    {sealingNeedsAttention && <div className="capture-warning" role="status">
      <div className="capture-warning-copy">
        <strong>{sealingPhase === 'unreachable' ? `${sealingServiceName} cannot be reached` : 'Sealing trust needs attention'}</strong>
        <span>{state.sealing_service_readiness.message ?? (sealingPhase === 'unreachable'
          ? 'The trusted endpoint did not complete its transport handshake.'
          : 'The configured trust source did not resolve a trusted sealing endpoint.')}</span>
        <span>Capture needs this trusted transport, but it does not require an Exalto Seal account. Restore the connection, then start capturing.</span>
      </div>
      <div className="capture-warning-actions">
        <button type="button" onClick={onRetryConnections}>Try again</button>
        <button type="button" onClick={() => onNavigate('settings')}>Review sealing status</button>
      </div>
    </div>}

    <section className="capture-workflow" aria-label="Trace workflow">
      <WorkflowStep number="01" label="Capture" detail={recording ? 'Recording locally' : 'Ready when you start'} state={recording ? 'active' : 'idle'} />
      <WorkflowStep number="02" label="Review" detail={hasCapturedTrace ? 'Inspect disclosure' : 'After capture'} state={hasCapturedTrace ? 'complete' : 'idle'} />
      <WorkflowStep number="03" label="Seal" detail={state.counts.notarizing ? 'Sealing now' : hasSealedTrace ? 'Portable proof ready' : 'When you need proof'} state={state.counts.notarizing ? 'active' : hasSealedTrace ? 'complete' : 'idle'} />
      <WorkflowStep number="04" label="Verify or share" detail={hasSealedTrace ? 'Available' : 'After sealing'} state={hasSealedTrace ? 'complete' : 'idle'} />
    </section>

    <section className="capture-layout">
      <div className="capture-main-stack">
        <div className="capture-receipt">
          <header>
            <div><span className="section-label">Private traces</span><h2>{traceTotal ? `${traceTotal} on this Mac` : 'No traces yet'}</h2></div>
            <FileCheck2 size={19} aria-hidden="true" />
          </header>
          {traceTotal ? <div className="capture-counts">
            <button onClick={() => onOpenTraces('state=captured')}><b>{state.counts.captured}</b><span>Captured</span><ChevronRight size={14} /></button>
            <button onClick={() => onOpenTraces('status=notarizing')}><b>{state.counts.notarizing}</b><span>Sealing</span><ChevronRight size={14} /></button>
            <button onClick={() => onOpenTraces('state=notarized')}><b>{state.counts.notarized}</b><span>Sealed</span><ChevronRight size={14} /></button>
            <button onClick={() => onOpenTraces('status=needs_attention')}><b>{state.counts.needs_attention}</b><span>Needs attention</span><ChevronRight size={14} /></button>
          </div> : <div className="capture-empty">
            <p>Start capturing, then make a request in a connected AI client.</p>
            <button type="button" onClick={() => onNavigate('providers')}>Set up an AI connection <ChevronRight size={14} /></button>
          </div>}
          <button className="receipt-action" onClick={() => onNavigate('traces')}>
            Open traces <ChevronRight size={15} />
          </button>
        </div>
        <section className="capture-route-card">
          <header><span className="section-label">What crosses each boundary</span><strong>{sealingReady ? `${sealingServiceName} is ready to receive ciphertext.` : `${sealingServiceName} is not used until it is ready.`} Plaintext stays between this Mac and the provider.</strong></header>
          <div className="native-route">
            <RouteStop title="AI client" detail="Credential and plaintext" active={state.running} tone="local" />
            <RouteStop title="This Mac" detail="Private capture" active={recording} tone="local" />
            <RouteStop title={sealingServiceName} detail={recording && sealingReady ? 'Ciphertext only' : 'Not used'} active={recording && sealingReady} tone="seal" />
            <RouteStop title="Provider" detail="Authenticated request" active={state.running} tone="seal" />
          </div>
        </section>
      </div>

      <div className="capture-side-stack">
        <section className="capture-connection-card">
          <header><div><span className="section-label">AI connections</span><h2>Use the tools you already have</h2></div><Plug size={18} aria-hidden="true" /></header>
          <p>Codex CLI, Claude Code, and API clients can send their normal provider request through Exalto Capture.</p>
          <button type="button" onClick={() => onNavigate('providers')}>Set up a connection <ChevronRight size={14} /></button>
        </section>
        <section className="capture-protection-card">
          <header><div><span className="section-label">Privacy and storage</span><h2>{vault.label}</h2></div><ShieldCheck size={18} aria-hidden="true" /></header>
          <p>{vault.detail}</p>
          <dl>
            <div><dt>Sealing service</dt><dd>{`${sealingServiceName} · ${sealingStatus}`}</dd></div>
            <div><dt>Local route</dt><dd><code>{state.proxy_listener}</code></dd></div>
          </dl>
        </section>
      </div>
    </section>
  </div>;
}

function WorkflowStep({ number, label, detail, state }: {
  number: string;
  label: string;
  detail: string;
  state: 'idle' | 'active' | 'complete';
}) {
  return <div className={`workflow-step is-${state}`}>
    <span>{number}</span>
    <strong>{label}</strong>
    <small>{detail}</small>
  </div>;
}

export function RouteStop({ title, detail, active, tone = 'seal' }: {
  title: string;
  detail: string;
  active: boolean;
  tone?: 'local' | 'seal';
}) {
  return <div className={`native-route-stop is-${tone}`}><span className={active ? 'is-active' : ''} /><strong>{title}</strong><small>{detail}</small></div>;
}
