mod api_origin;
pub(crate) mod auth;
pub(crate) mod config;
pub(crate) mod proxy;
pub(crate) mod registry;
pub(crate) mod sharing;
pub(crate) mod storage;

/// Public API origin compiled into released clients. Override it at build time
/// with `NOTARYD_PUBLIC_ORIGIN` when producing a self-hosted distribution.
pub(crate) use notary_updater::{BUILD_ID, DEFAULT_PUBLIC_ORIGIN};

pub(crate) const DAEMON_USER_AGENT: &str = concat!("notaryd/", env!("CARGO_PKG_VERSION"));

pub(crate) fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().user_agent(DAEMON_USER_AGENT)
}
