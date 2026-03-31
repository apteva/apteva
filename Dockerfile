# ─── Stage 1: Build dashboard ───
FROM oven/bun:1 AS dashboard-builder

WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/bun.lock ./
RUN bun install --frozen-lockfile

COPY dashboard/ ./
RUN bun run build.ts

# ─── Stage 2: Build Go binaries ───
FROM golang:1.26-alpine AS go-builder

ARG VERSION=dev
RUN apk add --no-cache git

# Copy all Go source (core depends on computer via replace directive)
WORKDIR /build
COPY core/ ./core/
COPY computer/ ./computer/

# Build core
WORKDIR /build/core
RUN CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${VERSION}" -o /apteva-core .

# Build server (with embedded dashboard)
WORKDIR /build/server
COPY server/ ./
COPY --from=dashboard-builder /build/dashboard/dist/ ./dashboard/
RUN CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${VERSION}" -o /apteva-server .

# ─── Stage 3: Runtime ───
FROM alpine:3.21

RUN apk add --no-cache ca-certificates

COPY --from=go-builder /apteva-core /usr/local/bin/apteva-core
COPY --from=go-builder /apteva-server /usr/local/bin/apteva-server
COPY integrations/src/apps /data/integrations

ENV PORT=5280
ENV CORE_CMD=/usr/local/bin/apteva-core
ENV DB_PATH=/data/apteva.db
ENV DATA_DIR=/data
ENV APPS_DIR=/data/integrations

EXPOSE 5280

VOLUME /data

ENTRYPOINT ["apteva-server"]
