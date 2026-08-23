import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Switch,
  Text,
  Title,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CodeXml, Copy, Moon, PanelLeft, ShieldCheck, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { AccountConnection, AccountConnectionStarted, LocalApi, Notary, Status } from '../api';
import { LocalApiError } from '../api';
import {
  abbreviatedKeyId,
  formatNotaryBoundary,
  notaryLifecycle,
  orderNotaries,
} from '../notaryLifecycle';
import {
  Fact,
  formatBytes,
  formatDate,
  LoadingState,
  mutationError,
  QueryError,
  requiredValue,
  StatusLabel,
} from '../shared';

export type DesktopSettingsState = {
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

export function useDesktopSettingsBridge(
  embedded: boolean,
  suppliedState?: DesktopSettingsState | null,
  suppliedAction?: (action: DesktopSettingsAction) => void,
) {
  const [bridgedState, setBridgedState] = useState<DesktopSettingsState | null>(null);
  useEffect(() => {
    if (!embedded || suppliedState) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== 'notary:desktop-settings') return;
      setBridgedState(event.data.payload as DesktopSettingsState);
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'notary:desktop-settings-ready' }, '*');
    return () => window.removeEventListener('message', receive);
  }, [embedded, suppliedState]);
  const send = (action: DesktopSettingsAction) => {
    if (suppliedAction) suppliedAction(action);
    else
      window.parent.postMessage({ type: 'notary:desktop-settings-action', payload: action }, '*');
  };
  return { state: suppliedState ?? bridgedState, send };
}

export type AccountConnectionController = ReturnType<typeof useAccountConnection>;

function accountPollRetryDelaySeconds(intervalSeconds: number, failures: number) {
  const base = Math.max(1, intervalSeconds);
  return Math.min(30, base * 2 ** Math.min(Math.max(0, failures - 1), 4));
}

export function useAccountConnection(api: LocalApi) {
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ['account'], queryFn: api.account, retry: false });
  const [started, setStarted] = useState<{
    flow: AccountConnectionStarted;
    nextPollAt: number;
    startedAt: number;
    failures: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!started) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [started]);

  const schedule = (flow: AccountConnectionStarted) => {
    const startedAt = Date.now();
    setStarted({
      flow,
      startedAt,
      nextPollAt: startedAt + flow.poll_interval_seconds * 1000,
      failures: 0,
    });
  };
  const begin = useMutation({
    mutationFn: api.startAccountConnection,
    onSuccess: schedule,
    onError: (error) => mutationError('Could not begin authorization', error),
  });
  const poll = useMutation({
    mutationFn: () =>
      api.pollAccountConnection(
        requiredValue(started, 'started account connection').flow.request_id,
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(['account'], result);
      if (result.signed_in || result.connection_state === 'connected') setStarted(null);
      else if (started)
        setStarted({
          ...started,
          nextPollAt: Date.now() + started.flow.poll_interval_seconds * 1000,
          failures: 0,
        });
    },
    onError: (error) => {
      mutationError('Could not check authorization', error);
      setStarted((current) => {
        if (!current) return current;
        const failures = current.failures + 1;
        const delay = accountPollRetryDelaySeconds(current.flow.poll_interval_seconds, failures);
        return { ...current, failures, nextPollAt: Date.now() + delay * 1000 };
      });
    },
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectAccount,
    onSuccess: () => {
      setStarted(null);
      void queryClient.invalidateQueries({ queryKey: ['account'] });
    },
    onError: (error) => mutationError('Could not disconnect this device', error),
  });
  const expired = Boolean(
    started && now >= started.startedAt + started.flow.expires_in_seconds * 1000,
  );
  const pollReady = Boolean(started && !expired && now >= started.nextPollAt);

  useEffect(() => {
    // A zero interval is used by deterministic dashboard fixtures to require
    // an explicit check. The daemon clamps real intervals to at least one
    // second, so only real authorization flows are automatically polled.
    if (
      !started ||
      expired ||
      started.flow.poll_interval_seconds === 0 ||
      !pollReady ||
      poll.isPending
    )
      return;
    poll.mutate();
  }, [expired, poll, pollReady, started]);

  return {
    account,
    started,
    now,
    expired,
    pollReady,
    begin,
    poll,
    disconnect,
    cancel: () => setStarted(null),
    refresh: () => account.refetch(),
  };
}

export function accountDisplayName(account: AccountConnection) {
  return account.display_name || account.provider_display_name || 'Notary Account';
}

function authProviderLabel(provider?: string | null) {
  if (!provider) return 'Hosted account';
  return provider === 'google' ? 'Google' : provider === 'github' ? 'GitHub' : provider;
}

function accountConnectionLabel(account: AccountConnection | undefined, error: unknown) {
  if (error) return 'Temporarily unavailable';
  if (!account) return 'Loading account';
  if (account.connection_state === 'reauthorization_required') return 'Reconnect required';
  if (account.connection_state === 'unavailable') return 'Temporarily unavailable';
  if (account.signed_in || account.connection_state === 'connected') return 'Connected';
  return 'Not connected';
}

export function AccountConnectionCard({
  controller,
  compact = false,
  fixture = false,
}: {
  controller: AccountConnectionController;
  compact?: boolean;
  fixture?: boolean;
}) {
  const { account, started, expired, pollReady, begin, poll, cancel, refresh } = controller;
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const { disconnect } = controller;
  const api = controller.account.data;
  const canDisconnect = Boolean(api?.signed_in && api.credential_kind !== 'api_key');
  const disconnectAccount = async () => {
    if (!canDisconnect) return;
    setDisconnectOpen(false);
    disconnect.mutate();
  };
  const state = accountConnectionLabel(api, account.error);
  const connected = Boolean(api?.signed_in || api?.connection_state === 'connected');
  const unavailable = state === 'Temporarily unavailable';
  const links = api?.links;

  return (
    <section
      className={`account-connection-card${compact ? ' account-connection-card--compact' : ''}`}
      aria-labelledby={compact ? undefined : 'local-account-title'}
    >
      <Group justify="space-between" align="flex-start">
        <div>
          <Text className="eyebrow">Account</Text>
          {!compact && (
            <Title id="local-account-title" order={2}>
              Hosted account connection
            </Title>
          )}
        </div>
        <StatusLabel
          state={
            connected
              ? 'ready'
              : unavailable
                ? 'unavailable'
                : api?.connection_state === 'reauthorization_required'
                  ? 'expired'
                  : 'muted'
          }
        />
      </Group>
      {account.isLoading ? (
        <Loader size="sm" />
      ) : connected && api ? (
        <>
          <div className="account-connection-identity">
            <div>
              <b>{accountDisplayName(api)}</b>
              {api.provider_display_name && api.display_name && (
                <Text>{api.provider_display_name}</Text>
              )}
              <Text>
                {authProviderLabel(api.auth_provider)} ·{' '}
                {api.credential_name || api.device_name || 'Connected service'}
              </Text>
            </div>
            {api.credential_kind === 'api_key' && <Badge variant="light">API key</Badge>}
          </div>
          {api.billing && (
            <dl className="account-connection-facts">
              <Fact label="Plan" value={`${api.billing.plan} · ${api.billing.billing_status}`} />
              {api.billing.purchase_mode && (
                <Fact label="Billing" value={api.billing.purchase_mode} />
              )}
              {api.credits && (
                <Fact
                  label="Notarization"
                  value={`${formatBytes(api.credits.notarization.total_used_bytes)} used · ${formatBytes(api.credits.notarization.total_remaining_bytes)} remaining`}
                />
              )}
              {api.credits && (
                <Fact
                  label="Capture"
                  value={`${formatBytes(api.credits.capture.total_used_bytes)} used · ${formatBytes(api.credits.capture.total_remaining_bytes)} remaining`}
                />
              )}
              {api.credits && (
                <Fact
                  label="Monthly included"
                  value={formatBytes(api.credits.notarization.included_monthly_remaining_bytes)}
                />
              )}
              {api.credits && (
                <Fact
                  label="Supplemental"
                  value={formatBytes(api.credits.notarization.supplemental_remaining_bytes)}
                />
              )}
              {api.credits && (
                <Fact label="Reset" value={formatDate((api.credits.reset_at ?? 0) * 1000)} />
              )}
              {api.credits?.notarization.next_grant_expiration && (
                <Fact
                  label="Next expiration"
                  value={formatDate(api.credits.notarization.next_grant_expiration * 1000)}
                />
              )}
            </dl>
          )}
          {links && (
            <Group className="account-connection-links" gap="xs">
              <Button
                component="a"
                href={links.account}
                target="_blank"
                rel="noreferrer"
                variant="subtle"
              >
                Open account
              </Button>
              <Button
                component="a"
                href={links.usage}
                target="_blank"
                rel="noreferrer"
                variant="subtle"
              >
                Usage and credits
              </Button>
              <Button
                component="a"
                href={links.plans}
                target="_blank"
                rel="noreferrer"
                variant="subtle"
              >
                Plans and pricing
              </Button>
              <Button
                component="a"
                href={links.settings}
                target="_blank"
                rel="noreferrer"
                variant="subtle"
              >
                {api.credential_kind === 'api_key' ? 'Manage API keys' : 'Account settings'}
              </Button>
            </Group>
          )}
          {canDisconnect && (
            <Button variant="outline" onClick={() => setDisconnectOpen(true)}>
              Disconnect this device
            </Button>
          )}
        </>
      ) : (
        <>
          <Text>
            {api?.connection_state === 'reauthorization_required'
              ? 'The local authorization expired or was revoked. Reconnect to restore hosted credits and account-owned sharing.'
              : unavailable
                ? 'The account service could not be reached. Local Traces and verification remain available.'
                : 'Connect an account to see hosted credits and use account-owned sharing.'}
          </Text>
          <Group>
            <Button variant="outline" loading={begin.isPending} onClick={() => begin.mutate()}>
              {api?.connection_state === 'reauthorization_required'
                ? 'Reconnect'
                : compact
                  ? 'Connect account'
                  : 'Sign in or create account'}
            </Button>
            {unavailable && (
              <Button variant="subtle" onClick={() => refresh()}>
                Refresh
              </Button>
            )}
          </Group>
        </>
      )}
      {started && (
        <div className="authorization-code">
          <Text className="eyebrow">Approval code</Text>
          <code>{started.flow.user_code}</code>
          {!fixture && (
            <a href={started.flow.verification_uri_complete} target="_blank" rel="noreferrer">
              Open approval page
            </a>
          )}
          {expired ? (
            <Text>Authorization expired. Start again to get a fresh request.</Text>
          ) : (
            <Text>
              {pollReady
                ? 'Ready to check.'
                : `Next check in ${Math.max(1, Math.ceil((started.nextPollAt - controller.now) / 1000))}s.`}
            </Text>
          )}
          <Group>
            <Button
              size="xs"
              variant="subtle"
              disabled={expired || !pollReady}
              loading={poll.isPending}
              onClick={() => poll.mutate()}
            >
              Check approval
            </Button>
            <Button size="xs" variant="subtle" onClick={cancel}>
              Cancel
            </Button>
            {expired && (
              <Button
                size="xs"
                variant="subtle"
                loading={begin.isPending}
                onClick={() => begin.mutate()}
              >
                Try again
              </Button>
            )}
          </Group>
        </div>
      )}
      <Text className="account-local-boundary">
        Connecting an account does not upload or share local Traces.
      </Text>
      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent className="axis-local-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This revokes only the local browser-approved session. It does not sign out the website
              or delete your hosted account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending}
              onClick={() => void disconnectAccount()}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect device'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function SchemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const options = [
    { value: 'auto' as const, label: 'System', icon: PanelLeft },
    { value: 'light' as const, label: 'Light', icon: Sun },
    { value: 'dark' as const, label: 'Dark', icon: Moon },
  ];
  return (
    <div className="scheme-control" role="group" aria-label="Color scheme">
      {options.map(({ value, label, icon: Icon }) => (
        <Tooltip key={value} label={label}>
          <button
            type="button"
            className={colorScheme === value ? 'is-active' : ''}
            aria-pressed={colorScheme === value}
            aria-label={`${label} color scheme`}
            onClick={() => setColorScheme(value)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function LocalNotaryRecord({
  record,
  activeKeyId,
}: {
  record: Notary;
  activeKeyId?: string | null;
}) {
  const lifecycle = notaryLifecycle(record.lifecycle);
  const copyKey = async () => {
    await navigator.clipboard.writeText(record.key_id);
    notifications.show({
      title: 'Notary key ID copied',
      message: 'The complete key ID is on the clipboard.',
    });
  };
  return (
    <article className={`local-notary-record local-notary-record--${record.lifecycle}`}>
      <header>
        <span className={`local-notary-state local-notary-state--${record.lifecycle}`}>
          <i aria-hidden="true" />
          {record.lifecycle}
        </span>
        {record.key_id === activeKeyId && (
          <span className="local-notary-selected">Selected active key</span>
        )}
      </header>
      <Title order={3}>{lifecycle.label}</Title>
      <Text>{lifecycle.description}</Text>
      <dl className="local-notary-facts">
        <Fact label="Endpoint" value={record.endpoint} />
        <Fact label="Transport" value={record.transport.toUpperCase()} />
        <Fact
          label="Valid from"
          value={formatNotaryBoundary(record.valid_from_unix_ms, {
            kind: 'lower',
            missingLabel: 'Not defined by explicit configuration',
          })}
        />
        <Fact label="Capture cutoff" value={formatNotaryBoundary(record.valid_until_unix_ms)} />
        <Fact
          label="Notarization cutoff"
          value={formatNotaryBoundary(record.notarize_until_unix_ms)}
        />
      </dl>
      <div className="local-notary-key">
        <span>Key ID / fingerprint</span>
        <code title={record.key_id}>{abbreviatedKeyId(record.key_id)}</code>
        <ActionIcon
          variant="subtle"
          onClick={copyKey}
          aria-label={`Copy full key ID ${record.key_id}`}
        >
          <Copy size={15} />
        </ActionIcon>
      </div>
    </article>
  );
}

function SettingsNotaries({ api }: { api: LocalApi }) {
  const notaries = useQuery({ queryKey: ['notaries'], queryFn: api.notaries, retry: false });
  const errorCode = notaries.error instanceof LocalApiError ? notaries.error.code : null;
  const records = orderNotaries(notaries.data?.notaries ?? [], notaries.data?.active_key_id);
  return (
    <Paper className="settings-panel settings-notaries">
      <div className="settings-notaries-heading">
        <div>
          <Text className="eyebrow">Notaries</Text>
          <Title order={2}>Configured trust</Title>
        </div>
        {notaries.data?.generation != null && (
          <Text>Registry generation {notaries.data.generation}</Text>
        )}
      </div>
      <Text className="settings-notaries-note">
        This is the trust state used by the local service. It describes key lifecycle and permitted
        work, not endpoint health or availability.
      </Text>
      {notaries.isLoading ? (
        <div className="local-notary-loading" role="status" aria-label="Loading local notary trust">
          <i />
          <i />
          <i />
        </div>
      ) : notaries.error ? (
        <div className="local-notary-state-panel" role="alert">
          <b>
            {errorCode === 'registry_state_invalid'
              ? 'Pinned trust state is malformed'
              : 'Local notary trust is unavailable'}
          </b>
          <span>
            {errorCode === 'registry_state_invalid'
              ? 'The cached Registry could not be validated. No notary is presented as usable.'
              : 'The local service could not return its configured trust metadata. No endpoint status can be inferred.'}
          </span>
          <Button variant="outline" onClick={() => notaries.refetch()}>
            Try again
          </Button>
        </div>
      ) : !records.length ? (
        <div className="local-notary-state-panel">
          <b>No pinned notary records</b>
          <span>
            The local service has not retained a Registry generation. No notary is presented as
            available.
          </span>
        </div>
      ) : (
        <>
          <dl className="settings-notary-source">
            <Fact
              label="Trust source"
              value={
                notaries.data?.source === 'explicit_configuration'
                  ? 'Explicit self-hosted configuration'
                  : 'Pinned Registry'
              }
            />
            {notaries.data?.registry_source && (
              <Fact label="Registry source" value={notaries.data.registry_source} />
            )}
          </dl>
          {notaries.data?.source === 'explicit_configuration' && (
            <Text className="explicit-notary-note">
              This endpoint and key come from local configuration and are not members of the hosted
              Registry.
            </Text>
          )}
          <div className="local-notary-list">
            {records.map((record) => (
              <LocalNotaryRecord
                key={record.key_id}
                record={record}
                activeKeyId={notaries.data?.active_key_id}
              />
            ))}
          </div>
        </>
      )}
    </Paper>
  );
}

function SettingsGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-labelledby={id}>
      <Title id={id} order={1} className="settings-group-title">
        {title}
      </Title>
      {children}
    </section>
  );
}

function EmbeddedNotaries({ api }: { api: LocalApi }) {
  const notaries = useQuery({ queryKey: ['notaries'], queryFn: api.notaries, retry: false });
  const records = orderNotaries(notaries.data?.notaries ?? [], notaries.data?.active_key_id);
  const active =
    records.find((record) => record.key_id === notaries.data?.active_key_id) ?? records[0];
  return (
    <Paper className="settings-panel embedded-notaries">
      <Text className="eyebrow">Notaries</Text>
      {notaries.isLoading ? (
        <LoadingState label="Loading Notaries" />
      ) : notaries.error ? (
        <QueryError error={notaries.error} title="Notaries are unavailable" />
      ) : !active ? (
        <Text>No notary is configured.</Text>
      ) : (
        <>
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={2}>{active.name}</Title>
              <Text>Operated by {active.operator}</Text>
            </div>
            <StatusLabel state={active.lifecycle} />
          </Group>
          <dl className="receipt-list">
            <Fact
              label="Source"
              value={
                notaries.data?.source === 'explicit_configuration'
                  ? 'Explicit configuration'
                  : 'Pinned Registry'
              }
            />
            <Fact
              label="Active verification key"
              value={abbreviatedKeyId(active.verification_key)}
            />
            <Fact label="Status" value={notaryLifecycle(active.lifecycle).label} />
          </dl>
          <details className="notary-details">
            <summary>View details</summary>
            {records.map((record) => (
              <article key={record.key_id} className="notary-detail-record">
                <Group justify="space-between" align="flex-start">
                  <div>
                    <Title order={3}>{record.name}</Title>
                    <Text>Operated by {record.operator}</Text>
                  </div>
                  <StatusLabel state={record.lifecycle} />
                </Group>
                <dl className="receipt-list">
                  <Fact label="Endpoint" value={record.endpoint} />
                  <Fact label="Transport" value={record.transport.toUpperCase()} />
                  <Fact label="Verification key" value={record.verification_key} />
                  <Fact label="Key ID" value={record.key_id} />
                  <Fact
                    label="Valid from"
                    value={formatNotaryBoundary(record.valid_from_unix_ms, { kind: 'lower' })}
                  />
                  <Fact
                    label="Capture cutoff"
                    value={formatNotaryBoundary(record.valid_until_unix_ms)}
                  />
                  <Fact
                    label="Notarization cutoff"
                    value={formatNotaryBoundary(record.notarize_until_unix_ms)}
                  />
                </dl>
              </article>
            ))}
          </details>
        </>
      )}
    </Paper>
  );
}

function EmbeddedCaptureSetting({ status, api }: { status: Status; api: LocalApi }) {
  const queryClient = useQueryClient();
  const [captureEnabled, setCaptureEnabled] = useState(status.capture_enabled);
  const captureMode = useMutation({
    mutationFn: (enabled: boolean) => api.updateCaptureSetting(enabled),
    onSuccess: (setting) => {
      setCaptureEnabled(setting.enabled);
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      notifications.show({
        title: setting.enabled ? 'Capture new requests on' : 'Capture new requests off',
        message: setting.enabled
          ? 'Supported requests create private local Traces.'
          : 'Requests pass through locally and create no Trace.',
      });
    },
    onError: (error) => mutationError('Capture mode did not change', error),
  });
  useEffect(() => setCaptureEnabled(status.capture_enabled), [status.capture_enabled]);
  return (
    <Paper className="capture-mode-setting">
      <div>
        <Text fw={700}>Capture new requests</Text>
        <Text>
          {captureEnabled
            ? 'On — supported requests use notarized capture and create private local Traces.'
            : 'Off — requests pass through locally and create no Trace.'}
        </Text>
      </div>
      <Switch
        aria-label="Capture new requests"
        checked={captureEnabled}
        disabled={captureMode.isPending}
        onChange={(event) => captureMode.mutate(event.currentTarget.checked)}
      />
    </Paper>
  );
}

export function EmbeddedSettingsView({
  status,
  api,
  desktopSettings,
  onDesktopAction,
}: {
  status: Status;
  api: LocalApi;
  desktopSettings: DesktopSettingsState | null;
  onDesktopAction: (action: DesktopSettingsAction) => void;
}) {
  const accountConnection = useAccountConnection(api);
  const openApiUrl = `${window.location.origin}/openapi.json`;
  const statusUrl = `${window.location.origin}/v1/status`;
  const copyOpenApi = async () => {
    await navigator.clipboard.writeText(openApiUrl);
    notifications.show({
      title: 'OpenAPI URL copied',
      message: 'Use this URL to discover admin routes and request bodies.',
    });
  };
  const update = desktopSettings?.update;
  const updateWorking =
    Boolean(desktopSettings?.update_busy) ||
    ['checking', 'downloading', 'installing'].includes(update?.phase ?? '');
  return (
    <div className="view-page settings-page settings-page--embedded">
      <SettingsGroup id="settings-general" title="General">
        <div className="settings-flat-group">
          <EmbeddedCaptureSetting status={status} api={api} />
          <Paper className="capture-mode-setting">
            <div>
              <Text fw={700}>Open Notary at sign-in</Text>
              <Text>
                Closing the window leaves Notary available from the menu bar.
                {desktopSettings?.vault_label === 'Passphrase vault'
                  ? ' The app opens locked until you enter the vault passphrase.'
                  : ''}
              </Text>
            </div>
            <Switch
              aria-label="Open Notary at sign-in"
              checked={desktopSettings?.launch_at_login ?? false}
              disabled={!desktopSettings?.launch_ready}
              onChange={(event) =>
                onDesktopAction({
                  action: 'set_launch_at_login',
                  enabled: event.currentTarget.checked,
                })
              }
            />
          </Paper>
        </div>
      </SettingsGroup>
      <SettingsGroup id="settings-account" title="Account">
        <AccountConnectionCard controller={accountConnection} />
      </SettingsGroup>
      <SettingsGroup id="settings-security" title="Security">
        <div className="settings-subgroup-grid">
          <Paper className="settings-panel">
            <Text className="eyebrow">Local data</Text>
            <Title order={2}>{desktopSettings?.vault_label ?? status.vault}</Title>
            <Text>{desktopSettings?.vault_detail ?? 'Private evidence is protected locally.'}</Text>
            <Text>
              {desktopSettings?.vault_label === 'Passphrase vault'
                ? 'The passphrase is required after each app start. Changing protection requires a guided migration of existing private Traces.'
                : 'Changing protection requires a guided migration so existing private Traces retain one authoritative key.'}
            </Text>
            <dl className="receipt-list">
              <Fact label="Metadata" value={status.metadata_backend} />
              <Fact label="Artifacts" value={status.artifact_backend} />
              <Fact label="Retained preview limit" value={`${status.preview_chars} characters`} />
            </dl>
          </Paper>
          <EmbeddedNotaries api={api} />
        </div>
      </SettingsGroup>
      <SettingsGroup id="settings-updates" title="Updates">
        <Paper className="settings-panel embedded-update-settings">
          <dl className="receipt-list">
            <Fact label="Current version" value={desktopSettings?.app_version ?? status.version} />
            <Fact
              label="Automatic updates"
              value={update?.enabled ? 'Checks signed releases automatically' : 'Off in this build'}
            />
            <Fact label="Current build" value={update?.current_build_id ?? status.build_id} />
            {update?.latest_build_id && (
              <Fact label="Latest build" value={update.latest_build_id} />
            )}
          </dl>
          {update?.phase === 'downloading' && update.total_bytes && (
            <div className="desktop-update-progress" role="status">
              <span>
                <i
                  style={{
                    width: `${Math.min(100, (update.downloaded_bytes / update.total_bytes) * 100)}%`,
                  }}
                />
              </span>
              <Text>
                {formatBytes(update.downloaded_bytes)} of {formatBytes(update.total_bytes)}
              </Text>
            </div>
          )}
          {update?.message && <Text>{update.message}</Text>}
          {desktopSettings?.restart_block_reason && (
            <Text className="update-block-reason">{desktopSettings.restart_block_reason}</Text>
          )}
          <Group>
            <Button
              variant="outline"
              disabled={!update?.enabled || updateWorking}
              onClick={() => onDesktopAction({ action: 'check_for_updates' })}
            >
              Check now
            </Button>
            {update?.phase === 'ready' && (
              <Button
                disabled={Boolean(desktopSettings?.restart_block_reason) || updateWorking}
                onClick={() => onDesktopAction({ action: 'restart_to_update' })}
              >
                Restart to update
              </Button>
            )}
          </Group>
          <Text className="safe-note">
            Release signatures are verified for the ai.exalto.notary application identity before
            installation.
          </Text>
        </Paper>
      </SettingsGroup>
      <SettingsGroup id="settings-advanced" title="Advanced">
        <div className="settings-subgroup-grid">
          <Paper className="settings-panel">
            <Text className="eyebrow">Service</Text>
            <dl className="receipt-list">
              <Fact label="Provider proxy" value={status.proxy_listener} />
              <Fact label="Administration" value={status.admin_listener} />
              <Fact label="Runtime profile" value={status.runtime_profile} />
              <Fact label="Service version" value={status.version} />
              <Fact label="Service build" value={status.build_id} />
              <Fact label="App build" value={desktopSettings?.app_build_id ?? 'Unavailable'} />
              <Fact
                label="Metadata"
                value={`${status.metadata_backend} (${status.metadata_status})`}
              />
              <Fact
                label="Artifacts"
                value={`${status.artifact_backend} (${status.artifact_status})`}
              />
            </dl>
          </Paper>
          <Paper className="settings-panel">
            <Text className="eyebrow">Developer</Text>
            <dl className="receipt-list">
              <Fact label="Status endpoint" value={statusUrl} />
              <Fact label="API version" value="v1" />
              <Fact label="Vault mode" value={status.vault} />
            </dl>
            <div className="api-link">
              <code>{openApiUrl}</code>
              <ActionIcon variant="subtle" onClick={copyOpenApi} aria-label="Copy OpenAPI URL">
                <Copy size={15} />
              </ActionIcon>
            </div>
            <Button
              component="a"
              href="/openapi.json"
              target="_blank"
              variant="outline"
              leftSection={<CodeXml size={15} />}
            >
              Open generated OpenAPI
            </Button>
          </Paper>
        </div>
      </SettingsGroup>
      {desktopSettings?.notice && (
        <Text className="desktop-settings-notice">{desktopSettings.notice}</Text>
      )}
    </div>
  );
}

export function StandaloneSettingsView({ status, api }: { status: Status; api: LocalApi }) {
  const queryClient = useQueryClient();
  const [captureEnabled, setCaptureEnabled] = useState(status.capture_enabled);
  const captureMode = useMutation({
    mutationFn: (enabled: boolean) => api.updateCaptureSetting(enabled),
    onSuccess: (setting) => {
      setCaptureEnabled(setting.enabled);
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      notifications.show({
        title: setting.enabled ? 'Capture requests on' : 'Capture requests off',
        message: setting.enabled
          ? 'Later provider requests will use the remote notary and create private captures.'
          : 'Later provider requests will go directly to the provider and create no evidence.',
      });
    },
    onError: (error) => mutationError('Capture mode did not change', error),
  });
  useEffect(() => setCaptureEnabled(status.capture_enabled), [status.capture_enabled]);
  const isCluster = status.runtime_profile === 'cluster';
  const accountConnection = useAccountConnection(api);
  const openApiUrl = `${window.location.origin}/openapi.json`;
  const copyOpenApi = async () => {
    await navigator.clipboard.writeText(openApiUrl);
    notifications.show({
      title: 'OpenAPI URL copied',
      message: 'Use this URL to discover admin routes and request bodies.',
    });
  };
  const updateState = !status.updates.enabled
    ? isCluster
      ? 'Managed by deployment'
      : 'Disabled for source builds'
    : status.updates.update_available
      ? `Available: ${status.updates.latest_build_id}`
      : status.updates.error_code
        ? 'Check failed'
        : status.updates.last_checked_unix_ms
          ? 'Up to date'
          : 'Not checked yet';

  return (
    <div className="view-page settings-page">
      <SettingsGroup id="settings-general" title="General">
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Paper className="capture-mode-setting">
            <div>
              <Text fw={700}>Capture requests</Text>
              <Text>
                {captureEnabled
                  ? 'On — requests use the remote notary and create private captures.'
                  : 'Off — requests still pass through the local daemon, go directly to the provider, and create no evidence.'}
              </Text>
            </div>
            <Switch
              aria-label="Capture requests"
              checked={captureEnabled}
              disabled={captureMode.isPending}
              onChange={(event) => captureMode.mutate(event.currentTarget.checked)}
            />
          </Paper>
          <Paper className="appearance-setting">
            <Text fw={700}>Theme</Text>
            <SchemeControl />
          </Paper>
        </SimpleGrid>
      </SettingsGroup>
      <SettingsGroup id="settings-account" title="Account">
        <AccountConnectionCard controller={accountConnection} />
      </SettingsGroup>
      <SettingsGroup id="settings-notarization" title="Notarization">
        <SettingsNotaries api={api} />
      </SettingsGroup>
      <SettingsGroup id="settings-security" title="Security & storage">
        <Paper className="settings-panel">
          <Text className="eyebrow">Privacy policy</Text>
          <Title order={2}>Preview storage</Title>
          <Text>
            Up to {status.preview_chars.toLocaleString()} characters of known text fields are
            indexed {isCluster ? 'in shared metadata' : 'locally'}. Raw headers are never indexed.
          </Text>
          <dl className="receipt-list">
            <Fact label="Vault" value={status.vault} />
            <Fact
              label="Metadata"
              value={`${status.metadata_backend} (${status.metadata_status})`}
            />
            <Fact
              label="Artifacts"
              value={`${status.artifact_backend} (${status.artifact_status})`}
            />
          </dl>
        </Paper>
      </SettingsGroup>
      <SettingsGroup id="settings-service" title="Service">
        <Paper className="settings-panel">
          <Text className="eyebrow">{isCluster ? 'Deployment' : 'Listeners'}</Text>
          <Title order={2}>{isCluster ? 'Cluster endpoints' : 'Listener addresses'}</Title>
          <dl className="receipt-list">
            <Fact
              label="Provider proxy"
              value={isCluster ? status.proxy_origin : status.proxy_listener}
            />
            <Fact
              label="Admin & dashboard"
              value={isCluster ? status.admin_origin : status.admin_listener}
            />
            {isCluster && (
              <Fact label="Replica" value={status.instance_id ?? 'Assigned automatically'} />
            )}
            {isCluster && <Fact label="Lifecycle" value={status.lifecycle} />}
            <Fact
              label="Metadata"
              value={`${status.metadata_backend} (${status.metadata_status})`}
            />
            <Fact
              label="Artifacts"
              value={`${status.artifact_backend} (${status.artifact_status})`}
            />
            <Fact label="API version" value="v1" />
            <Fact label="Service version" value={status.version} />
            <Fact label="Build" value={status.build_id} />
            <Fact label="Updates" value={updateState} />
          </dl>
          <Text className="safe-note">
            <ShieldCheck size={15} />{' '}
            {isCluster
              ? 'Public traffic uses the configured TLS ingress; provider requests must never be replayed.'
              : 'Both listeners are restricted to loopback.'}
          </Text>
          {status.updates.update_available && (
            <Text>
              Run <code>notaryctl update</code>, then restart the service after active work
              finishes.
            </Text>
          )}
        </Paper>
      </SettingsGroup>
      <SettingsGroup id="settings-developer" title="Developer">
        <Paper className="settings-panel">
          <Text className="eyebrow">Agent discovery</Text>
          <Title order={2}>API specification</Title>
          <Text>Use the generated OpenAPI document to discover routes and request bodies.</Text>
          <div className="api-link">
            <code>{openApiUrl}</code>
            <ActionIcon variant="subtle" onClick={copyOpenApi} aria-label="Copy OpenAPI URL">
              <Copy size={15} />
            </ActionIcon>
          </div>
          <Button
            component="a"
            href="/openapi.json"
            target="_blank"
            variant="outline"
            leftSection={<CodeXml size={15} />}
          >
            Open specification
          </Button>
        </Paper>
      </SettingsGroup>
    </div>
  );
}
