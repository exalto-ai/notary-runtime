# Run a clustered daemon

Cluster mode runs interchangeable `notaryd` replicas with PostgreSQL metadata, S3-compatible private artifacts, one shared vault key, and an explicit remote notary endpoint/key. It does not require a hosted account or API credential.

The reference Compose deployment runs two daemon replicas plus PostgreSQL and a single-node SeaweedFS S3 object store. Your ingress owns TLS and exposes separate provider and administration origins.

```bash
./notary-cluster.sh init \
  proxy.notary.example admin.notary.example \
  tls://notary.example:7047 02...
./notary-cluster.sh up
```

## Upgrading an existing cluster

This release renames the cluster's Compose project, PostgreSQL role and
database, and object-store bucket to the canonical Notary names. Compose
namespaces volumes by project, so an existing deployment does not carry its
data across the rename and does not start on its old connection URL.

Existing operators should treat this as a new deployment: stop the old
cluster, keep the old `llm-notary-cluster_postgres-data` and
`llm-notary-cluster_minio-data` volumes until the new one is verified, and run
`init` into fresh state. There is no in-place migration, and none is provided.

### Moving from MinIO to SeaweedFS

The reference deployment now uses SeaweedFS instead of MinIO because the
pinned MinIO images can no longer be pulled. SeaweedFS does not read the old
`notary-cluster_minio-data` volume, so artifacts stay there until you copy
them. The copy must keep each object's `artifact-*` user metadata; the daemon
rejects objects without it. From `runtime/`, with the old MinIO image still
cached locally:

```bash
compose=(docker compose --env-file .notaryd-cluster/.env -f compose.cluster.yml)
"${compose[@]}" stop daemon                 # before updating: no new writes
git pull                                    # update to this release
"${compose[@]}" up -d object-store-init     # start SeaweedFS and create the bucket
export S3_KEY=$(cat .notaryd-cluster/secrets/s3-access-key)
export S3_SECRET=$(cat .notaryd-cluster/secrets/s3-secret-key)
docker run --rm --network notary-cluster \
  -e RCLONE_CONFIG_OLD_TYPE=s3 -e RCLONE_CONFIG_OLD_PROVIDER=Minio \
  -e RCLONE_CONFIG_OLD_ENDPOINT=http://minio:9000 \
  -e RCLONE_CONFIG_NEW_TYPE=s3 -e RCLONE_CONFIG_NEW_PROVIDER=SeaweedFS \
  -e RCLONE_CONFIG_NEW_ENDPOINT=http://object-store:8333 \
  -e RCLONE_CONFIG_OLD_ACCESS_KEY_ID="$S3_KEY" -e RCLONE_CONFIG_OLD_SECRET_ACCESS_KEY="$S3_SECRET" \
  -e RCLONE_CONFIG_NEW_ACCESS_KEY_ID="$S3_KEY" -e RCLONE_CONFIG_NEW_SECRET_ACCESS_KEY="$S3_SECRET" \
  rclone/rclone:1.75.0 copy --metadata --checksum old:trace-artifacts new:trace-artifacts
"${compose[@]}" run --rm daemon reconcile-artifacts --config /etc/notary/config.toml
```

Use your own network name if you changed `CLUSTER_NETWORK_NAME`. The old
`minio` container keeps running as an orphan of the updated project. Start the
daemons with `"${compose[@]}" up -d` only after the reconciliation report shows
no missing or corrupt references. Keep the old volume until you have checked
the new deployment; afterwards `"${compose[@]}" up -d --remove-orphans` stops
the old container, and `docker volume rm notary-cluster_minio-data` deletes
its data. If the MinIO image is no longer cached, the old volume cannot be
read by this deployment and no conversion is provided.

Setup writes private state under `.notaryd-cluster/`, generates the database/object-store/dashboard secrets and shared vault key, and never overwrites an existing setup. The deployment publishes no host ports; join an ingress to its Docker network and route provider traffic to `daemon:8787` and administration traffic to `daemon:8788`.

The profile is explicit:

```toml
[cluster]
proxy_origin = "https://proxy.notary.example"
admin_origin = "https://admin.notary.example"

[notary]
endpoint = "tls://notary.example:7047"
public_key = "02..."

[metadata]
backend = "postgres"

[storage]
backend = "s3"
```

For another scheduler, run `notaryd migrate --config /etc/notary/config.toml` once, then start two or more identical replicas. Every replica receives the same config, database, S3 namespace, admin password, and exact 32-byte `NOTARYD_CLUSTER_VAULT_KEY_FILE`. `NOTARYD_CLUSTER_INSTANCE_ID` is optional when the scheduler already provides a useful unique hostname.

Use `GET /healthz` for process liveness and `GET /readyz` for traffic routing. Readiness checks the replica lifecycle, PostgreSQL schema, S3 namespace, shared vault identity, and shared Registry snapshot. On SIGTERM a replica becomes unready, drains admitted streams for a bounded interval, then releases its lease.

Quiesce all replicas for a coordinated PostgreSQL/S3 backup. Preserve the cluster vault key with that backup. After restoring, keep replicas stopped and run `notaryd reconcile-artifacts --config ...` before resuming traffic.
