# Apteva Docker Image
# Build: docker build -f docker/Dockerfile -t apteva/apteva .
# Run: docker run -p 3000:3000 -v apteva_data:/data apteva/apteva

# ============ Build Stage ============
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install ALL dependencies (including devDependencies for build)
RUN bun install

# Copy source code
COPY src ./src
COPY bin ./bin
COPY build.ts tailwind.config.js tsconfig.json ./

# Build frontend
RUN bun run build

# ============ Production Stage ============
FROM oven/bun:1-debian

# Install runtime dependencies for MCP servers:
# - curl: health checks
# - ca-certificates: HTTPS
# - nodejs/npm: Node.js MCP servers (npx)
# - python3/pip: Python MCP servers (e.g., late-sdk, mcp-server-*)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    nodejs \
    npm \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install production dependencies only (includes agent binary via optionalDependencies)
RUN bun install --production

# Copy source code (needed for server runtime)
COPY src ./src
COPY bin ./bin

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /data

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Data volume
VOLUME /data

# Start the server
CMD ["bun", "run", "src/server.ts"]
