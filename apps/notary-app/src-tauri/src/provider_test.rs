use std::{str::FromStr, time::Duration};

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::json;
use zeroize::Zeroizing;

use crate::daemon::DaemonProcess;
use crate::service_client::{
    TemporaryCaptureState, confirm_disposable_trace_id, disposable_capture_target,
    run_while_window_generation_is_current, same_disposable_capture_target,
};

const CAPTURE_ORIGIN: &str = "http://127.0.0.1:8787";
const DISPOSABLE_TRACE_MARKER_PREFIX: &str = "EXALTO-CAPTURE-TEST-";
const DISPOSABLE_TRACE_MARKER_SUFFIX_LEN: usize = 24;
const PROVIDER_TEST_MAX_RESPONSE_BYTES: usize = 256 * 1024;
const DISPOSABLE_TEST_CANCELLED: &str = "The disposable capture test is no longer active.";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Openai,
    Anthropic,
    Openrouter,
}

impl Provider {
    const fn name(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Openrouter => "openrouter",
        }
    }

    const fn capture_test_path(self) -> &'static str {
        match self {
            Self::Openai => "/openai/v1/responses",
            Self::Anthropic => "/anthropic/v1/messages",
            Self::Openrouter => "/openrouter/api/v1/chat/completions",
        }
    }
}

impl FromStr for Provider {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "openai" => Ok(Self::Openai),
            "anthropic" => Ok(Self::Anthropic),
            "openrouter" => Ok(Self::Openrouter),
            _ => Err("Choose a supported API provider.".into()),
        }
    }
}

#[derive(Serialize)]
pub(super) struct ProviderCaptureTestResult {
    provider: Provider,
    model: String,
    marker: String,
    trace_id: Option<String>,
    http_status: u16,
    successful: bool,
    captured: bool,
}

fn normalize_api_key(api_key: String) -> Result<Zeroizing<String>, String> {
    let api_key = Zeroizing::new(api_key);
    let normalized = Zeroizing::new(api_key.trim().to_owned());
    if normalized.len() < 8
        || normalized.len() > 512
        || !normalized.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err("Enter a valid API key containing no spaces or line breaks.".into());
    }
    Ok(normalized)
}

fn normalize_model(provider: Provider, model: String) -> Result<String, String> {
    let model = model.trim();
    validate_model(provider, model)?;
    Ok(model.to_owned())
}

fn validate_model(provider: Provider, model: &str) -> Result<(), String> {
    let valid_syntax = !model.is_empty()
        && model.len() <= 200
        && model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        });
    let valid_provider_shape = match provider {
        Provider::Openai | Provider::Anthropic => !model.contains('/'),
        Provider::Openrouter => model
            .split_once('/')
            .is_some_and(|(namespace, name)| !namespace.is_empty() && !name.is_empty()),
    };
    if !valid_syntax || !valid_provider_shape {
        return Err("Enter a valid model identifier for this provider.".into());
    }
    Ok(())
}

fn validate_marker(marker: &str) -> Result<(), String> {
    let valid = marker
        .strip_prefix(DISPOSABLE_TRACE_MARKER_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == DISPOSABLE_TRACE_MARKER_SUFFIX_LEN
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'A'..=b'F'))
        });
    if !valid {
        return Err("The disposable test marker is invalid. Start a new connection test.".into());
    }
    Ok(())
}

fn provider_test_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("Exalto-Capture/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "The local provider test could not be prepared.".to_string())
}

fn sensitive_header(value: &[u8]) -> Result<HeaderValue, String> {
    let mut value = HeaderValue::from_bytes(value)
        .map_err(|_| "Enter a valid API key containing no spaces or line breaks.".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

fn provider_test_request(
    client: &reqwest::Client,
    provider: Provider,
    model: &str,
    marker: &str,
    api_key: &str,
) -> Result<reqwest::Request, String> {
    validate_model(provider, model)?;
    validate_marker(marker)?;
    let prompt = format!("Reply with exactly: {marker}");
    let body = match provider {
        Provider::Openai => json!({
            "model": model,
            "input": prompt,
            "max_output_tokens": 64,
            "stream": false,
        }),
        Provider::Anthropic | Provider::Openrouter => json!({
            "model": model,
            "max_tokens": 64,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
        }),
    };
    let body = serde_json::to_vec(&body)
        .map_err(|_| "The local provider test could not be prepared.".to_string())?;
    let url = format!("{CAPTURE_ORIGIN}{}", provider.capture_test_path());
    let mut request = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .body(body);
    match provider {
        Provider::Openai | Provider::Openrouter => {
            let authorization = Zeroizing::new(format!("Bearer {api_key}"));
            request = request.header(AUTHORIZATION, sensitive_header(authorization.as_bytes())?);
        }
        Provider::Anthropic => {
            request = request
                .header("x-api-key", sensitive_header(api_key.as_bytes())?)
                .header("anthropic-version", "2023-06-01");
        }
    }
    if provider == Provider::Openrouter {
        request = request
            .header("http-referer", "https://exalto.ai")
            .header("x-title", "Exalto Capture");
    }
    request
        .build()
        .map_err(|_| "The local provider test could not be prepared.".to_string())
}

fn provider_test_trace_id(headers: &HeaderMap) -> Result<Option<String>, String> {
    let Some(value) = headers.get("x-notary-trace-id") else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| "The local capture service returned an invalid Trace identifier.")?;
    let valid = value.strip_prefix("trc-").is_some_and(|suffix| {
        !suffix.is_empty()
            && value.len() <= 256
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    });
    if !valid {
        return Err("The local capture service returned an invalid Trace identifier.".into());
    }
    Ok(Some(value.to_owned()))
}

async fn drain_provider_test_response(response: &mut reqwest::Response) -> Result<(), String> {
    let mut received = 0_usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The provider test response could not be read.".to_string())?
    {
        received = received
            .checked_add(chunk.len())
            .ok_or_else(|| "The provider test response was too large.".to_string())?;
        if received > PROVIDER_TEST_MAX_RESPONSE_BYTES {
            return Err("The provider test response was too large.".into());
        }
    }
    Ok(())
}

// Tauri injects the two state arguments; the remaining inputs mirror the
// bounded provider-test request from the onboarding UI.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(super) async fn run_provider_capture_test(
    provider: String,
    model: String,
    marker: String,
    api_key: String,
    baseline_trace_ids: Vec<String>,
    lease_id: String,
    process: tauri::State<'_, DaemonProcess>,
    temporary_capture: tauri::State<'_, TemporaryCaptureState>,
) -> Result<ProviderCaptureTestResult, String> {
    let mut generation_events = temporary_capture.subscribe_window_generation();
    let expected_generation = *generation_events.borrow();
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    let provider = Provider::from_str(&provider)?;
    let model = normalize_model(provider, model)?;
    validate_marker(&marker)?;
    let api_key = normalize_api_key(api_key)?;
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
    .ok_or_else(|| "A compatible local service is not ready for the provider test.".to_string())?;
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    let client = provider_test_client()?;
    let request = provider_test_request(&client, provider, &model, &marker, &api_key)?;
    drop(api_key);
    let mut response = run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        client.execute(request),
    )
    .await?
    .map_err(|_| {
        "The provider test could not reach the local capture service. Start it and try again."
            .to_string()
    })?;
    let http_status = response.status().as_u16();
    let returned_trace_id = provider_test_trace_id(response.headers())?;
    run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        drain_provider_test_response(&mut response),
    )
    .await??;
    if !run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        same_disposable_capture_target(&process, target),
    )
    .await?
    {
        return Err("The local service changed during the provider test.".into());
    }
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    let successful = (200..=299).contains(&http_status);
    let trace_id = if successful {
        match returned_trace_id {
            Some(trace_id) => run_while_window_generation_is_current(
                &mut generation_events,
                expected_generation,
                DISPOSABLE_TEST_CANCELLED,
                confirm_disposable_trace_id(
                    &baseline_trace_ids,
                    provider.name(),
                    &marker,
                    &trace_id,
                ),
            )
            .await??
            .then_some(trace_id),
            None => None,
        }
    } else {
        None
    };
    if !run_while_window_generation_is_current(
        &mut generation_events,
        expected_generation,
        DISPOSABLE_TEST_CANCELLED,
        same_disposable_capture_target(&process, target),
    )
    .await?
    {
        return Err("The local service changed while confirming the provider test.".into());
    }
    if !temporary_capture.owns_live_lease(&lease_id)? {
        return Err(DISPOSABLE_TEST_CANCELLED.into());
    }
    Ok(ProviderCaptureTestResult {
        provider,
        model,
        marker,
        trace_id: trace_id.clone(),
        http_status,
        successful,
        captured: trace_id.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MARKER: &str = "EXALTO-CAPTURE-TEST-0123456789ABCDEF01234567";

    fn request_body(request: &reqwest::Request) -> serde_json::Value {
        let bytes = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .expect("provider test body is buffered");
        serde_json::from_slice(bytes).expect("provider test body is JSON")
    }

    #[test]
    fn provider_allowlist_is_exact_and_does_not_echo_input() {
        for provider in ["openai", "anthropic", "openrouter"] {
            assert!(Provider::from_str(provider).is_ok());
        }
        let secret_shaped_provider = "sk-secret-provider-name";
        let error = Provider::from_str(secret_shaped_provider).unwrap_err();
        assert!(!error.contains(secret_shaped_provider));
    }

    #[test]
    fn keys_are_trimmed_and_bounded() {
        assert_eq!(
            normalize_api_key("  sk-test-12345678\n".to_owned())
                .unwrap()
                .as_str(),
            "sk-test-12345678"
        );
        for invalid in ["", "       ", "short", "sk-test embedded-space"] {
            let error = normalize_api_key(invalid.to_owned()).unwrap_err();
            if !invalid.is_empty() {
                assert!(!error.contains(invalid));
            }
        }
        assert!(normalize_api_key("x".repeat(513)).is_err());
    }

    #[test]
    fn provider_test_requests_use_real_keys_on_exact_loopback_routes() {
        let client = provider_test_client().unwrap();
        let api_key = "sk-test-never-debug-this";
        let prompt = format!("Reply with exactly: {TEST_MARKER}");

        let openai = provider_test_request(
            &client,
            Provider::Openai,
            "gpt-4.1-mini",
            TEST_MARKER,
            api_key,
        )
        .unwrap();
        assert_eq!(
            openai.url().as_str(),
            "http://127.0.0.1:8787/openai/v1/responses"
        );
        assert_eq!(openai.headers()[AUTHORIZATION], format!("Bearer {api_key}"));
        assert!(openai.headers()[AUTHORIZATION].is_sensitive());
        assert_eq!(
            request_body(&openai),
            json!({
                "model": "gpt-4.1-mini",
                "input": prompt,
                "max_output_tokens": 64,
                "stream": false,
            })
        );
        assert!(!format!("{openai:?}").contains(api_key));

        let anthropic = provider_test_request(
            &client,
            Provider::Anthropic,
            "claude-3-5-haiku-latest",
            TEST_MARKER,
            api_key,
        )
        .unwrap();
        assert_eq!(
            anthropic.url().as_str(),
            "http://127.0.0.1:8787/anthropic/v1/messages"
        );
        assert_eq!(anthropic.headers()["x-api-key"], api_key);
        assert!(anthropic.headers()["x-api-key"].is_sensitive());

        let openrouter = provider_test_request(
            &client,
            Provider::Openrouter,
            "openai/gpt-4o-mini",
            TEST_MARKER,
            api_key,
        )
        .unwrap();
        assert_eq!(
            openrouter.url().as_str(),
            "http://127.0.0.1:8787/openrouter/api/v1/chat/completions"
        );
        assert_eq!(
            openrouter.headers()[AUTHORIZATION],
            format!("Bearer {api_key}")
        );
        assert!(openrouter.headers()[AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn provider_test_inputs_are_bounded() {
        assert_eq!(
            normalize_model(Provider::Openai, "  gpt-4.1-mini  ".into()).unwrap(),
            "gpt-4.1-mini"
        );
        assert!(normalize_model(Provider::Openai, "model with spaces".into()).is_err());
        assert!(normalize_model(Provider::Openrouter, "gpt-4o-mini".into()).is_err());
        validate_marker(TEST_MARKER).unwrap();
        assert!(validate_marker("secret-marker").is_err());
    }

    #[test]
    fn provider_test_trace_ids_are_optional_and_path_safe() {
        let mut headers = HeaderMap::new();
        assert_eq!(provider_test_trace_id(&headers).unwrap(), None);
        headers.insert(
            "x-notary-trace-id",
            HeaderValue::from_static("trc-1234-safe_identifier"),
        );
        assert_eq!(
            provider_test_trace_id(&headers).unwrap().as_deref(),
            Some("trc-1234-safe_identifier")
        );
        for invalid in ["trace-1234", "trc-../escape", "trc-"] {
            headers.insert("x-notary-trace-id", HeaderValue::from_str(invalid).unwrap());
            let error = provider_test_trace_id(&headers).unwrap_err();
            assert!(!error.contains(invalid));
        }
    }
}
