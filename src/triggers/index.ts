// Generic Trigger Provider Interface
// Allows multiple providers (Composio, AgentDojo, local, etc.) to offer trigger/webhook integrations

export interface TriggerType {
  slug: string;
  name: string;
  description: string;
  type: "webhook" | "poll";
  toolkit_slug: string;
  toolkit_name: string;
  logo: string | null;
  config_schema: Record<string, unknown>;
  payload_schema: Record<string, unknown>;
}

export interface TriggerInstance {
  id: string;
  trigger_slug: string;
  connected_account_id: string | null;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  created_at: string;
}

export interface TriggerProvider {
  id: string;
  name: string;

  // Browse available trigger types
  listTriggerTypes(apiKey: string, toolkitSlugs?: string[]): Promise<TriggerType[]>;
  getTriggerType(apiKey: string, slug: string): Promise<TriggerType | null>;

  // CRUD trigger instances (all remote)
  createTrigger(
    apiKey: string,
    slug: string,
    connectedAccountId: string,
    config?: Record<string, unknown>,
  ): Promise<{ triggerId: string }>;
  listTriggers(apiKey: string): Promise<TriggerInstance[]>;
  enableTrigger(apiKey: string, triggerId: string): Promise<boolean>;
  disableTrigger(apiKey: string, triggerId: string): Promise<boolean>;
  deleteTrigger(apiKey: string, triggerId: string): Promise<boolean>;

  // Webhook configuration
  setupWebhook(apiKey: string, webhookUrl: string): Promise<{ secret?: string }>;
  getWebhookConfig(apiKey: string): Promise<{ url: string | null; secret: string | null }>;

  // Webhook verification and parsing (each provider signs differently)
  verifyWebhook(req: Request, body: string, secret: string): boolean;
  parseWebhookPayload(body: Record<string, unknown>): {
    triggerSlug: string;
    triggerInstanceId: string | null;
    payload: Record<string, unknown>;
  };
}

// Provider registry
const triggerProviders: Map<string, TriggerProvider> = new Map();

export function registerTriggerProvider(provider: TriggerProvider) {
  triggerProviders.set(provider.id, provider);
}

export function getTriggerProvider(id: string): TriggerProvider | undefined {
  return triggerProviders.get(id);
}

export function getTriggerProviderIds(): string[] {
  return Array.from(triggerProviders.keys());
}
