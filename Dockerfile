# Apteva — single instance, headless
# Core only, no dashboard/server. CLI connects via --no-spawn.
#
# Build:  docker build -t apteva .
# Run:    docker run -d -p 3210:3210 -v apteva-data:/data -e FIREWORKS_API_KEY=sk_... apteva
# CLI:    ./apteva --no-spawn --addr <host>:3210

# ─── Build core ───
FROM golang:1.26-alpine AS builder
RUN apk add --no-cache git
WORKDIR /build
COPY ../core/ core/
COPY ../computer/ computer/
WORKDIR /build/core
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /apteva-core .

# ���── Runtime ───
FROM alpine:3.21
RUN apk add --no-cache ca-certificates chromium
COPY --from=builder /apteva-core /usr/local/bin/apteva-core

VOLUME /data
WORKDIR /data

ENV API_PORT=3210
ENV NO_TUI=1
EXPOSE 3210

ENTRYPOINT ["apteva-core", "--headless"]
