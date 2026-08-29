import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  SlidersHorizontal,
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
  openProductLink,
  runProviderCaptureTest,
  startDaemon,
  type DesktopState,
} from './bridge';
import { DesktopAccountCard } from './AccountCard';
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
type ClientId = 'codex' | 'claude' | 'api';
type ApiProviderId = 'openai' | 'anthropic' | 'openrouter';
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

const clientChoices = [
  {
    id: 'codex',
    name: 'Codex CLI',
    detail: 'Use the ChatGPT sign-in already saved by Codex',
    status: 'Live-tested',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'Use the claude.ai sign-in already saved by Claude Code',
    status: 'Live-tested',
  },
  {
    id: 'api',
    name: 'API or SDK',
    detail: 'Keep your existing environment or try a temporary onboarding key',
    status: 'No key storage',
  },
] as const;

const apiProviders = [
  {
    id: 'openai',
    name: 'OpenAI',
    environmentVariable: 'OPENAI_API_KEY',
    baseUrl: 'http://127.0.0.1:8787/openai/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyDestination: 'openai_key',
    keyLabel: 'Create an OpenAI API key',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    environmentVariable: 'ANTHROPIC_API_KEY',
    baseUrl: 'http://127.0.0.1:8787/anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyDestination: 'anthropic_key',
    keyLabel: 'Create an Anthropic API key',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    environmentVariable: 'OPENROUTER_API_KEY',
    baseUrl: 'http://127.0.0.1:8787/openrouter/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyDestination: 'openrouter_key',
    keyLabel: 'Create an OpenRouter API key',
  },
] as const;

type ApiProvider = (typeof apiProviders)[number];

const CODEX_CONFIG = `model_provider = "capture-chatgpt"

[model_providers.capture-chatgpt]
name = "Exalto Capture, ChatGPT plan"
base_url = "http://127.0.0.1:8787/codex"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false`;

const CLAUDE_COMMAND = `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \\
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic \\
  claude`;

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

function expectedTestProvider(client: ClientId, provider: ApiProvider) {
  if (client === 'codex') return 'openai';
  if (client === 'claude') return 'anthropic';
  return provider.id;
}

function testCommand(client: ClientId, provider: ApiProvider, prompt: string) {
  if (client === 'codex') {
    return `codex exec --ephemeral --skip-git-repo-check \\
  '${prompt}'`;
  }
  if (client === 'claude') {
    return `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \\
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic \\
  claude -p '${prompt}'`;
  }
  if (provider.id === 'anthropic') {
    return `curl http://127.0.0.1:8787/anthropic/v1/messages \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -H 'anthropic-version: 2023-06-01' \\
  -H 'content-type: application/json' \\
  -d '{"model":"YOUR_MODEL","max_tokens":64,"messages":[{"role":"user","content":"${prompt}"}]}'`;
  }
  if (provider.id === 'openrouter') {
    return `curl http://127.0.0.1:8787/openrouter/api/v1/chat/completions \\
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"${prompt}"}]}'`;
  }
  return `curl http://127.0.0.1:8787/openai/v1/responses \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"model":"YOUR_MODEL","input":"${prompt}"}'`;
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
  const [client, setClient] = useState<ClientId>('codex');
  const [apiProviderId, setApiProviderId] = useState<ApiProviderId>('openai');
  const [onboardingApiKey, setOnboardingApiKey] = useState('');
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
  const apiProvider = apiProviders.find((item) => item.id === apiProviderId) ?? apiProviders[0];
  const testPrompt = `Reply with exactly: ${testMarker}`;
  const useOnboardingApiTest = client === 'api' && Boolean(onboardingApiKey.trim());
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
    if (nextClient !== 'api') setOnboardingApiKey('');
    setClient(nextClient);
  };

  const chooseApiProvider = (provider: ApiProviderId) => {
    setError(null);
    setOnboardingApiKey('');
    setApiProviderId(provider);
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
      setOnboardingApiKey('');
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
      const expectedProvider = expectedTestProvider(client, apiProvider);
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

  const runOnboardingApiTest = async (model: string) => {
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
    if (testBaseline === null) {
      setError('Prepare the disposable capture test again.');
      return;
    }
    if (!onboardingApiKey.trim()) {
      setError(`Paste a temporary ${apiProvider.name} API key before running the in-app test.`);
      return;
    }
    preparationCancelled.current = false;
    const operation = testOperation.current + 1;
    testOperation.current = operation;
    const generation = windowGeneration.current;
    setTestStatus('checking');
    setError(null);
    try {
      const result = await runProviderCaptureTest(
        apiProvider.id,
        model,
        testMarker,
        onboardingApiKey,
        [...testBaseline],
        leaseId,
      );
      if (
        !testWorkIsCurrent(operation, generation) ||
        temporaryCaptureLease.current !== leaseId
      ) return;
      if (!result.successful) {
        setError(`${apiProvider.name} returned HTTP ${result.http_status}. Check that the key and model are available to this account.`);
        setTestStatus('not-found');
        return;
      }
      if (!result.captured || !result.trace_id) {
        await restoreTestCapture(leaseId);
        if (!testWorkIsCurrent(operation, generation)) return;
        setDisposableTraceId(null);
        setTestStatus('unconfirmed');
        return;
      }
      await restoreTestCapture(leaseId);
      if (!testWorkIsCurrent(operation, generation)) return;
      setDisposableTraceId(result.trace_id);
      setTestStatus('captured');
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
    setOnboardingApiKey('');
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
    setOnboardingApiKey('');
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

  return <div className="onboarding-window exalto-onboarding">
    <header className="onboarding-toolbar" data-tauri-drag-region="deep">
      <div className="traffic-light-space" data-tauri-drag-region />
      <div className="onboarding-brand" data-tauri-drag-region="deep">
        <img src={notaryMark} alt="" />
        <strong data-tauri-drag-region>Exalto Capture</strong>
      </div>
      <span className="onboarding-window-context">Setup {String(stepIndex + 1).padStart(2, '0')} / 06</span>
      {onCancel && <button className="onboarding-close" type="button" onClick={() => void cancelSetup()} disabled={navigationBusy}>Done</button>}
    </header>
    <div className="onboarding-progress" aria-label={`Setup step ${stepIndex + 1} of ${onboardingSteps.length}`}>
      {onboardingSteps.map((item, index) => <span key={item} className={index <= stepIndex ? 'is-complete' : ''} />)}
    </div>
    <main className="onboarding-body">
      <section className="onboarding-content">
        {step !== 'welcome' && <button className="back-button" type="button" onClick={() => void goBack()} disabled={navigationBusy}>
          <ChevronLeft size={14} /> Back
        </button>}
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
          apiProvider={apiProvider}
          setApiProvider={chooseApiProvider}
          onboardingApiKey={onboardingApiKey}
          setOnboardingApiKey={setOnboardingApiKey}
          busy={busy}
          running={state.running}
          externallyManagedService={state.running && !state.managed_by_desktop}
          onContinue={() => void startService()}
        />}
        {step === 'test' && <TestTraceStep
          client={client}
          apiProvider={apiProvider}
          useOnboardingApiTest={useOnboardingApiTest}
          testPrompt={testPrompt}
          state={state}
          status={testStatus}
          busy={busy}
          onCheck={() => void checkForTestTrace()}
          onRunOnboardingApiTest={(model) => void runOnboardingApiTest(model)}
          onContinue={() => void leaveTest()}
          onSkip={() => void leaveTest()}
        />}
        {step === 'account' && <AccountReadyStep
          state={state}
          client={client}
          apiProvider={apiProvider}
          disposableTraceId={disposableTraceId}
          busy={busy}
          onFinish={finish}
        />}
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </section>
      <OnboardingAside
        step={step}
        sealingService={sealingService}
        client={client}
        apiProvider={apiProvider}
        useOnboardingApiTest={useOnboardingApiTest}
        testStatus={testStatus}
      />
    </main>
  </div>;
}

function WelcomeStep({ state, onContinue }: { state: DesktopState; onContinue: () => void }) {
  const fresh = !state.agent_configured && !state.vault_configured;
  return <div className="wizard-step welcome-step">
    <span className="wizard-kicker">Local trace capture</span>
    <h1>Set up Exalto Capture</h1>
    <p>{fresh
      ? 'Capture a model exchange on this Mac, review what a sealed trace can reveal, then send it to Exalto Seal or another compatible notary for sealing.'
      : 'This Mac already has capture settings. Setup will preserve them while it checks the path from your AI tool to a portable trace.'}</p>
    <div className="capture-workflow" aria-label="Capture, review, seal, then verify or share">
      {['Capture', 'Review', 'Seal', 'Verify or share'].map((label, index) => <div key={label}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{label}</strong>
      </div>)}
    </div>
    <figure className="trace-receipt" aria-label="A sample local trace receipt">
      <figcaption><span><CircleDot size={11} /> REC</span><code>TRACE / LOCAL</code></figcaption>
      <dl>
        <div><dt>AI tool</dt><dd>Codex CLI</dd></div>
        <div><dt>Provider</dt><dd>Authenticated response</dd></div>
        <div><dt>Private content</dt><dd>Hidden from the sealing service</dd></div>
        <div><dt>Portable result</dt><dd>.llmtrace</dd></div>
      </dl>
      <p>A trace proves the interaction it contains. It does not prove that omitted interactions never happened.</p>
    </figure>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue}>Begin setup <ChevronRight size={15} /></button></div>
  </div>;
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
  return <div className="wizard-step">
    <span className="wizard-kicker">Local protection</span>
    <h1>Protect private traces on this Mac</h1>
    <p>A full private capture can reconstruct the original provider request, including credentials. Exalto Capture vault-encrypts that artifact before writing it to disk.</p>
    <div className="wizard-warning preview-storage-warning" role="note"><LockKeyhole size={16} /><span>When retained previews are enabled, short prompt and response excerpts are also kept in local metadata so Traces can be browsed. Those excerpts stay on this Mac but are not protected by the trace vault.</span></div>
    {configured ? <div className="configured-protection"><BadgeCheck size={22} /><div><strong>Local protection is already configured</strong><span>Your existing vault will remain unchanged.</span></div></div> : <div className="protection-options" role="radiogroup" aria-label="Private trace protection">
      <button type="button" role="radio" aria-checked={mode === 'keychain'} className={mode === 'keychain' ? 'is-selected' : ''} onClick={chooseKeychain}>
        <span className="radio-mark">{mode === 'keychain' && <span />}</span><KeyRound size={20} />
        <div><strong>Use macOS Keychain</strong><p>Recommended. macOS protects the vault key, with no separate password to remember.</p></div>
      </button>
      {advancedOpen && <button type="button" role="radio" aria-checked={mode === 'passphrase'} className={mode === 'passphrase' ? 'is-selected' : ''} onClick={() => setMode('passphrase')}>
        <span className="radio-mark">{mode === 'passphrase' && <span />}</span><SlidersHorizontal size={20} />
        <div><strong>Use a passphrase</strong><p>Enter it whenever the app opens. Exalto Capture does not save it.</p></div>
      </button>}
    </div>}
    {!configured && <button type="button" className="advanced-options-toggle" aria-expanded={advancedOpen} onClick={toggleAdvanced}><SlidersHorizontal size={13} /> Advanced protection <ChevronDown size={13} /></button>}
    {!configured && advancedOpen && mode === 'passphrase' && <div className="passphrase-fields">
      <label><span>Passphrase</span><input type="password" autoComplete="new-password" value={passphrase} aria-invalid={!passphraseValid} aria-describedby={!passphraseValid ? mismatchId : undefined} onChange={(event) => setPassphrase(event.target.value)} /></label>
      <label><span>Confirm passphrase</span><input type="password" autoComplete="new-password" value={passphraseConfirmation} aria-invalid={!passphraseValid} aria-describedby={!passphraseValid ? mismatchId : undefined} onChange={(event) => setPassphraseConfirmation(event.target.value)} /></label>
      {!passphrasePresent
        ? <small id={mismatchId} className="passphrase-mismatch" role="alert">Enter a non-empty passphrase.</small>
        : !passphrasesMatch && <small id={mismatchId} className="passphrase-mismatch" role="alert">The passphrases do not match.</small>}
    </div>}
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue} disabled={busy || (mode === 'passphrase' && (!advancedOpen || !passphraseValid))}>{busy ? 'Saving…' : 'Protect traces'} <ChevronRight size={15} /></button></div>
  </div>;
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
  return <div className="wizard-step notary-step">
    <span className="wizard-kicker">Choose a sealing service</span>
    <h1>{heading}</h1>
    <p>{introduction}</p>
    <div className="notary-choice is-selected">
      <span className="notary-choice-mark"><Check size={15} /></span>
      <div><strong>{service.name}</strong><p>{detail}</p></div>
      <span className="choice-status">{service.isExaltoSeal && !service.configured ? 'Recommended' : service.available ? 'Configured' : 'Unavailable'}</span>
    </div>
    <button type="button" className="advanced-options-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}><Network size={13} /> About compatible notaries <ChevronDown size={13} /></button>
    {advancedOpen && <div className="advanced-notaries">
      <div><Server size={17} /><span><strong>Compatible notary</strong><small>Selected through signed Registry trust</small></span><em>Administrator managed</em></div>
      <div><SquareTerminal size={17} /><span><strong>Self-hosted notary</strong><small>Operator endpoint and verification key required</small></span><em>Administrator managed</em></div>
      <p>This build preserves the pinned notary selected by its runtime configuration. Switching or adding a compatible notary requires an administrator-managed configuration.</p>
    </div>}
    <div className="notary-boundary">
      <div><span>SEALING SERVICE SEES</span><strong>Provider hostname, encrypted traffic, sizes, timing</strong></div>
      <div><span>APPLICATION PLAINTEXT</span><strong>Visible to this Mac and your chosen model provider</strong></div>
    </div>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" type="button" onClick={onContinue}>{continueLabel} <ChevronRight size={15} /></button></div>
  </div>;
}

function ClientStep({
  client,
  setClient,
  apiProvider,
  setApiProvider,
  onboardingApiKey,
  setOnboardingApiKey,
  busy,
  running,
  externallyManagedService,
  onContinue,
}: {
  client: ClientId;
  setClient: (client: ClientId) => void;
  apiProvider: ApiProvider;
  setApiProvider: (provider: ApiProviderId) => void;
  onboardingApiKey: string;
  setOnboardingApiKey: (apiKey: string) => void;
  busy: boolean;
  running: boolean;
  externallyManagedService: boolean;
  onContinue: () => void;
}) {
  return <div className="wizard-step client-step">
    <span className="wizard-kicker">Connect an AI tool</span>
    <h1>Which local tool will you use first?</h1>
    <p>Codex CLI and Claude Code keep their saved sign-ins. API clients keep their provider keys in the client or secret manager.</p>
    <div className="client-picker" role="radiogroup" aria-label="AI tool to connect first">
      {clientChoices.map((item) => <button key={item.id} type="button" role="radio" aria-checked={client === item.id} className={client === item.id ? 'is-selected' : ''} onClick={() => setClient(item.id)}>
        <span className="radio-mark">{client === item.id && <span />}</span>
        <div><strong>{item.name}</strong><p>{item.detail}</p></div>
        <small>{item.status}</small>
      </button>)}
    </div>
    {client === 'codex' && <div className="connection-instructions">
      <div className="instruction-heading"><span>CODEX CLI / SAVED CHATGPT SIGN-IN</span><strong>1. Confirm login, then add the local provider</strong></div>
      <pre><code>codex login status</code></pre>
      <p>The result must say <code>Logged in using ChatGPT</code>. Then add this to <code>~/.codex/config.toml</code> and keep your current model setting.</p>
      <pre><code>{CODEX_CONFIG}</code></pre>
      <p>Do not add <code>env_key</code>. Codex keeps and attaches its saved ChatGPT authorization.</p>
    </div>}
    {client === 'claude' && <div className="connection-instructions">
      <div className="instruction-heading"><span>CLAUDE CODE / SAVED CLAUDE.AI SIGN-IN</span><strong>1. Confirm login, then launch through the local route</strong></div>
      <pre><code>claude auth status</code></pre>
      <p>It must report <code>loggedIn: true</code>. A Claude Desktop login is separate and does not establish this CLI session.</p>
      <pre><code>{CLAUDE_COMMAND}</code></pre>
      <p>Remove any <code>apiKeyHelper</code> while using subscription authentication. Native Claude Desktop cannot use this route.</p>
    </div>}
    {client === 'api' && <ApiConnection
      apiProvider={apiProvider}
      setApiProvider={setApiProvider}
      onboardingApiKey={onboardingApiKey}
      setOnboardingApiKey={setOnboardingApiKey}
      busy={busy}
    />}
    <div className="wizard-warning credential-capture-warning" role="note">
      <LockKeyhole size={16} />
      <span>{externallyManagedService
        ? 'This compatible service was started outside Exalto Capture. Setup will reuse it without taking ownership or changing its capture setting. The disposable test requires capture to already be on.'
        : <>An encrypted private <code>.llmcapture</code> can reconstruct the authenticated provider request, including credential-bearing header bytes. Treat private captures as secrets and never share them.</>}</span>
    </div>
    <div className="wizard-actions"><button
      className="mac-button is-primary is-large"
      type="button"
      onClick={onContinue}
      disabled={busy}
    >{busy ? 'Preparing test…' : running ? 'Prepare disposable test' : 'Start service and prepare test'} <ChevronRight size={15} /></button></div>
  </div>;
}

function ApiConnection({
  apiProvider,
  setApiProvider,
  onboardingApiKey,
  setOnboardingApiKey,
  busy,
}: {
  apiProvider: ApiProvider;
  setApiProvider: (provider: ApiProviderId) => void;
  onboardingApiKey: string;
  setOnboardingApiKey: (apiKey: string) => void;
  busy: boolean;
}) {
  return <div className="api-connection">
    <div className="api-provider-picker" role="radiogroup" aria-label="API provider">
      {apiProviders.map((provider) => <button key={provider.id} type="button" role="radio" aria-checked={apiProvider.id === provider.id} className={apiProvider.id === provider.id ? 'is-selected' : ''} onClick={() => setApiProvider(provider.id)} disabled={busy}>{provider.name}</button>)}
      <button type="button" className="is-unsupported" disabled><span>xAI / Grok</span><small>Not yet supported</small></button>
    </div>
    <div className="unsupported-provider-guide">
      <span><strong>Planning to use Grok?</strong><small>Create an xAI API key now. The xAI and Grok capture route is not available in this build.</small></span>
      <a href="https://docs.x.ai/developers/quickstart" target="_blank" rel="noreferrer" onClick={(event) => {
        event.preventDefault();
        void openProductLink('xai_key');
      }}>Open the xAI key guide <ExternalLink size={12} /></a>
    </div>
    <div className="connection-instructions api-key-instructions">
      <div className="instruction-heading"><span>{apiProvider.name.toUpperCase()} / CLIENT-MANAGED KEY</span><strong>Keep the key in your current environment</strong></div>
      <dl>
        <div><dt>Environment variable</dt><dd><code>{apiProvider.environmentVariable}</code></dd></div>
        <div><dt>Local base URL</dt><dd><code>{apiProvider.baseUrl}</code></dd></div>
      </dl>
      <div className="credential-import">
        <label htmlFor={`provider-key-${apiProvider.id}`}>Optional temporary key for the onboarding test</label>
        <div>
          <input
            id={`provider-key-${apiProvider.id}`}
            value={onboardingApiKey}
            onChange={(event) => setOnboardingApiKey(event.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste key"
            disabled={busy}
          />
          {onboardingApiKey && <button className="mac-button" type="button" onClick={() => setOnboardingApiKey('')} disabled={busy}>Clear</button>}
        </div>
      </div>
      <a href={apiProvider.keyUrl} target="_blank" rel="noreferrer" onClick={(event) => {
        event.preventDefault();
        void openProductLink(apiProvider.keyDestination);
      }}>{apiProvider.keyLabel} <ExternalLink size={12} /></a>
      <p>Your SDK, CLI, shell, or secret manager remains the credential owner. If you paste a key here, setup keeps it only in this in-memory onboarding session, uses it for one normal provider request through the local route, and never saves it to Keychain, disk, or daemon configuration.</p>
    </div>
  </div>;
}

function TestTraceStep({ client, apiProvider, useOnboardingApiTest, testPrompt, state, status, busy, onCheck, onRunOnboardingApiTest, onContinue, onSkip }: {
  client: ClientId;
  apiProvider: ApiProvider;
  useOnboardingApiTest: boolean;
  testPrompt: string;
  state: DesktopState;
  status: TestStatus;
  busy: boolean;
  onCheck: () => void;
  onRunOnboardingApiTest: (model: string) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [onboardingModel, setOnboardingModel] = useState('');
  const captureTransportReady = state.sealing_service_readiness.phase === 'ready';
  const credentialCopy = useOnboardingApiTest
    ? `The temporary ${apiProvider.name} key remains only in setup memory and is not saved.`
    : `The credential remains in ${client === 'api' ? `${apiProvider.name} tooling` : client === 'codex' ? 'Codex CLI' : 'Claude Code'}.`;
  return <div className="wizard-step test-step">
    <span className="wizard-kicker">Test local capture</span>
    <h1>Capture one disposable trace</h1>
    <p>Send a tiny request through the route you just configured. If capture was off, Exalto Capture turns it on only for this disposable test, then restores your previous setting.</p>
    {!captureTransportReady && <div className="wizard-warning credential-service-warning" role="status">
      <Network size={16} />
      <span>The trusted capture transport is not ready. No Exalto Seal account is required. Wait for the trusted connection, then run this disposable test.</span>
    </div>}
    <div className="test-prompt-receipt">
      <span><CircleDot size={11} /> REC / SMALL TEST</span>
      <strong>{testPrompt}</strong>
      <small>Use a low-cost model available to your account. {credentialCopy} Once captured, setup can take this exact disposable Trace through sealing and local verification.</small>
    </div>
    {useOnboardingApiTest ? <form className="connection-instructions managed-test-runner" onSubmit={(event) => {
      event.preventDefault();
      if (!captureTransportReady) return;
      onRunOnboardingApiTest(onboardingModel);
    }}>
      <div className="instruction-heading"><span>TEMPORARY IN-APP TEST</span><strong>No credential is copied into a terminal command</strong></div>
      <label htmlFor="managed-test-model"><span>{apiProvider.name} model ID</span><input
        id="managed-test-model"
        value={onboardingModel}
        onChange={(event) => setOnboardingModel(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="A low-cost model available to your account"
        disabled={status === 'checking' || busy}
      /></label>
      <button className="mac-button is-primary" type="submit" disabled={!captureTransportReady || !onboardingModel.trim() || status === 'checking' || busy}>{status === 'checking' ? 'Running test…' : 'Run in-app test'}</button>
      <p>Setup sends the real key in the provider's normal authentication header through the local proxy. It is not written to Keychain, disk, app settings, or daemon configuration.</p>
    </form> : captureTransportReady ? <div className="connection-instructions test-command">
      <div className="instruction-heading"><span>RUN IN TERMINAL</span><strong>{client === 'api' ? `Replace YOUR_MODEL with an available ${apiProvider.name} model` : 'Run one ephemeral request'}</strong></div>
      <pre><code>{testCommand(client, apiProvider, testPrompt)}</code></pre>
    </div> : <div className="connection-instructions test-command is-waiting">
      <div className="instruction-heading"><span>WAIT FOR TRUSTED TRANSPORT</span><strong>The disposable command will appear when capture is ready</strong></div>
      <p>Capture authenticates the provider exchange through a trusted live transport. This check is separate from an Exalto Seal account.</p>
    </div>}
    <div className={`test-result is-${status}`} role="status" aria-live="polite">
      <span>{status === 'captured' || status === 'unconfirmed' ? <Check size={16} /> : <StatusDot running={state.capture_enabled} warning={!state.capture_enabled} />}</span>
      <div>
        <strong>{status === 'captured' ? 'Test trace captured' : status === 'unconfirmed' ? 'Request succeeded, trace not auto-confirmed' : status === 'checking' ? useOnboardingApiTest ? 'Running provider test' : 'Checking local traces' : status === 'not-found' ? 'No new trace yet' : state.capture_enabled ? 'Disposable capture is on' : state.running ? 'Disposable capture is off' : 'Local service is still starting'}</strong>
        <small>{status === 'captured'
          ? 'The matching response appeared in the local store, and your previous capture setting was restored. Continue to seal and verify it, or keep it private on this Mac.'
          : status === 'unconfirmed'
            ? 'The provider returned success, but automatic confirmation requires response previews. Your previous capture setting was restored. Continue, then open Traces to review the request.'
          : status === 'not-found'
            ? useOnboardingApiTest ? 'Check the temporary key and model, then run the in-app test again.' : 'Run the command, wait for its response, then check again. Automatic confirmation requires response previews.'
            : useOnboardingApiTest ? 'Enter a model ID and run the in-app test above.' : 'Run the command above, then check for its matching response.'}</small>
      </div>
    </div>
    <div className="wizard-actions split-actions">
      {status === 'captured' || status === 'unconfirmed' ? <button className="mac-button is-primary is-large" type="button" onClick={onContinue} disabled={busy}>{busy ? 'Finishing…' : 'Continue'} <ChevronRight size={15} /></button> : !useOnboardingApiTest && <button className="mac-button is-primary is-large" type="button" onClick={onCheck} disabled={!captureTransportReady || status === 'checking' || busy}>{status === 'checking' ? 'Checking…' : 'Check for new trace'}</button>}
      {status !== 'captured' && status !== 'unconfirmed' && <button className="mac-button is-large" type="button" onClick={onSkip} disabled={status === 'checking' || busy}>{busy ? 'Restoring setting…' : status === 'checking' ? 'Test in progress…' : 'Continue without a test'}</button>}
    </div>
  </div>;
}

function AccountReadyStep({ state, client, apiProvider, disposableTraceId, busy, onFinish }: {
  state: DesktopState;
  client: ClientId;
  apiProvider: ApiProvider;
  disposableTraceId: string | null;
  busy: boolean;
  onFinish: (destination: View, traceTarget?: TraceTarget) => Promise<void>;
}) {
  const clientLabel = client === 'codex' ? 'Codex CLI' : client === 'claude' ? 'Claude Code' : `${apiProvider.name} API or SDK`;
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
  return <div className="wizard-step account-step ready-step">
    <span className="ready-check"><Check size={23} /></span>
    <span className="wizard-kicker">Ready</span>
    <h1>Exalto Capture is ready</h1>
    <p>Local capture does not require an Exalto account. Connect one now for hosted credits, usage, and account-owned sharing, or continue without it.</p>
    <div className="ready-summary">
      <div><span><StatusDot running={state.running} /></span><strong>Local service</strong><small>{state.running ? `Running, capture ${state.capture_enabled ? 'on' : 'off'}` : 'Starting'}</small></div>
      <div><span><SquareTerminal size={15} /></span><strong>First AI tool</strong><small>{clientLabel}</small></div>
      <div><span><FileCheck2 size={15} /></span><strong>Sealing service</strong><small>{notaryLabel} · {sealingStatus}</small></div>
      <div><span><ShieldCheck size={15} /></span><strong>Local vault</strong><small>{vaultProtection(state.vault_mode).label}</small></div>
    </div>
    <DesktopAccountCard compact />
    {disposableTraceId && <div className={`first-proof-ready ${sealingReady ? '' : 'is-blocked'}`}>
      <span><BadgeCheck size={17} /></span>
      {sealingReady
        ? <div><strong>Your first local Trace is ready to seal</strong><small>Exalto Capture will open this exact test Trace, seal it with {notaryLabel}, and verify the portable proof locally. It will stay private unless you explicitly share it.</small></div>
        : <div><strong>Your first local Trace will stay private for now</strong><small>{notaryLabel} is {sealingPhase === 'unreachable' ? 'not reachable' : sealingPhase === 'trust_unavailable' ? 'missing trusted endpoint information' : 'still starting'}. Finish setup, then retry the Seal connection before creating a portable proof.</small></div>}
    </div>}
    <div className="wizard-actions split-actions final-actions">
      {disposableTraceId && sealingReady ? <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('traces', { traceId: disposableTraceId, action: 'first-proof' })} disabled={busy}>{busy ? 'Finishing setup…' : 'Seal and verify test Trace'} <ChevronRight size={15} /></button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>Keep it local for now</button>
      </> : disposableTraceId ? <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>{busy ? 'Finishing setup…' : 'Open Capture and retry Seal'} <ChevronRight size={15} /></button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('traces', { traceId: disposableTraceId })} disabled={busy}>Open test Trace</button>
      </> : <>
        <button className="mac-button is-primary is-large" type="button" onClick={() => void onFinish('home')} disabled={busy}>{busy ? 'Finishing setup…' : 'Open Capture'} <ChevronRight size={15} /></button>
        <button className="mac-button is-large" type="button" onClick={() => void onFinish('traces')} disabled={busy}>Open Traces</button>
      </>}
    </div>
  </div>;
}

function OnboardingAside({ step, sealingService, client, apiProvider, useOnboardingApiTest, testStatus }: {
  step: OnboardingStep;
  sealingService: OnboardingSealingService;
  client: ClientId;
  apiProvider: ApiProvider;
  useOnboardingApiTest: boolean;
  testStatus: TestStatus;
}) {
  const clientLabel = client === 'codex' ? 'Codex CLI' : client === 'claude' ? 'Claude Code' : `${apiProvider.name} SDK`;
  const content = {
    welcome: {
      label: 'TRACE WORKFLOW',
      title: 'Local first, portable when you choose',
      copy: 'Capture keeps a private record on this Mac. Sealing creates a portable .llmtrace. Sharing is always a later explicit action.',
    },
    protection: {
      label: 'LOCAL BOUNDARY',
      title: 'Full captures are encrypted, previews are separate',
      copy: 'The reconstructable capture is vault-encrypted. If retained previews are enabled, bounded excerpts stay in local metadata outside that vault.',
    },
    notary: {
      label: 'SEALING BOUNDARY',
      title: 'The witness sees ciphertext, not the conversation',
      copy: `${sealingService.name} participates in the provider connection. It receives encrypted protocol data and the upstream hostname, never application plaintext.`,
    },
    client: {
      label: 'CLIENT FIRST',
      title: useOnboardingApiTest
        ? `Try ${apiProvider.name} without saving its key`
        : `${clientLabel} remains the credential owner`,
      copy: useOnboardingApiTest
        ? 'The pasted key exists only in this setup session and is used for one ordinary request through the local proxy.'
        : 'Only its provider base URL changes. The login, API key, model selection, and request continue to be managed by the tool.',
    },
    test: {
      label: 'DISPOSABLE TRACE',
      title: testStatus === 'captured'
        ? 'The local route is working'
        : testStatus === 'unconfirmed'
          ? 'The provider request succeeded'
          : 'Prove the path with a tiny request',
      copy: testStatus === 'unconfirmed'
        ? 'Open Traces after setup to review the request. Automatic matching was unavailable because response previews are off.'
        : 'The test is deliberately small. Keep it private, inspect it later, or delete it when you no longer need it.',
    },
    account: {
      label: 'OPTIONAL ACCOUNT',
      title: 'Capture now, connect hosted services when useful',
      copy: 'An account enables hosted credits, usage, and account-owned sharing. It does not upload or publish local traces automatically.',
    },
  }[step];
  return <aside className="onboarding-aside">
    <span className="aside-label">{content.label}</span>
    <h2>{content.title}</h2>
    <p>{content.copy}</p>
    <div className="aside-flow" aria-label="Local capture path">
      <div className={step === 'client' ? 'is-active' : ''}><span>01</span><strong>{clientLabel}</strong><small>{useOnboardingApiTest ? 'Temporary test key in memory' : 'Login and key managed here'}</small></div>
      <div className={step === 'protection' || step === 'test' ? 'is-active is-local' : 'is-local'}><span>02</span><strong>Exalto Capture</strong><small>Loopback and private vault</small></div>
      <div className={step === 'notary' ? 'is-active' : ''}><span>03</span><strong>{sealingService.name}</strong><small>Encrypted witness</small></div>
      <div><span>04</span><strong>Model provider</strong><small>Authenticated response</small></div>
    </div>
    <div className="aside-privacy"><LockKeyhole size={17} /><span>Prompts, responses, and provider credentials are not sent to the sealing service.</span></div>
  </aside>;
}
