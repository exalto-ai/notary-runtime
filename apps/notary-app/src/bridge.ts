import { invoke } from '@tauri-apps/api/core';

export type TraceCounts = {
  captured: number;
  notarizing: number;
  notarized: number;
  needs_attention: number;
  capturing: number;
  capture_failed: number;
};

export type DesktopState = {
  running: boolean;
  managed_by_desktop: boolean;
  vault_configured: boolean;
  agent_configured: boolean;
  onboarding_complete: boolean;
  vault_mode: string;
  vault_locked: boolean;
  version: string | null;
  app_version: string;
  app_build_id: string;
  daemon_build_id: string | null;
  proxy_listener: string;
  admin_listener: string;
  notary: string | null;
  capture_enabled: boolean;
  counts: TraceCounts;
  message: string | null;
};

export type DesktopUpdateState = {
  enabled: boolean;
  phase: 'disabled' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error';
  current_build_id: string;
  latest_build_id: string | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  message: string | null;
};

export type AccountConnectionState = 'disconnected' | 'connected' | 'reauthorization_required' | 'unavailable';

export type AccountCreditBalance = {
  total_granted_bytes: number;
  total_used_bytes: number;
  total_remaining_bytes: number;
  included_monthly_remaining_bytes: number;
  supplemental_remaining_bytes: number;
  next_grant_expiration?: number | null;
};

export type AccountConnection = {
  signed_in: boolean;
  connection_state?: AccountConnectionState | null;
  provider_display_name?: string | null;
  display_name?: string | null;
  auth_provider?: string | null;
  device_name?: string | null;
  credential_kind?: string | null;
  credential_name?: string | null;
  billing?: { plan: string; billing_status: string; purchase_mode?: string | null } | null;
  credits?: { capture: AccountCreditBalance; notarization: AccountCreditBalance; reset_at: number } | null;
  links?: { account: string; usage: string; plans: string; settings: string } | null;
};

export type AccountConnectionStarted = {
  request_id: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in_seconds: number;
  poll_interval_seconds: number;
  state: string;
};

const emptyCounts: TraceCounts = {
  captured: 0,
  notarizing: 0,
  notarized: 0,
  needs_attention: 0,
  capturing: 0,
  capture_failed: 0,
};

export const isTauri = () => '__TAURI_INTERNALS__' in window;

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function fallbackState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    running: false,
    managed_by_desktop: false,
    vault_configured: true,
    agent_configured: true,
    onboarding_complete: true,
    vault_mode: 'keychain',
    vault_locked: false,
    version: null,
    app_version: '0.1.0',
    app_build_id: 'dev',
    daemon_build_id: null,
    proxy_listener: '127.0.0.1:8787',
    admin_listener: '127.0.0.1:8788',
    notary: null,
    capture_enabled: false,
    counts: emptyCounts,
    message: null,
    ...overrides,
  };
}

function forcedState(): DesktopState | null {
  const screen = new URLSearchParams(window.location.search).get('screen');
  if (screen === 'onboarding') {
    return fallbackState({
      vault_configured: false,
      agent_configured: false,
      onboarding_complete: false,
      vault_mode: 'not configured',
      vault_locked: false,
    });
  }
  if (screen === 'unlock') {
    return fallbackState({
      running: false,
      vault_mode: 'passphrase',
      vault_locked: true,
    });
  }
  if (screen === 'offline') {
    return fallbackState({
      message: 'The local service is not responding.',
    });
  }
  if (screen === 'capture-off' || screen === 'capture-on') {
    return fallbackState({
      running: true,
      managed_by_desktop: true,
      capture_enabled: screen === 'capture-on',
      version: '0.1.0',
      daemon_build_id: 'dev',
      notary: 'registry',
      counts: { ...emptyCounts, captured: 3, notarizing: 1, notarized: 8, needs_attention: 2 },
    });
  }
  return null;
}

export async function getDesktopState(): Promise<DesktopState> {
  const forced = forcedState();
  if (forced) return forced;
  if (isTauri()) return invoke<DesktopState>('get_desktop_state');

  try {
    const response = await fetch('/admin-api/v1/status');
    if (!response.ok) throw new Error(`Local service returned ${response.status}`);
    const status = await response.json();
    return {
      running: true,
      managed_by_desktop: false,
      vault_configured: status.vault !== 'unavailable',
      agent_configured: true,
      onboarding_complete: true,
      vault_mode: status.vault === 'OS vault' ? 'keychain' : 'passphrase',
      vault_locked: false,
      version: status.version,
      app_version: '0.1.0',
      app_build_id: 'dev',
      daemon_build_id: status.build_id ?? null,
      proxy_listener: status.proxy_listener,
      admin_listener: status.admin_listener,
      notary: status.notary,
      capture_enabled: status.capture_enabled,
      counts: status.counts,
      message: null,
    };
  } catch (error) {
    return fallbackState({ message: errorMessage(error) });
  }
}

export async function configureVault(mode: 'keychain' | 'passphrase', passphrase?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('configure_vault', { mode, passphrase });
}

export async function unlockVault(passphrase: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('unlock_vault', { passphrase });
}

export async function completeOnboarding(): Promise<void> {
  if (!isTauri()) return;
  await invoke('complete_onboarding');
}

export async function startDaemon(): Promise<void> {
  if (!isTauri()) return;
  await invoke('start_daemon');
}

export async function stopDaemon(): Promise<void> {
  if (!isTauri()) return;
  await invoke('stop_daemon');
}

export async function restartDaemon(): Promise<void> {
  if (!isTauri()) return;
  await invoke('restart_daemon');
}

export async function getUpdateState(): Promise<DesktopUpdateState> {
  if (!isTauri()) {
    const preview = new URLSearchParams(window.location.search).get('update');
    if (preview === 'ready') {
      return {
        enabled: true,
        phase: 'ready',
        current_build_id: 'preview-build-a',
        latest_build_id: 'preview-build-b',
        downloaded_bytes: 42 * 1024 * 1024,
        total_bytes: 42 * 1024 * 1024,
        message: 'The latest release is ready. Restart when local work is idle.',
      };
    }
    if (preview === 'downloading') {
      return {
        enabled: true,
        phase: 'downloading',
        current_build_id: 'preview-build-a',
        latest_build_id: 'preview-build-b',
        downloaded_bytes: 24 * 1024 * 1024,
        total_bytes: 42 * 1024 * 1024,
        message: 'Downloading the signed update…',
      };
    }
    return {
      enabled: false,
      phase: 'disabled',
      current_build_id: 'dev',
      latest_build_id: null,
      downloaded_bytes: 0,
      total_bytes: null,
      message: 'Automatic updates are available in signed release builds.',
    };
  }
  return invoke<DesktopUpdateState>('get_update_state');
}

export async function checkForUpdates(): Promise<DesktopUpdateState> {
  if (!isTauri()) return getUpdateState();
  return invoke<DesktopUpdateState>('check_for_updates');
}

export async function installUpdateAndRestart(): Promise<void> {
  if (!isTauri()) return;
  await invoke('install_update_and_restart');
}

export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isTauri()) return localStorage.getItem('notary-launch-at-login') === 'true';
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem('notary-launch-at-login', String(enabled));
    return;
  }
  const plugin = await import('@tauri-apps/plugin-autostart');
  if (enabled) await plugin.enable();
  else await plugin.disable();
}

async function browserAccountRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/admin-api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  if (!response.ok) throw new Error(`Local account request failed (${response.status})`);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function getAccountConnection(): Promise<AccountConnection> {
  if (!isTauri()) return browserAccountRequest<AccountConnection>('/v1/account');
  return invoke<AccountConnection>('get_account_connection');
}

export async function startAccountConnection(): Promise<AccountConnectionStarted> {
  if (!isTauri()) return browserAccountRequest<AccountConnectionStarted>('/v1/account', { method: 'POST', body: '{}' });
  return invoke<AccountConnectionStarted>('start_account_connection');
}

export async function pollAccountConnection(requestId: string): Promise<AccountConnection> {
  if (!isTauri()) return browserAccountRequest<AccountConnection>(`/v1/account/${encodeURIComponent(requestId)}`);
  return invoke<AccountConnection>('poll_account_connection', { requestId });
}

export async function disconnectAccount(): Promise<void> {
  if (!isTauri()) return browserAccountRequest<void>('/v1/account', { method: 'DELETE' });
  await invoke('disconnect_account');
}

export async function openAccountLink(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await invoke('open_account_link', { url });
}
