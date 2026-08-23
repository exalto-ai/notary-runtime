# Coding-agent playbook for the local service

## Install the portable skill

The `notaryctl` release embeds the portable skill from
[`skills/notary`](../skills/notary/SKILL.md). Install it without
starting or contacting the daemon:

```bash
notaryctl skill install --target codex
notaryctl skill install --target claude
notaryctl skill install --target all
```

Codex installs under `~/.agents/skills`. Claude Code installs under
`$CLAUDE_CONFIG_DIR/skills` when that environment variable is nonempty and
under `~/.claude/skills` otherwise. Use `notaryctl skill install --skills-dir
/path/to/agent/skills` for another Agent Skills compatible client. The
installer appends the `notaryctl` skill directory, reports `installed`,
`current`, or `updated`, and emits the same result as structured data with
`--json`.

Claude Code detects changes inside its existing personal `skills` directory
without a restart. If that top-level directory did not exist when the current
Claude Code session started, restart Claude Code after installation so it can
watch and discover the new directory.

An existing different skill is left unchanged, and an `--target all` conflict
is detected before either destination is written. Inspect local modifications
before using `--force`. Re-run installation after updating the CLI so the
installed instructions stay aligned with the release.

The installed skill is the preferred reusable instruction surface. For an
agent without skill support, give it the loopback administration origin and
this playbook, not an old list of CLI commands. The live OpenAPI document is
the endpoint and schema authority.

## Required behavior

1. Confirm `GET /healthz` succeeds and use only the configured loopback admin
   origin. Do not follow an untrusted origin or expose the service remotely.
2. Fetch `/openapi.json` before choosing a route, method, request body, or
   response field. Do not rely on a memorized API shape.
3. Call `/v1` without credentials unless the service returns 401. If the user
   configured `admin.auth`, obtain its username and password through the
   approved secret mechanism and use the OpenAPI `basicAuth` scheme. Never
   print, log, embed, persist, or put the password in a URL.
4. Find Traces through `/v1/traces` and act on returned `trc-…`
   identifiers. Never ask for or submit an arbitrary local filesystem path.
   Search input may contain punctuation; the service treats it as text
   boundaries rather than raw full-text-search syntax. Capture responses
   include stored prompt and output previews, so project each item to safe
   metadata before command output enters the agent transcript.
5. Treat notarization as asynchronous. Save the returned `op-…` identifier and
   poll its documented operation URL until `succeeded`, `failed`, or
   `interrupted`. Use `attempt_history` when explaining retries.
6. Use `GET /v1/traces/{trace_id}/package.llmtrace` to download the exact canonical
   `.llmtrace` bytes, and `POST /v1/traces/{trace_id}/verify` for
   cryptographic package verification. Decrypting or structurally validating
   an encrypted capture is not independent verification.
7. Never request, decode, upload, or expose decrypted `.llmcapture` contents,
   credentials, cookies, raw authenticated headers, authentication secrets,
   or vault material.
8. Ask the user before sharing a notarized trace or changing service
   configuration. Notarization alone is not sharing consent. Confirm whether
   the public link should be Unlisted or Listed.
9. After approval, poll `GET /v1/traces/{trace_id}/share` through the local
   admin API. Do not extract or reproduce the vault-held account credential.

Use safe error codes and redacted event messages for diagnosis. If the OpenAPI
document does not describe an operation, stop and explain that the installed
service does not support it.

Prefer server-side filters from the discovered contract. In particular,
filter Traces by stable `state` or operational `status`, and filter Activity by
`severity`, `event_type`, `trace_id`, `operation_id`, or
`created_after_unix_ms`. Do not download a broad history merely to discard most
of it in the client.

## Example prompt for an agent

```text
Use the Notary administration service at http://127.0.0.1:8788.
First check /healthz and fetch /openapi.json. Use the local API without
credentials unless it returns 401. If authentication is configured, use only
the approved Basic credentials and never print or persist the password.
Find the newest captured OpenAI response whose preview matches "sanitized",
show me its safe metadata, and ask before starting notarization. If I approve,
record the returned operation identifier and poll it to a terminal state. When
notarized, run the documented trace verification operation and report exactly
what it verifies. Do not access checkpoint paths or contents, and do not share.
```

## Safe shell workflow

The default loopback configuration needs no credentials:

```bash
export NOTARYD_ADMIN_ORIGIN=http://127.0.0.1:8788

curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/healthz"
curl --fail-with-body "$NOTARYD_ADMIN_ORIGIN/openapi.json" \
  > /tmp/notary-openapi.json
```

Inspect the downloaded specification, then search and select only an identifier
returned by the service:

```bash
curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces?query=sanitized&provider=openai&state=captured&limit=10" \
  | jq '.items |= map({trace_id, created_at_unix_ms, provider, requested_model, state, status, notarization_eligible, failure_code})'

trace_id=trc-example
curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id" \
  | jq 'del(.prompt_preview, .prompt_preview_truncated, .output_preview, .output_preview_truncated)'
```

After explicit user approval, queue notarization. A `202 Accepted` response has
the shape `{"operation":{…},"deduplicated":false}`. `deduplicated: true`
means an existing operation was returned and should be polled instead of
starting another:

```bash
response=$(curl --fail-with-body -X POST \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/notarizations")
operation_id=$(printf '%s' "$response" | jq -r '.operation.operation_id')

while :; do
  operation=$(curl --fail-with-body \
    "$NOTARYD_ADMIN_ORIGIN/v1/operations/$operation_id") || exit 1
  state=$(printf '%s' "$operation" | jq -r '.state')
  progress=$(printf '%s' "$operation" | jq -r \
    'if .progress.proof then "\(.progress.proof.bytes_completed)/\(.progress.proof.bytes_total) bytes, \(.progress.proof.commitments_completed)/\(.progress.proof.commitments_total) commitments" else .progress.phase end')
  printf 'Notarization progress: %s\n' "$progress"
  case "$state" in
    succeeded|failed|interrupted) break ;;
    queued|running) sleep 3 ;;
    *) printf 'Unexpected operation state: %s\n' "$state" >&2; exit 1 ;;
  esac
done
printf 'Operation %s ended in %s\n' "$operation_id" "$state"
```

If notarization succeeds, independently verify the notarized trace:

```bash
test "$state" = succeeded || exit 1
curl --fail-with-body -X POST \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/verify"
```

For a portable file that is not retained by this daemon, use
`notaryctl traces verify ./capture.llmtrace`. The CLI sends those bytes to the
loopback daemon's in-memory verifier; it reads no `.llmcapture` and writes no
local state.

Report `outcome`, `verified_at_unix_ms`, `notary_key_id`, and `trust_source`.
Do not translate a successful checkpoint read into a verification claim.

If the user separately approves public sharing, submit the Trace identifier,
defaulting to Unlisted unless they request public discovery, and
follow admission through the local service:

```bash
share=$(curl --fail-with-body -X PUT \
  -H 'Content-Type: application/json' \
  --data '{"visibility":"unlisted"}' \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/share")

curl --fail-with-body \
  "$NOTARYD_ADMIN_ORIGIN/v1/traces/$trace_id/share"
```

Report the bounded progress or failure code. Do not claim the trace is
reachable until `progress` is `shared`. Never describe an Unlisted
share as private; anyone with its link can open it.

## JavaScript example

This example discovers the contract before using the default local API:

```js
const origin = 'http://127.0.0.1:8788';

const health = await fetch(`${origin}/healthz`);
if (!health.ok) throw new Error(`Local service unavailable: ${health.status}`);

const specification = await fetch(`${origin}/openapi.json`).then((response) => response.json());
if (!specification.paths['/v1/traces']) throw new Error('Installed API is incompatible');

const response = await fetch(`${origin}/v1/traces?state=captured&limit=10`);
if (!response.ok) throw new Error(`Capture search failed: ${response.status}`);
const captures = await response.json();
console.log(captures.items.map(({ trace_id, provider, requested_model, state, status }) => ({
  trace_id, provider, requested_model, state, status
})));
```

If a `/v1` request returns 401, do not guess credentials. Ask for the
configured `admin.auth` username and password, then retry with HTTP Basic as
described by the live specification. An interactive shell can use
`curl --user local-admin URL` so curl prompts for the password rather than
putting it in shell history or the process argument list.

The service returns the documented JSON error envelope for invalid query
values, including malformed numeric values. Branch on `error.code`; do not
parse plain-text framework messages.

This output is deliberately limited to safe metadata store fields. An automation
should not print previews unless the user explicitly asks and the local preview
policy allows it.

See the [local service guide](local-service.md) for state and trust semantics,
and the [dashboard guide](admin-dashboard.md) for the equivalent visual flow.
