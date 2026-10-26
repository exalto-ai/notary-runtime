import { BadgeCheck, Check, ChevronDown, ChevronLeft, CircleDot, LockKeyhole } from 'lucide-react';
import { useState } from 'react';
import { AgentSetup, agentSetupPrompt, CLAUDE_COMMAND, CODEX_CONFIG } from './AgentSetup';
import { completeOnboarding, configureVault, type DesktopState, errorMessage } from './bridge';
import notaryMark from './notary-mark.svg';
import { ProviderConnections } from './ProviderConnections';
import type { View } from './product';
import './onboarding.css';

type OnboardingStep = 'welcome' | 'protection' | 'client';
type VaultSetupMode = 'keychain' | 'passphrase';
type ClientId = 'codex' | 'claude' | 'builtin';

const onboardingSteps: OnboardingStep[] = ['welcome', 'protection', 'client'];

const stepNames: Record<OnboardingStep, string> = {
  welcome: 'Overview',
  protection: 'Protection',
  client: 'Chat',
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
    detail:
      'Configure a separate Codex session. It keeps your existing ChatGPT sign-in or API key.',
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

export function Onboarding({
  state,
  refresh,
  onFinish,
  initialStep = 'welcome',
  onCancel,
}: {
  state: DesktopState;
  refresh: () => Promise<void>;
  onFinish: (view: View) => void;
  initialStep?: OnboardingStep;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [protectionMode, setProtectionMode] = useState<VaultSetupMode>('keychain');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('');
  const [client, setClient] = useState<ClientId>('builtin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stepIndex = onboardingSteps.indexOf(step);

  const chooseClient = (nextClient: ClientId) => {
    setError(null);
    setClient(nextClient);
  };

  // Leaving the protection step backwards forgets an unsaved passphrase.
  const leaveStep = (target: OnboardingStep) => {
    setError(null);
    if (step === 'protection') {
      setProtectionMode('keychain');
      setPassphrase('');
      setPassphraseConfirmation('');
    }
    setStep(target);
  };

  const canReturnTo = (target: OnboardingStep) => onboardingSteps.indexOf(target) < stepIndex;

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
        await configureVault(
          protectionMode,
          protectionMode === 'passphrase' ? passphrase : undefined,
        );
        setPassphrase('');
        setPassphraseConfirmation('');
        await refresh();
      }
      setStep('client');
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

  const decisions: Partial<Record<OnboardingStep, string>> = {
    protection: state.vault_configured
      ? 'Existing vault'
      : protectionMode === 'passphrase'
        ? 'Passphrase'
        : 'Keychain',
    client: clientLabels[client],
  };

  return (
    <div className="onboarding-window exalto-onboarding">
      <aside className="setup-rail">
        <div className="setup-rail-drag" data-tauri-drag-region />
        <div className="setup-brand" data-tauri-drag-region="deep">
          <img src={notaryMark} alt="" />
          <strong data-tauri-drag-region>Exalto Capture</strong>
        </div>
        <span className="setup-rail-label">Setup</span>
        <ol
          className="setup-ledger"
          aria-label={`Setup step ${stepIndex + 1} of ${onboardingSteps.length}`}
        >
          {onboardingSteps.map((item, index) => {
            const content = (
              <>
                <span className="ledger-mark">
                  {index < stepIndex ? <Check size={11} /> : index + 1}
                </span>
                <span className="ledger-name">{stepNames[item]}</span>
                {index <= stepIndex && decisions[item] && (
                  <span className="ledger-value">{decisions[item]}</span>
                )}
              </>
            );
            return (
              <li
                key={item}
                className={index < stepIndex ? 'is-done' : index === stepIndex ? 'is-current' : ''}
                aria-current={index === stepIndex ? 'step' : undefined}
              >
                {canReturnTo(item) ? (
                  <button
                    type="button"
                    className="ledger-step"
                    onClick={() => leaveStep(item)}
                    disabled={busy}
                    aria-label={`Return to ${stepNames[item]}`}
                  >
                    {content}
                  </button>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ol>
      </aside>
      <section className={`onboarding-content${step === 'client' ? ' is-client-step' : ''}`}>
        <header className="setup-bar" data-tauri-drag-region="deep">
          {step !== 'welcome' ? (
            <button
              className="back-button"
              type="button"
              onClick={() => leaveStep(onboardingSteps[stepIndex - 1])}
              disabled={busy}
            >
              <ChevronLeft size={13} /> Back
            </button>
          ) : (
            <span className="setup-bar-step" />
          )}
          {onCancel && (
            <button className="onboarding-close" type="button" onClick={onCancel} disabled={busy}>
              Done
            </button>
          )}
        </header>
        {step === 'welcome' && (
          <WelcomeStep state={state} onContinue={() => setStep('protection')} />
        )}
        {step === 'protection' && (
          <ProtectionStep
            configured={state.vault_configured}
            mode={protectionMode}
            setMode={setProtectionMode}
            passphrase={passphrase}
            setPassphrase={setPassphrase}
            passphraseConfirmation={passphraseConfirmation}
            setPassphraseConfirmation={setPassphraseConfirmation}
            busy={busy}
            onContinue={() => void configureProtection()}
          />
        )}
        {step === 'client' && (
          <ClientStep
            client={client}
            setClient={chooseClient}
            busy={busy}
            onFinish={(destination) => void finish(destination)}
          />
        )}
        {error && (
          <div
            className={`onboarding-error${step === 'client' ? ' client-step-error' : ''}`}
            role="alert"
          >
            {error}
          </div>
        )}
      </section>
    </div>
  );
}

function WelcomeStep({ state, onContinue }: { state: DesktopState; onContinue: () => void }) {
  const fresh = !state.agent_configured && !state.vault_configured;
  return (
    <>
      <div className="wizard-step welcome-step">
        <h1>Set up Exalto Capture</h1>
        <p>
          {fresh
            ? 'Capture a model exchange on this Mac, review what a sealed trace can reveal, then send it to Exalto Seal or another compatible notary for sealing.'
            : 'This Mac already has capture settings. Setup will preserve them while it checks the path from your AI tool to a portable trace.'}
        </p>
        <figure className="trace-receipt" aria-label="A sample local trace receipt">
          <figcaption>
            <span>
              <CircleDot size={10} /> REC
            </span>
            <code>TRACE / LOCAL</code>
          </figcaption>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>Built-in chat or your AI tool</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>Authenticated response</dd>
            </div>
            <div>
              <dt>Private content</dt>
              <dd>Hidden from the sealing service</dd>
            </div>
            <div>
              <dt>Portable result</dt>
              <dd>.llmtrace</dd>
            </div>
          </dl>
          <p>
            A trace proves the interaction it contains. It does not prove that omitted interactions
            never happened.
          </p>
        </figure>
      </div>
      <div className="wizard-actions">
        <button type="button" className="mac-button is-primary is-large" onClick={onContinue}>
          Begin setup
        </button>
      </div>
    </>
  );
}

function ProtectionStep({
  configured,
  mode,
  setMode,
  passphrase,
  setPassphrase,
  passphraseConfirmation,
  setPassphraseConfirmation,
  busy,
  onContinue,
}: {
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
  return (
    <>
      <div className="wizard-step">
        <h1>Protect private traces on this Mac</h1>
        <p>
          A full private capture can reconstruct the original provider request, including
          credentials. Exalto Capture vault-encrypts that artifact before writing it to disk.
        </p>
        {configured ? (
          <div className="configured-protection">
            <BadgeCheck size={18} />
            <div>
              <strong>Local protection is already configured</strong>
              <span>Your existing vault will remain unchanged.</span>
            </div>
          </div>
        ) : (
          <div
            className="protection-options"
            role="radiogroup"
            aria-label="Private trace protection"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'keychain'}
              className={mode === 'keychain' ? 'is-selected' : ''}
              onClick={chooseKeychain}
            >
              <span className="radio-mark">{mode === 'keychain' && <span />}</span>
              <div>
                <strong>Use macOS Keychain</strong>
                <p>
                  Recommended. macOS protects the vault key, with no separate password to remember.
                </p>
              </div>
            </button>
            {advancedOpen && (
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'passphrase'}
                className={mode === 'passphrase' ? 'is-selected' : ''}
                onClick={() => setMode('passphrase')}
              >
                <span className="radio-mark">{mode === 'passphrase' && <span />}</span>
                <div>
                  <strong>Use a passphrase</strong>
                  <p>Enter it whenever the app opens. Exalto Capture does not save it.</p>
                </div>
              </button>
            )}
          </div>
        )}
        {!configured && (
          <button
            type="button"
            className="advanced-options-toggle"
            aria-expanded={advancedOpen}
            onClick={toggleAdvanced}
          >
            Advanced protection <ChevronDown size={12} />
          </button>
        )}
        {!configured && advancedOpen && mode === 'passphrase' && (
          <div className="passphrase-fields">
            <label>
              <span>Passphrase</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                aria-invalid={!passphraseValid}
                aria-describedby={!passphraseValid ? mismatchId : undefined}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <label>
              <span>Confirm passphrase</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passphraseConfirmation}
                aria-invalid={!passphraseValid}
                aria-describedby={!passphraseValid ? mismatchId : undefined}
                onChange={(event) => setPassphraseConfirmation(event.target.value)}
              />
            </label>
            {!passphrasePresent ? (
              <small id={mismatchId} className="passphrase-mismatch" role="alert">
                Enter a non-empty passphrase.
              </small>
            ) : (
              !passphrasesMatch && (
                <small id={mismatchId} className="passphrase-mismatch" role="alert">
                  The passphrases do not match.
                </small>
              )
            )}
          </div>
        )}
        <div className="wizard-note" role="note">
          <LockKeyhole size={13} />
          <span>
            When retained previews are enabled, short prompt and response excerpts are also kept in
            local metadata so Traces can be browsed. Those excerpts stay on this Mac but are not
            protected by the trace vault.
          </span>
        </div>
      </div>
      <div className="wizard-actions">
        <button
          type="button"
          className="mac-button is-primary is-large"
          onClick={onContinue}
          disabled={busy || (mode === 'passphrase' && (!advancedOpen || !passphraseValid))}
        >
          {busy ? 'Saving…' : 'Protect traces'}
        </button>
      </div>
    </>
  );
}

function ClientStep({
  client,
  setClient,
  busy,
  onFinish,
}: {
  client: ClientId;
  setClient: (client: ClientId) => void;
  busy: boolean;
  onFinish: (destination: View) => void;
}) {
  return (
    <>
      <div className="wizard-step client-step-scroll">
        <h1>Where would you like to chat?</h1>
        <p>
          Chat inside Capture, or configure an external tool to send through it. You can add more
          connections later.
        </p>
        <div className="client-picker" role="radiogroup" aria-label="AI tool to connect first">
          {clientChoices.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={client === item.id}
              className={client === item.id ? 'is-selected' : ''}
              onClick={() => setClient(item.id)}
              disabled={busy}
            >
              {item.name}
            </button>
          ))}
        </div>
        <p className="harness-description">
          {clientChoices.find((item) => item.id === client)?.detail}
        </p>
        {client === 'builtin' ? (
          <ProviderConnections disabled={busy} />
        ) : (
          <AgentSetup
            key={client}
            client={client}
            prompt={agentSetupPrompt(client)}
            disabled={busy}
            manual={
              client === 'codex' ? (
                <>
                  <p>
                    Run <code>codex login status</code>. Keep its existing sign-in. For a ChatGPT
                    login, use the configuration below. For API-key authentication, use{' '}
                    <code>http://127.0.0.1:8787/openai/v1</code> as the base URL and{' '}
                    <code>env_key = "OPENAI_API_KEY"</code> instead of{' '}
                    <code>requires_openai_auth</code>. Set the key privately in your shell.
                  </p>
                  <pre>
                    <code>{CODEX_CONFIG}</code>
                  </pre>
                  <p>
                    Merge this into your user config, respecting <code>CODEX_HOME</code>. Start with{' '}
                    <code>codex --profile exalto-capture</code>. Desktop chats are not automatically
                    captured by this CLI profile.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Set <code>ANTHROPIC_API_KEY</code> privately in your shell or secret manager,
                    then launch a separate session using API billing.
                  </p>
                  <pre>
                    <code>{CLAUDE_COMMAND}</code>
                  </pre>
                  <p>
                    Claude Desktop can configure the CLI. Its own conversations do not use this
                    capture route.
                  </p>
                </>
              )
            }
          />
        )}
        {client !== 'builtin' && (
          <div className="wizard-note credential-capture-note" role="note">
            <LockKeyhole size={13} />
            <span>
              Credentials stay in your tool. Private encrypted captures can retain
              credential-bearing request bytes; keep them secret.
            </span>
          </div>
        )}
      </div>
      <div className="wizard-actions client-step-actions">
        <button
          className="mac-button is-primary is-large"
          type="button"
          disabled={busy}
          onClick={() => onFinish(client === 'builtin' ? 'chat' : 'traces')}
        >
          {busy ? 'Finishing setup…' : client === 'builtin' ? 'Try a chat' : 'Open Capture'}
        </button>
      </div>
    </>
  );
}
