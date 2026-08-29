# Exalto Capture provider and client setup

Exalto Capture launches `notaryd` when no compatible local service is already
running. `notaryd` exposes provider-compatible HTTP/1.1 routes on one loopback
listener. Codex CLI and Claude Code can keep their saved product sign-ins. API
and SDK clients send their existing provider key. In every case, replace only
the base URL.

## Route map

| Provider | Local SDK base URL | Upstream host | Typical operation |
| --- | --- | --- | --- |
| OpenAI | `http://127.0.0.1:8787/openai/v1` | `api.openai.com` | Responses |
| Codex with a ChatGPT plan | `http://127.0.0.1:8787/codex` | `chatgpt.com/backend-api/codex` | Responses |
| Anthropic / Claude Code | `http://127.0.0.1:8787/anthropic` | `api.anthropic.com` | Messages |
| DeepSeek | `http://127.0.0.1:8787/deepseek` | `api.deepseek.com` | Chat Completions |
| OpenRouter | `http://127.0.0.1:8787/openrouter/api/v1` | `openrouter.ai` | Chat Completions |

The daemon removes the configured local route prefix before forwarding. A
caller cannot provide an arbitrary upstream URL. Enabled prefixes must be
distinct and non-overlapping.

These base URLs do not change when **Capture requests** is off. Traffic still
crosses the local daemon and remains restricted to the fixed origin in this
table, but the daemon connects directly over WebPKI HTTPS. It does not use a
remote notary or create evidence, a capture ID, previews, or a `.llmcapture`.
That request cannot later be notarized or verified. Turning capture back on
affects later requests only.

Examples below use `YOUR_MODEL` deliberately. Choose a model available to the
provider account rather than copying a time-sensitive model name.

## Supported subscription clients

| Client surface | Current status |
| --- | --- |
| Codex CLI with its saved ChatGPT login | Supported and live-tested |
| Claude Code with its saved claude.ai login | Supported and live-tested |
| Codex desktop app | Not yet end-to-end tested or supported |
| Native Claude Desktop | Cannot currently be configured for the local route |
| Browser, Slack, remote, or cloud sessions | Outside the loopback proxy and unsupported |

The Exalto Capture macOS app can start and manage the local proxy for either
supported CLI. It does not supply the provider login or configure the vendor
client. Codex desktop may read the same local Codex configuration for local
work, but that path remains unverified; do not rely on it as a supported
integration yet.

## API-key setup in Exalto Capture

Choose **API or SDK** in the setup assistant, then select OpenAI, Anthropic, or
OpenRouter. Each supported provider includes a fixed link to its official key
page. The SDK, CLI, shell, or secret manager remains the credential owner and
sends the real key in the provider's normal authentication header.

For a quick disposable onboarding test, the developer may paste a provider key
into setup. The webview keeps that value only in the current in-memory setup
session and passes it to one native test command. The command sends the real key
through the same fixed loopback route as any other client. The app does not
write the key to Keychain, disk, app settings, or daemon configuration. It is
cleared when setup finishes, is cancelled, or the setup window closes.

If a compatible `notaryd` is already running outside the app, setup reuses it
instead of starting another process. The app does not stop, restart, or change
the capture setting of that process. A disposable test can use it when capture
is already enabled.

xAI and Grok are not capture routes in this build. Setup still links to the
[official xAI API key quickstart](https://docs.x.ai/developers/quickstart) so a
developer can prepare a key without mistaking that preparation for working
capture support.

## OpenAI

```bash
curl http://127.0.0.1:8787/openai/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_MODEL","input":"Reply with exactly: notary","stream":true}'
```

Use the Responses API. Chat Completions normalization remains covered by
fixtures for compatible provider inputs, but the Codex integration below uses
Responses.

## Anthropic API key

```bash
curl http://127.0.0.1:8787/anthropic/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"YOUR_MODEL","max_tokens":64,"messages":[{"role":"user","content":"Reply with exactly: notary"}]}'
```

The `x-api-key` value, `anthropic-version` value, and content type are hidden in
the notarized disclosure. Their header names remain visible.

## Claude Code with a claude.ai plan

This flow is live-tested with Claude Code. It can keep using the claude.ai
login it already manages. First check the CLI's own authentication state:

```bash
claude auth status
```

It must report `loggedIn: true` with the first-party provider. A login in the
native Claude desktop app is separate and does not establish that Claude Code
CLI state. If the CLI is logged out, run `claude login` directly without the
Exalto Capture base URL, then check again. Exalto Capture does not perform the login or
refresh flow.

Run Claude Code with only its Anthropic base URL changed:

```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic \
  claude -p 'Reply with exactly: notary'
```

Remove any `apiKeyHelper` setting while using subscription authentication. Do
not add a gateway API key or an `ANTHROPIC_AUTH_TOKEN`: without those
overrides, Claude Code attaches its saved claude.ai authorization and includes
the OAuth capability in `anthropic-beta`.

Exalto Capture forwards `Authorization`, `anthropic-beta`, `anthropic-version`, the
`?beta=true` query, streaming events (including pings), tool definitions, tool
calls, and other current Messages fields unchanged. It treats Anthropic header
and body fields as open protocol lists rather than filtering them to a frozen
schema. Authorization and every other HTTP header value are hidden from the
notarized package; the disclosed request and response bodies still require
review before sharing.

If the saved login expires, unset `ANTHROPIC_BASE_URL`, let Claude Code sign in
or refresh directly, and then restore the base URL. To stop using the proxy,
unset `ANTHROPIC_BASE_URL`; this does not sign you out. API-key-authenticated
Anthropic requests remain supported on the same route.

The native Claude desktop app cannot currently be configured to send its model
traffic through this route. Claude on the web, in Slack, in remote sessions,
or in cloud execution also runs outside the local proxy and is not supported.

A verified trace proves that the request reached `api.anthropic.com` over the
authenticated provider connection and authenticates the disclosed request and
response bodies. It does not prove which person owned the claude.ai login,
which subscription they had, or how Anthropic accounted for the request.

## DeepSeek

DeepSeek's upstream origin has no implied `/v1` suffix; the proxy preserves the
requested API path.

```bash
curl http://127.0.0.1:8787/deepseek/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"Reply with exactly: notary"}]}'
```

## OpenRouter

```bash
curl http://127.0.0.1:8787/openrouter/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'HTTP-Referer: https://example.test' \
  -H 'X-Title: Exalto Capture example' \
  -d '{"model":"YOUR_MODEL","stream":true,"messages":[{"role":"user","content":"Reply with exactly: notary"}]}'
```

The verified provider is OpenRouter at `openrouter.ai`. A slug such as
`vendor/model` is authenticated request metadata; it does not prove a direct
TLS connection to that vendor. The values of `Authorization`, `HTTP-Referer`,
and `X-Title` are hidden in a notarized package.

## Streaming behavior

Server-Sent Events are relayed as they arrive. The proxy does not synthesize
events or buffer the full response before returning it. With capture on, one
short notary exchange seals the deferred capture after the provider stream
ends. With capture off, both request and response bodies stream through the
direct provider connection and no sealing work occurs.

The proxy does not implement WebSocket transport. Configure clients to use
HTTP streaming when they can select between HTTP and WebSockets.

## Codex with an OpenAI API key

Codex can use the OpenAI route through a custom Responses provider. The
`supports_websockets = false` setting is important because this prototype is
HTTP/1.1-only.

Add the following to `~/.codex/config.toml`, replacing the model with one
available to the OpenAI API key:

```toml
model_provider = "capture"
model = "YOUR_RESPONSES_MODEL"

[model_providers.capture]
name = "Exalto Capture local proxy"
base_url = "http://127.0.0.1:8787/openai/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
```

Then run Codex normally, for example:

```bash
codex exec --ephemeral --skip-git-repo-check \
  'Reply with exactly: notary'
```

The custom-provider keys above follow the current Codex configuration
reference. Avoid the built-in `openai_base_url` shortcut here: a named provider
makes the no-WebSocket capability explicit.

## Codex with a ChatGPT plan

Codex can also keep using the ChatGPT login it already manages. This is a
separate route because subscription-authenticated Codex connects to
`chatgpt.com/backend-api/codex`, not the public OpenAI API.

First confirm that Codex itself is signed in with ChatGPT:

```bash
codex login status
```

The result should say `Logged in using ChatGPT`. This flow is live-tested with
Codex CLI, and the CLI must own this login. A browser or another app's login
does not establish that CLI state.

Add this provider to `~/.codex/config.toml` and select it with
`model_provider`. Keep your current model setting:

```toml
model_provider = "capture-chatgpt"

[model_providers.capture-chatgpt]
name = "Exalto Capture, ChatGPT plan"
base_url = "http://127.0.0.1:8787/codex"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

Do not add `env_key` to this provider. `requires_openai_auth = true` tells
Codex to attach its saved ChatGPT authorization and account-routing headers.
Exalto Capture forwards those values for the provider request, but does not read
Codex's auth cache, collect browser cookies, refresh the login, or write the
header values to logs or notarized packages.

Run Codex normally after starting `notaryd`:

```bash
codex exec --ephemeral --skip-git-repo-check \
  'Reply with exactly: notary'
```

To stop using the proxy, restore your previous `model_provider` setting
(normally `openai`) and remove the `model_providers.capture-chatgpt` block.
This does not sign you out of ChatGPT.

A verified trace proves that the request reached `chatgpt.com` over the
authenticated provider connection and authenticates the disclosed request and
response bodies. It does not prove which person or organization owned the
ChatGPT account, which plan they had, or how OpenAI billed the request.

Codex desktop may read the same local configuration for local work, but this
integration has not yet been tested end to end there and is not a supported
client surface. Remote and cloud Codex work cannot reach the loopback proxy.

## Other agents and SDKs

- To let a local coding agent inspect and operate captured evidence, install
  the portable management skill with `notaryctl skill install --target codex`,
  `--target claude`, or `--target all`. Use `--skills-dir` for another
  Agent Skills compatible client. This teaches the agent to use the loopback
  administration API; it does not route that agent's own model traffic through
  the provider proxy.
- For an OpenAI-compatible DeepSeek or OpenRouter client, use the corresponding
  base URL from the route table and keep the provider's normal API-key
  variable.
- If a client hard-codes HTTP/2 or WebSockets with no HTTP/1.1 fallback, it is
  outside the current proxy scope.

## Capture size and response status

The default shared request-plus-response envelope is 15 MiB. The proxy counts
the request before opening the provider connection and the response while it
arrives, so it cannot knowingly write a checkpoint above the configured
notarization limit.

Non-`2xx` provider responses—including subscription authentication and provider
errors—are returned to the calling client and captured as encrypted local
evidence, but current normalizers reject them for notarization with
`unsupported_provider_http_status` before proof generation.

The full `.llmcapture` checkpoint is vault-encrypted. When the configured
preview limit is above zero, bounded prompt and response excerpts are stored
separately in local metadata for browsing and are not protected by that vault.
Set the preview limit to zero when local plaintext excerpts are unacceptable.
Doing so also disables automatic marker confirmation in desktop onboarding.

Real provider requests can incur cost. The ordinary test suite uses offline
fixtures; run live requests only as an explicit integration check.
