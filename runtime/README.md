# Notary runtime

This directory is the independently buildable public runtime for Notary. It contains the local proxy daemon, its thin REST CLI, the generic remote notary, the local dashboard, signed updater logic, protocol/evidence contracts, and the pinned TLSNotary dependencies.

It deliberately does not contain the server-side account, credit, billing,
hosted-admission, upload, or public-website implementations. The daemon and
dashboard retain optional clients for connecting to those hosted services;
their product policy and service code live outside this tree. Hosted notary
admission integrates through the notary server's admission-policy seam.

## Build

Rust 1.95 and a C toolchain are required:

```bash
cargo build --locked --workspace
cargo test --locked --workspace --all-targets --all-features
```

The local dashboard additionally needs Node.js 24 and npm:

```bash
npm --prefix apps/admin-dashboard ci
npm --prefix apps/admin-dashboard run build
```

Install the two local programs independently:

```bash
cargo install --locked --path crates/notaryd --bin notaryd
cargo install --locked --path crates/notaryctl --bin notaryctl
```

Run `notaryd`, route a supported provider client through `127.0.0.1:8787`, and inspect private captures through the dashboard at `127.0.0.1:8788` or the `notaryctl` command.

## Trust boundary

The local daemon sees plaintext model traffic and provider credentials. The remote notary resolves and connects to allowlisted provider hosts but must not receive either. A `.llmcapture` is private encrypted retry state capable of reconstructing the original request; a notarized `.llmtrace` is selectively disclosed public evidence. Never treat the two as interchangeable.

See [Getting started](docs/getting-started.md), [architecture](docs/architecture.md), [artifact formats](docs/artifact-formats.md), and [self-hosting](docs/self-hosting.md). Run `./tooling/check-boundary.sh` before publishing this tree.
