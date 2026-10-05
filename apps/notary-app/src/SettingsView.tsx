import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import {
  type DesktopSettingsAction,
  type DesktopSettingsState,
  InlineDashboard,
} from '../../../runtime/apps/admin-dashboard/src/Dashboard';
import type { DashboardRoute } from '../../../runtime/apps/admin-dashboard/src/routes';
import {
  AppearanceSection,
  GeneralSection,
  PreferenceRow,
  PreferenceSection,
} from '../../../runtime/apps/admin-dashboard/src/views/DesktopSettingsView';
import {
  type DesktopState,
  type DesktopUpdateState,
  errorMessage,
  getLaunchAtLogin,
  localApi,
  setLaunchAtLogin,
} from './bridge';
import {
  type TraceConstraint,
  type TraceTarget,
  updateRestartBlockReason,
  type View,
  vaultProtection,
  type WorkspaceView,
} from './product';

function dashboardRoute(
  route: WorkspaceView,
  constraint: TraceConstraint | null,
  traceTarget: TraceTarget | null,
): DashboardRoute {
  if (route === 'traces' && traceTarget) {
    return { view: route, id: traceTarget.traceId, action: traceTarget.action };
  }
  if (route === 'traces' && constraint) {
    const [key, value] = constraint.split('=');
    return {
      view: route,
      filters:
        key === 'state'
          ? { state: value as 'captured' | 'notarized' }
          : { status: value as 'notarizing' | 'needs_attention' },
    };
  }
  return { view: route };
}

export function SettingsView({
  route,
  constraint,
  traceTarget,
  onTraceActionConsumed,
  state,
  updateState,
  busy,
  notice,
  serviceError,
  onCheckUpdate,
  onRestartToUpdate,
  onStartService,
  onNavigate,
}: {
  route: WorkspaceView;
  constraint: TraceConstraint | null;
  traceTarget: TraceTarget | null;
  onTraceActionConsumed: (traceId: string, action: 'first-proof') => void;
  state: DesktopState;
  updateState: DesktopUpdateState | null;
  busy: string | null;
  notice: string | null;
  serviceError: string | null;
  onCheckUpdate: () => void;
  onRestartToUpdate: () => void;
  onStartService: () => void;
  onNavigate: (view: View, route?: DashboardRoute) => void;
}) {
  const [launch, setLaunch] = useState(false);
  const [launchReady, setLaunchReady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const vault = vaultProtection(state.vault_mode);

  useEffect(() => {
    void getLaunchAtLogin()
      .then((enabled) => setLaunch(enabled))
      .catch((error) => setMessage(errorMessage(error)))
      .finally(() => setLaunchReady(true));
  }, []);

  const changeLaunch = async (enabled: boolean) => {
    setMessage(null);
    try {
      await setLaunchAtLogin(enabled);
      setLaunch(enabled);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const handleDesktopAction = (action: DesktopSettingsAction) => {
    if (action.action === 'set_launch_at_login') void changeLaunch(action.enabled);
    if (action.action === 'check_for_updates') onCheckUpdate();
    if (action.action === 'restart_to_update') onRestartToUpdate();
  };

  const desktopSettings: DesktopSettingsState = {
    launch_at_login: launch,
    launch_ready: launchReady,
    vault_label: vault.label,
    app_version: state.app_version,
    app_build_id: state.app_build_id,
    update: updateState,
    update_busy: busy === 'update-check' || busy === 'update-install',
    restart_block_reason: updateRestartBlockReason(state),
    notice: message ?? notice,
  };

  if (!state.running && route !== 'settings') {
    return (
      <div className="native-page workspace-offline-page">
        <section>
          <h1>Local service is off</h1>
          <p>
            Start the local service to inspect private traces and connections. Capture remains off.
          </p>
          <button
            className="mac-button is-primary"
            type="button"
            onClick={onStartService}
            disabled={busy === 'service-start'}
          >
            {busy === 'service-start' ? 'Starting local service…' : 'Start local service'}
          </button>
          {serviceError && (
            <p className="native-notice" role="alert">
              {serviceError}
            </p>
          )}
        </section>
      </div>
    );
  }

  if (!state.running && route === 'settings') {
    return (
      <div className="native-page inline-dashboard-page">
        <main className="dashboard-shell dashboard-shell--inline dashboard-main">
          <div className="view-page preferences">
            <PreferenceSection title="Account">
              <PreferenceRow
                label="Local service is off"
                detail={
                  serviceError ? (
                    <span className="preference-attention" role="alert">
                      {serviceError}
                    </span>
                  ) : (
                    'Start it to connect an account.'
                  )
                }
              >
                <Button loading={busy === 'service-start'} onClick={onStartService}>
                  Start local service
                </Button>
              </PreferenceRow>
            </PreferenceSection>
            <PreferenceSection title="Privacy">
              <PreferenceRow label="Private traces">
                <span className="preference-value">{vault.label}</span>
              </PreferenceRow>
            </PreferenceSection>
            <AppearanceSection />
            <GeneralSection settings={desktopSettings} onAction={handleDesktopAction} />
            <PreferenceSection title="Advanced">
              <PreferenceRow label="Provider proxy">
                <code>{state.proxy_listener}</code>
              </PreferenceRow>
              <PreferenceRow label="Build">
                <code>App {state.app_build_id}</code>
              </PreferenceRow>
            </PreferenceSection>
            {desktopSettings.notice && (
              <p className="preference-notice">{desktopSettings.notice}</p>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="native-page inline-dashboard-page">
      <InlineDashboard
        key={`${route}:${constraint ?? ''}:${traceTarget?.traceId ?? ''}:${traceTarget?.action ?? ''}`}
        api={localApi}
        apiBaseUrl="http://127.0.0.1:8788"
        route={dashboardRoute(route, constraint, traceTarget)}
        desktopSettings={desktopSettings}
        onDesktopSettingsAction={handleDesktopAction}
        desktopShell
        onNavigate={(next) => onNavigate(next.view as View, next)}
        onTraceActionConsumed={onTraceActionConsumed}
      />
    </div>
  );
}
