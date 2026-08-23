use std::sync::atomic::{AtomicBool, Ordering};

use notaryctl::client::TraceCounts;
use serde::Serialize;
use tauri::Manager;

mod daemon;
mod service_client;
mod tray;
mod updates;
mod vault;

use daemon::{
    DaemonProcess, request_managed_daemon_shutdown, restart_daemon, start_daemon, stop_daemon,
};
use service_client::{
    daemon_is_healthy, disconnect_account, get_account_connection, open_account_link,
    poll_account_connection, read_admin_status, start_account_connection,
};
use tray::{create_tray, schedule_capture_menu_updates, show_main_window};
use updates::{
    DesktopUpdaterState, check_for_updates, get_update_state, install_update_and_restart,
    schedule_update_checks,
};
use vault::{
    VaultSession, agent_config_path, complete_onboarding, configure_vault, local_vault_mode,
    onboarding_marker_path, passphrase_vault_is_locked, should_auto_start, unlock_vault,
};

#[cfg(test)]
use service_client::validate_account_link;
#[cfg(test)]
use updates::{
    build_ids_require_update, desktop_updates_enabled, pending_build_is_latest,
    restart_block_reason,
};

#[derive(Default)]
struct ExitState {
    allowed: AtomicBool,
    draining: AtomicBool,
}

#[derive(Debug, Serialize)]
struct DesktopState {
    running: bool,
    managed_by_desktop: bool,
    vault_configured: bool,
    agent_configured: bool,
    onboarding_complete: bool,
    vault_mode: String,
    vault_locked: bool,
    version: Option<String>,
    app_version: String,
    app_build_id: String,
    daemon_build_id: Option<String>,
    proxy_listener: String,
    admin_listener: String,
    notary: Option<String>,
    capture_enabled: bool,
    counts: TraceCounts,
    message: Option<String>,
}

#[tauri::command]
async fn get_desktop_state(
    process: tauri::State<'_, DaemonProcess>,
    vault_session: tauri::State<'_, VaultSession>,
) -> Result<DesktopState, String> {
    let (vault_configured, local_mode) = local_vault_mode();
    let agent_configured = agent_config_path().is_ok_and(|path| path.exists());
    let onboarding_complete = onboarding_marker_path().is_ok_and(|path| path.exists());
    let managed_by_desktop = process
        .0
        .lock()
        .map_err(|_| "daemon process state is unavailable")?
        .is_some();

    match read_admin_status().await {
        Ok(status) => {
            let daemon_build_id = status.build_id.clone();
            let message = (daemon_build_id != env!("NOTARY_BUILD_ID")).then(|| {
                "The app and running local service are different builds. Update or restart the separately installed service before relying on new client behavior."
                    .into()
            });
            Ok(DesktopState {
                running: true,
                managed_by_desktop,
                vault_configured,
                agent_configured,
                onboarding_complete,
                vault_mode: match status.vault.as_str() {
                    "OS vault" => "keychain".into(),
                    "passphrase vault" => local_mode,
                    _ => status.vault,
                },
                vault_locked: false,
                version: Some(status.version),
                app_version: env!("CARGO_PKG_VERSION").into(),
                app_build_id: env!("NOTARY_BUILD_ID").into(),
                daemon_build_id: Some(daemon_build_id),
                proxy_listener: status.proxy_listener,
                admin_listener: status.admin_listener,
                notary: Some(status.notary),
                capture_enabled: status.capture_enabled,
                counts: status.counts,
                message,
            })
        }
        Err(error) => {
            let running = daemon_is_healthy().await;
            Ok(DesktopState {
                running,
                managed_by_desktop,
                vault_configured,
                agent_configured,
                onboarding_complete,
                vault_locked: passphrase_vault_is_locked(&local_mode, &vault_session),
                vault_mode: local_mode,
                version: None,
                app_version: env!("CARGO_PKG_VERSION").into(),
                app_build_id: env!("NOTARY_BUILD_ID").into(),
                daemon_build_id: None,
                proxy_listener: "127.0.0.1:8787".into(),
                admin_listener: "127.0.0.1:8788".into(),
                notary: None,
                capture_enabled: false,
                counts: TraceCounts::default(),
                message: if running { Some(error) } else { None },
            })
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(DaemonProcess::default())
        .manage(VaultSession::default())
        .manage(ExitState::default())
        .manage(DesktopUpdaterState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(include_str!("../../../../runtime/config/updater-public-key.txt").trim())
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_desktop_state,
            get_account_connection,
            start_account_connection,
            poll_account_connection,
            disconnect_account,
            open_account_link,
            configure_vault,
            unlock_vault,
            complete_onboarding,
            start_daemon,
            stop_daemon,
            restart_daemon,
            get_update_state,
            check_for_updates,
            install_update_and_restart,
        ])
        .setup(|app| {
            let capture_requests = create_tray(app)?;
            schedule_capture_menu_updates(capture_requests);
            schedule_update_checks(app.handle().clone());
            let (vault_configured, vault_mode) = local_vault_mode();
            let onboarding_complete = onboarding_marker_path().is_ok_and(|path| path.exists());
            if should_auto_start(vault_configured, &vault_mode, onboarding_complete) {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let process = app_handle.state::<DaemonProcess>();
                    let _ = start_daemon(app_handle.clone(), process).await;
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                #[cfg(target_os = "macos")]
                let _ = window
                    .app_handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Notary desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
            let exit = app.state::<ExitState>();
            if exit.allowed.load(Ordering::Acquire) {
                return;
            }
            let managed = app
                .state::<DaemonProcess>()
                .0
                .lock()
                .is_ok_and(|process| process.is_some());
            if !managed {
                return;
            }
            api.prevent_exit();
            if exit
                .draining
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return;
            }
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let process = app_handle.state::<DaemonProcess>();
                match request_managed_daemon_shutdown(&process).await {
                    Ok(_) => {
                        app_handle
                            .state::<ExitState>()
                            .allowed
                            .store(true, Ordering::Release);
                        app_handle.exit(code.unwrap_or(0));
                    }
                    Err(error) => {
                        eprintln!("Could not drain the local service before exit: {error}");
                        app_handle
                            .state::<ExitState>()
                            .draining
                            .store(false, Ordering::Release);
                        show_main_window(&app_handle);
                    }
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_build_identity_controls_desktop_updates() {
        assert!(!desktop_updates_enabled("dev", "1"));
        assert!(!desktop_updates_enabled("signed-preview", "0"));
        assert!(!build_ids_require_update("build-a", "build-a"));
        assert!(build_ids_require_update("build-a", "build-b"));
        assert!(build_ids_require_update("newer-build", "older-build"));
        assert!(pending_build_is_latest(Some("build-b"), "build-b"));
        assert!(!pending_build_is_latest(Some("build-b"), "build-a"));
    }

    #[test]
    fn active_local_work_and_external_services_block_restart() {
        let mut counts = TraceCounts {
            capturing: 1,
            ..TraceCounts::default()
        };
        assert!(restart_block_reason(&counts, true, true).is_some());
        counts.capturing = 0;
        counts.notarizing = 1;
        assert!(restart_block_reason(&counts, true, true).is_some());
        counts.notarizing = 0;
        assert!(restart_block_reason(&counts, true, false).is_some());
        assert!(restart_block_reason(&counts, true, true).is_none());
        assert!(restart_block_reason(&counts, false, false).is_none());
    }

    #[test]
    fn daemon_counts_round_trip_through_the_shared_client_contract() {
        let counts: TraceCounts = serde_json::from_value(serde_json::json!({
            "captured": 3,
            "notarizing": 1,
            "notarized": 8,
            "needs_attention": 2,
            "capturing": 1,
            "capture_failed": 1
        }))
        .unwrap();

        assert_eq!(
            serde_json::to_value(&counts).unwrap(),
            serde_json::json!({
                "captured": 3,
                "notarizing": 1,
                "notarized": 8,
                "needs_attention": 2,
                "capturing": 1,
                "capture_failed": 1
            })
        );
    }

    #[test]
    fn passphrase_vaults_wait_for_an_in_memory_unlock() {
        let session = VaultSession::default();
        assert!(passphrase_vault_is_locked("passphrase", &session));
        assert!(!passphrase_vault_is_locked("keychain", &session));
        assert!(!passphrase_vault_is_locked("convenience", &session));
        assert!(!should_auto_start(true, "passphrase", true));
        assert!(should_auto_start(true, "keychain", true));
        assert!(should_auto_start(true, "convenience", true));
        assert!(!should_auto_start(false, "keychain", true));
        assert!(!should_auto_start(true, "keychain", false));
    }

    #[test]
    fn account_links_allow_only_known_routes_and_device_authorization_parameters() {
        assert!(
            validate_account_link(
                "https://notary.example/authorize?request_id=abc&approval_secret=xyz"
            )
            .is_ok()
        );
        assert!(validate_account_link("https://notary.example/account/usage").is_ok());
        assert!(validate_account_link("https://notary.example/account/traces").is_ok());
        assert!(validate_account_link("https://notary.example/#/account/usage").is_ok());
        assert!(validate_account_link("https://notary.example/#/account/traces").is_ok());
        assert!(validate_account_link("https://notary.example/authorize?request_id=abc").is_err());
        assert!(
            validate_account_link("https://notary.example/authorize?request_id=abc&evil=xyz")
                .is_err()
        );
        assert!(validate_account_link("http://example.com/#/account").is_err());
    }
}
