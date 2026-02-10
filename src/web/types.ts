// Shared types for the Apteva UI

export type AgentMode = "coordinator" | "worker";

export interface MultiAgentConfig {
  enabled: boolean;
  mode?: AgentMode;
  group?: string; // Defaults to projectId if not specified
}

export interface AgentBuiltinTools {
  webSearch: boolean;
  webFetch: boolean;
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
  builtinTools?: AgentBuiltinTools;
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
  builtinTools: { webSearch: false, webFetch: false },
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

export interface McpServerSummary {
  id: string;
  name: string;
  type: string;
  status: "stopped" | "running";
  port: number | null;
  url?: string | null; // For HTTP servers
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
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
  skills: string[]; // Array of Skill IDs
  skillDetails?: SkillSummary[]; // Full details included from API
  projectId: string | null; // Optional project grouping
  createdAt: string;
}

export interface McpServer {
  id: string;
  name: string;
  type: "npm" | "pip" | "github" | "http" | "custom";
  package: string | null;
  pip_module: string | null;  // For pip type: module to run (e.g., "late.mcp")
  command: string | null;
  url: string | null;
  headers: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  source: string | null; // "composio", "smithery", or null for local
  project_id: string | null; // null = global, otherwise project-scoped
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

export type Route = "dashboard" | "activity" | "agents" | "tasks" | "connections" | "mcp" | "skills" | "tests" | "telemetry" | "settings" | "api";

// Tool use content block in trajectory
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Tool result content block in trajectory
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// Trajectory step from the agent API (chat message format)
export interface TaskTrajectoryStep {
  id: string;
  role: "user" | "assistant";
  content: string | Array<ToolUseBlock | ToolResultBlock>;
  created_at: string;
  model?: string;
}

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
  completed_at?: string;
  recurrence?: string;
  next_run?: string;
  result?: any;
  error?: string;
  trajectory?: TaskTrajectoryStep[];
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
  skills: string[];
  projectId?: string | null;
}
