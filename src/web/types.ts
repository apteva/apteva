// Shared types for the Apteva UI

export interface AgentFeatures {
  memory: boolean;
  tasks: boolean;
  vision: boolean;
  operator: boolean;
  mcp: boolean;
  realtime: boolean;
  files: boolean;
  agents: boolean;
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

export interface McpServerSummary {
  id: string;
  name: string;
  type: string;
  status: "stopped" | "running";
  port: number | null;
}

export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  systemPrompt: string;
  status: "stopped" | "running";
  port?: number;
  features: AgentFeatures;
  mcpServers: string[]; // Array of MCP server IDs
  mcpServerDetails?: McpServerSummary[]; // Full details included from API
  projectId: string | null; // Optional project grouping
  createdAt: string;
}

export interface McpServer {
  id: string;
  name: string;
  type: "npm" | "github" | "http" | "custom";
  package: string | null;
  command: string | null;
  url: string | null;
  headers: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  source: string | null; // "composio", "smithery", or null for local
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface ProviderModel {
  value: string;
  label: string;
  recommended?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  type: "llm" | "integration";
  docsUrl: string;
  description?: string;
  models: ProviderModel[];
  hasKey: boolean;
  keyHint: string | null;
  isValid: boolean | null;
  configured?: boolean; // for backwards compatibility
}

export interface OnboardingStatus {
  completed: boolean;
  providers_configured: string[];
  has_any_keys: boolean;
}

export type Route = "dashboard" | "agents" | "tasks" | "mcp" | "telemetry" | "settings" | "api";

export interface Task {
  id: string;
  title: string;
  description?: string;
  type: "once" | "recurring";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  priority: number;
  source: "local" | "delegated";
  created_at: string;
  execute_at?: string;
  executed_at?: string;
  recurrence?: string;
  next_run?: string;
  result?: any;
  agentId: string;
  agentName: string;
}

export interface DashboardStats {
  agents: {
    total: number;
    running: number;
  };
  tasks: {
    total: number;
    pending: number;
    running: number;
    completed: number;
  };
  providers: {
    configured: number;
  };
}

export interface NewAgentForm {
  name: string;
  model: string;
  provider: string;
  systemPrompt: string;
  features: AgentFeatures;
  mcpServers: string[];
  projectId?: string | null;
}
