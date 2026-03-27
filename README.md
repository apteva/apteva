# Apteva

Continuous AI agents with integrations, webhooks, and a management dashboard.

## Quick Start

```bash
npx apteva
```

This downloads the Apteva binaries and starts the server with dashboard at `http://localhost:5280`.

## What's Inside

- **apteva-core** — The thinking engine. Continuous loop, threads, tool dispatch, MCP, memory.
- **apteva-server** — Management server. Instances, connections, subscriptions, projects, dashboard.
- **200+ integrations** — Connect to GitHub, Slack, Stripe, OmniKit, and more.

## Configuration

Set environment variables before running:

```bash
PORT=5280              # Server port (default: 5280)
APTEVA_DATA=~/.apteva  # Data directory (default: ~/.apteva)
```

## From Source

```bash
# Build core
cd core && go build -o apteva-core .

# Build server
cd server && go build -o apteva-server .

# Run
./apteva-server
```

## License

MIT
