import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  disconnectAccount,
  errorMessage,
  getAccountConnection,
  openAccountLink,
  pollAccountConnection,
  startAccountConnection,
  type AccountConnection,
  type AccountConnectionStarted,
} from './bridge';
import { formatBytes } from './product';

function formatDate(seconds?: number | null) {
  if (!seconds) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(seconds * 1000));
}

function accountName(account: AccountConnection) {
  return account.display_name || account.provider_display_name || 'Notary account';
}

function accountProvider(account: AccountConnection) {
  if (account.auth_provider === 'google') return 'Google';
  if (account.auth_provider === 'github') return 'GitHub';
  return 'Hosted account';
}

export function DesktopAccountCard({
  compact = false,
  onContinue,
  onSkip,
}: {
  compact?: boolean;
  onContinue?: () => void;
  onSkip?: () => void;
}) {
  const [account, setAccount] = useState<AccountConnection | null>(null);
  const [flow, setFlow] = useState<{ value: AccountConnectionStarted; startedAt: number; nextPollAt: number; failures: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setAccount(await getAccountConnection());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!flow) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [flow]);

  const expired = Boolean(flow && now >= flow.startedAt + flow.value.expires_in_seconds * 1000);
  const pollReady = Boolean(flow && !expired && now >= flow.nextPollAt);

  const poll = async () => {
    if (!flow || !pollReady || polling) return;
    setPolling(true);
    try {
      const next = await pollAccountConnection(flow.value.request_id);
      setAccount(next);
      if (next.signed_in || next.connection_state === 'connected') setFlow(null);
      else setFlow({ ...flow, nextPollAt: Date.now() + flow.value.poll_interval_seconds * 1000, failures: 0 });
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
      setFlow((current) => {
        if (!current) return current;
        const failures = current.failures + 1;
        const delay = Math.min(30, Math.max(1, current.value.poll_interval_seconds) * 2 ** Math.min(Math.max(0, failures - 1), 4));
        return { ...current, failures, nextPollAt: Date.now() + delay * 1000 };
      });
    } finally {
      setPolling(false);
    }
  };

  useEffect(() => {
    if (!flow || expired || flow.value.poll_interval_seconds === 0 || !pollReady || polling) return;
    void poll();
  }, [expired, flow, pollReady, polling]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await startAccountConnection();
      const startedAt = Date.now();
      setFlow({ value, startedAt, nextPollAt: startedAt + value.poll_interval_seconds * 1000, failures: 0 });
      await openAccountLink(value.verification_uri_complete);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!account?.signed_in || account.credential_kind === 'api_key') return;
    if (!window.confirm('Disconnect this device? This revokes only the local browser-approved session.')) return;
    setBusy(true);
    try {
      await disconnectAccount();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const connected = Boolean(account?.signed_in || account?.connection_state === 'connected');
  const state = error ? 'unavailable' : account?.connection_state ?? (connected ? 'connected' : 'disconnected');
  const action = async (url: string) => {
    try { await openAccountLink(url); } catch (caught) { setError(errorMessage(caught)); }
  };

  return <section className={`native-account-card${compact ? ' is-compact' : ''}`}>
    <div className="native-account-heading"><div><span className="section-label">Account</span>{!compact && <h2>Hosted account</h2>}</div><span className={`account-state account-state--${state}`}>{state === 'connected' ? 'Connected' : state === 'reauthorization_required' ? 'Reconnect required' : state === 'unavailable' ? 'Temporarily unavailable' : 'Not connected'}</span></div>
    {account && connected ? <>
      <div className="native-account-identity"><div><strong>{accountName(account)}</strong><span>{accountProvider(account)} · {account.credential_name || account.device_name || 'Connected service'}</span></div>{account.credential_kind === 'api_key' && <small>API key</small>}</div>
      {account.billing && <div className="native-account-facts"><div><span>Plan</span><strong>{account.billing.plan}</strong></div><div><span>Billing</span><strong>{account.billing.billing_status}{account.billing.purchase_mode ? ` · ${account.billing.purchase_mode}` : ''}</strong></div>{account.credits && <div><span>Notarization used</span><strong>{formatBytes(account.credits.notarization.total_used_bytes)}</strong></div>}{account.credits && <div><span>Notarization remaining</span><strong>{formatBytes(account.credits.notarization.total_remaining_bytes)}</strong></div>}{account.credits && <div><span>Capture used</span><strong>{formatBytes(account.credits.capture.total_used_bytes)}</strong></div>}{account.credits && <div><span>Capture remaining</span><strong>{formatBytes(account.credits.capture.total_remaining_bytes)}</strong></div>}{account.credits && <div><span>Included monthly</span><strong>{formatBytes(account.credits.notarization.included_monthly_remaining_bytes)}</strong></div>}{account.credits && <div><span>Supplemental</span><strong>{formatBytes(account.credits.notarization.supplemental_remaining_bytes)}</strong></div>}{account.credits && <div><span>Reset</span><strong>{formatDate(account.credits.reset_at)}</strong></div>}{account.credits?.notarization.next_grant_expiration && <div><span>Next expiration</span><strong>{formatDate(account.credits.notarization.next_grant_expiration)}</strong></div>}</div>}
      {account.links && <div className="native-account-links"><button type="button" onClick={() => void action(account.links!.account)}>Open account</button><button type="button" onClick={() => void action(account.links!.usage)}>Usage and credits</button><button type="button" onClick={() => void action(account.links!.plans)}>Plans and pricing</button><button type="button" onClick={() => void action(account.links!.settings)}>{account.credential_kind === 'api_key' ? 'Manage API keys' : 'Account settings'}</button></div>}
      {account.credential_kind !== 'api_key' && <button className="mac-button is-small" type="button" onClick={() => void disconnect()} disabled={busy}>Disconnect this device</button>}
      {onContinue && <button className="mac-button is-primary is-large" type="button" onClick={onContinue}>Continue setup <ChevronRight size={15} /></button>}
    </> : <>
      <p>{state === 'reauthorization_required' ? 'This local authorization expired or was revoked. Reconnect to restore hosted credits and account-owned sharing.' : state === 'unavailable' ? 'The account service is temporarily unavailable. Local Traces and verification remain available.' : 'Sign in to see hosted credits, usage, and account-owned sharing. Signing in does not upload or publish local Traces.'}</p>
      <div className="wizard-actions"><button className="mac-button is-primary is-large" type="button" onClick={() => void start()} disabled={busy}>{busy ? 'Opening browser…' : state === 'reauthorization_required' ? 'Reconnect' : 'Sign in or create account'} <ChevronRight size={15} /></button>{onSkip && <button className="mac-button is-large" type="button" onClick={onSkip} disabled={busy}>Not now</button>}</div>
    </>}
    {error && <div className="onboarding-error" role="alert">{error}</div>}
    {flow && <div className="native-account-authorization"><span className="section-label">Approval code</span><strong>{flow.value.user_code}</strong>{expired ? <span>Authorization expired. Start again for a fresh request.</span> : <span>{pollReady ? 'Ready to check.' : `Next check in ${Math.max(1, Math.ceil((flow.nextPollAt - now) / 1000))}s.`}</span>}<div><button className="mac-button is-small" type="button" onClick={() => void poll()} disabled={expired || !pollReady || polling}>{polling ? 'Checking…' : 'Check approval'}</button><button className="mac-button is-small" type="button" onClick={() => setFlow(null)}>Cancel</button>{expired && <button className="mac-button is-small" type="button" onClick={() => void start()} disabled={busy}>Try again</button>}</div></div>}
  </section>;
}
