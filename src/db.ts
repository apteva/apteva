import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { encryptObject, decryptObject } from "./crypto";

// Types
export interface AgentFeatures {
  memory: boolean;
  tasks: boolean;
  vision: boolean;
  operator: boolean;
  mcp: boolean;
  realtime: boolean;
}

export const DEFAULT_FEATURES: AgentFeatures = {
  memory: true,
  tasks: false,
  vision: true,
  operator: false,
  mcp: false,
  realtime: false,
};

export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  system_prompt: string;
  status: "stopped" | "running";
  port: number | null;
  features: AgentFeatures;
  mcp_servers: string[]; // Array of MCP server IDs
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  name: string;
  model: string;
  provider: string;
  system_prompt: string;
  status: string;
  port: number | null;
  features: string | null;
  mcp_servers: string | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  key: string;
  value: string;
}

export interface ProviderKey {
  id: string;
  provider_id: string;
  encrypted_key: string;
  key_hint: string;
  is_valid: boolean;
  last_tested_at: string | null;
  created_at: string;
}

export interface ProviderKeyRow {
  id: string;
  provider_id: string;
  encrypted_key: string;
  key_hint: string;
  is_valid: number;
  last_tested_at: string | null;
  created_at: string;
}

export interface McpServer {
  id: string;
  name: string;
  type: "npm" | "github" | "http" | "custom";
  package: string | null;
  command: string | null;
  args: string | null;
  env: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  created_at: string;
}

export interface McpServerRow {
  id: string;
  name: string;
  type: string;
  package: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  port: number | null;
  status: string;
  created_at: string;
}

// Database instance
let db: Database;

// Initialize database
export function initDatabase(dataDir: string): Database {
  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, "apteva.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Run migrations
  runMigrations();

  // Database initialized silently
  return db;
}

// Get database instance
export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

// Migrations
function runMigrations() {
  // Create migrations table if not exists
  db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const migrations: { name: string; sql: string }[] = [
    {
      name: "001_create_agents",
      sql: `
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          system_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
          status TEXT NOT NULL DEFAULT 'stopped',
          port INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
        CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents(provider);
      `,
    },
    {
      name: "002_create_settings",
      sql: `
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `,
    },
    {
      name: "003_create_threads",
      sql: `
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          title TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_threads_agent ON threads(agent_id);
      `,
    },
    {
      name: "004_create_messages",
      sql: `
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      `,
    },
    {
      name: "005_create_provider_keys",
      sql: `
        CREATE TABLE IF NOT EXISTS provider_keys (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL UNIQUE,
          encrypted_key TEXT NOT NULL,
          key_hint TEXT,
          is_valid INTEGER DEFAULT 1,
          last_tested_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id);
      `,
    },
    {
      name: "006_add_agent_features",
      sql: `
        ALTER TABLE agents ADD COLUMN features TEXT DEFAULT '{"memory":true,"tasks":false,"vision":true,"operator":false,"mcp":false,"realtime":false}';
      `,
    },
    {
      name: "007_create_mcp_servers",
      sql: `
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'npm',
          package TEXT,
          command TEXT,
          args TEXT,
          env TEXT DEFAULT '{}',
          port INTEGER,
          status TEXT NOT NULL DEFAULT 'stopped',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
      `,
    },
    {
      name: "008_add_agent_mcp_servers",
      sql: `
        ALTER TABLE agents ADD COLUMN mcp_servers TEXT DEFAULT '[]';
      `,
    },
    {
      name: "009_create_telemetry",
      sql: `
        CREATE TABLE IF NOT EXISTS telemetry_events (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          category TEXT NOT NULL,
          type TEXT NOT NULL,
          level TEXT NOT NULL,
          trace_id TEXT,
          span_id TEXT,
          thread_id TEXT,
          data TEXT,
          metadata TEXT,
          duration_ms INTEGER,
          error TEXT,
          received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_agent ON telemetry_events(agent_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_time ON telemetry_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_telemetry_category ON telemetry_events(category);
        CREATE INDEX IF NOT EXISTS idx_telemetry_level ON telemetry_events(level);
        CREATE INDEX IF NOT EXISTS idx_telemetry_trace ON telemetry_events(trace_id);
      `,
    },
  ];

  // Check which migrations have been applied
  const applied = new Set<string>();
  const rows = db.query("SELECT name FROM migrations").all() as { name: string }[];
  for (const row of rows) {
    applied.add(row.name);
  }

  // Run pending migrations
  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      // Migration runs silently
      db.run(migration.sql);
      db.run("INSERT INTO migrations (name) VALUES (?)", [migration.name]);
    }
  }
}

// Agent CRUD operations
export const AgentDB = {
  // Create a new agent
  create(agent: Omit<Agent, "created_at" | "updated_at" | "status" | "port">): Agent {
    const now = new Date().toISOString();
    const featuresJson = JSON.stringify(agent.features || DEFAULT_FEATURES);
    const mcpServersJson = JSON.stringify(agent.mcp_servers || []);
    const stmt = db.prepare(`
      INSERT INTO agents (id, name, model, provider, system_prompt, features, mcp_servers, status, port, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', NULL, ?, ?)
    `);
    stmt.run(agent.id, agent.name, agent.model, agent.provider, agent.system_prompt, featuresJson, mcpServersJson, now, now);
    return this.findById(agent.id)!;
  },

  // Find agent by ID
  findById(id: string): Agent | null {
    const row = db.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | null;
    return row ? rowToAgent(row) : null;
  },

  // Get all agents
  findAll(): Agent[] {
    const rows = db.query("SELECT * FROM agents ORDER BY created_at DESC").all() as AgentRow[];
    return rows.map(rowToAgent);
  },

  // Get running agents (for auto-restart)
  findRunning(): Agent[] {
    const rows = db.query("SELECT * FROM agents WHERE status = 'running'").all() as AgentRow[];
    return rows.map(rowToAgent);
  },

  // Update agent
  update(id: string, updates: Partial<Omit<Agent, "id" | "created_at">>): Agent | null {
    const agent = this.findById(id);
    if (!agent) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.model !== undefined) {
      fields.push("model = ?");
      values.push(updates.model);
    }
    if (updates.provider !== undefined) {
      fields.push("provider = ?");
      values.push(updates.provider);
    }
    if (updates.system_prompt !== undefined) {
      fields.push("system_prompt = ?");
      values.push(updates.system_prompt);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.port !== undefined) {
      fields.push("port = ?");
      values.push(updates.port);
    }
    if (updates.features !== undefined) {
      fields.push("features = ?");
      values.push(JSON.stringify(updates.features));
    }
    if (updates.mcp_servers !== undefined) {
      fields.push("mcp_servers = ?");
      values.push(JSON.stringify(updates.mcp_servers));
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      db.run(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  // Delete agent
  delete(id: string): boolean {
    const result = db.run("DELETE FROM agents WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Set agent status
  setStatus(id: string, status: "stopped" | "running", port?: number): Agent | null {
    return this.update(id, { status, port: port ?? null });
  },

  // Reset all agents to stopped (on server restart)
  resetAllStatus(): void {
    db.run("UPDATE agents SET status = 'stopped', port = NULL");
  },

  // Count agents
  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM agents").get() as { count: number };
    return row.count;
  },

  // Count running agents
  countRunning(): number {
    const row = db.query("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get() as { count: number };
    return row.count;
  },
};

// Thread CRUD operations
export const ThreadDB = {
  create(id: string, agentId: string, title?: string): void {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, agentId, title || null, now, now]
    );
  },

  findById(id: string) {
    return db.query("SELECT * FROM threads WHERE id = ?").get(id);
  },

  findByAgent(agentId: string) {
    return db.query("SELECT * FROM threads WHERE agent_id = ? ORDER BY updated_at DESC").all(agentId);
  },

  delete(id: string): boolean {
    const result = db.run("DELETE FROM threads WHERE id = ?", [id]);
    return result.changes > 0;
  },
};

// Message CRUD operations
export const MessageDB = {
  create(id: string, threadId: string, role: string, content: string): void {
    db.run(
      "INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)",
      [id, threadId, role, content]
    );
    // Update thread's updated_at
    db.run("UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [threadId]);
  },

  findByThread(threadId: string) {
    return db.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId);
  },
};

// Settings operations
export const SettingsDB = {
  get(key: string): string | null {
    const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP",
      [key, value, value]
    );
  },

  delete(key: string): boolean {
    const result = db.run("DELETE FROM settings WHERE key = ?", [key]);
    return result.changes > 0;
  },
};

// Helper to convert DB row to Agent type
function rowToAgent(row: AgentRow): Agent {
  let features = DEFAULT_FEATURES;
  if (row.features) {
    try {
      features = { ...DEFAULT_FEATURES, ...JSON.parse(row.features) };
    } catch {
      // Use defaults if parsing fails
    }
  }
  let mcp_servers: string[] = [];
  if (row.mcp_servers) {
    try {
      mcp_servers = JSON.parse(row.mcp_servers);
    } catch {
      // Use empty array if parsing fails
    }
  }
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    provider: row.provider,
    system_prompt: row.system_prompt,
    status: row.status as "stopped" | "running",
    port: row.port,
    features,
    mcp_servers,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Provider Keys operations
export const ProviderKeysDB = {
  // Save or update a provider key
  save(providerId: string, encryptedKey: string, keyHint: string): ProviderKey {
    const existing = this.findByProvider(providerId);
    const now = new Date().toISOString();

    if (existing) {
      db.run(
        "UPDATE provider_keys SET encrypted_key = ?, key_hint = ?, is_valid = 1, last_tested_at = NULL, created_at = ? WHERE provider_id = ?",
        [encryptedKey, keyHint, now, providerId]
      );
    } else {
      const id = generateId();
      db.run(
        "INSERT INTO provider_keys (id, provider_id, encrypted_key, key_hint, is_valid, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        [id, providerId, encryptedKey, keyHint, now]
      );
    }

    return this.findByProvider(providerId)!;
  },

  // Find key by provider
  findByProvider(providerId: string): ProviderKey | null {
    const row = db.query("SELECT * FROM provider_keys WHERE provider_id = ?").get(providerId) as ProviderKeyRow | null;
    return row ? rowToProviderKey(row) : null;
  },

  // Get all provider keys (without the actual encrypted key for listing)
  findAll(): ProviderKey[] {
    const rows = db.query("SELECT * FROM provider_keys ORDER BY created_at DESC").all() as ProviderKeyRow[];
    return rows.map(rowToProviderKey);
  },

  // Get list of provider IDs that have keys configured
  getConfiguredProviders(): string[] {
    const rows = db.query("SELECT provider_id FROM provider_keys").all() as { provider_id: string }[];
    return rows.map(r => r.provider_id);
  },

  // Update validity status after testing
  setValidity(providerId: string, isValid: boolean): void {
    db.run(
      "UPDATE provider_keys SET is_valid = ?, last_tested_at = ? WHERE provider_id = ?",
      [isValid ? 1 : 0, new Date().toISOString(), providerId]
    );
  },

  // Delete a provider key
  delete(providerId: string): boolean {
    const result = db.run("DELETE FROM provider_keys WHERE provider_id = ?", [providerId]);
    return result.changes > 0;
  },

  // Check if any keys are configured
  hasAnyKeys(): boolean {
    const row = db.query("SELECT COUNT(*) as count FROM provider_keys").get() as { count: number };
    return row.count > 0;
  },

  // Count configured providers
  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM provider_keys").get() as { count: number };
    return row.count;
  },
};

// Helper to convert DB row to ProviderKey type
function rowToProviderKey(row: ProviderKeyRow): ProviderKey {
  return {
    id: row.id,
    provider_id: row.provider_id,
    encrypted_key: row.encrypted_key,
    key_hint: row.key_hint,
    is_valid: row.is_valid === 1,
    last_tested_at: row.last_tested_at,
    created_at: row.created_at,
  };
}

// MCP Server operations
export const McpServerDB = {
  create(server: Omit<McpServer, "created_at" | "status" | "port">): McpServer {
    const now = new Date().toISOString();
    // Encrypt env vars (credentials) before storing
    const envEncrypted = encryptObject(server.env || {});
    const stmt = db.prepare(`
      INSERT INTO mcp_servers (id, name, type, package, command, args, env, status, port, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', NULL, ?)
    `);
    stmt.run(server.id, server.name, server.type, server.package, server.command, server.args, envEncrypted, now);
    return this.findById(server.id)!;
  },

  findById(id: string): McpServer | null {
    const row = db.query("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | null;
    return row ? rowToMcpServer(row) : null;
  },

  findAll(): McpServer[] {
    const rows = db.query("SELECT * FROM mcp_servers ORDER BY created_at DESC").all() as McpServerRow[];
    return rows.map(rowToMcpServer);
  },

  findRunning(): McpServer[] {
    const rows = db.query("SELECT * FROM mcp_servers WHERE status = 'running'").all() as McpServerRow[];
    return rows.map(rowToMcpServer);
  },

  update(id: string, updates: Partial<Omit<McpServer, "id" | "created_at">>): McpServer | null {
    const server = this.findById(id);
    if (!server) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.type !== undefined) {
      fields.push("type = ?");
      values.push(updates.type);
    }
    if (updates.package !== undefined) {
      fields.push("package = ?");
      values.push(updates.package);
    }
    if (updates.command !== undefined) {
      fields.push("command = ?");
      values.push(updates.command);
    }
    if (updates.args !== undefined) {
      fields.push("args = ?");
      values.push(updates.args);
    }
    if (updates.env !== undefined) {
      fields.push("env = ?");
      // Encrypt env vars (credentials) before storing
      values.push(encryptObject(updates.env));
    }
    if (updates.port !== undefined) {
      fields.push("port = ?");
      values.push(updates.port);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }

    if (fields.length > 0) {
      values.push(id);
      db.run(`UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  setStatus(id: string, status: "stopped" | "running", port?: number): McpServer | null {
    return this.update(id, { status, port: port ?? null });
  },

  delete(id: string): boolean {
    const result = db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
    return result.changes > 0;
  },

  resetAllStatus(): void {
    db.run("UPDATE mcp_servers SET status = 'stopped', port = NULL");
  },

  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM mcp_servers").get() as { count: number };
    return row.count;
  },
};

// Helper to convert DB row to McpServer type
function rowToMcpServer(row: McpServerRow): McpServer {
  // Decrypt env vars (handles both encrypted and legacy unencrypted data)
  const env = row.env ? decryptObject(row.env) : {};
  return {
    id: row.id,
    name: row.name,
    type: row.type as McpServer["type"],
    package: row.package,
    command: row.command,
    args: row.args,
    env,
    port: row.port,
    status: row.status as "stopped" | "running",
    created_at: row.created_at,
  };
}

// Telemetry Event types
export interface TelemetryEvent {
  id: string;
  agent_id: string;
  timestamp: string;
  category: string;
  type: string;
  level: string;
  trace_id: string | null;
  span_id: string | null;
  thread_id: string | null;
  data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  duration_ms: number | null;
  error: string | null;
  received_at: string;
}

interface TelemetryEventRow {
  id: string;
  agent_id: string;
  timestamp: string;
  category: string;
  type: string;
  level: string;
  trace_id: string | null;
  span_id: string | null;
  thread_id: string | null;
  data: string | null;
  metadata: string | null;
  duration_ms: number | null;
  error: string | null;
  received_at: string;
}

// Telemetry operations
export const TelemetryDB = {
  // Insert batch of events
  insertBatch(agentId: string, events: Array<{
    id: string;
    timestamp: string;
    category: string;
    type: string;
    level: string;
    trace_id?: string;
    span_id?: string;
    thread_id?: string;
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    duration_ms?: number;
    error?: string;
  }>): number {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO telemetry_events
      (id, agent_id, timestamp, category, type, level, trace_id, span_id, thread_id, data, metadata, duration_ms, error, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const event of events) {
      const result = stmt.run(
        event.id,
        agentId,
        event.timestamp,
        event.category,
        event.type,
        event.level,
        event.trace_id || null,
        event.span_id || null,
        event.thread_id || null,
        event.data ? JSON.stringify(event.data) : null,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.duration_ms || null,
        event.error || null,
        now
      );
      if (result.changes > 0) inserted++;
    }
    return inserted;
  },

  // Query events with filters
  query(filters: {
    agent_id?: string;
    category?: string;
    level?: string;
    trace_id?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  } = {}): TelemetryEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agent_id) {
      conditions.push("agent_id = ?");
      params.push(filters.agent_id);
    }
    if (filters.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters.level) {
      conditions.push("level = ?");
      params.push(filters.level);
    }
    if (filters.trace_id) {
      conditions.push("trace_id = ?");
      params.push(filters.trace_id);
    }
    if (filters.since) {
      conditions.push("timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push("timestamp <= ?");
      params.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const sql = `SELECT * FROM telemetry_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.query(sql).all(...params) as TelemetryEventRow[];
    return rows.map(rowToTelemetryEvent);
  },

  // Get usage stats
  getUsage(filters: {
    agent_id?: string;
    since?: string;
    until?: string;
    group_by?: "agent" | "day";
  } = {}): Array<{
    agent_id?: string;
    date?: string;
    input_tokens: number;
    output_tokens: number;
    llm_calls: number;
    tool_calls: number;
    errors: number;
  }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agent_id) {
      conditions.push("agent_id = ?");
      params.push(filters.agent_id);
    }
    if (filters.since) {
      conditions.push("timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push("timestamp <= ?");
      params.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let groupBy = "";
    let selectFields = "";

    if (filters.group_by === "day") {
      groupBy = "GROUP BY date(timestamp)";
      selectFields = "date(timestamp) as date,";
    } else if (filters.group_by === "agent") {
      groupBy = "GROUP BY agent_id";
      selectFields = "agent_id,";
    }

    const sql = `
      SELECT
        ${selectFields}
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN json_extract(data, '$.input_tokens') ELSE 0 END), 0) as input_tokens,
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN json_extract(data, '$.output_tokens') ELSE 0 END), 0) as output_tokens,
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN 1 ELSE 0 END), 0) as llm_calls,
        COALESCE(SUM(CASE WHEN category = 'TOOL' THEN 1 ELSE 0 END), 0) as tool_calls,
        COALESCE(SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END), 0) as errors
      FROM telemetry_events
      ${where}
      ${groupBy}
    `;

    return db.query(sql).all(...params) as Array<{
      agent_id?: string;
      date?: string;
      input_tokens: number;
      output_tokens: number;
      llm_calls: number;
      tool_calls: number;
      errors: number;
    }>;
  },

  // Get summary stats
  getStats(agentId?: string): {
    total_events: number;
    total_llm_calls: number;
    total_tool_calls: number;
    total_errors: number;
    total_input_tokens: number;
    total_output_tokens: number;
  } {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const params = agentId ? [agentId] : [];

    const sql = `
      SELECT
        COUNT(*) as total_events,
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN 1 ELSE 0 END), 0) as total_llm_calls,
        COALESCE(SUM(CASE WHEN category = 'TOOL' THEN 1 ELSE 0 END), 0) as total_tool_calls,
        COALESCE(SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END), 0) as total_errors,
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN json_extract(data, '$.input_tokens') ELSE 0 END), 0) as total_input_tokens,
        COALESCE(SUM(CASE WHEN category = 'LLM' THEN json_extract(data, '$.output_tokens') ELSE 0 END), 0) as total_output_tokens
      FROM telemetry_events
      ${where}
    `;

    return db.query(sql).get(...params) as {
      total_events: number;
      total_llm_calls: number;
      total_tool_calls: number;
      total_errors: number;
      total_input_tokens: number;
      total_output_tokens: number;
    };
  },

  // Delete old events (retention)
  deleteOlderThan(days: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const result = db.run(
      "DELETE FROM telemetry_events WHERE timestamp < ?",
      [cutoff.toISOString()]
    );
    return result.changes;
  },

  // Delete all events for an agent
  deleteByAgent(agentId: string): number {
    const result = db.run(
      "DELETE FROM telemetry_events WHERE agent_id = ?",
      [agentId]
    );
    return result.changes;
  },

  // Count events
  count(agentId?: string): number {
    if (agentId) {
      const row = db.query("SELECT COUNT(*) as count FROM telemetry_events WHERE agent_id = ?").get(agentId) as { count: number };
      return row.count;
    }
    const row = db.query("SELECT COUNT(*) as count FROM telemetry_events").get() as { count: number };
    return row.count;
  },
};

function rowToTelemetryEvent(row: TelemetryEventRow): TelemetryEvent {
  return {
    id: row.id,
    agent_id: row.agent_id,
    timestamp: row.timestamp,
    category: row.category,
    type: row.type,
    level: row.level,
    trace_id: row.trace_id,
    span_id: row.span_id,
    thread_id: row.thread_id,
    data: row.data ? JSON.parse(row.data) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    duration_ms: row.duration_ms,
    error: row.error,
    received_at: row.received_at,
  };
}

// Generate unique ID
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
