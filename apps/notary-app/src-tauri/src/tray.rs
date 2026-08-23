use std::time::Duration;

use tauri::{
    Manager,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

use crate::service_client::{read_admin_status, write_capture_setting};

pub(super) fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(super) fn create_tray(app: &tauri::App) -> tauri::Result<CheckMenuItem<tauri::Wry>> {
    let open_app = MenuItem::with_id(app, "open_app", "Open Notary", true, None::<&str>)?;
    let capture_requests = CheckMenuItem::with_id(
        app,
        "capture_requests",
        "Capture new requests — service stopped",
        false,
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Notary", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_app, &capture_requests, &separator, &quit])?;

    #[cfg(target_os = "macos")]
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    #[cfg(not(target_os = "macos"))]
    let tray_icon = app.default_window_icon().expect("application icon").clone();

    TrayIconBuilder::with_id("notary")
        .icon(tray_icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Notary")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event({
            let capture_requests = capture_requests.clone();
            move |app, event| match event.id().as_ref() {
                "open_app" => show_main_window(app),
                "capture_requests" => {
                    let requested = capture_requests.is_checked().unwrap_or(false);
                    let capture_requests = capture_requests.clone();
                    tauri::async_runtime::spawn(async move {
                        match write_capture_setting(requested).await {
                            Ok(enabled) => {
                                let _ = capture_requests.set_checked(enabled);
                                let _ = capture_requests.set_text("Capture new requests");
                                let _ = capture_requests.set_enabled(true);
                            }
                            Err(_) => {
                                let _ = capture_requests.set_checked(!requested);
                                let _ =
                                    capture_requests.set_text("Capture new requests — unavailable");
                                let _ = capture_requests.set_enabled(false);
                            }
                        }
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(capture_requests)
}

pub(super) fn schedule_capture_menu_updates(capture_requests: CheckMenuItem<tauri::Wry>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match read_admin_status().await {
                Ok(status) => {
                    let _ = capture_requests.set_checked(status.capture_enabled);
                    let _ = capture_requests.set_text("Capture new requests");
                    let _ = capture_requests.set_enabled(true);
                }
                Err(_) => {
                    let _ = capture_requests.set_text("Capture new requests — service stopped");
                    let _ = capture_requests.set_enabled(false);
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}
