<p align="center">
  <a href="https://apteva.ai"><img src="https://apteva.ai/icon.png" width="80" alt="Apteva logo" /></a>
</p>

<h1 align="center">Apteva</h1>

<p align="center"><strong>The open-source AI operating system.</strong></p>

<p align="center">
  Run persistent agents, install apps, and connect your tools in one workspace.<br />
  Agents remember, schedule work, and act—with permissions and activity you can inspect.
</p>

<p align="center">
  <a href="https://apteva.ai">Website</a> ·
  <a href="https://docs.apteva.ai/">Documentation</a> ·
  <a href="https://apteva.ai/apps">Apps</a> ·
  <a href="https://apteva.ai/cloud">Cloud</a> ·
  <a href="https://discord.gg/apteva">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/apteva/apteva/releases/latest"><img src="https://img.shields.io/github/v/release/apteva/apteva?style=flat-square" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/apteva"><img src="https://img.shields.io/npm/v/apteva?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/apteva/apteva/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/apteva/apteva/ci.yml?style=flat-square&label=tests" alt="CLI checks" /></a>
</p>

## Get started

```bash
npx apteva
```

On macOS or Linux with Node.js 18+. Apteva downloads the native release and opens your local dashboard. Connect a model provider, create an agent, and give it a responsibility.

Self-host free on your own machine or infrastructure, or use [Apteva Cloud](https://apteva.ai/cloud) for a managed workspace. [Read the setup guide →](https://docs.apteva.ai/#quickstart)

## An operating system around your agents

Apteva combines a persistent agent runtime, an app system, and a workspace that grows around what you install. Give agents ongoing responsibilities, connect the systems they need, and keep their work in view.

<table>
  <tr>
    <td width="33%"><img src="https://apteva.ai/product-concepts/persistent-agent.png" alt="Persistent agent concept: remembered context, a prepared reply, and a scheduled follow-up" /></td>
    <td width="33%"><img src="https://apteva.ai/product-concepts/dashboard.png" alt="Dashboard concept: agent activity, tool usage, and decisions awaiting review" /></td>
    <td width="33%"><img src="https://apteva.ai/product-concepts/apps.png" alt="App library concept: CRM, storage, code, tasks, and other installable apps" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Persistent agents</strong></td>
    <td align="center"><strong>One workspace</strong></td>
    <td align="center"><strong>Installable apps</strong></td>
  </tr>
</table>

<p align="center"><sub>Product concept illustrations from <a href="https://apteva.ai">apteva.ai</a>.</sub></p>

| | What you get |
|---|---|
| **Agents that keep working** | Memory across conversations, events, scheduled follow-ups, and durable tasks that survive restarts. |
| **A workspace shaped by your apps** | Install CRM, storage, tasks, code, or other apps. Each can bring tools, its own UI, routes, channels, and workers. |
| **Connections to your tools** | Hundreds of integrations, including GitHub, Slack, Stripe, Shopify, HubSpot, Google Workspace, and databases. |
| **Control you can inspect** | Set goals and permissions, follow activity and tool calls, and review actions that need human judgment. |
| **Multi-agent work** | Delegate bounded tasks to workers while keeping progress and ownership visible. |
| **Your models and infrastructure** | Choose hosted or local models. Run locally, self-host, or use Cloud. |

## Give an agent a responsibility

- **Support:** triage incoming tickets, find answers, prepare replies, and escalate decisions.
- **Sales:** enrich leads, update your CRM, and follow up when a deal needs attention.
- **Content:** research topics, create assets, publish through connected tools, and track results.
- **Engineering:** monitor deployments, investigate alerts, run tests, and prepare fixes.
- **Operations:** process invoices, reconcile records, and coordinate recurring work.

[Explore use cases →](https://apteva.ai/use-cases)

## Run it your way

**Local:** run `npx apteva`. Your workspace data stays on your machine; hosted model providers and connected services receive the requests you send to them.

**Docker:** run the published image with persistent storage:

```bash
docker run -d \
  --name apteva \
  -p 5280:5280 \
  -v apteva-data:/data \
  ghcr.io/apteva/apteva:latest
```

Open [http://localhost:5280](http://localhost:5280). Pin a numbered image tag for production. See [deployment and HTTPS setup](docs/deployment.md) for your own domain.

**Cloud:** [Apteva Cloud](https://apteva.ai/cloud) runs the same platform without managing the server yourself.

Use OpenAI, Anthropic, Google, Fireworks, Ollama, NVIDIA, Venice, xAI, or other compatible model providers. Choose different providers per project and switch models without rebuilding your agents.

## Build on Apteva

Write an app with the [App SDK](https://github.com/apteva/app-sdk) to add tools, UI panels, HTTP routes, workers, channels, and operational data. Your app sits alongside the first-party apps in the same workspace.

[Browse apps](https://apteva.ai/apps) · [Build an app](https://apteva.ai/developers/apps) · [Platform API](https://apteva.ai/developers/api)

This repository contains the **CLI, npm installer, local lifecycle, and platform release pipeline**. The rest of the operating system lives in companion repositories:

| Repository | Role |
|---|---|
| [core](https://github.com/apteva/core) | Persistent agent runtime and thinking loop |
| [server](https://github.com/apteva/server) | Management API, orchestration, apps, and embedded dashboard |
| [dashboard](https://github.com/apteva/dashboard) | Administration and operations UI |
| [apps](https://github.com/apteva/apps) | First-party operational apps |
| [integrations](https://github.com/apteva/integrations) | Integration catalog, OAuth, webhooks, and MCP generation |
| [app-sdk](https://github.com/apteva/app-sdk) | Go SDK for building apps |
| [computer](https://github.com/apteva/computer) | Browser and computer-use backends |

For source builds and the repository layout, start with the [development guide](docs/development.md). See also [app testing scenarios](docs/testing-scenarios.md) and [multi-agent topology tests](docs/test-topology.md).

## Community

Read the [documentation](https://docs.apteva.ai/), join [Discord](https://discord.gg/apteva), or open an [issue](https://github.com/apteva/apteva/issues) for bugs and feature requests.

Open source. Yours to run.
