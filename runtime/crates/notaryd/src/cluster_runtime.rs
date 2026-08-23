//! Explicit multi-replica runtime identity and lifecycle.

use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use tokio::sync::watch;

use crate::{
    config::{CLUSTER_INSTANCE_ID_ENV, valid_instance_id},
    metadata_store::{
        CaptureClaim, MetadataResult, MetadataStoreError, NotarizationClaim, ReplicaIdentity,
        ServerMetadataStore,
    },
};

#[cfg(not(feature = "daemon-e2e"))]
const HEARTBEAT_INTERVAL_SECONDS: u64 = 5;
#[cfg(feature = "daemon-e2e")]
const HEARTBEAT_INTERVAL_SECONDS: u64 = 2;
#[cfg(not(feature = "daemon-e2e"))]
const LEASE_SECONDS: u64 = 20;
#[cfg(feature = "daemon-e2e")]
const LEASE_SECONDS: u64 = 8;
#[cfg(not(feature = "daemon-e2e"))]
const CLAIM_MAX_RUNTIME_SECONDS: u64 = 3_600;
#[cfg(feature = "daemon-e2e")]
const CLAIM_MAX_RUNTIME_SECONDS: u64 = 60;
#[cfg(not(feature = "daemon-e2e"))]
const WITHDRAWAL_DELAY_SECONDS: u64 = 8;
#[cfg(feature = "daemon-e2e")]
const WITHDRAWAL_DELAY_SECONDS: u64 = 4;
#[cfg(not(feature = "daemon-e2e"))]
const SHUTDOWN_GRACE_SECONDS: u64 = 120;
#[cfg(feature = "daemon-e2e")]
const SHUTDOWN_GRACE_SECONDS: u64 = 45;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Lifecycle {
    Starting = 0,
    Ready = 1,
    Draining = 2,
}

#[derive(Debug)]
pub(crate) struct ClusterRuntime {
    identity: ReplicaIdentity,
    lifecycle: AtomicU8,
}

impl ClusterRuntime {
    pub(crate) fn from_environment() -> MetadataResult<Self> {
        let instance_id = std::env::var(CLUSTER_INSTANCE_ID_ENV)
            .ok()
            .or_else(|| {
                std::env::var("HOSTNAME")
                    .ok()
                    .filter(|value| valid_instance_id(value))
            })
            .unwrap_or_else(|| format!("replica-{}", uuid::Uuid::new_v4().simple()));
        let identity = ReplicaIdentity::new(instance_id)?;
        Ok(Self {
            identity,
            lifecycle: AtomicU8::new(Lifecycle::Starting as u8),
        })
    }

    pub(crate) fn identity(&self) -> &ReplicaIdentity {
        &self.identity
    }

    pub(crate) const fn heartbeat_interval_seconds(&self) -> u64 {
        HEARTBEAT_INTERVAL_SECONDS
    }

    pub(crate) const fn lease_seconds(&self) -> u64 {
        LEASE_SECONDS
    }

    pub(crate) const fn withdrawal_delay_seconds(&self) -> u64 {
        WITHDRAWAL_DELAY_SECONDS
    }

    pub(crate) const fn shutdown_grace_seconds(&self) -> u64 {
        SHUTDOWN_GRACE_SECONDS
    }

    pub(crate) fn keep_capture_claim_alive(
        &self,
        metadata: Arc<dyn ServerMetadataStore>,
        claim: CaptureClaim,
    ) -> ClaimLeaseGuard {
        self.keep_claim_alive(metadata, ClaimToRenew::Capture(claim))
    }

    pub(crate) fn keep_notarization_claim_alive(
        &self,
        metadata: Arc<dyn ServerMetadataStore>,
        claim: NotarizationClaim,
    ) -> ClaimLeaseGuard {
        self.keep_claim_alive(metadata, ClaimToRenew::Notarization(Box::new(claim)))
    }

    fn keep_claim_alive(
        &self,
        metadata: Arc<dyn ServerMetadataStore>,
        claim: ClaimToRenew,
    ) -> ClaimLeaseGuard {
        let (shutdown, mut stopped) = watch::channel(false);
        let renewal_interval = Duration::from_secs(HEARTBEAT_INTERVAL_SECONDS);
        let maximum_runtime = Duration::from_secs(CLAIM_MAX_RUNTIME_SECONDS);
        let lease_seconds = LEASE_SECONDS;
        tokio::spawn(async move {
            let started = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    result = stopped.changed() => {
                        if result.is_err() || *stopped.borrow() { return; }
                    }
                    () = tokio::time::sleep(renewal_interval) => {}
                }
                if started.elapsed() >= maximum_runtime {
                    tracing::warn!(
                        "cluster work claim reached its maximum runtime; allowing lease expiry"
                    );
                    return;
                }
                let result = match &claim {
                    ClaimToRenew::Capture(claim) => {
                        metadata.renew_capture_claim(claim, lease_seconds).await
                    }
                    ClaimToRenew::Notarization(claim) => {
                        metadata
                            .renew_notarization_claim(claim, lease_seconds)
                            .await
                    }
                };
                match result {
                    Ok(()) => {}
                    Err(MetadataStoreError::Fenced) => return,
                    Err(error) => {
                        tracing::warn!(error = %error, "cluster work claim renewal failed; retrying until the lease expires")
                    }
                }
            }
        });
        ClaimLeaseGuard { shutdown }
    }

    pub(crate) fn capture_claim(&self, trace_id: impl Into<String>) -> CaptureClaim {
        CaptureClaim::new(trace_id, self.identity.clone())
    }

    pub(crate) fn new_claim_fence(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    pub(crate) fn mark_ready(&self) {
        self.lifecycle
            .store(Lifecycle::Ready as u8, Ordering::Release);
    }

    pub(crate) fn mark_draining(&self) {
        self.lifecycle
            .store(Lifecycle::Draining as u8, Ordering::Release);
    }

    pub(crate) fn lifecycle(&self) -> Lifecycle {
        match self.lifecycle.load(Ordering::Acquire) {
            1 => Lifecycle::Ready,
            2 => Lifecycle::Draining,
            _ => Lifecycle::Starting,
        }
    }
}

enum ClaimToRenew {
    Capture(CaptureClaim),
    Notarization(Box<NotarizationClaim>),
}

pub(crate) struct ClaimLeaseGuard {
    shutdown: watch::Sender<bool>,
}

impl Drop for ClaimLeaseGuard {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}
