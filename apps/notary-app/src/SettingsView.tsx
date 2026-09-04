import { useEffect, useState } from 'react';
import {
  errorMessage,
  getLaunchAtLogin,
  setLaunchAtLogin,
  type DesktopState,
  type DesktopUpdateState,
} from './bridge';
import { updateRestartBlockReason, vaultProtection, type View } from './product';
import {
  type DesktopSettingsAction,
  type DesktopSettingsPayload,
  WorkspaceFrame,
} from './Shell';

export function SettingsView({
  state,
  updateState,
  busy,
  notice,
  serviceError,
  onCheckUpdate,
  onRestartToUpdate,
  onStartService,
  onNavigate,
  allowLegacyWorkspace,
}: {
  state: DesktopState;
  updateState: DesktopUpdateState | null;
  busy: string | null;
  notice: string | null;
  serviceError: string | null;
  onCheckUpdate: () => void;
  onRestartToUpdate: () => void;
  onStartService: () => void;
  onNavigate: (view: View) => void;
  allowLegacyWorkspace: boolean;
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
      setMessage(enabled ? 'Open at sign-in is on.' : 'Open at sign-in is off.');
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const handleDesktopAction = (action: DesktopSettingsAction) => {
    if (action.action === 'set_launch_at_login') void changeLaunch(action.enabled);
    if (action.action === 'check_for_updates') onCheckUpdate();
    if (action.action === 'restart_to_update') onRestartToUpdate();
  };

  const desktopSettings: DesktopSettingsPayload = {
    launch_at_login: launch,
    launch_ready: launchReady,
    vault_label: vault.label,
    vault_detail: vault.detail,
    app_version: state.app_version,
    app_build_id: state.app_build_id,
    update: updateState,
    update_busy: busy === 'update-check' || busy === 'update-install',
    restart_block_reason: updateRestartBlockReason(state),
    notice: message ?? notice,
  };

  if (!state.running) {
    const restartBlock = updateRestartBlockReason(state);
    const updateBusy = busy === 'update-check' || busy === 'update-install';
    return (
      <div className="native-page preferences-page offline-settings-page">
        <section className="preference-section">
          <h2>Connections</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>AI connections and Exalto account</strong>
                <span>Start the local service to manage connections. Capture remains off.</span>
              </div>
              <button className="mac-button is-primary" type="button" onClick={onStartService} disabled={busy === 'service-start'}>
                {busy === 'service-start' ? 'Starting…' : 'Start local service'}
              </button>
            </div>
            <p className="preference-note">Connecting an account never uploads or shares a local trace automatically.</p>
            {serviceError && <p className="preference-note native-notice service-start-notice" role="alert">{serviceError}</p>}
          </div>
        </section>
        <section className="preference-section">
          <h2>Privacy &amp; storage</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>Local data · {vault.label}</strong>
                <span>{vault.detail}</span>
              </div>
            </div>
            <div className="preference-row">
              <div>
                <strong>{state.sealing_service?.name ?? 'Sealing service'}</strong>
                <span>Sealing-service details are available after the local service starts.</span>
              </div>
            </div>
            <p className="preference-note">Changing protection requires a guided migration of existing private traces.</p>
          </div>
        </section>
        <section className="preference-section">
          <h2>App</h2>
          <div className="preference-group">
            <label className="preference-row">
              <div>
                <strong>Open Exalto Capture at sign-in</strong>
                <span>Closing the window leaves Exalto Capture available from the menu bar.</span>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={launch}
                disabled={!launchReady}
                onChange={(event) => void changeLaunch(event.target.checked)}
              />
            </label>
            <div className="preference-row">
              <div>
                <strong>Exalto Capture {state.app_version}</strong>
                <span>{updateState?.message ?? 'Signed release updates are unavailable in this build.'}</span>
              </div>
              {updateState?.phase === 'ready' ? (
                <button
                  className="mac-button is-primary"
                  disabled={Boolean(restartBlock) || updateBusy}
                  onClick={onRestartToUpdate}
                >
                  Restart to update
                </button>
              ) : (
                <button
                  className="mac-button"
                  disabled={!updateState?.enabled || updateBusy}
                  onClick={onCheckUpdate}
                >
                  Check now
                </button>
              )}
            </div>
            {restartBlock && <p className="preference-note update-block-note">{restartBlock}</p>}
            <p className="preference-note">Updates are checked against this app's installed macOS identity before installation.</p>
          </div>
        </section>
        <section className="preference-section">
          <h2>Advanced</h2>
          <div className="preference-group compact-rows">
            <div className="preference-row"><strong>Service · Provider proxy</strong><code>{state.proxy_listener}</code></div>
            <div className="preference-row"><strong>Service · Administration</strong><code>{state.admin_listener}</code></div>
            <div className="preference-row"><strong>Service build</strong><code>Not running</code></div>
            <div className="preference-row"><strong>Developer · App build</strong><code>{state.app_build_id}</code></div>
          </div>
        </section>
        {(notice || message) && <div className="native-notice">{message ?? notice}</div>}
      </div>
    );
  }

  return (
    <div className="native-page embedded-settings-page">
      <WorkspaceFrame
        route="settings"
        running={state.running}
        desktopSettings={desktopSettings}
        onDesktopSettingsAction={handleDesktopAction}
        onRouteChange={onNavigate}
        allowLegacyFrameLoadFallback={allowLegacyWorkspace}
      />
    </div>
  );
}
