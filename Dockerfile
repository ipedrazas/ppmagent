# syntax=docker/dockerfile:1

# ── Stage 1: build the `ppm` memory CLI from source ──────────────────────────
# ppm is a pure-Go binary; CGO disabled so it runs on any base image.
FROM golang:1.26-alpine AS ppm-builder
ARG PPM_VERSION=latest
ENV CGO_ENABLED=0 GOBIN=/out
RUN apk add --no-cache git \
    && go install "github.com/ipedrazas/ppm@${PPM_VERSION}"
# → /out/ppm

# ── Stage 2: build the `proteos` delegation CLI from source ──────────────────
# proteos is a pure-Go binary (module rooted at the repo's cli/ subdir, main at
# cli/cmd/proteos); CGO disabled so it runs on any base image. The module's
# version tags are not in `cli/vX.Y.Z` form, so go install resolves `@latest`
# to a pseudo-version of the default branch — mirror ppm's `latest` default.
FROM golang:1.26-alpine AS proteos-builder
ARG PROTEOS_VERSION=latest
ENV CGO_ENABLED=0 GOBIN=/out
RUN apk add --no-cache git \
    && go install "github.com/tavon-ai/proteos/cli/cmd/proteos@${PROTEOS_VERSION}"
# → /out/proteos

# ── Stage 3: build the `dbxcli` tracker CLI from source ──────────────────────
# dbxcli is a Rust binary (reqwest + rustls-tls — no OpenSSL/system TLS deps).
FROM rust:1-bookworm AS dbxcli-builder
ARG DBXCLI_VERSION=v0.1.12
RUN cargo install --git https://github.com/tavon-ai/dbxcli --tag "${DBXCLI_VERSION}" --locked --root /out
# → /out/bin/dbxcli

# ── Stage 4: install JS dependencies (cached on lockfile) ────────────────────
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── Stage 5: runtime ─────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/ipedrazas/ppmagent"
LABEL org.opencontainers.image.description="PM / Product-Owner agent (pi runtime) with ppm-backed memory"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    PPMA_PPM_BIN=ppm \
    PPMA_DBXCLI_BIN=dbxcli \
    PPMA_PROTEOS_BIN=proteos \
    PPM_MEMORY_ROOT=/app/memory

# The external CLIs the agent shells out to, on PATH. dbxcli still needs its
# DataboxPPM config/token at runtime, and proteos its PROTEOS_URL/PROTEOS_TOKEN
# (env or a mounted config file).
COPY --from=ppm-builder /out/ppm /usr/local/bin/ppm
COPY --from=proteos-builder /out/proteos /usr/local/bin/proteos
COPY --from=dbxcli-builder /out/bin/dbxcli /usr/local/bin/dbxcli

# App: deps then source.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Memory workspace, owned by the unprivileged `bun` user that the base image ships.
RUN mkdir -p /app/memory && chown -R bun:bun /app
USER bun

ENTRYPOINT ["bun", "src/index.ts"]
