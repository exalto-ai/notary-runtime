# Notary runtime agent guide

- `crates/notary-core` owns protocol and evidence contracts.
- `crates/notaryd` is the local proxy/API daemon and supports optional PostgreSQL/S3 clustering.
- `crates/notaryctl` is a thin REST client for the daemon.
- `crates/notary-server` is the generic remote notary.
- `crates/notary-updater` owns signed release updates.
- `apps/admin-dashboard` is the daemon's embedded dashboard.

The local proxy handles plaintext and credentials; a remote notary must never receive either. Never log provider credentials. A deferred `.llmcapture` contains an encrypted checkpoint capable of reconstructing the original request and must only be written with vault encryption.

Run `./tooling/check-boundary.sh`, `cargo fmt --check -p notary-core -p notaryd -p notaryctl -p notary-updater -p notary-server`, `cargo test --workspace --all-targets --all-features`, and `npm --prefix apps/admin-dashboard run build` for changes that affect the corresponding code.
