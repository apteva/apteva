import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

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
    const stmt = db.prepare(`
      INSERT INTO agents (id, name, model, provider, system_prompt, features, status, port, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'stopped', NULL, ?, ?)
    `);
    stmt.run(agent.id, agent.name, agent.model, agent.provider, agent.system_prompt, featuresJson, now, now);
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
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    provider: row.provider,
    system_prompt: row.system_prompt,
    status: row.status as "stopped" | "running",
    port: row.port,
    features,
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

// Generate unique ID
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
