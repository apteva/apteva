// Shared types for the Apteva UI

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
  systemPrompt: string;
  status: "stopped" | "running";
  port?: number;
  features: AgentFeatures;
  createdAt: string;
}

export interface ProviderModel {
  value: string;
  label: string;
  recommended?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  docsUrl: string;
  models: ProviderModel[];
  hasKey: boolean;
  keyHint: string | null;
  isValid: boolean | null;
}

export interface OnboardingStatus {
  completed: boolean;
  providers_configured: string[];
  has_any_keys: boolean;
}

export type Route = "dashboard" | "agents" | "settings";

export interface NewAgentForm {
  name: string;
  model: string;
  provider: string;
  systemPrompt: string;
  features: AgentFeatures;
}
