# Local service and REST API

In the default local profile, one `notaryd` process owns the metadata store,
vault, artifacts, and durable operation state. The short-lived
`notaryctl` command talks to it through the versioned loopback API.
`notaryd` owns two different loopback listeners:

| Listener | Default | Purpose |
| --- | --- | --- |
| Provider proxy | `http://127.0.0.1:8787` | Receives provider-compatible requests and creates private captures. |
| Administration | `http://127.0.0.1:8788` | Serves the dashboard, health check, OpenAPI document, and `/v1` API. |

Both addresses must be distinct and loopback-only. The separation prevents a
program that can send model requests through the proxy from automatically
receiving access to capture management. An `/admin` path on the proxy would
not provide that boundary: a route prefix is organization, not authentication.
The PostgreSQL-and-S3 cluster profile is documented separately in
[Cluster deployment](cluster-operations.md).

## Pause new captures

Use the **Capture requests** switch in the dashboard Settings page or the
generated local API:

`GET /v1/settings/capture` reads the authoritative value and
`PUT /v1/settings/capture` changes it.

```bash
curl http://127.0.0.1:8788/v1/settings/capture
curl -X PUT http://127.0.0.1:8788/v1/settings/capture \
  -H 'content-type: application/json' \
  -d '{"enabled":false}'
```

The write returns the authoritative stored value. The setting lives in daemon
metadata, defaults to on, and survives daemon and desktop restarts. If admin
authentication is configured, these routes require it like the other `/v1`
routes.

Off does not stop or bypass the local daemon. Existing configured provider
URLs continue to work, but new requests stream from `notaryd` directly to
the adapter's fixed provider origin over HTTPS. There is no remote notary,
hosted admission, capture row, capture ID, preview, or `.llmcapture`, so nothing
from that request can later be notarized or verified. Existing captures and
notarizations remain usable. Enabling capture first initializes trusted notary
state; if that fails, the API returns
`capture_enable_initialization_failed` and capture stays off.

## Start and supervise the service

Run the service in the foreground. It writes the default configuration on
first start, or accepts an explicit file:

```bash
notaryd --config /path/to/config.toml
```

The process logs lifecycle metadata to standard error and exits when it cannot
bind either listener or safely open its storage. A service manager such as
systemd, launchd, or the Windows Service Control Manager can supervise this
same foreground command. Stop it through the manager or with the terminal's
normal interrupt; do not run a second process against the same metadata store.

On interrupt or termination, the daemon first closes both listeners to new
requests. Existing provider response streams are allowed to finish and seal
their private capture, and the notarization worker stops claiming queued work
after it finishes the operation it already owns. Queued operations remain in
the metadata store for the next start. The desktop app requests the same drain
over
its private child-process pipe. It does not send a kill signal as an update or
normal stop mechanism.

There is no compatibility alias: `notaryctl` does not start the service.
Service-manager `ExecStart`, launchd `ProgramArguments`, and Windows service
definitions must invoke `notaryd`, optionally followed by `--config` and
the configuration path.

The executable name is the same in each supervisor. Adapt the executable and
configuration paths to the installation:

```ini
# systemd service
ExecStart=/usr/local/bin/notaryd --config /etc/notary/config.toml
```

```xml
<!-- launchd ProgramArguments -->
<array>
  <string>/usr/local/bin/notaryd</string>
  <string>--config</string>
  <string>/Users/example/Library/Application Support/notary/config.toml</string>
</array>
```

```powershell
# Windows Service Control Manager
sc.exe create Notary binPath= '"C:\Program Files\Notary\notaryd.exe" --config "C:\ProgramData\Notary\config.toml"'
```

The smallest useful explicit configuration is:

```toml
format = "notary/notaryd-config/v1"

[proxy]
listen = "127.0.0.1:8787"

[admin]
listen = "127.0.0.1:8788"

# Optional. Omit this table to allow access from local processes without credentials.
# [admin.auth]
# username = "local-admin"
# password_hash = "$argon2id$v=19$m=32768,t=2,p=1$..."

[notary]
# A local/self-hosted endpoint and its compressed SEC1 public key are paired.
# endpoint = "tcp://127.0.0.1:7047"
# public_key = "02..."
```

### Metadata backend

SQLite remains the default. Pre-cutover databases are rejected rather than
migrated. To run one daemon with PostgreSQL instead, change only the backend:

```toml
[metadata]
backend = "postgres"
```

```bash
export NOTARYD_METADATA_DATABASE_URL='postgresql://…'
notaryd migrate --config /path/to/config.toml
notaryd --config /path/to/config.toml
```

Use `NOTARYD_METADATA_DATABASE_URL_FILE` for a mounted secret. The defaults
verify the database certificate and hostname and use up to eight pooled
connections. Separate migration credentials, TLS/pool tuning, role grants, and
backup steps are covered in [cluster operations](cluster-operations.md).

The migrator touches only the daemon-owned schema; runtime startup never
migrates or falls back to SQLite. Prompt and output previews are plaintext in
PostgreSQL even though deferred checkpoints remain vault-encrypted. PostgreSQL
alone does not make multiple daemon processes safe. Keep one process unless
cluster mode is enabled with PostgreSQL and S3.

### Artifact backend

The filesystem remains the default artifact writer. Pre-cutover paths and
legacy `.llmbundle` files are not imported or read. To write vault-encrypted
`.llmcapture` checkpoints and exact `.llmtrace` packages to an
S3-compatible private bucket, select S3 explicitly:

```toml
[storage]
backend = "s3"

[storage.s3]
bucket = "trace-artifacts"
```

That minimal form uses AWS S3 in `us-east-1`, the private `notaryd`
prefix, HTTPS, virtual-hosted addressing, and bounded timeouts. Set `region`
for another AWS region. S3-compatible services may also set `endpoint` and
`force_path_style`; plain HTTP additionally requires the explicit
`allow_insecure_http = true` opt-in and is intended only for a trusted local
emulator such as MinIO.

Credentials never belong in `config.toml`. Set
`NOTARYD_ARTIFACT_S3_ACCESS_KEY_ID` and
`NOTARYD_ARTIFACT_S3_SECRET_ACCESS_KEY`, or use their `_FILE` forms. An
optional session token uses `NOTARYD_ARTIFACT_S3_SESSION_TOKEN` or its
`_FILE` form. A direct value wins without reading the corresponding file.
Ambient instance metadata and shared SDK profiles are not used.

An explicit endpoint must be an origin with no credentials, path, query, or
fragment. Give the runtime `GetObject` and `PutObject` access within the
configured prefix, plus `ListBucket` constrained with `s3:prefix` to the
managed `notaryd/` namespace. Readiness uses one bounded, non-mutating
list request against that namespace; reconciliation uses the same permission.
Runtime credentials do not need `DeleteObject`. Objects are always addressed
under `notaryd/capture-checkpoints` or `notaryd/trace-packages`. Neither bucket
nor object keys contain
prompts, outputs, or provider credentials.

The daemon privately spools, hashes, conditionally creates, reads back, and
verifies each object before metadata can advertise it. A retry reuses an exact
size/hash match and never overwrites different bytes. Locators record the
backend, so filesystem and S3 records remain independently readable when the
selected writer changes. Writes go to one selected backend only; there is no
dual-write migration or automatic copy.

Missing objects return `artifact_missing`; wrong size or hash returns
`artifact_corrupt`; size limits, immutable collisions, unavailable backends,
and missing historical backend configuration have separate safe codes. The
runtime does not automatically delete unreferenced objects. An object left by
a stop after PUT but before metadata commit remains adoptable by capture
recovery or notarization retry. Stop the daemon and run the bounded,
report-only check before cleanup:

```bash
notaryd reconcile-artifacts --config /etc/notary/config.toml
```

The JSON report verifies every referenced artifact and counts old,
unreferenced candidates only beneath the configured managed prefix. The safe
default ignores objects newer than seven days; `--orphan-grace-days` can
override that threshold. The command never prints object keys, mutates
metadata, or deletes bytes, and it follows bounded S3 pages until the complete
managed prefix has been scanned. Operators may
remove candidates only after resolving every missing, corrupt, invalid, or
backend finding, while the daemon remains stopped, and after comparing the
report with a consistent metadata backup. Never apply that cleanup rule
outside the managed prefix.

The admin listener is open to local processes by default. Both listeners must
still use loopback addresses, and the provider proxy never mounts admin
routes. This is the simplest setup for a single-user workstation and for a
coding agent already running with the user's local permissions.

To require credentials, add `[admin.auth]` with a username and an Argon2id PHC
password hash. The hash contains its salt and work parameters; never store the
plaintext password in the configuration. Generate it with a tool that prompts
for the password instead of accepting it as a command-line value. For example:

```bash
caddy hash-password --algorithm argon2id
```

Copy the complete output into `password_hash`. Notary rejects plaintext,
bcrypt, and malformed values. The Argon2id requirement follows current
[OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html);
the prompted Caddy command is one convenient generator, not a runtime
dependency.

## Health, discovery, and authentication

The dashboard shell, its static assets, `GET /healthz`, `GET /readyz`, and
`GET /openapi.json` are always public on the loopback admin listener. With the
default configuration, `/v1` is also available without credentials. OpenAPI
describes each operation as accepting anonymous access or HTTP Basic because
the exact requirement is a local configuration choice.

Start with the default flow:

```bash
export NOTARYD_ADMIN_ORIGIN=http://127.0.0.1:8788

curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/healthz"
curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/readyz"
curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/openapi.json" > /tmp/notary-openapi.json
curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/v1/status"
```

Keep the origin fixed to the configured loopback listener. Do not accept an
origin from untrusted input.

`/healthz` is local process liveness and stays healthy during a database or S3
outage. `/readyz` runs bounded probes for metadata and the selected artifact
writer and returns `503` when either dependency is unavailable. Historical
inactive artifact readers are checked when an artifact needs them, not by the
global readiness probe.

When `admin.auth` is configured, API clients may send standard HTTP Basic
credentials. A browser receives 401, shows the username/password form, and
exchanges those credentials at `POST /v1/session` for an HttpOnly, SameSite
cookie. It clears the fields and does not keep the password in browser storage.
For an interactive shell, `curl --user local-admin URL` prompts for the
password without placing it in shell history or the process argument list.
Noninteractive clients should obtain the password from their approved secret
mechanism and follow the `basicAuth` scheme in OpenAPI. The service sends no
cross-origin access headers, so another website cannot use the admin API as a
browser backend.

The bundled CLI reads the daemon configuration only to resolve the loopback
admin listener and configured username. It rejects non-loopback listeners,
checks `/healthz` for API `v1` before each command, and sends every stateful
operation through `/v1`. With Basic authentication enabled it prompts for the
password without echoing it. For automation, store the password in a private
UTF-8 file and pass its path rather than the secret itself:

```bash
notaryctl status
notaryctl --admin-password-file /private/admin-password status
notaryctl --config /path/to/config.toml traces list --metadata-only --json
```

On Unix, the password file must not be accessible to group or other users.
The CLI never reads the Argon2id hash as though it were a password and never
stores a prompted password.

`notaryctl version`, `notaryctl update --check`, `notaryctl update`, and
`notaryctl skill install` run before configuration loading and daemon
compatibility checks. This keeps release recovery and agent-skill installation
available when the service is stopped or an installed pair has an incompatible
API. Official daemons authenticate the signed `latest` channel and its
monotonically increasing revision, then check it in the background after
startup and about every six hours with jitter. `/v1/status` reports only the
current/latest build IDs, availability, last check time, and a bounded failure
code; development builds make no update request.

## Command client

Human-readable output is the default. `--json` prints one JSON value to
standard output for automation on success or failure. A failure retains its
nonzero exit status and uses the bounded
`{"error":{"code":"...","message":"..."}}` envelope without a duplicate
plain-text diagnostic. List filters map directly to server-side REST filters,
and accepted mutations print the durable operation or job identifier without
waiting indefinitely. Trace-list JSON includes stored prompt and output
previews; use `--metadata-only` before sending it to an agent transcript:

```bash
notaryctl traces list --query sanitized --provider openai --limit 20
notaryctl traces list --cursor "$next_cursor"
notaryctl traces list --provider openai --all --metadata-only --json
notaryctl traces show trc-example
notaryctl traces notarize trc-example
notaryctl traces show trc-example --json
notaryctl traces verify trc-example
notaryctl activity --severity error --limit 20
notaryctl activity --after "$high_water_cursor"
notaryctl notaries list
notaryctl skill install --target all
notaryctl open
```

The skill installer writes the release's portable `notaryctl` skill to Codex,
Claude Code, both, or a custom skills directory. It preflights every requested
destination and refuses to replace different bundled files without `--force`.
It does not contact the daemon. See the [coding-agent
playbook](agent-playbook.md) for paths and consent boundaries.

Sharing identity remains daemon-owned. Account connection, disconnection,
inspection, and sharing all use the local REST API, so only `notaryd` accesses
the credential vault or notarized artifact:

```bash
notaryctl account connect
notaryctl account show
notaryctl account show --json
notaryctl traces share trc-example                         # Unlisted by default
notaryctl traces share trc-example --visibility listed
notaryctl traces share trc-example --force                 # Only after disclosure review
notaryctl traces share trc-example --reactivate            # Resume a stopped share
notaryctl account disconnect
```

`account show` reports an explicit connection state (`disconnected`, `connected`,
`reauthorization_required`, or `unavailable`) and, when available, the display
name, sign-in provider, device or API-key mode, plan, billing state, account
links, and credit balances. Human output is intended for quick inspection;
`--json` is the stable machine-readable form. When connected, account
inspection includes the same total, monthly, additional, reset, and expiration
values returned by the hosted account API.
The account dashboard retrieves credit activity separately from the paginated
`GET /api/credits/history` route. These fields affect hosted notarization
only; they do not enter local captures or notarized evidence.

Exit code `2` is invalid input, `3` means the daemon is unavailable, `4` is an
authentication failure, `5` is not found, `6` is a state conflict, `7` is a
retryable daemon failure, and `8` is an API-version mismatch. Other failures
use `1`. Error text is safe and never echoes credentials or plaintext headers.

## API conventions

- `/v1` is the current administration API version. Fetch `GET /openapi.json`
  at runtime rather than guessing routes, fields, or future versions. Use
  `GET /healthz` for liveness and `GET /readyz` for dependency readiness.
- Request and response bodies are JSON where the OpenAPI operation declares a
  body. Trace and operation identifiers are opaque strings such as `trc-…` and
  `op-…`.
- Errors use `{"error":{"code":"safe_code","message":"safe message"}}`.
  Codes and messages exclude credentials, plaintext headers, and local paths.
  Invalid query values use the same JSON envelope; for example, a negative
  `limit` returns `invalid_query_parameter` instead of a framework error page.
- Trace lists use `limit` and an opaque `cursor`. Supported filters are
  `query`, `state`, `status`, `provider`, `model`, `streaming`,
  `created_from_unix_ms`, `created_before_unix_ms`, and `metadata_only`. A
  cursor is valid only with the route and filters that produced it. Offset
  pagination and old capture/notarization filter aliases are rejected.
- Trace search treats punctuation as token boundaries, so `safety-review`
  and `**safety**` are safe inputs. Space-separated words must all match;
  double quotes preserve a phrase such as `"safety review"`.
- The `needs_attention` status is the cursor-paginated aggregate of capture
  failures and failed or interrupted notarization attempts.
- Activity supports exact `severity`, `event_type`, `trace_id`, and
  `operation_id` filters, a `created_after_unix_ms` lower bound, and `limit`.
  Use `next_cursor` to continue backward through history. Save the separate
  `high_water_cursor` and pass it as `after` to follow newer events without
  changing the meaning of the back-pagination cursor.
- Mutations that start background work return `202 Accepted`. Record the
  returned operation identifier and poll its technical resource. A 202
  response does not mean the proof is complete.
- Cancellation is not implemented. Do not invent or call a cancellation route.

The OpenAPI document is the complete schema reference. This compact map shows
which workflow owns each operation:

| Workflow | Operations |
| --- | --- |
| Discovery | `GET /healthz`, `GET /readyz`, `GET /openapi.json` |
| Session and status | `POST /v1/session`, `DELETE /v1/session`, `GET /v1/status` |
| Capture setting | `GET /v1/settings/capture`, `PUT /v1/settings/capture` |
| Notaries and providers | `GET /v1/notaries`, `GET /v1/providers` |
| Traces | `GET /v1/traces`, `GET /v1/traces/{trace_id}` |
| Notarization | `POST /v1/traces/{trace_id}/notarizations`, `GET /v1/operations/{operation_id}` |
| Notarized Trace | `GET /v1/traces/{trace_id}/package.llmtrace`, `GET /v1/traces/{trace_id}/content`, `POST /v1/traces/{trace_id}/verify` |
| Portable verification | `POST /v1/verify` |
| Activity | `GET /v1/activity` |
| Account connection | `GET /v1/account`, `POST /v1/account`, `GET /v1/account/{request_id}`, `DELETE /v1/account` |
| Sharing | `GET /v1/traces/{trace_id}/share`, `PUT /v1/traces/{trace_id}/share`, `DELETE /v1/traces/{trace_id}/share` |

`GET /v1/notaries` returns a safe read-only view of the locally pinned or
server-shared Registry, or the explicitly configured self-hosted endpoint and
key. Each Notary preserves its proper `name`, `operator`, verification key, and
`lifecycle`. Registry membership describes allowed protocol use; it is not an
endpoint health check. `GET /v1/providers` is the explicit provider allowlist:
it reports pinned hosts, client API styles, proxy route prefixes, and configured
readiness without accepting arbitrary upstream hosts.

For example, search the plain-text preview index and fetch one Trace by its
identifier:

```bash
curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces?query=sanitized&provider=openai&limit=20"

trace_id=trc-example
curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id"
```

Inspect only failed/interrupted Traces or error Activity without downloading
and filtering the entire bounded history in the client:

```bash
curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces?status=notarization_failed&limit=20"

curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/activity?severity=error&event_type=notarization_failed&limit=20"
```

The searchable preview is local plaintext. Set `prompt_preview_chars` and
`output_preview_chars` to `0` when even a short searchable preview is not
appropriate for the machine.

## Trace and notarization lifecycle

A Trace has stable `state: captured` once its encrypted checkpoint is committed.
It remains Captured while notarization is queued, running, failed, or
interrupted, and becomes `state: notarized` only when the exact `.llmtrace`
package is committed and available. A request still being captured or whose
source capture failed has null state and `status: capturing` or
`status: capture_failed`. The other operational statuses are `notarizing`,
`notarization_failed`, and `notarization_interrupted`; a stable state without a
subordinate condition has null status. `GET /v1/status` exposes `captured`,
`notarizing`, `notarized`, `needs_attention`, `capturing`, and `capture_failed`
counts.

The current provider normalizers support successful response schemas only.
When capture completes with a non-`2xx` provider status, Trace detail sets
`notarization_eligible` to `false` and reports
`notarization_ineligibility_code: unsupported_provider_http_status`. Starting
notarization returns `409` with the same code before any proof work is queued.
The encrypted checkpoint remains local and unchanged; retry is not offered because
the recorded provider response cannot become successful on a later attempt.

Queue or retry notarization with `POST /v1/traces/{trace_id}/notarizations` and
save the durable operation identifier from the 202 response. Poll it with
`GET /v1/operations/{operation_id}`:

```bash
trace_id=trc-example
response=$(curl --fail-with-body -X POST \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/notarizations")
operation_id=$(printf '%s' "$response" | jq -r '.operation.operation_id')
printf 'Queued operation %s\n' "$operation_id"

curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/operations/$operation_id"
```

If the same Trace is submitted while active work already exists, the service
returns that operation and sets `deduplicated` to `true`. It does not start a
competing proof. A failed or interrupted operation is requeued through the same
Trace action, preserving its identifier and `attempt_history`. Poll while
operation `state` is `queued` or `running`; terminal states are `succeeded`,
`failed`, and `interrupted`.

Every operation response includes `progress.phase`. The values are `queued`,
`preparing`, `proving`, `signing`, `packaging`, and `complete`; these are named
milestones, not equal portions of elapsed time. During `proving`,
`progress.proof` reports `bytes_completed`, `bytes_total`,
`commitments_completed`, and `commitments_total`. The byte ratio measures
private transcript authentication inside the dominant proof loop. It is not an
overall ETA, and the service retains the last proof counters while signing or
packaging. The daemon updates durable counters at most about once per second.

After a restart, work that was `running` is recorded as `interrupted` with the
safe code `service_restarted`. Queued work remains durable. Retry only a
`failed` or `interrupted` operation whose response says `retryable: true` by
posting the owning Trace action again:

```bash
curl --fail-with-body -X POST \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/notarizations"
```

Trace detail includes the current technical `notarization` with `retryable` and
complete `attempt_history`, so an agent can distinguish earlier interrupted or
failed attempts from the current aggregate state without searching Activity.

## Validation, verification, and sharing

An encrypted `.llmcapture` is private retry state. Checking that the vault can
decrypt and parse it establishes only that the local artifact is structurally
usable; it is not independent proof of the provider response. The capture can
reconstruct the original authenticated request, including credentials, so it
must remain vault-encrypted and local.

A notarized trace is one deterministic `.llmtrace` ZIP containing the
TLSNotary evidence, disclosed HTTP artifacts, manifest, archive manifest, and
canonical OpenTelemetry JSON. Every HTTP header value is hidden except the
exact structural value `Transfer-Encoding: chunked`; the authenticated request
and response bodies remain disclosed. Download its exact bytes or verify it
through the Trace identifier:

```bash
trace_id=trc-example
curl --fail-with-body --output "$trace_id.llmtrace" \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/package.llmtrace"

curl --fail-with-body -X POST \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/verify"
```

`POST /v1/verify` accepts one bounded portable `.llmtrace` body for in-memory
verification without importing, retaining, indexing, or sharing it. It
returns `outcome: passed`, `failed`, or `unsupported`; failures are results,
not competing Trace states. The thin CLI uses this loopback route for
path-based verification.

A successful response contains `outcome: passed`, a verification time,
`notary_key_id`, and `trust_source`. This operation rechecks the evidence,
disclosure, hashes, provider adapter, and canonical trace bytes.
`GET /v1/traces/{trace_id}/content` decodes the same notarized package into
its manifest and canonical trace document for inspection; it does not replace
the verification operation.

Sharing is a later, explicit consent decision. It is never part of local
notarization. The `/v1/account` device flow authorizes the local service, and
`PUT /v1/traces/{trace_id}/share` creates or updates the one canonical share
for an eligible Notarized Trace with explicit `unlisted` or `listed`
visibility. It may also set expiry and a write-only password; responses expose
only `password_protected`, never the password. Ask the user before sharing or
changing service configuration. Device authorization starts with `202 Accepted`; obey
its `poll_interval_seconds` and keep polling the returned
`/v1/account/{request_id}` route while `signed_in` is false.
When the daemon uses an injected API key, `POST /v1/account` and
`DELETE /v1/account` return `409`; create and revoke API keys in the hosted
dashboard instead.
Before it authenticates or uploads, the local service cryptographically verifies
the exact notarized package and applies the same versioned public-disclosure
safety policy used by hosted admission. The hosted worker repeats both checks;
local acceptance never guarantees admission by a newer server policy.
An explicit `force: true` request, exposed by `notaryctl traces share --force`, accepts
only unexplained high-entropy values after the user reviews the complete
disclosure. It cannot override known secret patterns, credential fields,
disclosed header values, signed credential queries, invalid archives, or failed
cryptographic verification.
After submission, poll `GET /v1/traces/{trace_id}/share` on the local admin
listener. Persisted progress is `verifying`, `shared`, `stopped`, `rejected`,
or `failed`. An expired share remains `shared` with `access_enabled: false`,
while `stopped` records an explicit owner action. The safe response includes `access_enabled`, visibility,
expiry, and access URLs but never an intake or presigned upload URL. The service
uses the vault-held account credential
to fetch admission state; agents and the dashboard never receive that
credential. A missing local share returns `404`. If the connected Account does
not own the retained canonical hosted identity, status and mutation return
`409` without deleting the association or creating a second public URL.
Missing or expired account authorization also returns `409`; a temporary
platform or network failure returns `503` rather than pretending the share disappeared. A shared response
contains the stable `share_url` and exact public `package_url`. Anyone with an
Unlisted or Listed link can read the disclosure; this is not private access.
`DELETE /v1/traces/{trace_id}/share` stops public access without deleting or
changing the local Notarized Trace. Its response retains the canonical hosted
identity in a disabled state. Editing access settings does not republish it;
`PUT` with `reactivate: true` is the explicit resume operation. If the retained
expiration has elapsed, the resume request must also choose a new expiration
or clear it with `expires_in_days: 0`. Hosted storage or billing limits retain
their safe `402` error code, password-work limits return `429`, and a missing
replacement expiration returns `400 trace_reactivation_expiry_required`.

## Local trust boundary

The API is intentionally identifier-based. It does not accept arbitrary input
or output paths and does not return decrypted checkpoint contents, credential
values, cookies, raw authenticated headers, vault keys, token values, or
presigned upload URLs. API errors and activity events follow the same rule.
Foreground startup diagnostics can name a configured local path when that path
must be repaired, so treat process logs as local-sensitive operational data.
Keep these constraints when adding endpoints: private evidence stays local,
and public artifacts must not claim guarantees beyond what their verifier
checks.

For exact operations and schemas, use the live [OpenAPI document](http://127.0.0.1:8788/openapi.json).
For the visual workflow, continue with the [local dashboard guide](admin-dashboard.md).
For the on-disk privacy and verification boundary, see [Artifact formats and
verification](artifact-formats.md).
