use std::time::Duration;

use tauri::{
    Emitter, Manager,
    menu::{
        AboutMetadata, CheckMenuItem, HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu,
    },
    tray::TrayIconBuilder,
};

use crate::ExitState;
use crate::daemon::{DaemonProcess, start_daemon};
use crate::service_client::{TemporaryCaptureState, read_admin_status, write_capture_setting};

pub(super) const SAFE_HIDE_MENU_ID: &str = "app_hide";
pub(super) const CAPTURE_STATE_CHANGED_EVENT: &str = "exalto:capture-state-changed";
/// Menu-bar commands the web view carries out: a view name, `new-chat`, or `find`.
pub(super) const MENU_COMMAND_EVENT: &str = "exalto:menu";
const MENU_BAR_CAPTURE_ID: &str = "menu_capture_requests";
const CAPTURE_MENU_LABEL: &str = "Capture";
const OPEN_APP_MENU_LABEL: &str = "Open";
const QUIT_MENU_LABEL: &str = "Quit";

/// The tray and menu-bar capture toggles show one state.
#[derive(Clone)]
pub(super) struct CaptureMenuState {
    items: Vec<CheckMenuItem<tauri::Wry>>,
}

impl CaptureMenuState {
    fn set(&self, enabled: bool) {
        for item in &self.items {
            let _ = item.set_checked(enabled);
            let _ = item.set_enabled(true);
        }
    }

    pub(super) fn add(&mut self, item: CheckMenuItem<tauri::Wry>) {
        self.items.push(item);
    }

    fn menu_bar_checked(&self) -> bool {
        self.items
            .iter()
            .find(|item| item.id().as_ref() == MENU_BAR_CAPTURE_ID)
            .and_then(|item| item.is_checked().ok())
            .unwrap_or(false)
    }
}

/// Turn capture on or off from a menu, starting the daemon first when needed,
/// and publish the resulting state to every toggle and the web view.
pub(super) fn request_capture(app: &tauri::AppHandle, requested: bool) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if requested && read_admin_status().await.is_err() {
            let process = app_handle.state::<DaemonProcess>();
            if start_daemon(app_handle.clone(), process).await.is_err() {
                publish_capture_state(&app_handle, false);
                return;
            }
        }
        let temporary_capture = app_handle.state::<TemporaryCaptureState>();
        match write_capture_setting(requested, &temporary_capture).await {
            Ok(enabled) => publish_capture_state(&app_handle, enabled),
            Err(_) => publish_capture_state(&app_handle, !requested),
        }
    });
}

pub(super) fn publish_capture_state(app: &tauri::AppHandle, enabled: bool) {
    if let Some(menu) = app.try_state::<CaptureMenuState>() {
        menu.set(enabled);
    }
    let _ = app.emit(CAPTURE_STATE_CHANGED_EVENT, enabled);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AppMenuAction {
    Hide,
    Settings,
    HelpGuide,
    HelpReport,
    /// Sent to the web view as an `exalto:menu` command.
    Command(&'static str),
    ToggleCapture,
}

pub(super) fn app_menu_action(id: &str) -> Option<AppMenuAction> {
    match id {
        SAFE_HIDE_MENU_ID => Some(AppMenuAction::Hide),
        "app_settings" => Some(AppMenuAction::Settings),
        "help_guide" => Some(AppMenuAction::HelpGuide),
        "help_report" => Some(AppMenuAction::HelpReport),
        "file_new_chat" => Some(AppMenuAction::Command("new-chat")),
        "view_home" => Some(AppMenuAction::Command("home")),
        "view_chat" => Some(AppMenuAction::Command("chat")),
        "view_traces" => Some(AppMenuAction::Command("traces")),
        "view_settings" => Some(AppMenuAction::Command("settings")),
        "view_find" => Some(AppMenuAction::Command("find")),
        MENU_BAR_CAPTURE_ID => Some(AppMenuAction::ToggleCapture),
        _ => None,
    }
}

pub(super) fn send_menu_command(app: &tauri::AppHandle, command: &str) {
    show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(MENU_COMMAND_EVENT, command);
    }
}

pub(super) fn toggle_capture_from_menu(app: &tauri::AppHandle) {
    let requested = app
        .try_state::<CaptureMenuState>()
        .map(|state| state.menu_bar_checked())
        .unwrap_or(false);
    request_capture(app, requested);
}

fn find_submenu(menu: &Menu<tauri::Wry>, text: &str) -> tauri::Result<Option<Submenu<tauri::Wry>>> {
    Ok(menu.items()?.into_iter().find_map(|item| {
        item.as_submenu()
            .filter(|submenu| submenu.text().is_ok_and(|label| label == text))
            .cloned()
    }))
}

pub(super) fn show_main_window(app: &tauri::AppHandle) {
    let exit = app.state::<ExitState>();
    match app
        .state::<TemporaryCaptureState>()
        .allow_live_leases_if(|| !exit.is_draining())
    {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            eprintln!("Could not reopen disposable capture setup: {error}");
            return;
        }
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(super) fn show_settings_window(app: &tauri::AppHandle) {
    show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("exalto:navigate", "settings");
    }
}

/// Build the menu bar. Returns the Capture check item so it can share state
/// with the tray toggle.
pub(super) fn create_app_menu(app: &tauri::App) -> tauri::Result<CheckMenuItem<tauri::Wry>> {
    let menu = Menu::default(app.handle())?;

    #[cfg(target_os = "macos")]
    if let Some(app_menu) = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu())
        .cloned()
    {
        app_menu.set_text("Exalto Capture")?;
        let original_items = app_menu.items()?;
        if let Some(original_about) = original_items
            .first()
            .and_then(|item| item.as_predefined_menuitem())
        {
            let about = PredefinedMenuItem::about(
                app,
                Some("About Exalto Capture"),
                Some(AboutMetadata {
                    name: Some("Exalto Capture".into()),
                    version: Some(app.package_info().version.to_string()),
                    copyright: app.config().bundle.copyright.clone(),
                    ..Default::default()
                }),
            )?;
            app_menu.remove(original_about)?;
            app_menu.insert(&about, 0)?;
        }
        if let Some(hide) = original_items
            .get(4)
            .and_then(|item| item.as_predefined_menuitem())
        {
            let safe_hide = MenuItem::with_id(
                app,
                SAFE_HIDE_MENU_ID,
                "Hide Exalto Capture",
                true,
                Some("CmdOrCtrl+H"),
            )?;
            app_menu.remove(hide)?;
            app_menu.insert(&safe_hide, 4)?;
        }
        if let Some(quit) = original_items
            .last()
            .and_then(|item| item.as_predefined_menuitem())
        {
            quit.set_text("Quit Exalto Capture")?;
        }
        let settings =
            MenuItem::with_id(app, "app_settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        let settings_separator = PredefinedMenuItem::separator(app)?;
        app_menu.insert(&settings, 2)?;
        app_menu.insert(&settings_separator, 3)?;
    }

    // File: the one document-like action the app has.
    let new_chat = MenuItem::with_id(app, "file_new_chat", "New Chat", true, Some("CmdOrCtrl+N"))?;
    if let Some(file) = find_submenu(&menu, "File")? {
        file.prepend_items(&[&new_chat, &PredefinedMenuItem::separator(app)?])?;
    } else {
        let file = Submenu::with_items(app, "File", true, &[&new_chat])?;
        menu.insert(&file, 1)?;
    }

    // View: the four sections and Find.
    let view_items = [
        MenuItem::with_id(app, "view_home", "Overview", true, Some("CmdOrCtrl+1"))?,
        MenuItem::with_id(app, "view_chat", "Chat", true, Some("CmdOrCtrl+2"))?,
        MenuItem::with_id(app, "view_traces", "Traces", true, Some("CmdOrCtrl+3"))?,
        MenuItem::with_id(app, "view_settings", "Settings", true, Some("CmdOrCtrl+4"))?,
    ];
    let find = MenuItem::with_id(app, "view_find", "Find", true, Some("CmdOrCtrl+F"))?;
    let view_separator = PredefinedMenuItem::separator(app)?;
    let find_separator = PredefinedMenuItem::separator(app)?;
    let view_entries: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &view_items[0],
        &view_items[1],
        &view_items[2],
        &view_items[3],
        &view_separator,
        &find,
        &find_separator,
    ];
    if let Some(view) = find_submenu(&menu, "View")? {
        view.prepend_items(&view_entries)?;
    } else {
        let view = Submenu::with_items(app, "View", true, &view_entries)?;
        let position = menu.items()?.len().saturating_sub(2);
        menu.insert(&view, position)?;
    }

    // Capture: one check item, kept in step with the tray.
    let capture_requests = CheckMenuItem::with_id(
        app,
        MENU_BAR_CAPTURE_ID,
        "Capture Requests",
        true,
        false,
        Some("CmdOrCtrl+Shift+R"),
    )?;
    let capture = Submenu::with_items(app, "Capture", true, &[&capture_requests])?;
    let capture_position = menu
        .items()?
        .iter()
        .position(|item| {
            item.as_submenu()
                .is_some_and(|submenu| submenu.text().is_ok_and(|label| label == "Window"))
        })
        .unwrap_or(menu.items()?.len().saturating_sub(1));
    menu.insert(&capture, capture_position)?;

    if let Some(help_item) = menu.get(HELP_SUBMENU_ID)
        && let Some(help) = help_item.as_submenu()
    {
        let guide = MenuItem::with_id(
            app,
            "help_guide",
            "Read the Exalto Capture guide",
            true,
            None::<&str>,
        )?;
        let report = MenuItem::with_id(app, "help_report", "Report a problem", true, None::<&str>)?;
        help.append_items(&[&guide, &report])?;
    }

    app.set_menu(menu)?;
    Ok(capture_requests)
}

pub(super) fn create_tray(app: &tauri::App) -> tauri::Result<CaptureMenuState> {
    let open_app = MenuItem::with_id(app, "open_app", OPEN_APP_MENU_LABEL, true, None::<&str>)?;
    let capture_requests = CheckMenuItem::with_id(
        app,
        "capture_requests",
        CAPTURE_MENU_LABEL,
        true,
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", QUIT_MENU_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture_requests, &separator, &open_app, &quit])?;

    #[cfg(target_os = "macos")]
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    #[cfg(not(target_os = "macos"))]
    let tray_icon = app.default_window_icon().expect("application icon").clone();

    TrayIconBuilder::with_id("notary")
        .icon(tray_icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Exalto Capture")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event({
            let capture_requests = capture_requests.clone();
            move |app, event| match event.id().as_ref() {
                "open_app" => show_main_window(app),
                "capture_requests" => {
                    request_capture(app, capture_requests.is_checked().unwrap_or(false));
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(CaptureMenuState {
        items: vec![capture_requests],
    })
}

pub(super) fn schedule_capture_menu_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_published = None;
        loop {
            let enabled = read_admin_status()
                .await
                .map(|status| status.capture_enabled)
                .unwrap_or(false);
            if last_published != Some(enabled) {
                publish_capture_state(&app, enabled);
                last_published = Some(enabled);
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_hide_uses_the_safe_application_menu_action() {
        assert_eq!(
            app_menu_action(SAFE_HIDE_MENU_ID),
            Some(AppMenuAction::Hide)
        );
        assert_eq!(app_menu_action("hide"), None);
    }

    #[test]
    fn capture_menu_uses_a_stable_toggle_label() {
        assert_eq!(
            [CAPTURE_MENU_LABEL, OPEN_APP_MENU_LABEL, QUIT_MENU_LABEL],
            ["Capture", "Open", "Quit"]
        );
    }
}
