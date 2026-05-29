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
  <a href="https://github.com/apteva/computer">Computer</a> ·
  <a href="https://github.com/apteva/integrations">Integrations</a>
</p>

---

## Quick Start

```bash
npx apteva
```

A setup wizard guides you through provider selection, API key, and capabilities. Then the agent starts thinking.

Or from source:

```bash
cd core && go build -o apteva-core .
cd ../server && go build -o apteva-server .
cd ../apteva && go build -o apteva .
./apteva
```

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
- Browses the web, takes screenshots, clicks through pages
- Connects to GitHub, Stripe, Slack — 263+ integrations

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  ./apteva                                            │
│  Setup wizard → TUI terminal interface               │
│  Channels: CLI, Telegram, Discord                    │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  apteva-server (:5280)                               │
│  Auth · Instances · Integrations · Webhooks          │
│                                                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐              │
│  │ core-1  │  │ core-2  │  │ core-3  │  ...         │
│  │ default │  │ support │  │ monitor │              │
│  └────┬────┘  └────┬────┘  └────┬────┘              │
│       │            │            │                    │
│       ▼            ▼            ▼                    │
│  ┌──────────────────────────────────────────────┐    │
│  │              MCP Tools                       │    │
│  │  channels · exec · web · browser             │    │
│  │  github · stripe · slack · 263+ more         │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  memory · self-pacing · evolve · persistent history  │
└──────────────────────────────────────────────────────┘
```

One command (`./apteva`) starts everything. The CLI spawns the server, the server spawns core instances, and the agent begins thinking.

## Key Features

| Feature | Description |
|---------|-------------|
| **Continuous Thinking** | Infinite loop — observe, reason, act, sleep. Not request-response. |
| **Multi-Threaded** | Spawns worker threads for parallel tasks. Each has its own tools, pace, and directive. |
| **Self-Evolving** | Persistent memory. Refines its own directives over time. Gets sharper the longer it runs. |
| **Self-Pacing** | Sets its own sleep duration — 2 seconds when busy, hours when idle. Events wake it instantly. |
| **Session Persistence** | Conversation history survives restarts. JSONL per thread, auto-compaction, never loses context. |
| **Agent-Driven Safety** | No forced approval gates. The agent decides, learns from feedback, asks when unsure. Three modes: autonomous, cautious, learn. |
| **263+ Integrations** | GitHub, Slack, Stripe, Shopify, and more. Each runs as its own MCP server. Credentials encrypted. |
| **Browser Control** | Provided by the Computer app through MCP tools and app-managed sessions. |
| **Multi-Channel** | CLI terminal, Telegram, Discord. Agent routes responses to the right channel. |
| **Multi-Instance** | Run multiple agents in parallel. Each has its own directive, tools, and history. Projects for isolation. |
| **Terminal UI** | Two-panel TUI with live status, thread thoughts, streaming responses, modal commands. |
| **Embeddable** | The core is a standalone Go binary. Run it headless, connect via API, embed anywhere. |

## Use Cases

- **Run a business** — Support, sales, content, billing — fully autonomous, 24/7
- **Content pipeline** — Research, write, publish, distribute, track — zero human input
- **Ad operations** — Monitor ROAS, adjust budgets, generate creatives, A/B test
- **DevOps** — Monitor deploys, triage alerts, write patches, coordinate incidents
- **Personal assistant** — Email triage, calendar management, reminders, research
- **Web automation** — Browse sites, fill forms, take screenshots, extract data

## CLI Commands

| Command | Description |
|---------|-------------|
| `/status` | Core status |
| `/config` | Full config |
| `/directive [text]` | Show or set directive |
| `/mode` | Switch mode: autonomous, cautious, learn |
| `/threads` | List/kill threads |
| `/integrate <app>` | Connect an integration (263+ apps) |
| `/connect telegram` | Connect Telegram bot |
| `/channels` | List connected channels |
| `/mcp` | Manage MCP servers |
| `/help` | All commands |

Everything else you type is sent to the agent.

## Modes

| Mode | Behavior |
|------|----------|
| **autonomous** | Agent acts freely. Learns from feedback. Trusted. |
| **cautious** | Asks before destructive or external actions. Learns from answers. |
| **learn** | Asks about every new tool type. Builds a safety profile over time. |

All modes use `[[remember]]` for persistent learning. The agent gets smarter the longer it runs.

## Providers

| Provider | Models |
|----------|--------|
| **Fireworks** | Kimi K2.5 |
| **Anthropic** | Claude Sonnet 4, Claude Haiku 4.5 |
| **OpenAI** | GPT-4.1, GPT-4.1-mini |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash |

Select during setup. Switch anytime with `/mode` or the API.

## Repositories

| Repo | Description |
|------|-------------|
| [`apteva/apteva`](https://github.com/apteva/apteva) | This repo — CLI, setup wizard, TUI, npm launcher |
| [`apteva/core`](https://github.com/apteva/core) | The thinking engine (Go) |
| [`apteva/server`](https://github.com/apteva/server) | Management server — auth, instances, integrations, dashboard (Go) |
| [`apteva/integrations`](https://github.com/apteva/integrations) | 263 app connectors + webhook registrar (TypeScript) |

## Configuration

```bash
# Data stored in
~/.apteva/apteva.json    # CLI config (capabilities, API key, instance ID)
~/.apteva/apteva.db      # Server database (auth, connections, providers)
```

## From Source

```bash
# Build all three binaries
cd core && go build -o apteva-core .
cd ../server && go build -o apteva-server .
cd ../apteva && go build -o apteva .

# Run (starts server + core + TUI)
cd apteva && ./apteva

# Or run core standalone (headless)
cd core && ./apteva-core --headless

# Or connect CLI to a remote server
./apteva --no-spawn --server <host>:5280
```

## Docker

```bash
# Build
docker build -t apteva .

# Run
docker run -p 5280:5280 -v apteva-data:/data apteva

# Connect CLI to it
./apteva --no-spawn --server <host>:5280
```

## Migrating from OpenClaw

Already running OpenClaw agents? Here's how to switch.

| OpenClaw | Apteva | Notes |
|----------|--------|-------|
| `claw.run(prompt)` | `config.json` → directive | Apteva doesn't need prompts. It runs continuously. |
| `claw.tool(...)` | MCP server | Any MCP server works. 263+ built-in. |
| `claw.memory` | `[[remember]]` | Persistent across restarts. Embedding-based recall. |
| `claw.agent(name)` | `[[spawn id="name"]]` | Threads are cheaper. They share memory and tools. |
| Webhook handlers | Subscriptions | Events route directly to threads. |
| `OPENCLAW_API_KEY` | `FIREWORKS_API_KEY` | Or Anthropic, OpenAI, Google. Your choice. |
| Cron jobs | Self-pacing | No cron needed. `[[pace sleep="5m"]]` and it wakes on events. |
| Agent state files | Evolving directives | The agent rewrites its own config. It improves itself. |
| Session files | JSONL history | Persistent per thread, auto-compaction, survives restarts. |

### Why switch?

- **OpenClaw agents sleep between requests.** Apteva agents think between requests.
- **OpenClaw needs orchestration.** Apteva orchestrates itself.
- **OpenClaw bills per call.** Apteva self-paces to minimize cost — sleeps long when idle, thinks fast when busy.
- **OpenClaw agents forget.** Apteva agents remember, learn, and evolve their own directives.

The fundamental difference: OpenClaw agents are **functions you call**. Apteva agents are **processes that run**. One waits. The other works.

## License

[MIT](LICENSE)

---

<p align="center">
  <strong>Artificial consciousness for machines that work.</strong><br>
  <a href="https://apteva.ai">apteva.ai</a>
</p>
