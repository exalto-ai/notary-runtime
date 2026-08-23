# Notary Runtime

This repository is the public source projection of the Notary Runtime and
desktop application. The private development repository remains canonical;
every exported commit records the exact canonical source SHA in
`.notary-source.json`.

The Runtime keeps provider plaintext and credentials on the local machine. A
remote notary resolves and connects to an explicitly allowed provider hostname
and receives only the Proxy-TLS protocol traffic needed for capture and
notarization. A deferred `.llmcapture` can reconstruct the original request and
must never be written without local vault encryption.

## Layout

- `runtime/` is the standalone Rust workspace containing the CLI, daemon,
  generic notary, updater, dashboard, protocol contracts, and documentation.
- `apps/notary-app/` is the desktop application and bundles `notaryd` from the
  Runtime workspace.

## Build

Install Rust 1.95.0, Node.js 24, npm, and the platform prerequisites documented
by Tauri. From the repository root:

```bash
cargo test --locked --manifest-path runtime/Cargo.toml --workspace --all-targets --all-features
npm --prefix runtime/apps/admin-dashboard ci
npm --prefix runtime/apps/admin-dashboard run build
npm --prefix apps/notary-app ci
npm --prefix apps/notary-app run prepare:sidecar:debug
npm --prefix apps/notary-app run build
```

The export workflow verifies the Runtime and desktop from a clean projection
before advancing `main`. This repository is currently a one-way mirror; public
contribution import automation is intentionally not part of the first export.

Stable source releases use `vX.Y.Z` tags. Each tag and GitHub Release maps to
the exact canonical private source SHA recorded in `.notary-source.json`;
installable clients are published separately through the signed `latest`
channel at `notary.exalto.ai`.

The source is licensed under MIT or Apache-2.0 at your option. Vendored
components retain their own notices and licences.
