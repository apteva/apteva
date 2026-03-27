FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /build

# Clone and build core
RUN git clone --depth 1 https://github.com/apteva/core.git core
RUN cd core && CGO_ENABLED=0 go build -ldflags="-s -w" -o /apteva-core .

# Clone and build server
RUN git clone --depth 1 https://github.com/apteva/server.git server
RUN cd server && CGO_ENABLED=0 go build -ldflags="-s -w" -o /apteva-server .

# Clone integrations catalog (just the JSON files)
RUN git clone --depth 1 https://github.com/apteva/integrations.git integrations

# --- Runtime (scratch = zero overhead) ---
FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /apteva-core /usr/local/bin/apteva-core
COPY --from=builder /apteva-server /usr/local/bin/apteva-server
COPY --from=builder /build/integrations/src/apps /data/integrations

ENV PORT=5280
ENV CORE_CMD=/usr/local/bin/apteva-core
ENV DB_PATH=/data/apteva.db
ENV DATA_DIR=/data
ENV APPS_DIR=/data/integrations

EXPOSE 5280

VOLUME /data

ENTRYPOINT ["apteva-server"]
