use std::{sync::Mutex, time::Duration};

use notary_core::vault::CHILD_KEY_STDIN_ENV;
use tauri::Manager;
use tauri_plugin_shell::{ShellExt, process::CommandChild};

use crate::service_client::daemon_is_healthy;
use crate::vault::{VaultSession, local_vault_mode, vault_unlock_key_for_child};

const DESKTOP_CONTROL_STDIN_ENV: &str = "NOTARYD_DESKTOP_CONTROL_STDIN";

#[derive(Default)]
pub(super) struct DaemonProcess(pub(super) Mutex<Option<CommandChild>>);

pub(super) fn spawn_daemon(app: &tauri::AppHandle, process: &DaemonProcess) -> Result<(), String> {
    let vault_session = app.state::<VaultSession>();
    let unlock_key = vault_unlock_key_for_child(&vault_session)?;
    let (mut events, mut child) = app
        .shell()
        .sidecar("notaryd")
        .map_err(|error| format!("Could not locate the bundled notaryd service: {error}"))?
        .env(CHILD_KEY_STDIN_ENV, "1")
        .env(DESKTOP_CONTROL_STDIN_ENV, "1")
        .spawn()
        .map_err(|error| format!("Could not start the bundled notaryd service: {error}"))?;

    if let Err(error) = child.write(&unlock_key) {
        return Err(format!(
            "Could not send the unlocked capture key to the local service: {error}"
        ));
    }
    drop(unlock_key);

    *process
        .0
        .lock()
        .map_err(|_| "daemon process state is unavailable")? = Some(child);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(
                event,
                tauri_plugin_shell::process::CommandEvent::Terminated(_)
            ) {
                if let Ok(mut guard) = app_handle.state::<DaemonProcess>().0.lock() {
                    *guard = None;
                }
                break;
            }
        }
    });
    Ok(())
}

pub(super) async fn request_managed_daemon_shutdown(
    process: &DaemonProcess,
) -> Result<bool, String> {
    {
        let mut guard = process
            .0
            .lock()
            .map_err(|_| "daemon process state is unavailable")?;
        let Some(child) = guard.as_mut() else {
            return Ok(false);
        };
        child
            .write(b"shutdown\n")
            .map_err(|error| format!("Could not request a safe local-service shutdown: {error}"))?;
    }
    for _ in 0..6_000 {
        let stopped = process
            .0
            .lock()
            .map_err(|_| "daemon process state is unavailable")?
            .is_none();
        if stopped {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(
        "The local service is still draining work after ten minutes. It was left running; try again after active work finishes."
            .into(),
    )
}

#[tauri::command]
pub(super) async fn start_daemon(
    app: tauri::AppHandle,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<(), String> {
    if daemon_is_healthy().await {
        return Ok(());
    }
    if !local_vault_mode().0 {
        return Err("Choose how to protect private captures before starting the service.".into());
    }
    let already_starting = process
        .0
        .lock()
        .map_err(|_| "daemon process state is unavailable")?
        .is_some();
    if !already_starting {
        spawn_daemon(&app, &process)?;
    }
    for _ in 0..50 {
        if daemon_is_healthy().await {
            return Ok(());
        }
        let still_running = process
            .0
            .lock()
            .map_err(|_| "daemon process state is unavailable")?
            .is_some();
        if !still_running {
            return Err("The bundled local service exited before becoming ready.".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("The bundled local service did not become ready within five seconds.".into())
}

#[tauri::command]
pub(super) async fn stop_daemon(process: tauri::State<'_, DaemonProcess>) -> Result<(), String> {
    match request_managed_daemon_shutdown(&process).await? {
        true => Ok(()),
        false if daemon_is_healthy().await => Err(
            "This service was started outside the desktop app. Stop it from the process that launched it."
                .into(),
        ),
        false => Ok(()),
    }
}

#[tauri::command]
pub(super) async fn restart_daemon(
    app: tauri::AppHandle,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<(), String> {
    let stopped = request_managed_daemon_shutdown(&process).await?;
    if !stopped && daemon_is_healthy().await {
        return Err(
            "This service was started outside the desktop app. Restart it from the process that launched it."
                .into(),
        );
    }
    spawn_daemon(&app, &process)
}
