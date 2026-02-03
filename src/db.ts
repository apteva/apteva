import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { encrypt, decrypt, encryptObject, decryptObject } from "./crypto";
import { randomBytes } from "crypto";

// Types
export type AgentMode = "coordinator" | "worker";

export interface MultiAgentConfig {
  enabled: boolean;
  mode?: AgentMode;
  group?: string; // Defaults to projectId if not specified
}

export interface AgentFeatures {
  memory: boolean;
  tasks: boolean;
  vision: boolean;
  operator: boolean;
  mcp: boolean;
  realtime: boolean;
  files: boolean;
  agents: boolean | MultiAgentConfig; // Can be boolean for backwards compat or full config
}

export const DEFAULT_FEATURES: AgentFeatures = {
  memory: true,
  tasks: false,
  vision: true,
  operator: false,
  mcp: false,
  realtime: false,
  files: false,
  agents: false,
};

// Helper to normalize agents feature to MultiAgentConfig
export function getMultiAgentConfig(features: AgentFeatures, projectId?: string | null): MultiAgentConfig {
  const agents = features.agents;
  if (typeof agents === "boolean") {
    return {
      enabled: agents,
      mode: "worker",
      group: projectId || undefined,
    };
  }
  return {
    ...agents,
    group: agents.group || projectId || undefined,
  };
}

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
  skills: string[]; // Array of Skill IDs
  project_id: string | null; // Optional project grouping
  api_key_encrypted: string | null; // Encrypted API key for agent authentication
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string; // Hex color for UI display
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
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
  skills: string | null;
  project_id: string | null;
  api_key_encrypted: string | null;
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
  url: string | null; // For http type: the remote server URL
  headers: Record<string, string>; // For http type: auth headers
  port: number | null;
  status: "stopped" | "running";
  source: string | null; // e.g., "composio", "smithery", null for local
  created_at: string;
}

// Skill types
export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string; // Full SKILL.md body (markdown)
  version: string; // Semantic version (e.g., "1.0.0")
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowed_tools: string[];
  source: "local" | "skillsmp" | "github" | "import";
  source_url: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  version: string;
  license: string | null;
  compatibility: string | null;
  metadata: string | null;
  allowed_tools: string | null;
  source: string;
  source_url: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface McpServerRow {
  id: string;
  name: string;
  type: string;
  package: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
  port: number | null;
  status: string;
  source: string | null;
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
    {
      name: "010_create_users",
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          email TEXT,
          role TEXT NOT NULL DEFAULT 'user',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_login_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
      `,
    },
    {
      name: "011_create_sessions",
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          refresh_token_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      `,
    },
    {
      name: "012_create_projects",
      sql: `
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          color TEXT NOT NULL DEFAULT '#6366f1',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
      `,
    },
    {
      name: "013_add_agent_project_id",
      sql: `
        ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
      `,
    },
    {
      name: "014_add_mcp_server_url_headers",
      sql: `
        ALTER TABLE mcp_servers ADD COLUMN url TEXT;
        ALTER TABLE mcp_servers ADD COLUMN headers TEXT DEFAULT '{}';
        ALTER TABLE mcp_servers ADD COLUMN source TEXT;
      `,
    },
    {
      name: "015_add_agent_api_key",
      sql: `
        ALTER TABLE agents ADD COLUMN api_key_encrypted TEXT;
      `,
    },
    {
      name: "016_create_skills",
      sql: `
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          content TEXT NOT NULL,
          license TEXT,
          compatibility TEXT,
          metadata TEXT DEFAULT '{}',
          allowed_tools TEXT DEFAULT '[]',
          source TEXT NOT NULL DEFAULT 'local',
          source_url TEXT,
          enabled INTEGER DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
        CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
        CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
      `,
    },
    {
      name: "017_add_skills_to_agents",
      sql: `
        ALTER TABLE agents ADD COLUMN skills TEXT DEFAULT '[]';
      `,
    },
    {
      name: "018_add_skill_version",
      sql: `
        ALTER TABLE skills ADD COLUMN version TEXT DEFAULT '1.0.0';
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
      try {
        // Migration runs silently
        db.run(migration.sql);
        db.run("INSERT INTO migrations (name) VALUES (?)", [migration.name]);
      } catch (err) {
        // Log error but continue - some migrations may fail if partially applied
        console.error(`[db] Migration ${migration.name} failed:`, err);
        // Still mark as applied to avoid retrying broken migrations
        try {
          db.run("INSERT INTO migrations (name) VALUES (?)", [migration.name]);
        } catch {
          // Ignore if already marked
        }
      }
    }
  }

  // Schema upgrade migrations (check actual table structure)
  runSchemaUpgrades();
}

// Handle schema changes that require checking actual table structure
function runSchemaUpgrades() {
  // Check if users table needs migration from email-based to username-based
  const tableInfo = db.query("PRAGMA table_info(users)").all() as { name: string }[];
  const columns = new Set(tableInfo.map(c => c.name));

  // Old schema has 'email' as required + 'name', new schema has 'username' + optional 'email'
  if (columns.has("name") && !columns.has("username")) {
    console.log("[db] Migrating users table from email-based to username-based auth...");

    // Get existing users
    const existingUsers = db.query("SELECT * FROM users").all() as any[];

    // Drop old table and indexes
    db.run("DROP INDEX IF EXISTS idx_users_email");
    db.run("DROP TABLE users");

    // Create new schema
    db.run(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      )
    `);
    db.run("CREATE UNIQUE INDEX idx_users_username ON users(username)");

    // Migrate existing users (use part before @ in email as username)
    for (const user of existingUsers) {
      const username = user.email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20);
      db.run(
        `INSERT INTO users (id, username, password_hash, email, role, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, username, user.password_hash, user.email, user.role, user.created_at, user.updated_at, user.last_login_at]
      );
    }

    if (existingUsers.length > 0) {
      console.log(`[db] Migrated ${existingUsers.length} user(s). Usernames derived from email addresses.`);
    }
  }
}

// Generate a unique API key for an agent
function generateAgentApiKey(agentId: string): string {
  const randomPart = randomBytes(24).toString("hex");
  return `agt_${randomPart}`;
}

// Agent CRUD operations
export const AgentDB = {
  // Get the next available port for a new agent (starting from 4100)
  getNextAvailablePort(): number {
    const BASE_PORT = 4100;
    const row = db.query("SELECT MAX(port) as max_port FROM agents").get() as { max_port: number | null };
    if (row.max_port === null) {
      return BASE_PORT;
    }
    return row.max_port + 1;
  },

  // Create a new agent with a permanently assigned port and API key
  create(agent: Omit<Agent, "created_at" | "updated_at" | "status" | "api_key_encrypted"> & { port?: number }): Agent {
    const now = new Date().toISOString();
    const featuresJson = JSON.stringify(agent.features || DEFAULT_FEATURES);
    const mcpServersJson = JSON.stringify(agent.mcp_servers || []);
    const skillsJson = JSON.stringify(agent.skills || []);
    // Assign port permanently at creation time
    const port = agent.port ?? this.getNextAvailablePort();
    // Generate and encrypt API key
    const apiKey = generateAgentApiKey(agent.id);
    const apiKeyEncrypted = encrypt(apiKey);
    const stmt = db.prepare(`
      INSERT INTO agents (id, name, model, provider, system_prompt, features, mcp_servers, skills, project_id, status, port, api_key_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)
    `);
    stmt.run(agent.id, agent.name, agent.model, agent.provider, agent.system_prompt, featuresJson, mcpServersJson, skillsJson, agent.project_id || null, port, apiKeyEncrypted, now, now);
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
    if (updates.skills !== undefined) {
      fields.push("skills = ?");
      values.push(JSON.stringify(updates.skills));
    }
    if (updates.project_id !== undefined) {
      fields.push("project_id = ?");
      values.push(updates.project_id);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      db.run(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  // Find agents by project
  findByProject(projectId: string | null): Agent[] {
    if (projectId === null) {
      const rows = db.query("SELECT * FROM agents WHERE project_id IS NULL ORDER BY created_at DESC").all() as AgentRow[];
      return rows.map(rowToAgent);
    }
    const rows = db.query("SELECT * FROM agents WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as AgentRow[];
    return rows.map(rowToAgent);
  },

  // Find agents that have a specific skill
  findBySkill(skillId: string): Agent[] {
    // SQLite JSON query: check if skills array contains the skillId
    const rows = db.query(
      `SELECT * FROM agents WHERE skills LIKE ? ORDER BY created_at DESC`
    ).all(`%"${skillId}"%`) as AgentRow[];
    return rows.map(rowToAgent);
  },

  // Delete agent
  delete(id: string): boolean {
    const result = db.run("DELETE FROM agents WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Set agent status (port is permanently assigned, don't change it)
  setStatus(id: string, status: "stopped" | "running"): Agent | null {
    return this.update(id, { status });
  },

  // Reset all agents to stopped (on server restart) - keep ports as they're permanent
  resetAllStatus(): void {
    db.run("UPDATE agents SET status = 'stopped'");
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

  // Get decrypted API key for an agent
  getApiKey(id: string): string | null {
    const agent = this.findById(id);
    if (!agent || !agent.api_key_encrypted) {
      return null;
    }
    try {
      return decrypt(agent.api_key_encrypted);
    } catch {
      return null;
    }
  },

  // Regenerate API key for an agent
  regenerateApiKey(id: string): string | null {
    const agent = this.findById(id);
    if (!agent) return null;

    const newApiKey = generateAgentApiKey(id);
    const encrypted = encrypt(newApiKey);
    const now = new Date().toISOString();

    db.run(
      "UPDATE agents SET api_key_encrypted = ?, updated_at = ? WHERE id = ?",
      [encrypted, now, id]
    );

    return newApiKey;
  },

  // Ensure agent has an API key (for migration of existing agents)
  ensureApiKey(id: string): string | null {
    const agent = this.findById(id);
    if (!agent) return null;

    // If agent already has a key, return it
    if (agent.api_key_encrypted) {
      try {
        return decrypt(agent.api_key_encrypted);
      } catch {
        // Key is corrupted, regenerate
      }
    }

    // Generate new key for agents without one
    return this.regenerateApiKey(id);
  },
};

// Project CRUD operations
export const ProjectDB = {
  // Create a new project
  create(project: { name: string; description?: string | null; color?: string }): Project {
    const id = generateId();
    const now = new Date().toISOString();
    const color = project.color || "#6366f1";

    db.run(
      `INSERT INTO projects (id, name, description, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, project.name, project.description || null, color, now, now]
    );

    return this.findById(id)!;
  },

  // Find project by ID
  findById(id: string): Project | null {
    const row = db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null;
    return row ? rowToProject(row) : null;
  },

  // Get all projects
  findAll(): Project[] {
    const rows = db.query("SELECT * FROM projects ORDER BY name ASC").all() as ProjectRow[];
    return rows.map(rowToProject);
  },

  // Update project
  update(id: string, updates: Partial<Omit<Project, "id" | "created_at">>): Project | null {
    const project = this.findById(id);
    if (!project) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description);
    }
    if (updates.color !== undefined) {
      fields.push("color = ?");
      values.push(updates.color);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  // Delete project (agents will have project_id set to NULL)
  delete(id: string): boolean {
    const result = db.run("DELETE FROM projects WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Count projects
  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM projects").get() as { count: number };
    return row.count;
  },

  // Get agent count per project
  getAgentCounts(): Map<string | null, number> {
    const rows = db.query(`
      SELECT project_id, COUNT(*) as count
      FROM agents
      GROUP BY project_id
    `).all() as { project_id: string | null; count: number }[];

    const counts = new Map<string | null, number>();
    for (const row of rows) {
      counts.set(row.project_id, row.count);
    }
    return counts;
  },
};

// Helper to convert DB row to Project type
function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

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
  let skills: string[] = [];
  if (row.skills) {
    try {
      skills = JSON.parse(row.skills);
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
    skills,
    project_id: row.project_id,
    api_key_encrypted: row.api_key_encrypted,
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
    // Encrypt env vars and headers (credentials) before storing
    const envEncrypted = encryptObject(server.env || {});
    const headersEncrypted = encryptObject(server.headers || {});
    const stmt = db.prepare(`
      INSERT INTO mcp_servers (id, name, type, package, command, args, env, url, headers, source, status, port, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', NULL, ?)
    `);
    stmt.run(
      server.id, server.name, server.type, server.package, server.command, server.args,
      envEncrypted, server.url || null, headersEncrypted, server.source || null, now
    );
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
    if (updates.url !== undefined) {
      fields.push("url = ?");
      values.push(updates.url);
    }
    if (updates.headers !== undefined) {
      fields.push("headers = ?");
      // Encrypt headers (may contain auth tokens) before storing
      values.push(encryptObject(updates.headers));
    }
    if (updates.source !== undefined) {
      fields.push("source = ?");
      values.push(updates.source);
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
  // Decrypt env vars and headers (handles both encrypted and legacy unencrypted data)
  const env = row.env ? decryptObject(row.env) : {};
  const headers = row.headers ? decryptObject(row.headers) : {};
  return {
    id: row.id,
    name: row.name,
    type: row.type as McpServer["type"],
    package: row.package,
    command: row.command,
    args: row.args,
    env,
    url: row.url,
    headers,
    port: row.port,
    status: row.status as "stopped" | "running",
    source: row.source,
    created_at: row.created_at,
  };
}

// Telemetry Event types
// User types
export interface User {
  id: string;
  username: string;
  password_hash: string;
  email: string | null; // Optional, for password recovery only
  role: "admin" | "user";
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  email: string | null;
  role: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface Session {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  created_at: string;
}

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
    project_id?: string | null; // Filter by project (null = unassigned agents)
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
      conditions.push("t.agent_id = ?");
      params.push(filters.agent_id);
    }
    if (filters.project_id !== undefined) {
      if (filters.project_id === null) {
        conditions.push("a.project_id IS NULL");
      } else {
        conditions.push("a.project_id = ?");
        params.push(filters.project_id);
      }
    }
    if (filters.category) {
      conditions.push("t.category = ?");
      params.push(filters.category);
    }
    if (filters.level) {
      conditions.push("t.level = ?");
      params.push(filters.level);
    }
    if (filters.trace_id) {
      conditions.push("t.trace_id = ?");
      params.push(filters.trace_id);
    }
    if (filters.since) {
      conditions.push("t.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push("t.timestamp <= ?");
      params.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    // Join with agents table when filtering by project
    const needsJoin = filters.project_id !== undefined;
    const sql = needsJoin
      ? `SELECT t.* FROM telemetry_events t JOIN agents a ON t.agent_id = a.id ${where} ORDER BY t.timestamp DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM telemetry_events t ${where} ORDER BY t.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.query(sql).all(...params) as TelemetryEventRow[];
    return rows.map(rowToTelemetryEvent);
  },

  // Get usage stats
  getUsage(filters: {
    agent_id?: string;
    project_id?: string | null;
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
    const needsJoin = filters.project_id !== undefined;

    if (filters.agent_id) {
      conditions.push("t.agent_id = ?");
      params.push(filters.agent_id);
    }
    if (filters.project_id !== undefined) {
      if (filters.project_id === null) {
        conditions.push("a.project_id IS NULL");
      } else {
        conditions.push("a.project_id = ?");
        params.push(filters.project_id);
      }
    }
    if (filters.since) {
      conditions.push("t.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until) {
      conditions.push("t.timestamp <= ?");
      params.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let groupBy = "";
    let selectFields = "";

    if (filters.group_by === "day") {
      groupBy = "GROUP BY date(t.timestamp)";
      selectFields = "date(t.timestamp) as date,";
    } else if (filters.group_by === "agent") {
      groupBy = "GROUP BY t.agent_id";
      selectFields = "t.agent_id as agent_id,";
    }

    const fromClause = needsJoin
      ? "FROM telemetry_events t JOIN agents a ON t.agent_id = a.id"
      : "FROM telemetry_events t";

    const sql = `
      SELECT
        ${selectFields}
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN json_extract(t.data, '$.input_tokens') ELSE 0 END), 0) as input_tokens,
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN json_extract(t.data, '$.output_tokens') ELSE 0 END), 0) as output_tokens,
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN 1 ELSE 0 END), 0) as llm_calls,
        COALESCE(SUM(CASE WHEN t.category = 'TOOL' THEN 1 ELSE 0 END), 0) as tool_calls,
        COALESCE(SUM(CASE WHEN t.level = 'error' THEN 1 ELSE 0 END), 0) as errors
      ${fromClause}
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
  getStats(filters: { agentId?: string; projectId?: string | null } = {}): {
    total_events: number;
    total_llm_calls: number;
    total_tool_calls: number;
    total_errors: number;
    total_input_tokens: number;
    total_output_tokens: number;
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const needsJoin = filters.projectId !== undefined;

    if (filters.agentId) {
      conditions.push("t.agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.projectId !== undefined) {
      if (filters.projectId === null) {
        conditions.push("a.project_id IS NULL");
      } else {
        conditions.push("a.project_id = ?");
        params.push(filters.projectId);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const fromClause = needsJoin
      ? "FROM telemetry_events t JOIN agents a ON t.agent_id = a.id"
      : "FROM telemetry_events t";

    const sql = `
      SELECT
        COUNT(*) as total_events,
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN 1 ELSE 0 END), 0) as total_llm_calls,
        COALESCE(SUM(CASE WHEN t.category = 'TOOL' THEN 1 ELSE 0 END), 0) as total_tool_calls,
        COALESCE(SUM(CASE WHEN t.level = 'error' THEN 1 ELSE 0 END), 0) as total_errors,
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN json_extract(t.data, '$.input_tokens') ELSE 0 END), 0) as total_input_tokens,
        COALESCE(SUM(CASE WHEN t.category = 'LLM' THEN json_extract(t.data, '$.output_tokens') ELSE 0 END), 0) as total_output_tokens
      ${fromClause}
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

// User operations
export const UserDB = {
  // Create a new user
  create(user: { username: string; password_hash: string; email?: string | null; role?: "admin" | "user" }): User {
    const id = generateId();
    const now = new Date().toISOString();
    const role = user.role || "user";

    db.run(
      `INSERT INTO users (id, username, password_hash, email, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, user.username.toLowerCase(), user.password_hash, user.email || null, role, now, now]
    );

    return this.findById(id)!;
  },

  // Find user by ID
  findById(id: string): User | null {
    const row = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
    return row ? rowToUser(row) : null;
  },

  // Find user by username
  findByUsername(username: string): User | null {
    const row = db.query("SELECT * FROM users WHERE username = ?").get(username.toLowerCase()) as UserRow | null;
    return row ? rowToUser(row) : null;
  },

  // Find user by email (for password recovery)
  findByEmail(email: string): User | null {
    const row = db.query("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | null;
    return row ? rowToUser(row) : null;
  },

  // Get all users
  findAll(): User[] {
    const rows = db.query("SELECT * FROM users ORDER BY created_at DESC").all() as UserRow[];
    return rows.map(rowToUser);
  },

  // Update user
  update(id: string, updates: Partial<Omit<User, "id" | "created_at">>): User | null {
    const user = this.findById(id);
    if (!user) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.username !== undefined) {
      fields.push("username = ?");
      values.push(updates.username.toLowerCase());
    }
    if (updates.password_hash !== undefined) {
      fields.push("password_hash = ?");
      values.push(updates.password_hash);
    }
    if (updates.email !== undefined) {
      fields.push("email = ?");
      values.push(updates.email);
    }
    if (updates.role !== undefined) {
      fields.push("role = ?");
      values.push(updates.role);
    }
    if (updates.last_login_at !== undefined) {
      fields.push("last_login_at = ?");
      values.push(updates.last_login_at);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      db.run(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  // Delete user
  delete(id: string): boolean {
    const result = db.run("DELETE FROM users WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Update last login
  updateLastLogin(id: string): void {
    db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [new Date().toISOString(), id]);
  },

  // Count users
  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
    return row.count;
  },

  // Check if any users exist
  hasUsers(): boolean {
    return this.count() > 0;
  },

  // Count admins
  countAdmins(): number {
    const row = db.query("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number };
    return row.count;
  },
};

// Helper to convert DB row to User type
function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    email: row.email,
    role: row.role as "admin" | "user",
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

// Session operations
export const SessionDB = {
  // Create a new session
  create(session: { user_id: string; refresh_token_hash: string; expires_at: string }): Session {
    const id = generateId();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, session.user_id, session.refresh_token_hash, session.expires_at, now]
    );

    return this.findById(id)!;
  },

  // Find session by ID
  findById(id: string): Session | null {
    const row = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row ? rowToSession(row) : null;
  },

  // Find session by refresh token hash
  findByTokenHash(tokenHash: string): Session | null {
    const row = db.query("SELECT * FROM sessions WHERE refresh_token_hash = ?").get(tokenHash) as SessionRow | null;
    return row ? rowToSession(row) : null;
  },

  // Get all sessions for a user
  findByUser(userId: string): Session[] {
    const rows = db.query("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC").all(userId) as SessionRow[];
    return rows.map(rowToSession);
  },

  // Delete session
  delete(id: string): boolean {
    const result = db.run("DELETE FROM sessions WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Delete session by token hash
  deleteByTokenHash(tokenHash: string): boolean {
    const result = db.run("DELETE FROM sessions WHERE refresh_token_hash = ?", [tokenHash]);
    return result.changes > 0;
  },

  // Delete all sessions for a user
  deleteByUser(userId: string): number {
    const result = db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    return result.changes;
  },

  // Delete expired sessions
  deleteExpired(): number {
    const result = db.run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]);
    return result.changes;
  },

  // Check if session is valid (exists and not expired)
  isValid(id: string): boolean {
    const session = this.findById(id);
    if (!session) return false;
    return new Date(session.expires_at) > new Date();
  },
};

// Helper to convert DB row to Session type
function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    user_id: row.user_id,
    refresh_token_hash: row.refresh_token_hash,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

// Skill operations
export const SkillDB = {
  // Create a new skill
  create(skill: Omit<Skill, "id" | "created_at" | "updated_at">): Skill {
    const id = generateId();
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(skill.metadata || {});
    const allowedToolsJson = JSON.stringify(skill.allowed_tools || []);

    db.run(
      `INSERT INTO skills (id, name, description, content, version, license, compatibility, metadata, allowed_tools, source, source_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        skill.name,
        skill.description,
        skill.content,
        skill.version || "1.0.0",
        skill.license || null,
        skill.compatibility || null,
        metadataJson,
        allowedToolsJson,
        skill.source,
        skill.source_url || null,
        skill.enabled ? 1 : 0,
        now,
        now,
      ]
    );

    return this.findById(id)!;
  },

  // Find skill by ID
  findById(id: string): Skill | null {
    const row = db.query("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | null;
    return row ? rowToSkill(row) : null;
  },

  // Find skill by name
  findByName(name: string): Skill | null {
    const row = db.query("SELECT * FROM skills WHERE name = ?").get(name) as SkillRow | null;
    return row ? rowToSkill(row) : null;
  },

  // Get all skills
  findAll(): Skill[] {
    const rows = db.query("SELECT * FROM skills ORDER BY name ASC").all() as SkillRow[];
    return rows.map(rowToSkill);
  },

  // Get enabled skills
  findEnabled(): Skill[] {
    const rows = db.query("SELECT * FROM skills WHERE enabled = 1 ORDER BY name ASC").all() as SkillRow[];
    return rows.map(rowToSkill);
  },

  // Update skill
  update(id: string, updates: Partial<Omit<Skill, "id" | "created_at">>): Skill | null {
    const skill = this.findById(id);
    if (!skill) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description);
    }
    if (updates.content !== undefined) {
      fields.push("content = ?");
      values.push(updates.content);
    }
    if (updates.version !== undefined) {
      fields.push("version = ?");
      values.push(updates.version);
    }
    if (updates.license !== undefined) {
      fields.push("license = ?");
      values.push(updates.license);
    }
    if (updates.compatibility !== undefined) {
      fields.push("compatibility = ?");
      values.push(updates.compatibility);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.allowed_tools !== undefined) {
      fields.push("allowed_tools = ?");
      values.push(JSON.stringify(updates.allowed_tools));
    }
    if (updates.source !== undefined) {
      fields.push("source = ?");
      values.push(updates.source);
    }
    if (updates.source_url !== undefined) {
      fields.push("source_url = ?");
      values.push(updates.source_url);
    }
    if (updates.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(updates.enabled ? 1 : 0);
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      db.run(`UPDATE skills SET ${fields.join(", ")} WHERE id = ?`, values);
    }

    return this.findById(id);
  },

  // Toggle skill enabled/disabled
  setEnabled(id: string, enabled: boolean): Skill | null {
    return this.update(id, { enabled });
  },

  // Delete skill
  delete(id: string): boolean {
    const result = db.run("DELETE FROM skills WHERE id = ?", [id]);
    return result.changes > 0;
  },

  // Count skills
  count(): number {
    const row = db.query("SELECT COUNT(*) as count FROM skills").get() as { count: number };
    return row.count;
  },

  // Count enabled skills
  countEnabled(): number {
    const row = db.query("SELECT COUNT(*) as count FROM skills WHERE enabled = 1").get() as { count: number };
    return row.count;
  },

  // Check if skill with name exists
  exists(name: string): boolean {
    const row = db.query("SELECT COUNT(*) as count FROM skills WHERE name = ?").get(name) as { count: number };
    return row.count > 0;
  },
};

// Helper to convert DB row to Skill type
function rowToSkill(row: SkillRow): Skill {
  let metadata: Record<string, string> = {};
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      // Use empty object if parsing fails
    }
  }
  let allowed_tools: string[] = [];
  if (row.allowed_tools) {
    try {
      allowed_tools = JSON.parse(row.allowed_tools);
    } catch {
      // Use empty array if parsing fails
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    version: row.version || "1.0.0",
    license: row.license,
    compatibility: row.compatibility,
    metadata,
    allowed_tools,
    source: row.source as Skill["source"],
    source_url: row.source_url,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Generate unique ID
export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}
