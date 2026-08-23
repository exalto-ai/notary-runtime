# Self-host the remote notary

Generate a 32-byte signing key and start the generic notary with an explicit provider allowlist:

```bash
install -m 0600 /dev/null notary.key
openssl rand -hex 32 > notary.key
cargo run -p notary-server -- \
  serve \
  --signing-key-file notary.key \
  --allow-host api.openai.com \
  --allow-host chatgpt.com \
  --allow-host api.anthropic.com \
  --allow-host api.deepseek.com \
  --allow-host openrouter.ai
```

The server prints its compressed SEC1 public key. You can inspect the key without starting either listener:

```bash
cargo run -p notary-server -- public-key --signing-key-file notary.key
```

Pair that key with the endpoint in each daemon configuration:

```toml
[notary]
endpoint = "tcp://127.0.0.1:7047"
public_key = "02..."
```

Use `tls://notary.example:443` when a public-CA TLS endpoint protects the network transport. TLS authenticates the transport; the configured secp256k1 key remains the evidence trust anchor.

The notary owns the upstream network connection, so every permitted hostname must be present in `--allow-host`. Keep the signing key outside the repository with owner-only permissions, encrypted backups, and restricted process access. Use `--notarization-only` during a planned key rotation so existing private captures can finish without admitting new capture sessions.

Important hard limits include `--max-concurrent-captures`, `--max-concurrent-notarizations`, `--max-total-private-chunk-bytes`, `--max-private-chunk-bytes`, `--max-private-chunk-commitments`, `--max-frame-bytes`, and `--session-timeout-secs`. Keep the total-private-byte limit at least as large as the daemon's `proxy.max_attestable_http_bytes`. Set the process supervisor's stop budget above `--shutdown-grace-secs`; shutdown stops admission, cancels active protocol work with a service-failed outcome, and waits only for the configured bounded drain.

The base server uses the runtime's ticketless admission policy. Product-specific account or billing admission belongs in a separate adapter implementing `AdmissionPolicy`; it is not part of the public runtime.

See [Notary key lifecycle](notary-key-lifecycle.md) and [clustered daemon operation](cluster-operations.md).
