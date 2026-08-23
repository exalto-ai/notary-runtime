FROM rust:1.95-slim-bookworm AS builder

WORKDIR /app
COPY . .
RUN cargo build --locked --release \
    -p notaryctl --bin notaryctl \
    -p notaryd --bin notaryd \
    -p notary-server --bin notary-server

FROM debian:bookworm-slim AS daemon

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/notaryd /usr/local/bin/notaryd
COPY --from=builder /app/target/release/notaryctl /usr/local/bin/notaryctl
RUN notaryd --help >/dev/null && notaryctl --help >/dev/null
ENTRYPOINT ["notaryd"]

FROM daemon AS cluster

RUN groupadd --gid 10001 notary \
    && useradd --uid 10001 --gid 10001 --system --no-create-home notary \
    && mkdir -p /var/lib/notary/config /var/lib/notary/data \
    && chown -R 10001:10001 /var/lib/notary
ENV XDG_CONFIG_HOME=/var/lib/notary/config \
    XDG_DATA_HOME=/var/lib/notary/data
USER 10001:10001
EXPOSE 8787 8788

FROM debian:bookworm-slim AS notary-server

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/notary-server /usr/local/bin/notary-server
RUN notary-server --help >/dev/null
EXPOSE 7047
ENTRYPOINT ["notary-server"]
CMD ["serve"]

FROM builder AS daemon-e2e-builder

RUN cargo build --locked --release \
    -p notaryd --features daemon-e2e --bins \
    -p notaryctl --bin notaryctl

FROM daemon AS daemon-e2e

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq openssl python3 sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=daemon-e2e-builder /app/target/release/notaryd /usr/local/bin/notaryd
COPY --from=daemon-e2e-builder /app/target/release/notaryctl /usr/local/bin/notaryctl
COPY --from=daemon-e2e-builder /app/target/release/notary-e2e-notary /usr/local/bin/notary-e2e-notary
COPY deploy-daemon-e2e/config.toml /etc/notary/config.toml
RUN cp /etc/notary/config.toml /etc/notary/config-s3.toml \
    && sed -i 's/backend = "filesystem"/backend = "s3"/' /etc/notary/config-s3.toml \
    && printf '%s\n' \
        '' \
        '[storage.s3]' \
        'bucket = "notaryd-e2e"' \
        'region = "us-east-1"' \
        'endpoint = "http://minio:9000"' \
        'prefix = "notaryd"' \
        'force_path_style = true' \
        'allow_insecure_http = true' \
        'connect_timeout_seconds = 3' \
        'operation_timeout_seconds = 10' \
        >> /etc/notary/config-s3.toml \
    && cp /etc/notary/config.toml /etc/notary/config-postgres.toml \
    && sed -i 's/backend = "sqlite"/backend = "postgres"/' /etc/notary/config-postgres.toml \
    && printf '%s\n' \
        '' \
        '[metadata.postgres]' \
        'ssl_mode = "disable"' \
        'max_connections = 8' \
        'connect_timeout_seconds = 3' \
        'acquire_timeout_seconds = 3' \
        'migration_lock_timeout_seconds = 5' \
        >> /etc/notary/config-postgres.toml \
    && cp /etc/notary/config-postgres.toml /etc/notary/config-postgres-lock-timeout.toml \
    && sed -i 's/migration_lock_timeout_seconds = 5/migration_lock_timeout_seconds = 1/' /etc/notary/config-postgres-lock-timeout.toml \
    && cp /etc/notary/config-postgres.toml /etc/notary/config-postgres-s3.toml \
    && sed -i 's/backend = "filesystem"/backend = "s3"/' /etc/notary/config-postgres-s3.toml \
    && sed -n '/^\[storage.s3\]/,$p' /etc/notary/config-s3.toml \
        >> /etc/notary/config-postgres-s3.toml \
    && cp /etc/notary/config-postgres-s3.toml /etc/notary/config-cluster-template.toml \
    && sed -i 's/127.0.0.1:8787/0.0.0.0:8787/' /etc/notary/config-cluster-template.toml \
    && sed -i 's/127.0.0.1:8788/0.0.0.0:8788/' /etc/notary/config-cluster-template.toml \
    && printf '%s\n' \
        '' \
        '[cluster]' \
        'proxy_origin = "https://proxy.e2e.invalid"' \
        'admin_origin = "https://admin.e2e.invalid"' \
        '' \
        '[admin.auth]' \
        'username = "cluster-admin"' \
        'password_hash = "$argon2id$v=19$m=19456,t=2,p=1$Y2x1c3Rlci1lMmUtc2FsdA$e5miUzfGBUsUELcxECEyngoD2trkyo28hZ794hQ9bO8"' \
        >> /etc/notary/config-cluster-template.toml
COPY deploy-daemon-e2e/provider.py /usr/local/libexec/notary-e2e-provider.py
COPY deploy-daemon-e2e/share.py /usr/local/libexec/notary-e2e-share.py

# Keep a plain `docker build .` on the production daemon, not the test image.
FROM daemon AS runtime
