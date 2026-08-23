use std::process::Command;

use notaryctl::client::{AccountConnection, AccountConnectionStarted, NotarydClient, Status};
use url::{Host, Url};

const ADMIN_ADDRESS: &str = "127.0.0.1:8788";

fn client() -> Result<NotarydClient, String> {
    NotarydClient::connect_loopback(
        ADMIN_ADDRESS
            .parse()
            .expect("the bundled admin address is valid"),
    )
    .map_err(|error| error.to_string())
}

pub(super) async fn read_admin_status() -> Result<Status, String> {
    client()?.status().await.map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn get_account_connection() -> Result<AccountConnection, String> {
    client()?
        .account_connection()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn start_account_connection() -> Result<AccountConnectionStarted, String> {
    client()?
        .start_account_connection()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn poll_account_connection(
    request_id: String,
) -> Result<AccountConnection, String> {
    client()?
        .poll_account_connection(&request_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn disconnect_account() -> Result<(), String> {
    client()?
        .disconnect_account()
        .await
        .map_err(|error| error.to_string())
}

pub(super) fn validate_account_link(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "The account link is not a valid URL.".to_string())?;
    let secure = url.scheme() == "https";
    let loopback_http = url.scheme() == "http"
        && url.host().is_some_and(|host| match host {
            Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
            Host::Ipv4(address) => address.is_loopback(),
            Host::Ipv6(address) => address.is_loopback(),
        });
    let fragment = url.fragment().unwrap_or_default();
    let legacy_route = fragment
        .split_once('?')
        .map_or(fragment, |(route, _)| route);
    let valid_authorization_query = |query: &str| {
        let mut request_id = false;
        let mut approval_secret = false;
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                return false;
            };
            if value.is_empty()
                || value
                    .bytes()
                    .any(|byte| byte.is_ascii_control() || byte == b'#')
            {
                return false;
            }
            match key {
                "request_id" if !request_id => request_id = true,
                "approval_secret" if !approval_secret => approval_secret = true,
                _ => return false,
            }
        }
        request_id && approval_secret
    };
    let legacy_authorization = fragment
        .strip_prefix("/authorize?")
        .is_some_and(valid_authorization_query);
    let clean_authorization = url.path() == "/authorize"
        && url.fragment().is_none()
        && url.query().is_some_and(valid_authorization_query);
    let clean_route = url.fragment().is_none()
        && url.query().is_none()
        && matches!(
            url.path(),
            "/account" | "/account/traces" | "/account/usage" | "/pricing" | "/account/settings"
        );
    let legacy_allowed_route = url.path() == "/"
        && url.query().is_none()
        && matches!(
            legacy_route,
            "/account" | "/account/traces" | "/account/usage" | "/pricing" | "/account/settings"
        );
    let allowed_route =
        clean_route || clean_authorization || legacy_allowed_route || legacy_authorization;
    if (!secure && !loopback_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !allowed_route
    {
        return Err(
            "The account link was rejected because it is not a trusted hosted route.".into(),
        );
    }
    Ok(url)
}

#[tauri::command]
pub(super) fn open_account_link(url: String) -> Result<(), String> {
    let url = validate_account_link(&url)?;
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url.as_str()).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open the account page: {error}"))
}

pub(super) async fn write_capture_setting(enabled: bool) -> Result<bool, String> {
    client()?
        .set_capture_enabled(enabled)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn daemon_is_healthy() -> bool {
    let Ok(client) = client() else {
        return false;
    };
    client.verify_version().await.is_ok()
}
