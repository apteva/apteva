# Apteva Database Schema

SQLite database stored at `~/.apteva/apteva.db`

## Migrations

Migrations run automatically on app startup via `initDatabase()`. Each migration is tracked in the `migrations` table to ensure it only runs once.

## Tables

### migrations

Tracks applied database migrations.

```sql
CREATE TABLE migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### users

User accounts for authentication.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user',  -- 'admin' or 'user'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
```

### sessions

User sessions for JWT refresh tokens.

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### settings

Key-value store for app settings.

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### provider_keys

Encrypted API keys for LLM providers (Anthropic, OpenAI, etc.).

```sql
CREATE TABLE provider_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  encrypted_key TEXT NOT NULL,
  key_hint TEXT NOT NULL,           -- Last 4 chars for display
  is_valid INTEGER DEFAULT 1,
  last_tested_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### agents

AI agent configurations.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,              -- e.g., 'claude-sonnet-4-5'
  provider TEXT NOT NULL,           -- e.g., 'anthropic'
  system_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',  -- 'stopped' or 'running'
  port INTEGER,                     -- Assigned port for agent HTTP server
  features TEXT DEFAULT '{}',       -- JSON: AgentFeatures object
  mcp_servers TEXT DEFAULT '[]',    -- JSON: Array of MCP server IDs
  skills TEXT DEFAULT '[]',         -- JSON: Array of Skill IDs
  project_id TEXT,                  -- Optional project grouping
  api_key_encrypted TEXT,           -- Encrypted API key for agent auth
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**AgentFeatures JSON structure:**
```json
{
  "memory": true,
  "tasks": false,
  "vision": true,
  "operator": false,
  "mcp": false,
  "realtime": false,
  "files": false,
  "agents": false
}
```

### projects

Agent grouping/organization.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#666666',  -- Hex color for UI
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### mcp_servers

MCP (Model Context Protocol) server configurations.

```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,               -- 'npm', 'github', 'http', 'custom'
  package TEXT,                     -- npm package name
  command TEXT,                     -- Custom command to run
  args TEXT,                        -- JSON: Command arguments
  env TEXT DEFAULT '{}',            -- JSON: Environment variables
  url TEXT,                         -- For http type: remote server URL
  headers TEXT DEFAULT '{}',        -- JSON: HTTP headers for auth
  port INTEGER,                     -- Local port when running
  status TEXT NOT NULL DEFAULT 'stopped',  -- 'stopped' or 'running'
  source TEXT,                      -- 'composio', 'smithery', or null
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### skills

Reusable agent instructions/capabilities.

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,            -- Full SKILL.md body (markdown)
  version TEXT DEFAULT '1.0.0',     -- Semantic version
  license TEXT,
  compatibility TEXT,
  metadata TEXT DEFAULT '{}',       -- JSON: Additional metadata
  allowed_tools TEXT DEFAULT '[]',  -- JSON: Tool restrictions
  source TEXT NOT NULL DEFAULT 'local',  -- 'local', 'skillsmp', 'github', 'import'
  source_url TEXT,                  -- URL if imported from marketplace
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### telemetry

Agent telemetry events for monitoring.

```sql
CREATE TABLE telemetry (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,           -- 'chat', 'tool', 'memory', 'task', 'error'
  event_type TEXT NOT NULL,
  data TEXT,                        -- JSON: Event-specific data
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Indexes

```sql
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_project ON agents(project_id);
CREATE INDEX idx_mcp_servers_status ON mcp_servers(status);
CREATE INDEX idx_telemetry_agent ON telemetry(agent_id);
CREATE INDEX idx_telemetry_created ON telemetry(created_at);
CREATE UNIQUE INDEX idx_users_username ON users(username);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_source ON skills(source);
CREATE INDEX idx_skills_enabled ON skills(enabled);
```

## Migration History

| Migration | Description |
|-----------|-------------|
| 001_initial | Core tables: migrations, agents, settings |
| 002_add_provider_keys | Provider API key storage |
| 003_add_mcp_servers | MCP server configurations |
| 004_add_features | Agent features JSON column |
| 005_add_mcp_to_agents | Link agents to MCP servers |
| 006_add_users | User authentication |
| 007_add_sessions | JWT session management |
| 008_add_telemetry | Telemetry events |
| 009_add_projects | Project organization |
| 010_add_agent_project | Link agents to projects |
| 011_add_user_role | Admin/user roles |
| 012_add_mcp_env | MCP server environment variables |
| 013_add_mcp_url_headers | Remote MCP server support |
| 014_add_mcp_source | MCP server source tracking |
| 015_add_agent_api_key | Per-agent API key authentication |
| 016_create_skills | Skills table |
| 017_add_skills_to_agents | Link agents to skills |
| 018_add_skill_version | Skill versioning |

## Relationships

```
users 1:N sessions
projects 1:N agents (via project_id)
agents N:M mcp_servers (via mcp_servers JSON array)
agents N:M skills (via skills JSON array)
agents 1:N telemetry (via agent_id)
```

## Notes

- All IDs are UUIDs generated via `crypto.randomUUID()`
- Timestamps are ISO 8601 strings
- JSON columns store serialized arrays/objects
- Encrypted columns use AES-256-GCM encryption
- WAL mode enabled for better concurrent access
- Foreign keys are enforced
