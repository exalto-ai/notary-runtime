# Getting started

Install the command-line tools to connect an SDK, coding agent, server, or
automated workflow. The daemon keeps private capture material on your machine;
the CLI is a short-lived client for its loopback REST API.

Notary is pre-release and does not yet promise stable compatibility or file
formats. The website's `latest` channel is deliberately moving: each successful
publication replaces the previous release.

## Install the CLI and local service

Use this path for SDK and agent integration, scripting, unattended systems, or
direct control of the local API. The installer supports Apple silicon Macs and
x86-64 or ARM64 Linux systems. It requires `curl`, `tar`, and either
`sha256sum` or `shasum`.

```bash
curl -fsSL https://notary.exalto.ai/install.sh | sh
```

The installer selects the current complete `latest` build, verifies the selected
archive against its published SHA-256 value, and places `notaryd` and
`notaryctl` in `~/.local/bin`. Set `NOTARY_INSTALL_DIR` to choose another
destination. The checksum detects corruption in transit or storage; it is not
an independent signature because the archive and checksum share a publisher.

After the first install, official builds authenticate the signed channel and
release manifest before trusting either binary's size and SHA-256. The client
remembers the highest signed channel revision it accepted, so replaying an
older pointer cannot silently downgrade it:

```bash
notaryctl version
notaryctl update --check
notaryctl update
```

The build ID, not the package's pre-release `0.1.0` label or a timestamp,
decides whether an update is available. Any different build ID is accepted,
including an intentional rollback selected by the trusted `latest` channel.
The updater stages and verifies both programs before changing either one and
keeps rollback copies until both replacements are confirmed. It never stops a
running daemon. Restart `notaryd` yourself after active capture and proof
work finishes. On Windows the daemon must already be stopped. The update is
applied by a short-lived helper after the running CLI exits; the version
command reports the helper's last durable result.

To build from source instead, install Rust 1.95.0 and a C toolchain, then run:

```bash
git clone https://github.com/exalto-ai/notary-runtime.git
cd notary-runtime/runtime
cargo install --locked --path crates/notaryd --bin notaryd
cargo install --locked --path crates/notaryctl --bin notaryctl
```

Node.js 24 and npm are needed only for dashboard development.

The two installed programs have separate jobs:

- `notaryd` is the long-running local proxy and administration daemon.
- `notaryctl` is a short-lived REST client for that daemon.

`notaryctl` does not start the service and does not open the metadata store, vault,
or artifacts directly.

## Install the portable agent skill

The CLI bundles an [Agent Skills](https://agentskills.io) compatible skill that
teaches local coding agents how to find captures, notarize selected calls,
verify traces, diagnose operations, and ask before state-changing or public
actions. Installing the skill does not contact or start the daemon.

Install it for one supported agent, or both:

```bash
notaryctl skill install --target codex
notaryctl skill install --target claude
notaryctl skill install --target all
```

Codex receives it under `~/.agents/skills/notary`. Claude Code receives it
under `$CLAUDE_CONFIG_DIR/skills/notary` when that environment variable is
nonempty and under `~/.claude/skills/notary` otherwise. For another
compatible agent, provide its skills directory and the installer will create
the `notaryctl` child:

```bash
notaryctl skill install --skills-dir /path/to/agent/skills
```

Claude Code detects changes inside its existing personal `skills` directory.
If that top-level directory did not exist when the current Claude Code session
started, restart Claude Code after installation so it discovers the skill.

The installed skill uses the command client first and treats the running
daemon's `/openapi.json` as the authority for operations the CLI does not
expose. It never needs a non-loopback listener. If a destination already
contains different bundled files, installation stops without changing any
target. Inspect the existing skill before explicitly replacing those files:

```bash
notaryctl skill install --target all --force
```

Re-run the install command after updating Notary so the installed skill
matches the local CLI. The portable source is committed at
[`skills/notary`](../skills/notary/SKILL.md), and the
[coding-agent playbook](agent-playbook.md) explains its safety and consent
boundaries.

## Start the daemon

```bash
notaryd
```

The first start writes `config.toml` once and initializes the checkpoint vault. The
default configuration enables the five built-in routes and binds only these
distinct loopback listeners:

| Listener | Address | Purpose |
| --- | --- | --- |
| Provider proxy | `127.0.0.1:8787` | Provider-compatible API requests |
| Administration | `127.0.0.1:8788` | Dashboard, health, OpenAPI, and `/v1` |

Configuration locations are:

- Linux: `$XDG_CONFIG_HOME/notary/config.toml` when `XDG_CONFIG_HOME` is set,
  otherwise `~/.config/notary/config.toml`
- macOS: `~/Library/Application Support/notary/config.toml`
- Windows: `%APPDATA%\notary\config.toml`

Use an explicit file when developing isolated configurations:

```bash
notaryd --config /path/to/config.toml
```

Pass the same `--config` option to `notaryctl` commands.

## Check the local service

Open [http://127.0.0.1:8788](http://127.0.0.1:8788), or query it directly:

```bash
curl --fail-with-body http://127.0.0.1:8788/healthz
curl --fail-with-body http://127.0.0.1:8788/openapi.json
notaryctl status
```

The administration API is open to other local processes by default. Configure
`admin.auth` when that is too broad for the machine. Both listeners remain
loopback-only even when authentication is enabled. See [Local service and REST
API](local-service.md#start-and-supervise-the-service).

## Choose a notary

With no explicit notary configuration, the daemon obtains one-time hosted
admission and the versioned notary Registry from the configured public LLM
Notary origin. The Registry is authenticated by HTTPS; it is not a separately
signed document. The client pins accepted generations and key lifecycle state
locally.

Each hosted capture requests a purpose-specific ticket without requesting a
copy of the account balance or a byte grant. Each hosted notarization requests
a separate ticket bound to the checkpoint's exact record digest and authenticated
allowance. Tickets are neither cached nor renewed. Admission denial, exhausted
allowance, expiry, and platform API outages are returned as bounded errors that
do not include the raw ticket or account credential.

For local or self-hosted development, start a notary and explicitly pin its
key:

```bash
install -m 0600 /dev/null notary.dev.key
openssl rand -hex 32 > notary.dev.key
cargo run -p notary-server --bin notary-server -- \
  serve \
  --signing-key-file notary.dev.key \
  --allow-host api.openai.com \
  --allow-host chatgpt.com \
  --allow-host api.anthropic.com \
  --allow-host api.deepseek.com \
  --allow-host openrouter.ai
```

The process prints its compressed SEC1 public key. Stop the local daemon, then
set both values in its `config.toml`:

```toml
[notary]
endpoint = "tcp://127.0.0.1:7047"
public_key = "02..."
```

An explicit endpoint without its expected key is rejected. Restart the daemon
after editing the file.

For unattended or clustered use, configure an explicit notary endpoint and key
so the runtime does not depend on a hosted account or platform API.

## Capture one call

Keep the API key in the provider client and replace only its base URL. For an
OpenAI Responses request:

```bash
curl http://127.0.0.1:8787/openai/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_RESPONSES_MODEL","input":"Reply with exactly: notary"}'
```

Use a model available to the provider account. See [Provider and agent
setup](provider-setup.md) for every route, including the live-tested Codex CLI
and Claude Code subscription configurations.

The response is relayed normally. After it ends, the daemon records a Trace
row and vault-encrypts `<trace-id>.llmcapture`. The capture file is a private
checkpoint containing enough information to reconstruct the original request,
including its credential. Do not inspect, copy, or upload it as though it were
a proof.

Find the Trace without decrypting every checkpoint:

```bash
notaryctl traces list --provider openai --limit 20
notaryctl traces show trc-example
```

Human Trace output omits stored prompt and output previews. For structured
discovery that enters an agent transcript, use
`notaryctl --json traces list --metadata-only`; raw Trace-list JSON includes
those previews.

## Notarize and verify

Only captured `2xx` responses are currently eligible for notarization.
Notarization is asynchronous and can take much longer than capture:

```bash
notaryctl traces notarize trc-example --wait
```

Without `--wait`, return to `notaryctl traces show trc-example` to inspect the
latest notarization attempt while it is queued or running. With `--wait`, the
CLI follows the attempt and reports authenticated transcript bytes and
completed commitments. Its terminal state is `succeeded`, `failed`, or
`interrupted`. A successful attempt writes one deterministic
`<trace-id>.llmtrace` package and retains the encrypted checkpoint. `--json
--wait` suppresses intermediate lines so standard output remains one JSON
value.

```bash
notaryctl traces verify trc-example
```

Verification checks the notary evidence, authenticated provider, disclosed
HTTP bytes, package hashes, privacy policy, and exact normalized trace. Read
[Artifact formats and verification](artifact-formats.md) before sharing the
package.

## Next steps

- [Use the dashboard](admin-dashboard.md)
- [Configure providers and coding agents](provider-setup.md)
- [Operate the daemon and REST API](local-service.md)
- [Understand the architecture and trust model](architecture.md)
- [Run a self-hosted notary](self-hosting.md)
- [Run clustered daemon replicas](cluster-operations.md)
