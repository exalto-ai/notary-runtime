import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDot,
  FileCheck2,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  SquareTerminal,
} from 'lucide-react';
import {
  beginTemporaryCapture,
  completeOnboarding,
  confirmDisposableTrace,
  configureVault,
  endTemporaryCapture,
  errorMessage,
  getDesktopState,
  getRecentTraceProbes,
  isTauri,
  startDaemon,
  type DesktopState,
} from './bridge';
import { ProviderConnections } from './BuiltinChat';
import { DesktopAccountCard } from './AccountCard';
import { AgentSetup, agentSetupPrompt, CODEX_CONFIG, CLAUDE_COMMAND } from './AgentSetup';
import {
  StatusDot,
  vaultProtection,
  type TraceTarget,
  type View,
} from './product';
import notaryMark from './notary-mark.svg';
import './onboarding.css';

type OnboardingStep = 'welcome' | 'protection' | 'notary' | 'client' | 'test' | 'account';
type VaultSetupMode = 'keychain' | 'passphrase';
type ClientId = 'codex' | 'claude' | 'builtin';
type TestStatus = 'idle' | 'checking' | 'not-found' | 'unconfirmed' | 'captured';
type TemporaryCaptureEvent = {
  window_generation: number;
  lease_id: string | null;
};

type OnboardingSealingService = {
  name: string;
  isExaltoSeal: boolean;
  available: boolean;
  configured: boolean;
};

function onboardingSealingService(state: DesktopState): OnboardingSealingService {
  if (state.sealing_service) {
    return {
      name: state.sealing_service.name,
      isExaltoSeal: state.sealing_service.kind === 'exalto_seal',
      available: true,
      configured: true,
    };
  }
  if (!state.agent_configured) {
    return {
      name: 'Exalto Seal',
      isExaltoSeal: true,
      available: true,
      configured: false,
    };
  }
  return {
    name: 'Configured sealing service',
    isExaltoSeal: false,
    available: false,
    configured: true,
  };
}

const onboardingSteps: OnboardingStep[] = [
  'welcome',
  'protection',
  'notary',
  'client',
  'test',
  'account',
];

const stepNames: Record<OnboardingStep, string> = {
  welcome: 'Overview',
  protection: 'Protection',
  notary: 'Sealing service',
  client: 'Chat',
  test: 'Capture test',
  account: 'Account',
};

const clientChoices = [
  {
    id: 'builtin',
    name: 'Built-in',
    detail: 'Chat inside Capture. Link your ChatGPT plan, or save an OpenAI or Anthropic API key.',
  },
  {
    id: 'codex',
    name: 'Codex',
    detail: 'Configure a separate Codex session. It keeps your existing ChatGPT sign-in or API key.',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'Configure a separate Claude Code session that uses an Anthropic API key.',
  },
] as const;

const clientLabels: Record<ClientId, string> = {
  builtin: 'Built-in chat',
  codex: 'Codex CLI',
  claude: 'Claude Code',
};

const TEST_MARKER_PREFIX = 'EXALTO-CAPTURE-TEST-';

export function createDisposableTestMarker() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${TEST_MARKER_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function createTemporaryCaptureLeaseId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectedTestProvider(client: ClientId) { return client === 'claude' ? 'anthropic' : 'openai'; }

function testCommand(client: ClientId, prompt: string) {
  if (client === 'codex') return `codex --profile exalto-capture exec --ephemeral --skip-git-repo-check '${prompt}'`;
  return `${CLAUDE_COMMAND} -p '${prompt}'`;
}

export function Onboarding({ state, refresh, onFinish, initialStep = 'welcome', initialError = null, onDisposableTestChange, onCancel }: {
  state: DesktopState;
  refresh: () => Promise<void>;
  onFinish: (view: View, traceTarget?: TraceTarget) => void;
  initialStep?: OnboardingStep;
  initialError?: string | null;
  onDisposableTestChange?: (active: boolean) => void;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [protectionMode, setProtectionMode] = useState<VaultSetupMode>('keychain');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('');
  const [client, setClient] = useState<ClientId>('builtin');
  const [testMarker] = useState(createDisposableTestMarker);
  const [testBaseline, setTestBaseline] = useState<ReadonlySet<string> | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [disposableTraceId, setDisposableTraceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const temporaryCaptureLease = useRef<string | null>(null);
  const preparationCancelled = useRef(false);
  const testOperation = useRef(0);
  const windowGeneration = useRef(state.temporary_capture_generation);
  const testPrompt = `Reply with exactly: ${testMarker}`;
  const stepIndex = onboardingSteps.indexOf(step);
  const sealingService = onboardingSealingService(state);

  useEffect(() => {
    windowGeneration.current = Math.max(
      windowGeneration.current,
      state.temporary_capture_generation,
    );
  }, [state.temporary_capture_generation]);

  const chooseClient = (nextClient: ClientId) => {
    setError(null);
    setClient(nextClient);
  };

  const invalidateTestWork = () => {
    preparationCancelled.current = true;
    testOperation.current += 1;
  };

  const testWorkIsCurrent = (operation: number, generation: number) =>
    operation === testOperation.current &&
    generation === windowGeneration.current &&
    !preparationCancelled.current;

  const restoreTestCapture = async (expectedLease = temporaryCaptureLease.current) => {
    if (!expectedLease) return;
    await endTemporaryCapture(expectedLease);
    if (temporaryCaptureLease.current !== expectedLease) return;
    temporaryCaptureLease.current = null;
    onDisposableTestChange?.(false);
    await refresh();
  };

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisten: UnlistenFn[] = [];
    const retain = (stopListening: UnlistenFn) => {
      if (disposed) stopListening();
      else unlisten.push(stopListening);
    };
    void listen<TemporaryCaptureEvent>('exalto:temporary-capture-cancelled', (event) => {
      windowGeneration.current = Math.max(
        windowGeneration.current,
        event.payload.window_generation,
      );
      const hadDisposableTest = Boolean(
        event.payload.lease_id || temporaryCaptureLease.current,
      );
      invalidateTestWork();
      setPassphrase('');
      setPassphraseConfirmation('');
      if (temporaryCaptureLease.current !== event.payload.lease_id) {
        temporaryCaptureLease.current = null;
      }
      if (!hadDisposableTest) return;
      setBusy(false);
      setTestStatus('idle');
      setStep('client');
      setError('The disposable test stopped when setup closed. Prepare it again when you are ready.');
    }).then(retain);
    void listen<TemporaryCaptureEvent>('exalto:temporary-capture-restored', (event) => {
      windowGeneration.current = Math.max(
        windowGeneration.current,
        event.payload.window_generation,
      );
      if (temporaryCaptureLease.current === event.payload.lease_id) {
        temporaryCaptureLease.current = null;
      }
      void refresh();
    }).then(retain);
    void listen<string>('exalto:temporary-capture-restore-failed', (event) => {
      setError(`Could not restore your capture setting: ${event.payload}`);
    }).then(retain);
    return () => {
      disposed = true;
      for (const stopListening of unlisten) stopListening();
    };
  }, [refresh]);

  const goBack = async () => {
    invalidateTestWork();
    setError(null);
    if (step === 'account') {
      setTestStatus('idle');
      setStep('client');
      return;
    }
    if (step === 'test') {
      setBusy(true);
      try {
        await restoreTestCapture();
      } catch (caught) {
        setError(`Could not restore your capture setting: ${errorMessage(caught)}`);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (step === 'protection') {
      setProtectionMode('keychain');
      setPassphrase('');
      setPassphraseConfirmation('');
    }
    setStep(onboardingSteps[Math.max(0, stepIndex - 1)]);
  };

  const configureProtection = async () => {
    if (protectionMode === 'passphrase') {
      if (!passphrase.trim()) {
        setError('Enter a non-empty vault passphrase.');
        return;
      }
      if (passphrase !== passphraseConfirmation) {
        setError('The passphrases do not match.');
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (!state.vault_configured) {
        await configureVault(protectionMode, protectionMode === 'passphrase' ? passphrase : undefined);
        setPassphrase('');
        setPassphraseConfirmation('');
        await refresh();
      }
      setStep('notary');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const startService = async () => {
    setBusy(true);
    setError(null);
    preparationCancelled.current = false;
    const operation = testOperation.current + 1;
    testOperation.current = operation;
    const generation = windowGeneration.current;
    let leaseId: string | null = null;
    try {
      if (temporaryCaptureLease.current) {
        const previousLease = temporaryCaptureLease.current;
        try {
          await restoreTestCapture(previousLease);
        } catch {
          // A safely deferred lease can outlive a daemon exit. Restarting the
          // supervised child forces capture off before it binds, then the
          // owner-scoped restore clears the durable recovery marker.
          await startDaemon();
          if (!testWorkIsCurrent(operation, generation)) return;
          await restoreTestCapture(previousLease);
        }
      }
      if (!testWorkIsCurrent(operation, generation)) return;
      await startDaemon();
      if (!testWorkIsCurrent(operation, generation)) return;
      let readiness: DesktopState | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        readiness = await getDesktopState(true);
        if (!testWorkIsCurrent(operation, generation)) return;
        if (readiness.sealing_service_readiness.phase === 'ready') break;
        if (
          readiness.sealing_service_readiness.phase === 'unreachable'
          || readiness.sealing_service_readiness.phase === 'trust_unavailable'
        ) break;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      await refresh();
      if (!testWorkIsCurrent(operation, generation)) return;
      if (readiness?.sealing_service_readiness.phase !== 'ready') {
        throw new Error(
          'The trusted capture transport is not ready. No Exalto Seal account is required. Restore the trusted connection, then prepare the disposable test again.',
        );
      }
      leaseId = createTemporaryCaptureLeaseId();
      temporaryCaptureLease.current = leaseId;
      onDisposableTestChange?.(true);
      await beginTemporaryCapture(generation, leaseId);
      if (!testWorkIsCurrent(operation, generation)) {
        await endTemporaryCapture(leaseId).catch(() => undefined);
        return;
      }
      await refresh();
      if (!testWorkIsCurrent(operation, generation)) return;
      let baseline = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (!testWorkIsCurrent(operation, generation)) return;
        try {
          baseline = await getRecentTraceProbes(leaseId);
          lastError = null;
          break;
        } catch (caught) {
          lastError = caught;
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      if (!testWorkIsCurrent(operation, generation)) return;
      if (lastError) throw lastError;
      if (baseline === null) throw new Error('The local service did not become ready.');
      setDisposableTraceId(null);
      setTestBaseline(new Set(baseline.map((trace) => trace.trace_id)));
      setTestStatus('idle');
      setStep('test');
    } catch (caught) {
      if (!testWorkIsCurrent(operation, generation)) {
        if (leaseId) await endTemporaryCapture(leaseId).catch(() => undefined);
        return;
      }
      let message = errorMessage(caught);
      if (leaseId && temporaryCaptureLease.current === leaseId) {
        try {
          await restoreTestCapture(leaseId);
        } catch (restoreError) {
          message = `${message} Capture may still be enabled: ${errorMessage(restoreError)}`;
        }
      }
      setError(message);
    } finally {
      if (operation === testOperation.current) setBusy(false);
    }
  };

  const checkForTestTrace = async () => {
    if (state.sealing_service_readiness.phase !== 'ready') {
      setError(
        'The trusted capture transport is not ready. No Exalto Seal account is required. Restore the trusted connection before running the disposable test.',
      );
      return;
    }
    const leaseId = temporaryCaptureLease.current;
    if (!leaseId) {
      setError('Prepare the disposable capture test again.');
      return;
    }
    preparationCancelled.current = false;
    const operation = testOperation.current + 1;
    testOperation.current = operation;
    const generation = windowGeneration.current;
    setTestStatus('checking');
    setError(null);
    try {
      const expectedProvider = expectedTestProvider(client);
      const traceId = testBaseline === null ? null : await confirmDisposableTrace(
        [...testBaseline],
        expectedProvider,
        testMarker,
        leaseId,
      );
      if (
        !testWorkIsCurrent(operation, generation) ||
        temporaryCaptureLease.current !== leaseId
      ) return;
      if (traceId) {
        await restoreTestCapture(leaseId);
        if (!testWorkIsCurrent(operation, generation)) return;
        setDisposableTraceId(traceId);
        setTestStatus('captured');
      } else {
        await refresh();
        if (!testWorkIsCurrent(operation, generation)) return;
        setTestStatus('not-found');
      }
    } catch (caught) {
      if (!testWorkIsCurrent(operation, generation)) return;
      setError(errorMessage(caught));
      setTestStatus('not-found');
    }
  };

  const leaveTest = async () => {
    invalidateTestWork();
    setBusy(true);
    setError(null);
    try {
      await restoreTestCapture();
      setStep('account');
    } catch (caught) {
      setError(`Could not restore your capture setting: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelSetup = async () => {
    invalidateTestWork();
    setBusy(true);
    setError(null);
    try {
      await restoreTestCapture();
      onCancel?.();
    } catch (caught) {
      setError(`Could not restore your capture setting: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (destination: View, traceTarget?: TraceTarget) => {
    invalidateTestWork();
    setBusy(true);
    setError(null);
    try {
      await restoreTestCapture();
      await completeOnboarding();
      await refresh();
      onFinish(destination, traceTarget);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const navigationBusy = busy || testStatus === 'checking';

  const decisions: Partial<Record<OnboardingStep, string>> = {
    protection: state.vault_configured
      ? 'Existing vault'
      : protectionMode === 'passphrase' ? 'Passphrase' : 'Keychain',
    notary: sealingService.name,
    client: clientLabels[client],
    test: testStatus === 'captured'
      ? 'Trace captured'
      : testStatus === 'unconfirmed' ? 'Unconfirmed' : undefined,
  };

  return <div className="onboarding-window exalto-onboarding">
    <aside className="setup-rail">
      <div className="setup-rail-drag" data-tauri-drag-region />
      <div className="setup-brand" data-tauri-drag-region="deep">
        <img src={notaryMark} alt="" />
        <strong data-tauri-drag-region>Exalto Capture</strong>
      </div>
      <span className="setup-rail-label">Setup</span>
      <ol className="setup-ledger" aria-label={`Setup step ${stepIndex + 1} of ${onboardingSteps.length}`}>
        {onboardingSteps.map((item, index) => <li
          key={item}
          className={index < stepIndex ? 'is-done' : index === stepIndex ? 'is-current' : ''}
          aria-current={index === stepIndex ? 'step' : undefined}
        >
          <span className="ledger-mark">{index < stepIndex ? <Check size={11} /> : index + 1}</span>
          <span className="ledger-name">{stepNames[item]}</span>
          {index <= stepIndex && decisions[item] && <span className="ledger-value">{decisions[item]}</span>}
        </li>)}
      </ol>
    </aside>
    <section className={`onboarding-content${step === 'client' ? ' is-client-step' : ''}`}>
      <header className="setup-bar" data-tauri-drag-region="deep">
        {step !== 'welcome'
          ? <button className="back-button" type="button" onClick={() => void goBack()} disabled={navigationBusy}>
            <ChevronLeft size={13} /> Back
          </button>
          : <span className="setup-bar-step" />}
        {onCancel && <button className="onboarding-close" type="button" onClick={() => void cancelSetup()} disabled={navigationBusy}>Done</button>}
      </header>
      {step === 'welcome' && <WelcomeStep state={state} onContinue={() => setStep('protection')} />}
      {step === 'protection' && <ProtectionStep
        configured={state.vault_configured}
        mode={protectionMode}
        setMode={setProtectionMode}
        passphrase={passphrase}
        setPassphrase={setPassphrase}
        passphraseConfirmation={passphraseConfirmation}
        setPassphraseConfirmation={setPassphraseConfirmation}
        busy={busy}
        onContinue={() => void configureProtection()}
      />}
      {step === 'notary' && <NotaryStep service={sealingService} onContinue={() => setStep('client')} />}
      {step === 'client' && <ClientStep
        client={client}
        setClient={chooseClient}
        busy={busy}
        running={state.running}
        externallyManagedService={state.running && !state.managed_by_desktop}
        onContinue={() => void startService()}
        onSkip={() => setStep('account')}
        onChat={() => void finish('chat')}
      />}
      {step === 'test' && <TestTraceStep
        client={client}
        testPrompt={testPrompt}
        state={state}
        status={testStatus}
        busy={busy}
        onCheck={() => void checkForTestTrace()}
        onContinue={() => void leaveTest()}
        onSkip={() => void leaveTest()}
      />}
      {step === 'account' && <AccountReadyStep
        state={state}
        client={client}
        disposableTraceId={disposableTraceId}
        busy={busy}
        onFinish={finish}
      />}
      {error && <div className={`onboarding-error${step === 'client' ? ' client-step-error' : ''}`} role="alert">{error}</div>}
    </section>
  </div>;
}

function WelcomeStep({ state, onContinue }: { state: DesktopState; onContinue: () => void }) {
  const fresh = !state.agent_configured && !state.vault_configured;
  return <>
    <div className="wizard-step welcome-step">
      <h1>Set up Exalto Capture</h1>
      <p>{fresh
        ? 'Capture a model exchange on this Mac, review what a sealed trace can reveal, then send it to Exalto Seal or another compatible notary for sealing.'
        : 'This Mac already has capture settings. Setup will preserve them while it checks the path from your AI tool to a portable trace.'}</p>
      <figure className="trace-receipt" aria-label="A sample local trace receipt">
        <figcaption><span><CircleDot size={10} /> REC</span><code>TRACE / LOCAL</code></figcaption>
        <dl>
          <div><dt>Source</dt><dd>Built-in chat or your AI tool</dd></div>
          <div><dt>Provider</dt><dd>Authenticated response</dd></div>
          <div><dt>Private content</dt><dd>Hidden from the sealing service</dd></div>
          <div><dt>Portable result</dt><dd>.llmtrace</dd></div>
        </dl>
        <p>A trace proves the interaction it contains. It does not prove that omitted interactions never happened.</p>
      </figure>
    </div>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue}>Begin setup</button></div>
  </>;
}

function ProtectionStep({ configured, mode, setMode, passphrase, setPassphrase, passphraseConfirmation, setPassphraseConfirmation, busy, onContinue }: {
  configured: boolean;
  mode: VaultSetupMode;
  setMode: (value: VaultSetupMode) => void;
  passphrase: string;
  setPassphrase: (value: string) => void;
  passphraseConfirmation: string;
  setPassphraseConfirmation: (value: string) => void;
  busy: boolean;
  onContinue: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(mode === 'passphrase');
  const passphrasesMatch = passphrase === passphraseConfirmation;
  const passphrasePresent = passphrase.trim().length > 0;
  const passphraseValid = passphrasePresent && passphrasesMatch;
  const mismatchId = 'vault-passphrase-mismatch';
  const chooseKeychain = () => {
    setMode('keychain');
    setPassphrase('');
    setPassphraseConfirmation('');
  };
  const toggleAdvanced = () => {
    if (advancedOpen) chooseKeychain();
    setAdvancedOpen(!advancedOpen);
  };
  return <>
    <div className="wizard-step">
      <h1>Protect private traces on this Mac</h1>
      <p>A full private capture can reconstruct the original provider request, including credentials. Exalto Capture vault-encrypts that artifact before writing it to disk.</p>
      {configured ? <div className="configured-protection"><BadgeCheck size={18} /><div><strong>Local protection is already configured</strong><span>Your existing vault will remain unchanged.</span></div></div> : <div className="protection-options" role="radiogroup" aria-label="Private trace protection">
        <button type="button" role="radio" aria-checked={mode === 'keychain'} className={mode === 'keychain' ? 'is-selected' : ''} onClick={chooseKeychain}>
          <span className="radio-mark">{mode === 'keychain' && <span />}</span>
          <div><strong>Use macOS Keychain</strong><p>Recommended. macOS protects the vault key, with no separate password to remember.</p></div>
        </button>
        {advancedOpen && <button type="button" role="radio" aria-checked={mode === 'passphrase'} className={mode === 'passphrase' ? 'is-selected' : ''} onClick={() => setMode('passphrase')}>
          <span className="radio-mark">{mode === 'passphrase' && <span />}</span>
          <div><strong>Use a passphrase</strong><p>Enter it whenever the app opens. Exalto Capture does not save it.</p></div>
        </button>}
      </div>}
      {!configured && <button type="button" className="advanced-options-toggle" aria-expanded={advancedOpen} onClick={toggleAdvanced}>Advanced protection <ChevronDown size={12} /></button>}
      {!configured && advancedOpen && mode === 'passphrase' && <div className="passphrase-fields">
        <label><span>Passphrase</span><input type="password" autoComplete="new-password" value={passphrase} aria-invalid={!passphraseValid} aria-describedby={!passphraseValid ? mismatchId : undefined} onChange={(event) => setPassphrase(event.target.value)} /></label>
        <label><span>Confirm passphrase</span><input type="password" autoComplete="new-password" value={passphraseConfirmation} aria-invalid={!passphraseValid} aria-describedby={!passphraseValid ? mismatchId : undefined} onChange={(event) => setPassphraseConfirmation(event.target.value)} /></label>
        {!passphrasePresent
          ? <small id={mismatchId} className="passphrase-mismatch" role="alert">Enter a non-empty passphrase.</small>
          : !passphrasesMatch && <small id={mismatchId} className="passphrase-mismatch" role="alert">The passphrases do not match.</small>}
      </div>}
      <div className="wizard-note" role="note"><LockKeyhole size={13} /><span>When retained previews are enabled, short prompt and response excerpts are also kept in local metadata so Traces can be browsed. Those excerpts stay on this Mac but are not protected by the trace vault.</span></div>
    </div>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue} disabled={busy || (mode === 'passphrase' && (!advancedOpen || !passphraseValid))}>{busy ? 'Saving…' : 'Protect traces'}</button></div>
  </>;
}

function NotaryStep({ service, onContinue }: {
  service: OnboardingSealingService;
  onContinue: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const heading = service.isExaltoSeal
    ? 'Start with Exalto Seal'
    : service.available
      ? `Continue with ${service.name}`
      : 'Review your configured sealing service';
  const introduction = service.isExaltoSeal
    ? 'Exalto Seal witnesses the provider connection while seeing encrypted protocol data, not your prompt, response, or provider credentials.'
    : service.available
      ? `${service.name} is selected by this runtime. The sealing service sees encrypted protocol data, not your prompt, response, or provider credentials.`
      : 'This Mac has an existing runtime configuration, but its sealing trust is not currently available. Exalto Capture will preserve that configuration.';
  const detail = service.isExaltoSeal
    ? 'The default hosted sealing service for this build. Capture does not require an Exalto Seal account, but it does require the trusted live capture transport.'
    : service.available
      ? 'Selected by the current signed Registry or local runtime configuration.'
      : 'Start the configured local service to inspect its endpoint and verification key.';
  const continueLabel = service.isExaltoSeal
    ? 'Continue with Exalto Seal'
    : service.available
      ? `Continue with ${service.name}`
      : 'Continue with configured service';
  return <>
    <div className="wizard-step notary-step">
      <h1>{heading}</h1>
      <p>{introduction}</p>
      <div className="notary-choice is-selected">
        <span className="notary-choice-mark"><Check size={13} /></span>
        <div><strong>{service.name}</strong><p>{detail}</p></div>
        <span className="choice-status">{service.isExaltoSeal && !service.configured ? 'Recommended' : service.available ? 'Configured' : 'Unavailable'}</span>
      </div>
      <dl className="notary-boundary">
        <div><dt>Sealing service sees</dt><dd>Provider hostname, encrypted traffic, sizes, timing</dd></div>
        <div><dt>Application plaintext</dt><dd>Visible to this Mac and your chosen model provider</dd></div>
      </dl>
      <button type="button" className="advanced-options-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>About compatible notaries <ChevronDown size={12} /></button>
      {advancedOpen && <div className="advanced-notaries">
        <div><Server size={15} /><span><strong>Compatible notary</strong><small>Selected through signed Registry trust</small></span><em>Administrator managed</em></div>
        <div><SquareTerminal size={15} /><span><strong>Self-hosted notary</strong><small>Operator endpoint and verification key required</small></span><em>Administrator managed</em></div>
        <p>This build preserves the pinned notary selected by its runtime configuration. Switching or adding a compatible notary requires an administrator-managed configuration.</p>
      </div>}
    </div>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" type="button" onClick={onContinue}>{continueLabel}</button></div>
  </>;
}

function ClientStep({ client, setClient, busy, running, externallyManagedService, onContinue, onSkip, onChat }: {
  client: ClientId; setClient: (client: ClientId) => void; busy: boolean;
  running: boolean; externallyManagedService: boolean; onContinue: () => void; onSkip: () => void; onChat: () => void;
}) {
  return <>
    <div className="wizard-step client-step-scroll">
      <h1>Where would you like to chat?</h1>
      <p>Chat inside Capture, or configure an external tool to send through it. You can add more connections later.</p>
      <div className="client-picker" role="radiogroup" aria-label="AI tool to connect first">
        {clientChoices.map((item) => <button key={item.id} type="button" role="radio" aria-checked={client === item.id} className={client === item.id ? 'is-selected' : ''} onClick={() => setClient(item.id)} disabled={busy}>
          {item.name}
        </button>)}
      </div>
      <p className="harness-description">{clientChoices.find((item) => item.id === client)?.detail}</p>
      {client === 'builtin' ? <ProviderConnections disabled={busy} /> : <AgentSetup key={client} client={client} prompt={agentSetupPrompt(client)} disabled={busy}
        manual={client === 'codex' ? <>
          <p>Run <code>codex login status</code>. Keep its existing sign-in. For a ChatGPT login, use the configuration below. For API-key authentication, use <code>http://127.0.0.1:8787/openai/v1</code> as the base URL and <code>env_key = "OPENAI_API_KEY"</code> instead of <code>requires_openai_auth</code>. Set the key privately in your shell.</p>
          <pre><code>{CODEX_CONFIG}</code></pre><p>Merge this into your user config, respecting <code>CODEX_HOME</code>. Start with <code>codex --profile exalto-capture</code>. Desktop chats are not automatically captured by this CLI profile.</p>
        </> : <><p>Set <code>ANTHROPIC_API_KEY</code> privately in your shell or secret manager, then launch a separate session using API billing.</p><pre><code>{CLAUDE_COMMAND}</code></pre><p>Claude Desktop can configure the CLI. Its own conversations do not use this capture route.</p></>} />}
      {client !== 'builtin' && <div className="wizard-note credential-capture-note" role="note"><LockKeyhole size={13} /><span>{externallyManagedService ? 'This separately managed service must already have capture on to run the optional test.' : 'Credentials stay in your tool. Private encrypted captures can retain credential-bearing request bytes; keep them secret.'}</span></div>}
    </div>
    <div className="wizard-actions client-step-actions">
      <button className="mac-button is-primary is-large" type="button" disabled={busy} onClick={client === 'builtin' ? onChat : onContinue}>{busy ? 'Preparing…' : client === 'builtin' ? 'Try a chat' : running ? 'Prepare optional test' : 'Start service and prepare test'}</button>
      <button className="mac-button is-large" type="button" disabled={busy} onClick={onSkip}>Continue without a test</button>
    </div>
  </>;
}

function TestTraceStep({ client, testPrompt, state, status, busy, onCheck, onContinue, onSkip }: {
  client: ClientId;
  testPrompt: string;
  state: DesktopState;
  status: TestStatus;
  busy: boolean;
  onCheck: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const captureTransportReady = state.sealing_service_readiness.phase === 'ready';
  const credentialCopy = `The credential stays in ${clientLabels[client]}.`;
  return <>
    <div className="wizard-step test-step">
      <h1>Capture one disposable trace</h1>
      <p>Send a tiny request through the route you just configured. If capture was off, Exalto Capture turns it on only for this disposable test, then restores your previous setting.</p>
      {!captureTransportReady && <div className="wizard-warning credential-service-warning" role="status">
        <Network size={13} />
        <span>The trusted capture transport is not ready. No Exalto Seal account is required. Wait for the trusted connection, then run this disposable test.</span>
      </div>}
      <div className="test-prompt-receipt">
        <span><CircleDot size={10} /> REC / SMALL TEST</span>
        <strong>{testPrompt}</strong>
        <small>Use a low-cost model available to your account. {credentialCopy} Once captured, setup can take this exact disposable Trace through sealing and local verification.</small>
      </div>
      {captureTransportReady && client !== 'builtin' ? <AgentSetup
      key={`${client}-${testPrompt}`}
      client={client}
      test
      disabled={busy || status === 'checking' || status === 'captured'}
      prompt={`Run one disposable Exalto Capture test in my local ${client === 'codex' ? 'Codex CLI' : 'Claude Code CLI'} environment. Setup should already be complete. ${client === 'codex' ? 'Run codex login status. Use the exalto-capture profile prepared for its existing ChatGPT or API-key authentication. Do not switch authentication methods. If the profile or required login is missing, stop and return to setup. Never read login caches or print tokens.' : 'Check only whether ANTHROPIC_API_KEY is nonempty; never read or print its value, login caches, or tokens. If missing, stop and ask me to provision it privately. Use API billing, never Claude subscription tokens.'} Do not change my global configuration, start/stop the service, change capture settings, or publish any Trace. Run this command once:\n\n${testCommand(client, testPrompt)}\n\nIf setup or the model is unavailable, report that and stop. Do not retry or fall back to a direct provider route. Return me to Exalto Capture to check for the matching Trace. A successful response alone does not confirm capture.`}
        manual={<pre><code>{testCommand(client, testPrompt)}</code></pre>}
      /> : <div className="connection-instructions test-command is-waiting">
        <div className="instruction-heading"><span>WAIT FOR TRUSTED TRANSPORT</span><strong>The disposable command will appear when capture is ready</strong></div>
        <p>Capture authenticates the provider exchange through a trusted live transport. This check is separate from an Exalto Seal account.</p>
      </div>}
      <div className={`test-result is-${status}`} role="status" aria-live="polite">
        <span>{status === 'captured' || status === 'unconfirmed' ? <Check size={14} /> : <StatusDot running={state.capture_enabled} warning={!state.capture_enabled} />}</span>
        <div>
          <strong>{status === 'captured' ? 'Test trace captured' : status === 'unconfirmed' ? 'Request succeeded, trace not auto-confirmed' : status === 'checking' ? 'Checking local traces' : status === 'not-found' ? 'No new trace yet' : state.capture_enabled ? 'Disposable capture is on' : state.running ? 'Disposable capture is off' : 'Local service is still starting'}</strong>
          <small>{status === 'captured'
            ? 'The matching response appeared in the local store, and your previous capture setting was restored. Continue to seal and verify it, or keep it private on this Mac.'
            : status === 'unconfirmed'
              ? 'The provider returned success, but automatic confirmation requires response previews. Your previous capture setting was restored. Continue, then open Traces to review the request.'
            : status === 'not-found'
              ? 'Run the test in your AI tool, wait for its response, then check again. Automatic confirmation requires response previews.'
              : 'Run the test above, then check for its matching response.'}</small>
        </div>
      </div>
    </div>
    <div className="wizard-actions split-actions">
      {status === 'captured' || status === 'unconfirmed' ? <button className="mac-button is-primary is-large" type="button" onClick={onContinue} disabled={busy}>{busy ? 'Finishing…' : 'Continue'}</button> : <button className="mac-button is-primary is-large" type="button" onClick={onCheck} disabled={!captureTransportReady || status === 'checking' || busy}>{status === 'checking' ? 'Checking…' : 'Check for new trace'}</button>}
      {status !== 'captured' && status !== 'unconfirmed' && <button className="mac-button is-large" type="button" onClick={onSkip} disabled={status === 'checking' || busy}>{busy ? 'Restoring setting…' : status === 'checking' ? 'Test in progress…' : 'Continue without a test'}</button>}
    </div>
  </>;
}

function AccountReadyStep({ state, client, disposableTraceId, busy, onFinish }: {
  state: DesktopState;
  client: ClientId;
  disposableTraceId: string | null;
  busy: boolean;
  onFinish: (destination: View, traceTarget?: TraceTarget) => Promise<void>;
}) {
  const clientLabel = clientLabels[client];
  const notaryLabel = state.sealing_service?.name ?? 'Sealing service';
  const sealingPhase = state.sealing_service_readiness.phase;
  const sealingReady = sealingPhase === 'ready';
  const sealingStatus = sealingReady
    ? 'Ready'
    : sealingPhase === 'starting'
      ? 'Starting'
      : sealingPhase === 'unreachable'
        ? 'Unreachable'
        : sealingPhase === 'trust_unavailable'
          ? 'Trust needs attention'
          : 'Off';
  return <>
    <div className="wizard-step account-step ready-step">
      <span className="ready-check"><Check size={16} /></span>
      <h1>Exalto Capture is ready</h1>
      <p>Local capture does not require an Exalto account. Connect one now for hosted credits, usage, and account-owned sharing, or continue without it.</p>
      <dl className="ready-summary">
        <div><span><StatusDot running={state.running} /></span><dt>Local service</dt><dd>{state.running ? `Running, capture ${state.capture_enabled ? 'on' : 'off'}` : 'Off'}</dd></div>
        <div><span><SquareTerminal size={13} /></span><dt>First AI tool</dt><dd>{clientLabel}</dd></div>
        <div><span><FileCheck2 size={13} /></span><dt>Sealing service</dt><dd>{notaryLabel} · {sealingStatus}</dd></div>
        <div><span><ShieldCheck size={13} /></span><dt>Local vault</dt><dd>{vaultProtection(state.vault_mode).label}</dd></div>
      </dl>
      {disposableTraceId && <div className={`first-proof-ready ${sealingReady ? '' : 'is-blocked'}`}>
        <span><BadgeCheck size={15} /></span>
        {sealingReady
          ? <div><strong>Your first local Trace is ready to seal</strong><small>Exalto Capture will open this exact test Trace, seal it with {notaryLabel}, and verify the portable proof locally. It will stay private unless you explicitly share it.</small></div>
          : <div><strong>Your first local Trace will stay private for now</strong><small>{notaryLabel} is {sealingPhase === 'unreachable' ? 'not reachable' : sealingPhase === 'trust_unavailable' ? 'missing trusted endpoint information' : 'still starting'}. Finish setup, then retry the Seal connection before creating a portable proof.</small></div>}
      </div>}
      <DesktopAccountCard compact />
    </div>
    <div className="wizard-actions split-actions final-actions">
      {disposableTraceId && sealingReady ? <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('traces', { traceId: disposableTraceId, action: 'first-proof' })} disabled={busy}>{busy ? 'Finishing setup…' : 'Seal and verify test Trace'}</button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>Keep it local for now</button>
      </> : disposableTraceId ? <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>{busy ? 'Finishing setup…' : 'Open Capture and retry Seal'}</button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('traces', { traceId: disposableTraceId })} disabled={busy}>Open test Trace</button>
      </> : <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>{busy ? 'Finishing setup…' : 'Open Capture'}</button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('traces')} disabled={busy}>Open Traces</button>
      </>}
    </div>
  </>;
}
