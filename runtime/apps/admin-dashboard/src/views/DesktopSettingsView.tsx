import {
  ActionIcon,
  Button,
  type MantineColorScheme,
  SegmentedControl,
  Switch,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { AccountConnectionCard } from '../AccountConnection';
import type { LocalApi, Notary, Status } from '../api';
import { formatNotaryBoundary, orderNotaries } from '../notaryLifecycle';
import { Fact, formatBytes, StatusLabel } from '../shared';

/** Desktop-owned settings the app passes into the embedded Preferences. */
export type DesktopSettingsState = {
  launch_at_login: boolean;
  launch_ready: boolean;
  vault_label: string;
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

/** A System Settings style group: a short header over one rounded group of rows. */
export function PreferenceSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="preference-section" aria-label={title}>
      <h2>{title}</h2>
      <div className="preference-group">{children}</div>
    </section>
  );
}

/** A label on the left, an optional secondary line, and the control or value on the right. */
export function PreferenceRow({
  label,
  detail,
  children,
}: {
  label: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="preference-row">
      <div>
        <span className="preference-label">{label}</span>
        {detail && <span className="preference-detail">{detail}</span>}
      </div>
      {children}
    </div>
  );
}

const appearanceOptions = [
  { value: 'auto', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AppearanceSection() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <PreferenceSection title="Appearance">
      <PreferenceRow label="Theme">
        <SegmentedControl
          aria-label="Theme"
          size="xs"
          data={appearanceOptions}
          value={colorScheme}
          onChange={(value) => setColorScheme(value as MantineColorScheme)}
        />
      </PreferenceRow>
    </PreferenceSection>
  );
}

function updateDetail(settings: DesktopSettingsState) {
  const update = settings.update;
  if (settings.restart_block_reason && update?.phase === 'ready') {
    return <span className="preference-attention">{settings.restart_block_reason}</span>;
  }
  if (update?.phase === 'downloading' && update.total_bytes) {
    return `Downloading ${formatBytes(update.downloaded_bytes)} of ${formatBytes(update.total_bytes)}`;
  }
  return update?.message ?? undefined;
}

export function GeneralSection({
  settings,
  onAction,
}: {
  settings: DesktopSettingsState;
  onAction: (action: DesktopSettingsAction) => void;
}) {
  const update = settings.update;
  const working =
    settings.update_busy || ['checking', 'downloading', 'installing'].includes(update?.phase ?? '');
  return (
    <PreferenceSection title="General">
      <PreferenceRow label="Open at sign-in">
        <Switch
          aria-label="Open Exalto Capture at sign-in"
          checked={settings.launch_at_login}
          disabled={!settings.launch_ready}
          onChange={(event) =>
            onAction({ action: 'set_launch_at_login', enabled: event.currentTarget.checked })
          }
        />
      </PreferenceRow>
      <PreferenceRow label={`Version ${settings.app_version}`} detail={updateDetail(settings)}>
        {update?.phase === 'ready' ? (
          <Button
            disabled={Boolean(settings.restart_block_reason) || working}
            onClick={() => onAction({ action: 'restart_to_update' })}
          >
            Restart to update
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={!update?.enabled || working}
            onClick={() => onAction({ action: 'check_for_updates' })}
          >
            Check now
          </Button>
        )}
      </PreferenceRow>
    </PreferenceSection>
  );
}

function serviceName(record: Notary, source: string | undefined, registry: string | null) {
  if (source === 'explicit_configuration') return 'Configured sealing service';
  if (source === 'registry' && registry === 'https://api.exalto.ai/api/registry')
    return 'Exalto Seal';
  return record.name.trim() || 'Registry sealing service';
}

function SealingSection({ api }: { api: LocalApi }) {
  const notaries = useQuery({ queryKey: ['notaries'], queryFn: api.notaries, retry: false });
  const data = notaries.data;
  const records = orderNotaries(data?.notaries ?? [], data?.active_key_id);
  const active = records.find((record) => record.key_id === data?.active_key_id) ?? records[0];
  return (
    <PreferenceSection title="Sealing">
      {notaries.isLoading ? (
        <PreferenceRow label="Sealing service" detail="Loading" />
      ) : notaries.error ? (
        <PreferenceRow label="Sealing service" detail="Unavailable">
          <Button variant="outline" onClick={() => notaries.refetch()}>
            Try again
          </Button>
        </PreferenceRow>
      ) : !active ? (
        <PreferenceRow label="Sealing service" detail="None configured" />
      ) : (
        <>
          <PreferenceRow
            label={serviceName(active, data?.source, data?.registry_source ?? null)}
            detail={data?.source === 'explicit_configuration' ? 'Local configuration' : undefined}
          >
            <StatusLabel state={active.lifecycle} />
          </PreferenceRow>
          <details className="preference-details">
            <summary>Details</summary>
            {records.map((record) => (
              <dl key={record.key_id} className="receipt-list">
                <Fact label="Signer" value={record.name.trim() || 'Not reported'} />
                <Fact label="Operator" value={record.operator} />
                <Fact label="Endpoint" value={record.endpoint} />
                <Fact label="Key ID" value={record.key_id} />
                <Fact label="Status" value={record.lifecycle} />
                <Fact
                  label="Capture cutoff"
                  value={formatNotaryBoundary(record.valid_until_unix_ms)}
                />
                <Fact
                  label="Sealing cutoff"
                  value={formatNotaryBoundary(record.notarize_until_unix_ms)}
                />
              </dl>
            ))}
          </details>
        </>
      )}
    </PreferenceSection>
  );
}

export function DesktopSettingsView({
  status,
  api,
  apiBaseUrl,
  desktopSettings,
  onDesktopAction,
}: {
  status: Status;
  api: LocalApi;
  apiBaseUrl?: string;
  desktopSettings: DesktopSettingsState;
  onDesktopAction: (action: DesktopSettingsAction) => void;
}) {
  const openApiUrl = `${(apiBaseUrl ?? window.location.origin).replace(/\/$/, '')}/openapi.json`;
  const copyOpenApi = async () => {
    await navigator.clipboard.writeText(openApiUrl);
    notifications.show({ message: 'OpenAPI URL copied' });
  };
  return (
    <div className="view-page preferences">
      <PreferenceSection title="Account">
        <AccountConnectionCard api={api} />
      </PreferenceSection>
      <SealingSection api={api} />
      <PreferenceSection title="Privacy">
        <PreferenceRow label="Private traces">
          <span className="preference-value">{desktopSettings.vault_label}</span>
        </PreferenceRow>
        <PreferenceRow label="Prompt previews" detail="Kept on this Mac outside the vault">
          <span className="preference-value">
            {status.preview_chars > 0
              ? `${status.preview_chars.toLocaleString()} characters`
              : 'Off'}
          </span>
        </PreferenceRow>
      </PreferenceSection>
      <AppearanceSection />
      <GeneralSection settings={desktopSettings} onAction={onDesktopAction} />
      <PreferenceSection title="Advanced">
        <PreferenceRow label="Provider proxy">
          <code>{status.proxy_listener}</code>
        </PreferenceRow>
        <PreferenceRow label="OpenAPI">
          <span className="preference-value">
            <code>{openApiUrl}</code>
            <ActionIcon variant="subtle" onClick={copyOpenApi} aria-label="Copy OpenAPI URL">
              <Copy size={14} />
            </ActionIcon>
          </span>
        </PreferenceRow>
        <PreferenceRow label="Build">
          <code>
            App {desktopSettings.app_build_id} · Service {status.build_id}
          </code>
        </PreferenceRow>
      </PreferenceSection>
      {desktopSettings.notice && <p className="preference-notice">{desktopSettings.notice}</p>}
    </div>
  );
}
