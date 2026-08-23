use std::env;

const DEFAULT_PUBLIC_ORIGIN: &str = "https://notary.exalto.ai";
const DEVELOPMENT_BUILD_ID: &str = "dev";

fn main() {
    println!("cargo:rerun-if-env-changed=NOTARY_PUBLIC_ORIGIN");
    println!("cargo:rerun-if-env-changed=NOTARY_BUILD_ID");
    println!("cargo:rerun-if-env-changed=NOTARY_UPDATES_ENABLED");
    let origin =
        env::var("NOTARY_PUBLIC_ORIGIN").unwrap_or_else(|_| DEFAULT_PUBLIC_ORIGIN.to_owned());
    let origin = origin.trim_end_matches('/');
    let authority = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"));
    assert!(
        authority.is_some(),
        "NOTARY_PUBLIC_ORIGIN must start with http:// or https://"
    );
    assert!(
        authority
            .is_some_and(|value| !value.is_empty() && !value.contains(['/', '?', '#', '\n', '\r'])),
        "NOTARY_PUBLIC_ORIGIN must be an origin without a path, query, fragment, or newline"
    );
    println!("cargo:rustc-env=NOTARY_PUBLIC_ORIGIN={origin}");

    let build_id = env::var("NOTARY_BUILD_ID").unwrap_or_else(|_| DEVELOPMENT_BUILD_ID.to_owned());
    assert!(
        valid_release_identifier(&build_id),
        "NOTARY_BUILD_ID must be a safe non-empty release identifier"
    );
    println!("cargo:rustc-env=NOTARY_BUILD_ID={build_id}");

    let updates_enabled = env::var("NOTARY_UPDATES_ENABLED").unwrap_or_else(|_| "0".into());
    assert!(
        matches!(updates_enabled.as_str(), "0" | "1"),
        "NOTARY_UPDATES_ENABLED must be 0 or 1"
    );
    println!("cargo:rustc-env=NOTARY_UPDATES_ENABLED={updates_enabled}");
}

fn valid_release_identifier(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('.')
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
