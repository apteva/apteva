// Shared types for the Apteva UI

export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  systemPrompt: string;
  status: "stopped" | "running";
  port?: number;
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
}
