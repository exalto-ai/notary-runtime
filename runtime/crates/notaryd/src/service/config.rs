//! Helpers for loading local service configuration.

use std::path::{Path, PathBuf};

use crate::config::{NotarydConfig, default_config_path};
use anyhow::Result;

pub(crate) fn config_path(path: Option<&Path>) -> Result<PathBuf> {
    match path {
        Some(path) => Ok(path.to_owned()),
        None => default_config_path(),
    }
}

/// Loads an notaryd configuration, generating the editable defaults on first
/// use. Every config-driven command shares this behavior so a fresh install
/// can start the proxy without a setup command.
pub(crate) fn load_notaryd_config(path: Option<&Path>) -> Result<(NotarydConfig, PathBuf)> {
    let explicit = path.is_some();
    let path = config_path(path)?;
    if explicit {
        let mut config = NotarydConfig::load(&path)?;
        config.resolve_runtime_secrets()?;
        return Ok((config, path));
    }
    let (mut config, created) = NotarydConfig::load_or_create(&path)?;
    if created {
        eprintln!("created default notaryd configuration: {}", path.display());
    }
    config.resolve_runtime_secrets()?;
    Ok((config, path))
}
