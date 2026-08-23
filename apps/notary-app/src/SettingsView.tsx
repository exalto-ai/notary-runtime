import { useEffect, useState } from 'react';
import {
  errorMessage,
  getLaunchAtLogin,
  setLaunchAtLogin,
  type DesktopState,
  type DesktopUpdateState,
} from './bridge';
import { updateRestartBlockReason, vaultProtection } from './product';
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
  onCheckUpdate,
  onRestartToUpdate,
}: {
  state: DesktopState;
  updateState: DesktopUpdateState | null;
  busy: string | null;
  notice: string | null;
  onCheckUpdate: () => void;
  onRestartToUpdate: () => void;
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
          <h2>General</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>Capture new requests</strong>
                <span>Unavailable while the local service is stopped.</span>
              </div>
              <input type="checkbox" role="switch" aria-label="Capture new requests" disabled />
            </div>
            <label className="preference-row">
              <div>
                <strong>Open Notary at sign-in</strong>
                <span>Closing the window leaves Notary available from the menu bar.</span>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={launch}
                disabled={!launchReady}
                onChange={(event) => void changeLaunch(event.target.checked)}
              />
            </label>
          </div>
        </section>
        <section className="preference-section">
          <h2>Account</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>Connection unavailable</strong>
                <span>The local service must be running to connect or disconnect an account.</span>
              </div>
            </div>
            <p className="preference-note">No local Trace is uploaded or shared by connecting an account.</p>
          </div>
        </section>
        <section className="preference-section">
          <h2>Security</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>Local data · {vault.label}</strong>
                <span>{vault.detail}</span>
              </div>
            </div>
            <div className="preference-row">
              <div>
                <strong>Notaries</strong>
                <span>Notary details are available after the local service starts.</span>
              </div>
            </div>
            <p className="preference-note">Changing protection requires a guided migration of existing private Traces.</p>
          </div>
        </section>
        <section className="preference-section">
          <h2>Updates</h2>
          <div className="preference-group">
            <div className="preference-row">
              <div>
                <strong>Notary {state.app_version}</strong>
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
            <p className="preference-note">Updates are signature-checked for ai.exalto.notary before installation.</p>
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
      />
    </div>
  );
}
