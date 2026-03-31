# ─── Stage 1: Clone repos ───
FROM alpine:3.21 AS source

RUN apk add --no-cache git
ARG VERSION=main

WORKDIR /src
RUN git clone --depth 1 -b ${VERSION} https://github.com/apteva/core.git || \
    git clone --depth 1 https://github.com/apteva/core.git
RUN git clone --depth 1 https://github.com/apteva/computer.git
RUN git clone --depth 1 https://github.com/apteva/server.git
RUN git clone --depth 1 https://github.com/apteva/dashboard.git
RUN git clone --depth 1 https://github.com/apteva/integrations.git

# ─── Stage 2: Build dashboard ───
FROM oven/bun:1 AS dashboard-builder

WORKDIR /build/dashboard
COPY --from=source /src/dashboard/package.json /src/dashboard/bun.lock ./
RUN bun install --frozen-lockfile

COPY --from=source /src/dashboard/ ./
RUN bun run build.ts

# ─── Stage 3: Build Go binaries ───
FROM golang:1.26-alpine AS go-builder

ARG APP_VERSION=0.5.0
RUN apk add --no-cache git

WORKDIR /build
COPY --from=source /src/core/ ./core/
COPY --from=source /src/computer/ ./computer/

# Build core
WORKDIR /build/core
RUN CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${APP_VERSION}" -o /apteva-core .

# Build server (with embedded dashboard)
WORKDIR /build/server
COPY --from=source /src/server/ ./
COPY --from=dashboard-builder /build/dashboard/dist/ ./dashboard/
RUN CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${APP_VERSION}" -o /apteva-server .

# ─── Stage 4: Runtime ───
FROM alpine:3.21

RUN apk add --no-cache ca-certificates

COPY --from=go-builder /apteva-core /usr/local/bin/apteva-core
COPY --from=go-builder /apteva-server /usr/local/bin/apteva-server
COPY --from=source /src/integrations/src/apps /data/integrations

ENV PORT=5280
ENV CORE_CMD=/usr/local/bin/apteva-core
ENV DB_PATH=/data/apteva.db
ENV DATA_DIR=/data
ENV APPS_DIR=/data/integrations

EXPOSE 5280

VOLUME /data

ENTRYPOINT ["apteva-server"]
