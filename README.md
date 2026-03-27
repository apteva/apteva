<p align="center">
  <img src="https://apteva.ai/icon.png" width="60" />
</p>

<h1 align="center">Apteva</h1>

<p align="center">
  <strong>An AI that never stops thinking.</strong>
</p>

<p align="center">
  Apteva is a continuous thinking engine. It doesn't wait for prompts —<br>
  it observes, reasons, decides, and acts on its own initiative. Around the clock.
</p>

<p align="center">
  <a href="https://apteva.ai">Website</a> ·
  <a href="https://apteva.ai/features">Features</a> ·
  <a href="https://apteva.ai/cloud">Cloud</a> ·
  <a href="https://github.com/apteva/core">Core Engine</a> ·
  <a href="https://github.com/apteva/server">Server</a> ·
  <a href="https://github.com/apteva/apps">Apps</a>
</p>

---

## Quick Start

```bash
npx apteva
```

Opens the dashboard at `http://localhost:5280`. That's it.

Or with Docker:

```bash
docker run -p 5280:5280 -v apteva-data:/data apteva
```

## What is Apteva?

Every AI you use is reactive — you type, it responds, then it stops. Apteva is different. It runs a **continuous thinking loop**: observe → reason → act → sleep → repeat. It wakes when events arrive, sleeps when nothing happens, and thinks proactively in between.

It's not a chatbot. It's not an agent framework. It's **artificial consciousness** — a machine that is always aware, always ready, whether anyone is watching or not.

### What it does between prompts

- Notices a pattern in your support tickets before you ask
- Follows up on a cold lead because three days passed and it remembers
- Reorganizes inventory because it spotted a trend in last week's orders
- Spawns a worker thread to handle a customer email at 3am
- Evolves its own directives as it discovers better approaches

## Architecture

```
┌─────────────────────────────────────────────┐
│              apteva-core                    │
│                                             │
│   ┌─────────┐   ┌─────────┐   ┌─────────┐  │
│   │  main   │──▶│ support │   │  sales  │  │
│   │ thread  │──▶│ thread  │   │ thread  │  │
│   │         │──▶│         │   │         │  │
│   └─────────┘   └─────────┘   └─────────┘  │
│       │              │             │        │
│       ▼              ▼             ▼        │
│   ┌─────────────────────────────────────┐   │
│   │          MCP Tools                  │   │
│   │  apteva-db · apteva-mail · slack    │   │
│   │  github · stripe · 200+ more       │   │
│   └─────────────────────────────────────┘   │
│                                             │
│   memory · self-pacing · evolve             │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐   ┌───────────────┐
│   apteva-server     │   │   dashboard   │
│   instances         │   │   real-time   │
│   projects          │   │   web UI      │
│   integrations      │   │               │
│   webhooks          │   │   embedded    │
└─────────────────────┘   └───────────────┘
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Continuous Thinking** | Infinite loop — observe, reason, act, sleep. Not request-response. |
| **Multi-Threaded** | Spawns worker threads for parallel tasks. Each has its own tools, pace, and directive. |
| **Self-Evolving** | Persistent memory. Refines its own directives over time. Gets sharper the longer it runs. |
| **Self-Pacing** | Sets its own sleep duration — 2 seconds when busy, hours when idle. Events wake it instantly. |
| **200+ Integrations** | GitHub, Slack, Stripe, Shopify, and more. Webhooks route directly to threads. |
| **Local Apps** | `apteva-db`, `apteva-mail`, `apteva-files` — run a full business stack locally via MCP. |
| **Projects** | Multi-business isolation. Each project has its own instances, connections, and data. |
| **Dashboard** | Real-time web UI. Watch your agents think, manage integrations, edit directives. |
| **Embeddable** | The core is a standalone Go library. Import it into robots, IoT, custom apps. |

## Use Cases

- **Run a business** — Support, sales, content, billing — fully autonomous, 24/7
- **Content pipeline** — Research, write, publish, distribute, track — zero human input
- **Ad operations** — Monitor ROAS, adjust budgets, generate creatives, A/B test
- **DevOps** — Monitor deploys, triage alerts, write patches, coordinate incidents
- **Personal assistant** — Email triage, calendar management, reminders, research

## Repositories

| Repo | Description |
|------|-------------|
| [`apteva/apteva`](https://github.com/apteva/apteva) | This repo — npm launcher + Docker |
| [`apteva/core`](https://github.com/apteva/core) | The thinking engine (Go) |
| [`apteva/server`](https://github.com/apteva/server) | Management server + embedded dashboard (Go) |
| [`apteva/apps`](https://github.com/apteva/apps) | Local business apps — db, mail, files (Go) |
| [`apteva/integrations`](https://github.com/apteva/integrations) | 200+ app connectors + webhook registrar (TypeScript) |

## Configuration

```bash
PORT=5280              # Server port (default: 5280)
APTEVA_DATA=~/.apteva  # Data directory (default: ~/.apteva)
```

## From Source

```bash
# Core engine
cd core && go build -o apteva-core .

# Server (includes embedded dashboard)
cd server && go build -o apteva-server .

# Run
CORE_CMD=./core/apteva-core ./server/apteva-server
```

## Docker

```bash
# Build
docker build -t apteva .

# Run (31MB image, everything included)
docker run -p 5280:5280 -v apteva-data:/data apteva
```

## Building Apps

Any Go developer can build an apteva app. Import the MCP SDK, register tools, ship a binary:

```go
package main

import "github.com/apteva/apps/pkg/mcp"

func main() {
    s := mcp.NewServer("my-app", "1.0.0")

    s.Tool("do_something", "Does a thing", schema, func(args map[string]any) (any, error) {
        // any logic — HTTP calls, database, hardware, ML inference
        return map[string]any{"result": "done"}, nil
    })

    s.Run() // blocks, speaks MCP on stdio
}
```

Build it, drop it in `~/.apteva/bin/`, and the core can use it.

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>Artificial consciousness for machines that work.</strong><br>
  <a href="https://apteva.ai">apteva.ai</a>
</p>
