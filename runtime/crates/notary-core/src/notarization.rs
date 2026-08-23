//! Capture checkpoint notarization and offline-verifiable trace packages.

#[cfg(test)]
use std::{fs, path::Path};
#[cfg(all(feature = "cli", test))]
use std::{fs::OpenOptions, io::Write as _, path::PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tlsn::attestation::CryptoProvider;

use crate::{
    CaptureCheckpoint, NotarizationPhase, NotarizationProgress, NotarizationProgressObserver,
    TraceEvidence, TraceEvidenceManifest,
    archive::{
        TRACE_EVIDENCE_FORMAT, TracePackageArchiveEntries, ValidatedTracePackageArchive,
        build_trace_package_archive_from_entries, read_trace_package_archive,
    },
    configured_crypto_provider, make_trace_evidence,
    normalize::{render_public_trace, verified_inference_from_capture},
    notarize_capture_checkpoint_to_admitted_with_progress,
    notarize_capture_checkpoint_to_with_progress,
    public::NORMALIZER_VERSION,
    registry::NotaryEndpoint,
    sha256_hex, verify_capture_value_with_provider,
};

/// Metadata binding a normalized trace to the included TLSNotary evidence.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedTraceManifest {
    format: String,
    normalizer_version: String,
    source: TraceEvidenceManifest,
    trace_sha256: String,
}

/// The authenticated result of fully verifying one canonical `.llmtrace`.
pub struct VerifiedTracePackage {
    pub manifest: VerifiedTraceManifest,
    /// Authenticated origin-form path from the provider request line.
    pub request_path: String,
    pub package_sha256: String,
    pub trace_sha256: String,
    pub trace: Vec<u8>,
}

impl VerifiedTraceManifest {
    /// Returns the source capture identifier.
    pub fn trace_id(&self) -> &str {
        &self.source.trace_id
    }

    /// Returns the provider connection time authenticated by the source
    /// presentation.
    pub fn created_at_unix_ms(&self) -> u64 {
        self.source.created_at_unix_ms
    }

    pub fn provider_name(&self) -> &str {
        &self.source.provider.name
    }

    pub fn provider_host(&self) -> &str {
        &self.source.provider.host
    }

    /// Returns the SEC1 key that signed the package source evidence.
    pub fn notary_public_key(&self) -> Result<Vec<u8>> {
        hex::decode(&self.source.notary.public_key)
            .context("trace package source notary key must be hexadecimal")
    }
}

/// Reads the embedded notary key from already-snapshotted `.llmtrace` bytes.
pub fn trace_package_notary_key_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    trace_manifest_from_archive(&read_trace_package_archive(bytes)?)?.notary_public_key()
}

/// Reads the authenticated provider-connection time from already-snapshotted
/// `.llmtrace` bytes. Full verification is still required before trusting it.
pub fn trace_package_created_at_unix_ms_bytes(bytes: &[u8]) -> Result<u64> {
    Ok(trace_manifest_from_archive(&read_trace_package_archive(bytes)?)?.created_at_unix_ms())
}

/// Completes a decoded capture checkpoint, reports milestones, and returns the
/// canonical `.llmtrace` bytes.
pub async fn notarize_capture_checkpoint_bytes_with_progress(
    checkpoint: &CaptureCheckpoint,
    trusted_notary_key: &[u8],
    notary: &NotaryEndpoint,
    max_attestable_http_bytes: usize,
    max_frame_bytes: usize,
    progress: NotarizationProgressObserver<'_>,
) -> Result<Vec<u8>> {
    let proof = notarize_capture_checkpoint_to_with_progress(
        notary,
        checkpoint,
        trusted_notary_key,
        max_attestable_http_bytes,
        max_frame_bytes,
        progress,
    )
    .await?;
    progress(NotarizationProgress::Phase(NotarizationPhase::Packaging));
    let capture = make_trace_evidence(
        &proof,
        checkpoint.trace_id().to_owned(),
        checkpoint.provider_name().to_owned(),
    )?;
    build_trace_package_bytes(&capture, trusted_notary_key)
}

/// Completes admitted notarization from a decoded private checkpoint, reports
/// milestones, and returns the canonical `.llmtrace` bytes.
#[allow(clippy::too_many_arguments)]
pub async fn notarize_capture_checkpoint_admitted_bytes_with_progress(
    checkpoint: &CaptureCheckpoint,
    trusted_notary_key: &[u8],
    notary: &NotaryEndpoint,
    max_attestable_http_bytes: usize,
    max_frame_bytes: usize,
    admission_value: &str,
    progress: NotarizationProgressObserver<'_>,
) -> Result<Vec<u8>> {
    let proof = notarize_capture_checkpoint_to_admitted_with_progress(
        notary,
        checkpoint,
        trusted_notary_key,
        max_attestable_http_bytes,
        max_frame_bytes,
        admission_value,
        progress,
    )
    .await?;
    progress(NotarizationProgress::Phase(NotarizationPhase::Packaging));
    let capture = make_trace_evidence(
        &proof,
        checkpoint.trace_id().to_owned(),
        checkpoint.provider_name().to_owned(),
    )?;
    build_trace_package_bytes(&capture, trusted_notary_key)
}

fn build_trace_package_bytes(
    capture: &TraceEvidence,
    trusted_notary_key: &[u8],
) -> Result<Vec<u8>> {
    build_trace_package_bytes_with_provider(
        capture,
        trusted_notary_key,
        &configured_crypto_provider()?,
    )
}

#[cfg(all(feature = "cli", test))]
pub(crate) fn write_trace_package_with_provider(
    capture: &TraceEvidence,
    output_path: &Path,
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<PathBuf> {
    let bytes =
        build_trace_package_bytes_with_provider(capture, trusted_notary_key, crypto_provider)?;
    write_trace_package_bytes(output_path, &bytes)
}

fn build_trace_package_bytes_with_provider(
    capture: &TraceEvidence,
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<Vec<u8>> {
    let (source, request, response) =
        verify_capture_value_with_provider(capture, trusted_notary_key, crypto_provider)?;
    let inference = verified_inference_from_capture(&source, &request, &response)?;
    let trace = render_public_trace(&[inference])?;
    let manifest = VerifiedTraceManifest {
        format: TRACE_EVIDENCE_FORMAT.to_owned(),
        normalizer_version: NORMALIZER_VERSION.to_owned(),
        source,
        trace_sha256: sha256_hex(&trace),
    };

    let manifest_json = serde_json::to_vec_pretty(&manifest)?;
    build_trace_package_archive_from_entries(TracePackageArchiveEntries {
        evidence_tlsn: &capture.evidence,
        manifest_json: &manifest_json,
        request_disclosed_http: &capture.request_disclosed,
        response_disclosed_http: &capture.response,
        trace_otlp_json: &trace,
    })
}

#[cfg(all(feature = "cli", test))]
fn write_trace_package_bytes(output_path: &Path, bytes: &[u8]) -> Result<PathBuf> {
    if output_path.exists() {
        bail!(
            "refusing to overwrite existing trace package: {}",
            output_path.display()
        );
    }
    write_atomic_trace(output_path, bytes)?;
    Ok(output_path.to_path_buf())
}

#[cfg(all(feature = "cli", test))]
fn write_atomic_trace(output_path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    let file_name = output_path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("trace package output has no file name"))?
        .to_string_lossy();
    for _ in 0..16 {
        let partial = parent.join(format!(
            ".{file_name}.{}.{:016x}.partial",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = match options.open(&partial) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("creating {}", partial.display()));
            }
        };
        let result = (|| -> Result<()> {
            file.write_all(bytes)
                .with_context(|| format!("writing {}", partial.display()))?;
            file.sync_all()
                .with_context(|| format!("syncing {}", partial.display()))?;
            drop(file);
            fs::hard_link(&partial, output_path).with_context(|| {
                format!(
                    "atomically committing trace package {}",
                    output_path.display()
                )
            })?;
            fs::remove_file(&partial)
                .with_context(|| format!("removing staging file {}", partial.display()))?;
            #[cfg(unix)]
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .with_context(|| format!("syncing trace package directory {}", parent.display()))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        return result;
    }
    bail!(
        "could not create a unique staging file beside {}",
        output_path.display()
    )
}

#[cfg(all(test, feature = "cli"))]
pub(crate) fn verify_trace_package_with_provider(
    path: &Path,
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<VerifiedTracePackage> {
    let bytes = read_trace_package_file(path)?;
    verify_trace_package_bytes_with_provider(&bytes, trusted_notary_key, crypto_provider)
}

/// Verifies exact `.llmtrace` bytes without retaining or extracting them.
pub fn verify_trace_package_bytes(
    bytes: &[u8],
    trusted_notary_key: &[u8],
) -> Result<VerifiedTracePackage> {
    let archive = read_trace_package_archive(bytes)?;
    verify_trace_package_archive_with_provider(
        archive,
        sha256_hex(bytes),
        trusted_notary_key,
        &configured_crypto_provider()?,
    )
}

#[cfg(all(test, feature = "cli"))]
fn verify_trace_package_bytes_with_provider(
    bytes: &[u8],
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<VerifiedTracePackage> {
    let archive = read_trace_package_archive(bytes)?;
    verify_trace_package_archive_with_provider(
        archive,
        sha256_hex(bytes),
        trusted_notary_key,
        crypto_provider,
    )
}

/// Fully verifies one already validated in-memory archive without parsing or
/// retaining a second copy of its ZIP entries.
pub fn verify_trace_package_archive(
    archive: ValidatedTracePackageArchive,
    package_sha256: String,
    trusted_notary_key: &[u8],
) -> Result<VerifiedTracePackage> {
    verify_trace_package_archive_with_provider(
        archive,
        package_sha256,
        trusted_notary_key,
        &configured_crypto_provider()?,
    )
}

fn verify_trace_package_archive_with_provider(
    archive: ValidatedTracePackageArchive,
    package_sha256: String,
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<VerifiedTracePackage> {
    let manifest = trace_manifest_from_archive(&archive)?;
    let mut files = archive.into_files();
    let capture = TraceEvidence {
        manifest: manifest.source.clone(),
        evidence: files
            .remove("evidence.tlsn")
            .expect("validated archive contains evidence"),
        request_disclosed: files
            .remove("request.disclosed.http")
            .expect("validated archive contains request disclosure"),
        response: files
            .remove("response.disclosed.http")
            .expect("validated archive contains response disclosure"),
    };
    let (source, request, response) =
        verify_capture_value_with_provider(&capture, trusted_notary_key, crypto_provider)?;
    let request_path = verified_request_path(&request)?;
    let inference = verified_inference_from_capture(&source, &request, &response)?;
    let expected = render_public_trace(&[inference])?;
    let actual = files
        .remove("trace.otlp.json")
        .expect("validated archive contains canonical trace");
    if manifest.trace_sha256 != sha256_hex(&actual) || actual != expected {
        bail!("OTLP trace does not match the authenticated source checkpoint");
    }
    let trace_sha256 = sha256_hex(&actual);
    Ok(VerifiedTracePackage {
        manifest,
        request_path,
        package_sha256,
        trace_sha256,
        trace: actual,
    })
}

fn verified_request_path(request: &str) -> Result<String> {
    let start_line = request
        .lines()
        .next()
        .context("verified provider request has no start line")?;
    let mut fields = start_line.split_ascii_whitespace();
    let _method = fields
        .next()
        .context("verified provider request has no method")?;
    let target = fields
        .next()
        .context("verified provider request has no target")?;
    let _version = fields
        .next()
        .context("verified provider request has no HTTP version")?;
    if fields.next().is_some() {
        bail!("verified provider request has an invalid start line");
    }
    let path = target.split_once('?').map_or(target, |(path, _)| path);
    if !path.starts_with('/') {
        bail!("verified provider request target is not origin-form");
    }
    Ok(path.to_owned())
}

/// Test-only entry point for exercising the complete package verifier with a
/// private certificate authority fixture. Production callers must use the
/// default public-root verifier above.
#[cfg(feature = "test-utils")]
#[doc(hidden)]
pub fn verify_trace_package_archive_with_provider_for_test(
    archive: ValidatedTracePackageArchive,
    package_sha256: String,
    trusted_notary_key: &[u8],
    crypto_provider: &CryptoProvider,
) -> Result<VerifiedTracePackage> {
    verify_trace_package_archive_with_provider(
        archive,
        package_sha256,
        trusted_notary_key,
        crypto_provider,
    )
}

/// Parses and version-checks the source manifest from a canonical archive
/// that has already passed entry, size, metadata, and hash validation.
/// Its fields remain untrusted until the complete package verifier succeeds.
pub fn trace_manifest_from_archive(
    archive: &ValidatedTracePackageArchive,
) -> Result<VerifiedTraceManifest> {
    let manifest: VerifiedTraceManifest = serde_json::from_slice(archive.file("manifest.json")?)
        .context("parsing trace package manifest")?;
    if manifest.format != TRACE_EVIDENCE_FORMAT || manifest.normalizer_version != NORMALIZER_VERSION
    {
        bail!("unsupported verified trace package format or normalizer version");
    }
    Ok(manifest)
}

#[cfg(test)]
fn read_trace_package_file(path: &Path) -> Result<Vec<u8>> {
    if path
        .extension()
        .is_some_and(|extension| extension == "llmcapture" || extension == "llmbundle")
    {
        bail!(
            "encrypted capture files are private retry state and cannot be verified as trace packages"
        );
    }
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("reading trace package {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!(
            "verified trace package must be one regular .llmtrace file: {}",
            path.display()
        );
    }
    fs::read(path).with_context(|| format!("reading trace package {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_checkpoint_is_never_accepted_as_a_verified_package() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["capture.llmcapture", "capture.llmbundle"] {
            let checkpoint = directory.path().join(name);
            fs::write(&checkpoint, b"encrypted private retry state").unwrap();

            let error = read_trace_package_file(&checkpoint).unwrap_err();

            assert!(error.to_string().contains("private retry state"));
        }
    }
}
