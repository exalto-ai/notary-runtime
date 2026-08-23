mod admission;
mod config;
mod server;

pub use admission::{
    AdmissionConstraints, AdmissionGrant, AdmissionPolicy, AdmissionRequest, SessionLifecycle,
    SessionOutcome, TicketlessAdmissionPolicy,
};
pub use config::{
    NotaryServerArgs, NotaryServerCommand, NotaryServerConfig, NotaryServerPublicKeyArgs,
    NotaryServerServeArgs, print_public_key, read_private_file,
};
pub use server::{run, serve, serve_on_listener, shutdown_signal};

#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod test_support {
    pub use crate::server::exercise_admission_policy_contract;
}
