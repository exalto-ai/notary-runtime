# Notary Runtime

[![Public Runtime CI](https://github.com/exalto-ai/notary-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/exalto-ai/notary-runtime/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE-MIT)

The open-source foundation of **Exalto Capture** and **Exalto Notary Protocol**.
Capture model-provider HTTP exchanges locally, seal them with Exalto Seal or a
compatible self-hosted notary, and verify portable Traces.

The public source includes the macOS desktop app, local daemon, CLI, generic
remote notary, dashboard, updater, and protocol and verification code. Exalto’s
hosted accounts, billing, uploads, and sharing implementation are proprietary
and maintained separately. Self-hosting does not require an Exalto account.

## Get started

- [Install the CLI and capture your first exchange](runtime/docs/getting-started.md)
- [Download Exalto Capture for macOS](https://seal.exalto.ai)
- [Run your own notary](runtime/docs/self-hosting.md)
- [Read the architecture and trust model](runtime/docs/architecture.md)
- [Understand Trace formats and verification](runtime/docs/artifact-formats.md)

This is pre-release software. Compatibility and artifact formats may change.
The local daemon handles provider plaintext and credentials; the remote notary
must not receive either. A `.llmcapture` is sensitive, vault-encrypted retry
state. A Sealed `.llmtrace` contains selectively disclosed evidence. See the
[trust model](runtime/docs/architecture.md) before sharing a Trace.

## Build from source

The CLI and daemon require Rust 1.95.0 and a C toolchain:

```bash
git clone https://github.com/exalto-ai/notary-runtime.git
cd notary-runtime
cargo install --locked --path runtime/crates/notaryd --bin notaryd
cargo install --locked --path runtime/crates/notaryctl --bin notaryctl
```

Dashboard development additionally requires Node.js 24 and npm:

```bash
npm --prefix runtime/apps/admin-dashboard ci
npm --prefix runtime/apps/admin-dashboard run build
```

To build the desktop app on macOS, install the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
npm --prefix apps/notary-app ci
npm --prefix apps/notary-app run tauri:build:debug
```

[Public CI](https://github.com/exalto-ai/notary-runtime/actions/workflows/ci.yml)
runs Rust formatting, linting, and tests, builds the dashboard, and builds the
macOS desktop app from this repository. Run the Runtime tests locally with:

```bash
cargo test --locked --manifest-path runtime/Cargo.toml --workspace --all-targets --all-features
```

## Development and feedback

Use [public issues](https://github.com/exalto-ai/notary-runtime/issues) for bugs
and suggestions. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

Development currently happens in Exalto’s private monorepo and is exported
here after validation. Public pull requests can be reviewed here, but accepted
changes must be imported into that monorepo before export; merging a change
only into this mirror would allow the next export to overwrite it. Each export
records its source revision in `.notary-source.json`.

[GitHub Releases](https://github.com/exalto-ai/notary-runtime/releases) provide
change notes and download links. Stable source releases use `vX.Y.Z` tags.
Official clients use the signed `latest` update channel at `seal.exalto.ai`; see
[download verification](runtime/docs/releases.md).

## License

Exalto-authored runtime and desktop source is [MIT licensed](LICENSE-MIT).
Vendored components retain their original licenses and notices; see
[third-party notices](runtime/THIRD-PARTY-NOTICES.md).
