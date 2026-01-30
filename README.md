# Apteva

Run AI agents locally on your machine.

[![npm version](https://img.shields.io/npm/v/apteva.svg)](https://www.npmjs.com/package/apteva)
[![license](https://img.shields.io/badge/license-ELv2-blue.svg)](LICENSE)

## Features

- **Multi-Provider Support** - Claude, GPT, Gemini, Llama, Grok, and more
- **Local-First** - Your data and API keys stay on your machine
- **Web Dashboard** - Beautiful UI for managing agents
- **Secure** - API keys encrypted at rest

## Quick Start

```bash
npx apteva
```

Open http://localhost:4280 in your browser.

## Installation

```bash
# npm
npm install -g apteva

# bun
bun add -g apteva
```

## Usage

```bash
# Start server (default port 4280)
apteva

# Custom port
apteva --port 8080

# Custom data directory
apteva --data-dir ./my-data
```

## Supported Providers

| Provider | Models |
|----------|--------|
| Anthropic | Claude Sonnet 4, Opus 4, Haiku |
| OpenAI | GPT-4o, GPT-4o Mini |
| Google | Gemini 2.0 Flash, 1.5 Pro |
| Groq | Llama 3.3 70B, Mixtral |
| xAI | Grok 2 |
| Fireworks | Llama, DeepSeek V3 |
| Together | Llama, DeepSeek R1 |
| Moonshot | Moonshot V1 |
| Venice | Llama 3.3 70B |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET | List agents |
| `/api/agents` | POST | Create agent |
| `/api/agents/:id/start` | POST | Start agent |
| `/api/agents/:id/stop` | POST | Stop agent |
| `/api/agents/:id/chat` | POST | Chat (streaming) |
| `/api/providers` | GET | List providers |
| `/api/health` | GET | Health check |

## Requirements

- Node.js 18+ or Bun 1.0+
- Linux, macOS, or Windows

## License

[Elastic License 2.0](LICENSE) - Free to use, cannot offer as a hosted service.

## Links

- [Issues](https://github.com/apteva/apteva/issues)
- [Contributing](CONTRIBUTING.md)
