use std::{
    future::Future,
    process::Command,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use notaryctl::client::{
    AccountConnection, AccountConnectionStarted, NotaryReadiness, NotaryTrust, NotaryTrustRecord,
    NotarydClient, Status, TraceProbe,
};
use serde::Serialize;
use url::{Host, Url};

use crate::daemon::{
    DaemonProcess, healthy_managed_generation, managed_daemon_is_healthy,
    same_managed_daemon_is_healthy, start_daemon,
};
use crate::vault::{
    clear_temporary_capture_recovery, mark_temporary_capture_recovery,
    temporary_capture_recovery_pending,
};

const ADMIN_ADDRESS: &str = "127.0.0.1:8788";
const RECOVERY_LEASE_ID: &str = "startup-recovery";
const INITIAL_WINDOW_GENERATION: u64 = 1;
const DISPOSABLE_TEST_CANCELLED: &str = "The disposable capture test is no longer active.";
const DISPOSABLE_TEST_SETUP_CANCELLED: &str =
    "Setup closed before the disposable test could start.";
const OFFICIAL_EXALTO_REGISTRY_SOURCES: [&str; 3] = [
    "https://seal.exalto.ai/api/registry",
    // Keep the retired hostname trusted for installed clients that have not
    // yet refreshed their hosted service configuration.
    "https://notary.exalto.ai/api/registry",
    "https://exalto.ai/api/registry",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SealingServiceKind {
    ExaltoSeal,
    Registry,
    Configured,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct SealingServiceIdentity {
    pub(super) name: String,
    pub(super) kind: SealingServiceKind,
}

fn official_exalto_registry(source: Option<&str>) -> bool {
    let Some(source) = source.and_then(|value| Url::parse(value).ok()) else {
        return false;
    };
    OFFICIAL_EXALTO_REGISTRY_SOURCES
        .iter()
        .any(|candidate| Url::parse(candidate).is_ok_and(|official| source == official))
}

fn safe_registry_name(record: &NotaryTrustRecord) -> Option<String> {
    let name = record.name.trim();
    (!name.is_empty() && name.len() <= 96 && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

fn resolve_sealing_service(trust: &NotaryTrust) -> Option<SealingServiceIdentity> {
    let active = match trust.active_key_id.as_deref() {
        Some(active_key_id) => trust
            .notaries
            .iter()
            .find(|record| record.key_id == active_key_id)?,
        None => trust.notaries.first()?,
    };

    match trust.source.as_str() {
        "registry" if official_exalto_registry(trust.registry_source.as_deref()) => {
            Some(SealingServiceIdentity {
                name: "Exalto Seal".into(),
                kind: SealingServiceKind::ExaltoSeal,
            })
        }
        "registry" => Some(SealingServiceIdentity {
            name: safe_registry_name(active).unwrap_or_else(|| "Registry sealing service".into()),
            kind: SealingServiceKind::Registry,
        }),
        "explicit_configuration" => Some(SealingServiceIdentity {
            name: "Configured sealing service".into(),
            kind: SealingServiceKind::Configured,
        }),
        _ => None,
    }
}

/// Remembers the capture setting while onboarding borrows capture for its
/// disposable test. The async mutex serializes begin/restore so a close or quit
/// cannot race a pending enable request and leave capture on.
pub(super) struct TemporaryCaptureState {
    previous: tokio::sync::Mutex<Option<(String, bool)>>,
    owner: Mutex<Option<String>>,
    active: AtomicBool,
    accepting_live_leases: AtomicBool,
    window_generation: AtomicU64,
    window_generation_events: tokio::sync::watch::Sender<u64>,
}

impl Default for TemporaryCaptureState {
    fn default() -> Self {
        Self::new(temporary_capture_recovery_pending())
    }
}

impl TemporaryCaptureState {
    fn new(recovery_pending: bool) -> Self {
        let (window_generation_events, _receiver) =
            tokio::sync::watch::channel(INITIAL_WINDOW_GENERATION);
        Self {
            previous: tokio::sync::Mutex::new(
                recovery_pending.then(|| (RECOVERY_LEASE_ID.into(), false)),
            ),
            owner: Mutex::new(recovery_pending.then(|| RECOVERY_LEASE_ID.into())),
            active: AtomicBool::new(recovery_pending),
            accepting_live_leases: AtomicBool::new(true),
            window_generation: AtomicU64::new(INITIAL_WINDOW_GENERATION),
            window_generation_events,
        }
    }

    pub(super) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(super) fn window_generation(&self) -> u64 {
        self.window_generation.load(Ordering::Acquire)
    }

    pub(super) fn suspend_live_leases_and_invalidate(
        &self,
    ) -> Result<(u64, Option<String>), String> {
        let owner = self
            .owner
            .lock()
            .map_err(|_| "temporary capture lease state is unavailable".to_string())?;
        self.accepting_live_leases.store(false, Ordering::Release);
        let generation = self
            .window_generation
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1);
        self.window_generation_events.send_replace(generation);
        Ok((generation, owner.clone()))
    }

    pub(super) fn allow_live_leases_if(
        &self,
        allow: impl FnOnce() -> bool,
    ) -> Result<bool, String> {
        let _owner = self
            .owner
            .lock()
            .map_err(|_| "temporary capture lease state is unavailable".to_string())?;
        if !allow() {
            return Ok(false);
        }
        self.accepting_live_leases.store(true, Ordering::Release);
        Ok(true)
    }

    pub(super) fn finish_close_if_current(
        &self,
        window_generation: u64,
        finish: impl FnOnce(),
    ) -> Result<bool, String> {
        let _owner = self
            .owner
            .lock()
            .map_err(|_| "temporary capture lease state is unavailable".to_string())?;
        if self.accepting_live_leases.load(Ordering::Acquire)
            || window_generation != self.window_generation()
        {
            return Ok(false);
        }
        finish();
        Ok(true)
    }

    pub(super) fn current_owner(&self) -> Result<Option<String>, String> {
        self.owner
            .lock()
            .map(|owner| owner.clone())
            .map_err(|_| "temporary capture lease state is unavailable".into())
    }

    pub(super) fn recovery_owner(&self) -> Result<Option<String>, String> {
        Ok(self
            .current_owner()?
            .filter(|owner| owner == RECOVERY_LEASE_ID))
    }

    fn claim_live_owner(&self, window_generation: u64, lease_id: &str) -> Result<(), String> {
        if !self.accepting_live_leases.load(Ordering::Acquire)
            || window_generation != self.window_generation()
        {
            return Err("Setup closed before the disposable test could start.".into());
        }
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "temporary capture lease state is unavailable".to_string())?;
        if !self.accepting_live_leases.load(Ordering::Acquire)
            || window_generation != self.window_generation()
        {
            return Err("Setup closed before the disposable test could start.".into());
        }
        if owner.is_some() {
            return Err(
                "Another disposable test or interrupted-test recovery is still finishing. Try again in a moment."
                    .into(),
            );
        }
        *owner = Some(lease_id.into());
        self.active.store(true, Ordering::Release);
        Ok(())
    }

    fn owns(&self, lease_id: &str) -> Result<bool, String> {
        self.owner
            .lock()
            .map(|owner| owner.as_deref() == Some(lease_id))
            .map_err(|_| "temporary capture lease state is unavailable".into())
    }

    pub(super) fn owns_live_lease(&self, lease_id: &str) -> Result<bool, String> {
        Ok(self.accepting_live_leases.load(Ordering::Acquire)
            && valid_live_lease_id(lease_id)
            && self.owns(lease_id)?)
    }

    pub(super) fn subscribe_window_generation(&self) -> tokio::sync::watch::Receiver<u64> {
        self.window_generation_events.subscribe()
    }

    fn release_owner(&self, lease_id: &str) -> Result<bool, String> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| "temporary capture lease state is unavailable".to_string())?;
        if owner.as_deref() != Some(lease_id) {
            return Ok(false);
        }
        self.active.store(false, Ordering::Release);
        *owner = None;
        Ok(true)
    }
}

fn valid_live_lease_id(lease_id: &str) -> bool {
    lease_id.len() == 32 && lease_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) async fn run_while_window_generation_is_current<T>(
    generation_events: &mut tokio::sync::watch::Receiver<u64>,
    expected_generation: u64,
    cancelled_message: &str,
    operation: impl Future<Output = T>,
) -> Result<T, String> {
    if *generation_events.borrow() != expected_generation {
        return Err(cancelled_message.into());
    }
    tokio::select! {
        biased;
        _ = generation_events.changed() => Err(cancelled_message.into()),
        output = operation => Ok(output),
    }
}

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

pub(super) async fn read_sealing_service() -> Result<Option<SealingServiceIdentity>, String> {
    client()?
        .notary_trust()
        .await
        .map(|trust| resolve_sealing_service(&trust))
        .map_err(|error| error.to_string())
}

pub(super) async fn read_sealing_service_readiness(
    refresh: bool,
) -> Result<NotaryReadiness, String> {
    client()?
        .notary_readiness(refresh)
        .await
        .map_err(|error| error.to_string())
}

pub(super) async fn confirm_disposable_trace_id(
    baseline_trace_ids: &[String],
    expected_provider: &str,
    confirmation_marker: &str,
    expected_trace_id: &str,
) -> Result<bool, String> {
    let trace_client = client()?;
    let trace_id = trace_client
        .confirm_disposable_trace(baseline_trace_ids, expected_provider, confirmation_marker)
        .await
        .map_err(|error| error.to_string())?;
    if trace_id.as_deref() != Some(expected_trace_id) {
        return Ok(false);
    }
    Ok(true)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DisposableCaptureTarget {
    Managed(u64),
    External,
}

pub(super) async fn disposable_capture_target(
    process: &DaemonProcess,
) -> Option<DisposableCaptureTarget> {
    if let Some(generation) = healthy_managed_generation(process).await {
        return Some(DisposableCaptureTarget::Managed(generation));
    }
    daemon_is_healthy()
        .await
        .then_some(DisposableCaptureTarget::External)
}

pub(super) async fn same_disposable_capture_target(
    process: &DaemonProcess,
    expected: DisposableCaptureTarget,
) -> bool {
    match expected {
        DisposableCaptureTarget::Managed(generation) => {
            same_managed_daemon_is_healthy(process, generation).await
        }
        DisposableCaptureTarget::External => {
            healthy_managed_generation(process).await.is_none() && daemon_is_healthy().await
        }
    }
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
    open_external_url(url.as_str(), "account page")
}

pub(super) fn product_link(destination: &str) -> Option<&'static str> {
    match destination {
        "public_traces" => Some("https://seal.exalto.ai/traces"),
        "guide" => Some("https://seal.exalto.ai/docs"),
        "report" => Some("https://github.com/exalto-ai/notary/issues/new"),
        "openai_key" => Some("https://platform.openai.com/api-keys"),
        "anthropic_key" => Some("https://console.anthropic.com/settings/keys"),
        "openrouter_key" => Some("https://openrouter.ai/settings/keys"),
        "xai_key" => Some("https://docs.x.ai/developers/quickstart"),
        _ => None,
    }
}

#[tauri::command]
pub(super) fn open_product_link(destination: String) -> Result<(), String> {
    let url = product_link(&destination)
        .ok_or_else(|| "The requested Exalto destination is not allowed.".to_string())?;
    open_external_url(url, "Exalto page")
}

fn open_external_url(url: &str, label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open the {label}: {error}"))
}

async fn set_capture_enabled_unchecked(enabled: bool) -> Result<bool, String> {
    client()?
        .set_capture_enabled(enabled)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn set_capture_enabled(
    enabled: bool,
    temporary_capture: tauri::State<'_, TemporaryCaptureState>,
) -> Result<bool, String> {
    write_capture_setting(enabled, &temporary_capture).await
}

pub(super) async fn restore_temporary_capture(
    state: &TemporaryCaptureState,
    process: &DaemonProcess,
    expected_owner: Option<&str>,
) -> Result<bool, String> {
    let mut previous = state.previous.lock().await;
    let Some(current_owner) = state.current_owner()? else {
        return Ok(false);
    };
    if expected_owner.is_some_and(|expected| expected != current_owner) {
        return Ok(false);
    }
    let Some((previous_owner, was_enabled)) = previous.clone() else {
        // Holding `previous` proves a queued begin has not entered its critical
        // section yet. Cancel its claimed owner; its generation/owner checks
        // will reject it before any service or capture change.
        state.release_owner(&current_owner)?;
        return Ok(false);
    };
    if previous_owner != current_owner {
        return Err("temporary capture lease ownership is inconsistent".into());
    }
    if !was_enabled {
        // Lock order is always previous -> daemon lifecycle. A close can
        // therefore cancel a queued begin without deadlocking a start that is
        // still acquiring the supervised process lifecycle.
        let _lifecycle = process.lifecycle.lock().await;
        let managed_generation = healthy_managed_generation(process)
            .await
            .ok_or_else(|| {
                "Capture recovery is waiting for the exact local service supervised by Exalto Capture. The previous setting remains protected for the next launch."
                    .to_string()
            })?;
        set_capture_enabled_unchecked(false).await?;
        if !same_managed_daemon_is_healthy(process, managed_generation).await {
            return Err(
                "The supervised local service changed while capture was being restored. Recovery remains pending for the next launch."
                    .into(),
            );
        }
        clear_temporary_capture_recovery()?;
    }
    *previous = None;
    state.release_owner(&current_owner)?;
    Ok(was_enabled)
}

#[tauri::command]
pub(super) async fn begin_temporary_capture(
    window_generation: u64,
    lease_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, TemporaryCaptureState>,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<bool, String> {
    if !valid_live_lease_id(&lease_id) {
        return Err("The disposable capture lease was rejected.".into());
    }
    let mut generation_events = state.subscribe_window_generation();
    if *generation_events.borrow() != window_generation {
        return Err(DISPOSABLE_TEST_SETUP_CANCELLED.into());
    }

    // A previous app session may have left the reserved recovery owner in
    // place after the local service could not start. Every new preparation is
    // also a recovery opportunity: supervise a healthy child, force capture
    // off before it binds, and clear only that reserved owner before claiming
    // the new live lease. Exact-owner restoration cannot affect a different
    // disposable test that starts concurrently.
    if state.recovery_owner()?.is_some() {
        run_while_window_generation_is_current(
            &mut generation_events,
            window_generation,
            DISPOSABLE_TEST_SETUP_CANCELLED,
            start_daemon(app.clone(), process.clone()),
        )
        .await??;
        if !run_while_window_generation_is_current(
            &mut generation_events,
            window_generation,
            DISPOSABLE_TEST_SETUP_CANCELLED,
            managed_daemon_is_healthy(&process),
        )
        .await?
        {
            return Err("The bundled local service stopped responding during recovery.".into());
        }
        run_while_window_generation_is_current(
            &mut generation_events,
            window_generation,
            DISPOSABLE_TEST_SETUP_CANCELLED,
            restore_temporary_capture(&state, &process, Some(RECOVERY_LEASE_ID)),
        )
        .await??;
    }

    state.claim_live_owner(window_generation, &lease_id)?;
    let mut previous = match run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        state.previous.lock(),
    )
    .await
    {
        Ok(previous) => previous,
        Err(error) => {
            state.release_owner(&lease_id)?;
            return Err(error);
        }
    };
    if !state.owns_live_lease(&lease_id)? {
        state.release_owner(&lease_id)?;
        return Err(DISPOSABLE_TEST_SETUP_CANCELLED.into());
    }
    if previous.is_some() {
        state.release_owner(&lease_id)?;
        return Err("An interrupted disposable test is still being recovered.".into());
    }

    match run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        start_daemon(app, process.clone()),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) | Err(error) => {
            state.release_owner(&lease_id)?;
            return Err(error);
        }
    }
    let _lifecycle = match run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        process.lifecycle.lock(),
    )
    .await
    {
        Ok(lifecycle) => lifecycle,
        Err(error) => {
            state.release_owner(&lease_id)?;
            return Err(error);
        }
    };
    let target = match run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        disposable_capture_target(&process),
    )
    .await
    {
        Ok(Some(target)) => target,
        Ok(None) => {
            state.release_owner(&lease_id)?;
            return Err(
                "A compatible local capture service is not ready for the disposable test.".into(),
            );
        }
        Err(error) => {
            state.release_owner(&lease_id)?;
            return Err(error);
        }
    };
    let was_enabled = match run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        read_admin_status(),
    )
    .await
    {
        Ok(Ok(status)) => status.capture_enabled,
        Ok(Err(error)) | Err(error) => {
            state.release_owner(&lease_id)?;
            return Err(error);
        }
    };
    if let Err(error) = validate_temporary_capture_target(was_enabled, target) {
        state.release_owner(&lease_id)?;
        return Err(error);
    }
    *previous = Some((lease_id.clone(), was_enabled));
    if !was_enabled && let Err(error) = mark_temporary_capture_recovery() {
        *previous = None;
        state.release_owner(&lease_id)?;
        return Err(error);
    }
    if !was_enabled {
        match run_while_window_generation_is_current(
            &mut generation_events,
            window_generation,
            DISPOSABLE_TEST_SETUP_CANCELLED,
            set_capture_enabled_unchecked(true),
        )
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                // The write may have reached the daemon even if its response
                // was lost. Keep the remembered setting active so the caller,
                // window close handler, or quit path can make a definitive
                // restore.
                return Err(format!(
                    "Could not confirm temporary capture was enabled: {error}"
                ));
            }
            Err(error) => {
                // Cancellation is equally ambiguous once the request has been
                // started, so preserve the recovery marker for the close path.
                return Err(error);
            }
        }
    }
    if !run_while_window_generation_is_current(
        &mut generation_events,
        window_generation,
        DISPOSABLE_TEST_SETUP_CANCELLED,
        same_disposable_capture_target(&process, target),
    )
    .await?
    {
        return Err(
            "The local service stopped responding during disposable setup. Capture recovery will keep the previous setting safe."
                .into(),
        );
    }
    if !state.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_SETUP_CANCELLED.into());
    }
    Ok(was_enabled)
}

fn validate_temporary_capture_target(
    was_enabled: bool,
    target: DisposableCaptureTarget,
) -> Result<(), String> {
    if target == DisposableCaptureTarget::External && !was_enabled {
        return Err(
            "The existing local service has capture turned off. Enable capture in that service before running the disposable test."
                .into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn end_temporary_capture(
    lease_id: String,
    state: tauri::State<'_, TemporaryCaptureState>,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<bool, String> {
    if !valid_live_lease_id(&lease_id) {
        return Err("The disposable capture lease was rejected.".into());
    }
    restore_temporary_capture(&state, &process, Some(&lease_id)).await
}

#[tauri::command]
pub(super) async fn recover_temporary_capture(
    state: tauri::State<'_, TemporaryCaptureState>,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<bool, String> {
    let Some(recovery_owner) = state.recovery_owner()? else {
        return Ok(false);
    };
    restore_temporary_capture(&state, &process, Some(&recovery_owner)).await
}

#[tauri::command]
pub(super) async fn get_recent_trace_probes(
    lease_id: String,
    temporary_capture: tauri::State<'_, TemporaryCaptureState>,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<Vec<TraceProbe>, String> {
    let mut generation_events = temporary_capture.subscribe_window_generation();
    let expected_generation = *generation_events.borrow();
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    let _lifecycle = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        process.lifecycle.lock(),
    )
    .await?;
    let target = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        disposable_capture_target(&process),
    )
    .await?
    .ok_or_else(|| "A compatible local service is not ready for a disposable test.".to_string())?;
    let trace_client = client()?;
    let probes = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        trace_client.recent_trace_probes(),
    )
    .await?
    .map_err(|error| error.to_string())?;
    if !run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        same_disposable_capture_target(&process, target),
    )
    .await?
    {
        return Err("The local service changed while reading local traces.".into());
    }
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    Ok(probes)
}

#[tauri::command]
pub(super) async fn confirm_disposable_trace(
    baseline_trace_ids: Vec<String>,
    expected_provider: String,
    confirmation_marker: String,
    lease_id: String,
    temporary_capture: tauri::State<'_, TemporaryCaptureState>,
    process: tauri::State<'_, DaemonProcess>,
) -> Result<Option<String>, String> {
    let mut generation_events = temporary_capture.subscribe_window_generation();
    let expected_generation = *generation_events.borrow();
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    let _lifecycle = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        process.lifecycle.lock(),
    )
    .await?;
    let target = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        disposable_capture_target(&process),
    )
    .await?
    .ok_or_else(|| "A compatible local service is not ready for confirmation.".to_string())?;
    let trace_client = client()?;
    let trace_id = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        trace_client.confirm_disposable_trace(
            &baseline_trace_ids,
            &expected_provider,
            &confirmation_marker,
        ),
    )
    .await?
    .map_err(|error| error.to_string())?;
    if !run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        same_disposable_capture_target(&process, target),
    )
    .await?
    {
        return Err("The local service changed while confirming the test trace.".into());
    }
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    Ok(trace_id)
}

pub(super) async fn write_capture_setting(
    enabled: bool,
    temporary_capture: &TemporaryCaptureState,
) -> Result<bool, String> {
    write_capture_setting_with(enabled, temporary_capture, set_capture_enabled_unchecked).await
}

async fn write_capture_setting_with<F, Fut>(
    enabled: bool,
    temporary_capture: &TemporaryCaptureState,
    write: F,
) -> Result<bool, String>
where
    F: FnOnce(bool) -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    // Normal user and tray writes share the same gate as disposable begin and
    // restore. A write that started first finishes before begin samples its
    // baseline; a write that waited behind begin sees the active lease and is
    // rejected instead of overwriting the borrowed setting.
    let _capture_gate = temporary_capture.previous.lock().await;
    if temporary_capture.is_active() {
        return Err(
            "The disposable capture test or its recovery currently controls this setting.".into(),
        );
    }
    write(enabled).await
}

pub(super) async fn daemon_is_healthy() -> bool {
    let Ok(client) = client() else {
        return false;
    };
    client.verify_version().await.is_ok()
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use notaryctl::client::{NotaryTrust, NotaryTrustRecord};
    use tokio::sync::Notify;

    use super::{
        DisposableCaptureTarget, SealingServiceIdentity, SealingServiceKind, TemporaryCaptureState,
        resolve_sealing_service, valid_live_lease_id, validate_temporary_capture_target,
        write_capture_setting_with,
    };

    fn trust(
        source: &str,
        registry_source: Option<&str>,
        active_key_id: Option<&str>,
        records: &[(&str, &str)],
    ) -> NotaryTrust {
        NotaryTrust {
            source: source.into(),
            registry_source: registry_source.map(str::to_owned),
            active_key_id: active_key_id.map(str::to_owned),
            notaries: records
                .iter()
                .map(|(name, key_id)| NotaryTrustRecord {
                    name: (*name).into(),
                    key_id: (*key_id).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn sealing_service_brand_requires_an_exact_official_registry() {
        let official = trust(
            "registry",
            Some("https://seal.exalto.ai/api/registry"),
            Some("key-1"),
            &[("Legacy hosted name", "key-1")],
        );
        assert_eq!(
            resolve_sealing_service(&official),
            Some(SealingServiceIdentity {
                name: "Exalto Seal".into(),
                kind: SealingServiceKind::ExaltoSeal,
            })
        );

        for source in [
            "https://seal.example/api/registry",
            "https://notary.exalto.ai.evil.example/api/registry",
            "https://notary.exalto.ai/api/registry?mirror=1",
        ] {
            let third_party = trust(
                "registry",
                Some(source),
                Some("key-1"),
                &[("Northstar Seal", "key-1")],
            );
            assert_eq!(
                resolve_sealing_service(&third_party),
                Some(SealingServiceIdentity {
                    name: "Northstar Seal".into(),
                    kind: SealingServiceKind::Registry,
                })
            );
        }
    }

    #[test]
    fn sealing_service_identity_is_neutral_for_explicit_or_unusable_trust() {
        let explicit = trust(
            "explicit_configuration",
            None,
            None,
            &[("Configured notary", "key-1")],
        );
        assert_eq!(
            resolve_sealing_service(&explicit),
            Some(SealingServiceIdentity {
                name: "Configured sealing service".into(),
                kind: SealingServiceKind::Configured,
            })
        );
        assert_eq!(
            resolve_sealing_service(&trust("registry", None, None, &[])),
            None
        );
        assert_eq!(
            resolve_sealing_service(&trust(
                "registry",
                Some("https://seal.example/api/registry"),
                Some("missing"),
                &[("Northstar Seal", "key-1")],
            )),
            None
        );
    }

    #[test]
    fn temporary_capture_never_enables_an_external_service() {
        assert!(
            validate_temporary_capture_target(false, DisposableCaptureTarget::Managed(1)).is_ok()
        );
        assert!(
            validate_temporary_capture_target(true, DisposableCaptureTarget::Managed(1)).is_ok()
        );
        assert!(validate_temporary_capture_target(true, DisposableCaptureTarget::External).is_ok());
        assert!(
            validate_temporary_capture_target(false, DisposableCaptureTarget::External).is_err()
        );
    }

    #[test]
    fn window_close_invalidates_a_queued_temporary_capture_begin() {
        let state = TemporaryCaptureState::new(false);
        let generation = state.window_generation();
        let (closed_generation, owner) = state.suspend_live_leases_and_invalidate().unwrap();
        assert!(closed_generation > generation);
        assert!(owner.is_none());
        assert!(
            state
                .claim_live_owner(generation, "0123456789abcdef0123456789abcdef")
                .is_err()
        );
        assert!(
            state
                .claim_live_owner(closed_generation, "0123456789abcdef0123456789abcdef")
                .is_err()
        );
        assert!(!state.is_active());
        let mut finished = false;
        assert!(
            state
                .finish_close_if_current(closed_generation, || finished = true)
                .unwrap()
        );
        assert!(finished);
        assert!(!state.allow_live_leases_if(|| false).unwrap());
        state.allow_live_leases_if(|| true).unwrap();
        assert!(
            !state
                .finish_close_if_current(closed_generation, || panic!("stale close ran"))
                .unwrap()
        );
        state
            .claim_live_owner(closed_generation, "0123456789abcdef0123456789abcdef")
            .unwrap();
        assert!(state.is_active());
    }

    #[test]
    fn temporary_capture_owners_are_exact_and_recovery_is_distinct() {
        let state = TemporaryCaptureState::new(false);
        let owner = "0123456789abcdef0123456789abcdef";
        state
            .claim_live_owner(state.window_generation(), owner)
            .unwrap();
        assert!(
            !state
                .release_owner("fedcba9876543210fedcba9876543210")
                .unwrap()
        );
        assert!(state.is_active());
        assert!(state.release_owner(owner).unwrap());
        assert!(!state.is_active());

        let recovery = TemporaryCaptureState::new(true);
        assert_eq!(
            recovery.recovery_owner().unwrap().as_deref(),
            Some("startup-recovery")
        );
        assert!(
            recovery
                .claim_live_owner(recovery.window_generation(), owner)
                .is_err()
        );
    }

    #[test]
    fn closing_gate_snapshots_an_already_claimed_owner() {
        let state = TemporaryCaptureState::new(false);
        let owner = "0123456789abcdef0123456789abcdef";
        let generation = state.window_generation();
        let generation_events = state.subscribe_window_generation();
        state.claim_live_owner(generation, owner).unwrap();
        assert!(state.owns_live_lease(owner).unwrap());

        let (closed_generation, snapshot) = state.suspend_live_leases_and_invalidate().unwrap();
        assert_eq!(snapshot.as_deref(), Some(owner));
        assert!(!state.owns_live_lease(owner).unwrap());
        assert_eq!(*generation_events.borrow(), closed_generation);
        assert!(
            state
                .claim_live_owner(closed_generation, "fedcba9876543210fedcba9876543210")
                .is_err()
        );
        assert!(state.release_owner(owner).unwrap());
    }

    #[test]
    fn live_temporary_capture_lease_ids_are_bounded_hex() {
        assert!(valid_live_lease_id("0123456789abcdef0123456789ABCDEF"));
        assert!(!valid_live_lease_id("startup-recovery"));
        assert!(!valid_live_lease_id("0123456789abcdef0123456789abcdef00"));
        assert!(!valid_live_lease_id("0123456789abcdef0123456789abcdeg"));
    }

    #[tokio::test]
    async fn normal_capture_writes_share_the_disposable_capture_gate() {
        let state = Arc::new(TemporaryCaptureState::new(false));
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let stored = Arc::new(AtomicBool::new(false));
        let task_state = Arc::clone(&state);
        let task_entered = Arc::clone(&entered);
        let task_release = Arc::clone(&release);
        let task_stored = Arc::clone(&stored);
        let writer = tokio::spawn(async move {
            write_capture_setting_with(true, &task_state, move |enabled| async move {
                task_entered.notify_one();
                task_release.notified().await;
                task_stored.store(enabled, Ordering::Release);
                Ok(enabled)
            })
            .await
        });

        entered.notified().await;
        let owner = "0123456789abcdef0123456789abcdef";
        state
            .claim_live_owner(state.window_generation(), owner)
            .unwrap();
        assert!(state.previous.try_lock().is_err());
        assert!(!stored.load(Ordering::Acquire));
        release.notify_one();
        assert!(writer.await.unwrap().unwrap());

        let begin_gate = state.previous.lock().await;
        assert!(stored.load(Ordering::Acquire));
        drop(begin_gate);
        state.release_owner(owner).unwrap();

        let begin_gate = state.previous.lock().await;
        state
            .claim_live_owner(state.window_generation(), owner)
            .unwrap();
        let rejected_state = Arc::clone(&state);
        let called = Arc::new(AtomicBool::new(false));
        let rejected_called = Arc::clone(&called);
        let queued_writer = tokio::spawn(async move {
            write_capture_setting_with(false, &rejected_state, move |_| async move {
                rejected_called.store(true, Ordering::Release);
                Ok(false)
            })
            .await
        });
        tokio::task::yield_now().await;
        drop(begin_gate);
        assert!(queued_writer.await.unwrap().is_err());
        assert!(!called.load(Ordering::Acquire));
        state.release_owner(owner).unwrap();
    }
}
