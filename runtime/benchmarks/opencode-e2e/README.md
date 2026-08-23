# OpenCode production canary

This benchmark runs one bounded coding task through OpenCode and the LLM
Notary OpenRouter proxy. It is an end-to-end product canary, not a model
benchmark.

The runner:

1. preflights the exact `:free` OpenRouter model and tool support;
2. starts `notaryd` with isolated config, catalog, vault, and artifact paths;
3. copies the failing Python fixture into a private `/tmp` directory;
4. lets a six-step OpenCode agent modify only `retry_after.py`;
5. checks the test result and exact diff allowlist;
6. notarizes and locally verifies eligible traces;
7. scans the public disclosure, explicitly accepts only entropy-heuristic false
   positives, publishes it as Listed, and polls admission;
8. downloads each public package and verifies it again; and
9. deletes all private state and retains only sanitized metrics and public URLs.

OpenCode raw events, prompts, model output, daemon logs, provider responses,
encrypted checkpoints, and private trace packages are never written to the
result artifact or workflow log.

The runner allows at most one retry from a fresh fixture for a typed transient
provider failure, a response that makes no tool call, or a nonzero OpenCode
exit after the tests and exact diff gate have already passed with only eligible
HTTP 200 captures. Captures from the failed attempt are recorded as sanitized
metadata but are never notarized or shared.

## Local run

The ignored repository `.env` must contain these dedicated values:

```dotenv
OPENROUTER_FREE_TIER_API_KEY=...
NOTARYD_E2E_API_KEY=...
NOTARYD_E2E_SLACK_WEBHOOK_URL=...
```

`OPENROUTER_FREE_TIER_API_KEY` is intentionally separate from a normal paid
`OPENROUTER_API_KEY`. The runner maps the free key to OpenCode only inside the
isolated child process.

Build and run from the repository root:

```bash
cargo build --manifest-path runtime/Cargo.toml --target-dir target \
  --release --locked -p notaryd --bin notaryd \
  -p notaryctl --bin notaryctl
npm install --global opencode-ai@1.18.11

set -a
source .env
set +a

result=/tmp/notary-opencode-e2e-result.json
set +e
python3 runtime/benchmarks/opencode-e2e/run.py \
  --notaryctl target/release/notaryctl \
  --notaryd target/release/notaryd \
  --result "$result"
status=$?
python3 runtime/benchmarks/opencode-e2e/notify.py "$result" || true
exit "$status"
```

This deliberately consumes hosted notarization capacity and creates Listed
public Traces in the shared collection. The runner's `--force` sharing decision cannot
override a known secret, credential field, disclosed header, malformed package,
or failed verification. Unit tests do neither:

```bash
python3 runtime/benchmarks/opencode-e2e/test_runner.py -v
```

## GitHub Actions

`.github/workflows/opencode-e2e.yml` runs every Monday and supports manual
dispatch. The reviewed default is `openrouter/cohere/north-mini-code:free`;
changing it starts a new observational timing series. The workflow installs
the current published `latest` Runtime instead of rebuilding the checkout, and
records that build ID plus the hosted rollout ID when the deployment exposes
one. Configure these repository secrets:

- `OPENROUTER_FREE_TIER_API_KEY`
- `NOTARY_E2E_API_KEY`
- `NOTARY_SLACK_WEBHOOK_URL`

The workflow maps the latter two repository secret names to the canonical
`NOTARYD_E2E_API_KEY` and `NOTARYD_E2E_SLACK_WEBHOOK_URL` process variables.

The workflow retains only `opencode-e2e-result.json`. The optional manual model
override must still be an exact OpenRouter `:free` model with tool support and
zero token and request pricing.
