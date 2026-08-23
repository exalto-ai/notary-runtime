import { useState } from 'react';
import {
  BadgeCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  SlidersHorizontal,
  UnlockKeyhole,
  UserRound,
} from 'lucide-react';
import {
  completeOnboarding,
  configureVault,
  errorMessage,
  startDaemon,
  type DesktopState,
} from './bridge';
import { DesktopAccountCard } from './AccountCard';
import { RouteStop } from './HomeView';
import { StatusDot, vaultProtection, type View } from './product';
import notaryMark from './notary-mark.svg';

type OnboardingStep = 'welcome' | 'protection' | 'provider' | 'account' | 'ready';
type VaultSetupMode = 'keychain' | 'passphrase';

const providers = [
  {
    id: 'codex',
    name: 'Codex (ChatGPT plan)',
    operation: 'Responses',
    baseUrl: 'http://127.0.0.1:8787/codex',
    modelExample: 'Use your current Codex model',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    operation: 'Chat Completions',
    baseUrl: 'http://127.0.0.1:8787/openrouter/api/v1',
    modelExample: 'provider/model:free',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    operation: 'Responses',
    baseUrl: 'http://127.0.0.1:8787/openai/v1',
    modelExample: 'gpt-5.4-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic / Claude Code',
    operation: 'Messages',
    baseUrl: 'http://127.0.0.1:8787/anthropic',
    modelExample: 'Use your current Claude Code model',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    operation: 'Chat Completions',
    baseUrl: 'http://127.0.0.1:8787/deepseek',
    modelExample: 'deepseek-chat',
  },
] as const;

type Provider = (typeof providers)[number];
type ProviderId = Provider['id'];

const onboardingSteps: OnboardingStep[] = ['welcome', 'protection', 'provider', 'account', 'ready'];

export function Onboarding({ state, refresh, onFinish }: {
  state: DesktopState;
  refresh: () => Promise<void>;
  onFinish: (view: View) => void;
}) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [protectionMode, setProtectionMode] = useState<VaultSetupMode>('keychain');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('openrouter');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providers.find((item) => item.id === selectedProvider) ?? providers[0];
  const stepIndex = onboardingSteps.indexOf(step);

  const goBack = () => {
    setError(null);
    if (step === 'protection') {
      setProtectionMode('keychain');
      setPassphrase('');
      setPassphraseConfirmation('');
    }
    setStep(onboardingSteps[Math.max(0, stepIndex - 1)]);
  };

  const configureProtection = async () => {
    if (protectionMode === 'passphrase' && passphrase !== passphraseConfirmation) {
      setError('The passphrases do not match.');
      return;
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
      setStep('provider');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const startService = async () => {
    setBusy(true);
    setError(null);
    try {
      await startDaemon();
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      await refresh();
      setStep('account');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (destination: View) => {
    setBusy(true);
    setError(null);
    try {
      await completeOnboarding();
      await refresh();
      onFinish(destination);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className="onboarding-window">
    <header className="onboarding-toolbar" data-tauri-drag-region="deep">
      <div className="traffic-light-space" data-tauri-drag-region />
      <strong className="onboarding-window-title" data-tauri-drag-region>Notary</strong>
      <span className="onboarding-window-context">Setup</span>
    </header>
    <div className="onboarding-progress" aria-label={`Setup step ${stepIndex + 1} of ${onboardingSteps.length}`}>
      {onboardingSteps.map((item, index) => <span key={item} className={index <= stepIndex ? 'is-complete' : ''} />)}
    </div>
    <main className="onboarding-body">
      <section className="onboarding-content">
        {step !== 'welcome' && <button className="back-button" type="button" onClick={goBack} disabled={busy}>
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
        {step === 'provider' && <ProviderStep
          provider={provider}
          selectedProvider={selectedProvider}
          setSelectedProvider={setSelectedProvider}
          model={model}
          setModel={setModel}
          busy={busy}
          onContinue={() => void startService()}
        />}
        {step === 'account' && <AccountStep
          onContinue={() => setStep('ready')}
          onSkip={() => setStep('ready')}
        />}
        {step === 'ready' && <ReadyStep
          state={state}
          provider={provider}
          model={model}
          busy={busy}
          onFinish={finish}
        />}
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </section>
      <OnboardingAside step={step} state={state} provider={provider} />
    </main>
  </div>;
}
function WelcomeStep({ state, onContinue }: { state: DesktopState; onContinue: () => void }) {
  const fresh = !state.agent_configured && !state.vault_configured;
  return <div className="wizard-step welcome-step">
    <span className="wizard-kicker">Welcome to Notary</span>
    <h1>Your model response is readable only where it needs to be.</h1>
    <p>{fresh
      ? 'Notary witnesses an authenticated provider exchange without giving the remote notary your prompt, response, or credentials.'
      : 'This Mac already has some Notary settings. Setup will preserve them while keeping the same privacy boundary.'}</p>
    <SetupTrustDiagram />
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue}>Continue <ChevronRight size={15} /></button></div>
  </div>;
}

function SetupTrustDiagram() {
  return <figure
    className="setup-trust-diagram"
    role="img"
    aria-label="The model provider sends an encrypted response through the remote notary to Notary on this Mac. The remote notary sees encrypted protocol data, while plaintext is decrypted locally for you and private evidence can be notarized into a portable trace."
  >
    <div className="setup-trust-flow" aria-hidden="true">
      <section className="setup-trust-node setup-provider-node">
        <span>Model provider</span>
        <strong>Authenticated response</strong>
        <small>Serves the normal request</small>
      </section>
      <div className="setup-encrypted-track setup-encrypted-track--provider">
        <i><LockKeyhole /></i>
        <small>Encrypted</small>
      </div>
      <section className="setup-trust-node setup-notary-node">
        <span>Remote notary</span>
        <code>8F 3C<br />A2 19</code>
        <strong>Ciphertext witness</strong>
        <small>No prompt, response, or credentials</small>
      </section>
      <div className="setup-encrypted-track setup-encrypted-track--local">
        <i><LockKeyhole /></i>
        <small>Encrypted</small>
      </div>
      <section className="setup-local-boundary">
        <span className="setup-local-label">On this Mac</span>
        <div className="setup-local-client">
          <img src={notaryMark} alt="" />
          <div><strong>This app</strong><small><UnlockKeyhole /> Decrypts locally</small></div>
        </div>
        <div className="setup-local-branches">
          <span className="setup-local-path setup-local-path--user"><i /></span>
          <span className="setup-local-path setup-local-path--capture"><i /></span>
        </div>
        <div className="setup-local-outputs">
          <div><UserRound /><span><strong>You</strong><small>Readable response</small></span></div>
          <div><FileCheck2 /><span><strong>Notarized trace</strong><small>Only when you notarize</small></span></div>
        </div>
      </section>
    </div>
    <figcaption><LockKeyhole /> Traffic is encrypted in transit. The remote notary never sees plaintext; private captures stay on this Mac.</figcaption>
  </figure>;
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
    <span className="wizard-kicker">Private captures</span>
    <h1>Protect evidence on this Mac</h1>
    <p>A private capture can reconstruct the original provider request, including credentials. It is always encrypted before it is written.</p>
    {configured ? <div className="configured-protection"><BadgeCheck size={22} /><div><strong>Capture protection is already configured</strong><span>This assistant will keep the existing vault unchanged.</span></div></div> : <div className="protection-options" role="radiogroup" aria-label="Private capture protection">
      <button type="button" role="radio" aria-checked={mode === 'keychain'} className={mode === 'keychain' ? 'is-selected' : ''} onClick={chooseKeychain}>
        <span className="radio-mark">{mode === 'keychain' && <span />}</span><KeyRound size={20} />
        <div><strong>Use Keychain</strong><p>Recommended. macOS protects the vault key; there is no separate password to remember.</p></div>
      </button>
      {advancedOpen && <button type="button" role="radio" aria-checked={mode === 'passphrase'} className={mode === 'passphrase' ? 'is-selected' : ''} onClick={() => setMode('passphrase')}>
        <span className="radio-mark">{mode === 'passphrase' && <span />}</span><SlidersHorizontal size={20} />
        <div><strong>Use a passphrase</strong><p>Enter it whenever the desktop app opens. Notary does not save it.</p></div>
      </button>}
    </div>}
    {!configured && <button type="button" className="advanced-options-toggle" aria-expanded={advancedOpen} onClick={toggleAdvanced}><SlidersHorizontal size={13} /> Advanced options <ChevronDown size={13} /></button>}
    {!configured && advancedOpen && mode === 'passphrase' && <div className="passphrase-fields">
      <label><span>Passphrase</span><input type="password" autoComplete="new-password" value={passphrase} aria-invalid={!passphrasesMatch} aria-describedby={!passphrasesMatch ? mismatchId : undefined} onChange={(event) => setPassphrase(event.target.value)} /></label>
      <label><span>Confirm passphrase</span><input type="password" autoComplete="new-password" value={passphraseConfirmation} aria-invalid={!passphrasesMatch} aria-describedby={!passphrasesMatch ? mismatchId : undefined} onChange={(event) => setPassphraseConfirmation(event.target.value)} /></label>
      {!passphrasesMatch && <small id={mismatchId} className="passphrase-mismatch" role="alert">The passphrases do not match.</small>}
    </div>}
    {!configured && advancedOpen && mode === 'passphrase' && passphrasesMatch && passphrase.length === 0 && <div className="wizard-warning"><ShieldCheck size={16} /><span>An empty passphrase provides no device protection. Anyone with this account's app data can open private captures.</span></div>}
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue} disabled={busy || (mode === 'passphrase' && (!advancedOpen || !passphrasesMatch))}>{busy ? 'Saving…' : 'Continue'} <ChevronRight size={15} /></button></div>
  </div>;
}

function ProviderStep({ provider, selectedProvider, setSelectedProvider, model, setModel, busy, onContinue }: {
  provider: Provider;
  selectedProvider: ProviderId;
  setSelectedProvider: (id: ProviderId) => void;
  model: string;
  setModel: (value: string) => void;
  busy: boolean;
  onContinue: () => void;
}) {
  return <div className="wizard-step provider-step">
    <span className="wizard-kicker">Providers</span>
    <h1>Connect your first provider</h1>
    <p>Choose one to set up now. Every local route remains available, and the provider credential stays in your existing client.</p>
    <div className="provider-picker" role="radiogroup" aria-label="Provider to configure first">
      {providers.map((item) => <button key={item.id} type="button" role="radio" aria-checked={selectedProvider === item.id} className={selectedProvider === item.id ? 'is-selected' : ''} onClick={() => setSelectedProvider(item.id)}>
        <span>{item.name.slice(0, 1)}</span><strong>{item.name}</strong><small>{item.operation}</small>
      </button>)}
    </div>
    <div className="provider-setup-card">
      <label><span>Local base URL</span><code>{provider.baseUrl}</code></label>
      <label><span>Model to try first <em>optional</em></span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider.modelExample} /></label>
      <p>The model name is a setup reminder only. Your client chooses the model on every request.</p>
    </div>
    <div className="wizard-actions"><button className="mac-button is-primary is-large" onClick={onContinue} disabled={busy}>{busy ? 'Starting service…' : 'Start Notary'} <ChevronRight size={15} /></button></div>
  </div>;
}

function ReadyStep({ state, provider, model, busy, onFinish }: {
  state: DesktopState;
  provider: Provider;
  model: string;
  busy: boolean;
  onFinish: (destination: View) => Promise<void>;
}) {
  return <div className="wizard-step ready-step">
    <span className="ready-check"><Check size={26} /></span>
    <span className="wizard-kicker">Setup complete</span>
    <h1>Notary is ready</h1>
    <p>The local service is running. Configure {provider.name} in your model client, then its next request will appear inside this app.</p>
    <div className="ready-summary">
      <div><span><StatusDot running={state.running} /></span><strong>Capture service</strong><small>{state.running ? 'Running' : 'Starting'}</small></div>
      <div><span className="provider-monogram">{provider.name.slice(0, 1)}</span><strong>{provider.name}</strong><small>{model || 'Client chooses model'}</small></div>
      <div><span><ShieldCheck size={16} /></span><strong>Private vault</strong><small>{vaultProtection(state.vault_mode).label}</small></div>
    </div>
    <div className="ready-url"><span>Paste this base URL into your client</span><code>{provider.baseUrl}</code></div>
    <div className="wizard-actions split-actions">
      <button className="mac-button is-primary is-large" onClick={() => void onFinish('traces')} disabled={busy}>Open Traces <ChevronRight size={15} /></button>
      <button className="mac-button is-large" onClick={() => void onFinish('home')} disabled={busy}>Go to Home</button>
    </div>
  </div>;
}

function AccountStep({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  return <div className="wizard-step account-step">
    <span className="wizard-kicker">Optional account</span>
    <h1>Connect a Notary by Exalto account</h1>
    <p>Sign in to see hosted credits and usage, use account-owned sharing, and manage connected devices. This does not upload, publish, or share any local Trace.</p>
    <DesktopAccountCard onContinue={onContinue} onSkip={onSkip} />
  </div>;
}

function OnboardingAside({ step, state, provider }: {
  step: OnboardingStep;
  state: DesktopState;
  provider: Provider;
}) {
  const content = {
    welcome: {
      title: 'The notary sees ciphertext, not your conversation',
      copy: 'It participates in the provider connection so the exchange can be authenticated without receiving the application plaintext.',
    },
    protection: {
      title: 'Private before public',
      copy: 'Captured trace evidence stays on this Mac. Notarizing creates its portable .llmtrace package; it does not publish or share the trace.',
    },
    provider: {
      title: `Connect ${provider.name}`,
      copy: 'Only the base URL changes. The API key or subscription login remains in the model client that already holds it.',
    },
    account: {
      title: 'Account connection is optional',
      copy: 'Hosted credits, usage, and account-owned sharing are available when you sign in. Local capture, notarization, and verification work without an account.',
    },
    ready: {
      title: 'One app, end to end',
      copy: 'Review Captured traces, notarize a portable package, and share a Notarized trace only through a later explicit action.',
    },
  }[step];
  return <aside className="onboarding-aside">
    <span className="aside-label">How it works</span>
    <h2>{content.title}</h2>
    <p>{content.copy}</p>
    {step === 'welcome' ? <dl className="aside-trust-facts">
      <div><dt>Remote notary</dt><dd>Provider hostname, encrypted traffic, sizes, timing, and protocol metadata—never plaintext</dd></div>
      <div><dt>This Mac</dt><dd>Provider credentials, prompts, responses, and private captures</dd></div>
      <div><dt>Shared later</dt><dd>Only the evidence you explicitly notarize and choose to share</dd></div>
    </dl> : <div className="aside-route">
      <RouteStop title="Model client" detail="Keeps the credential" active={step === 'ready' || state.running} />
      <RouteStop title="Notary" detail="Captures locally" active={step === 'ready' || state.running} />
      <RouteStop title="Remote notary" detail="Sees encrypted protocol" active={step === 'ready' || state.running} />
      <RouteStop title="Provider" detail="Returns the model response" active={step === 'ready' || state.running} />
    </div>}
    <div className="aside-privacy"><ShieldCheck size={17} /><span>Prompts, responses, and provider credentials are not sent to the remote notary.</span></div>
  </aside>;
}
