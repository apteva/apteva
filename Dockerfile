# Apteva — headless deployment
# Server manages core instances, integrations, auth.
# CLI connects remotely via: ./apteva --remote <host>:5280
#
# Build:
#   docker build -t apteva -f Dockerfile ..
#
# Run:
#   docker run -d -p 5280:5280 -v apteva-data:/data \
#     -e FIREWORKS_API_KEY=sk_... \
#     apteva
#
# Connect:
#   ./apteva --remote <host>:5280

# ─── Build Go binaries ───
FROM golang:1.26.5-alpine AS builder
RUN apk add --no-cache git

WORKDIR /build
COPY core/ core/
COPY computer/ computer/
COPY server/ server/

# Build core
WORKDIR /build/core
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /apteva-core ./cmd/apteva-core

# Build server
WORKDIR /build/server
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /apteva-server .

# ─── Runtime ───
FROM alpine:3.21
RUN apk add --no-cache ca-certificates chromium

COPY --from=builder /apteva-core /usr/local/bin/apteva-core
COPY --from=builder /apteva-server /usr/local/bin/apteva-server

VOLUME /data
WORKDIR /data

ENV PORT=5280
ENV CORE_CMD=/usr/local/bin/apteva-core
ENV DB_PATH=/data/apteva.db
ENV DATA_DIR=/data
ENV QUIET=1

EXPOSE 5280

ENTRYPOINT ["apteva-server"]
