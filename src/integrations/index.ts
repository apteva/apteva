// Generic Integration Provider Interface
// Allows multiple providers (Composio, Smithery, etc.) to offer OAuth app connections

export interface IntegrationApp {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  categories: string[];
  authSchemes: string[]; // e.g., ["OAUTH2", "API_KEY"]
}

export interface ConnectedAccount {
  id: string;
  appId: string;
  appName: string;
  status: "active" | "pending" | "failed" | "expired";
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConnectionRequest {
  redirectUrl: string | null; // null for API_KEY auth (no redirect needed)
  connectionId?: string;
  status?: "active" | "pending"; // API_KEY connections are immediately active
}

export interface ConnectionCredentials {
  authScheme: "OAUTH2" | "API_KEY" | "BEARER_TOKEN" | "BASIC";
  apiKey?: string;
  bearerToken?: string;
  username?: string;
  password?: string;
}

export interface IntegrationProvider {
  id: string;
  name: string;

  // List available apps/toolkits
  listApps(apiKey: string): Promise<IntegrationApp[]>;

  // List user's connected accounts
  listConnectedAccounts(apiKey: string, userId: string): Promise<ConnectedAccount[]>;

  // Initiate connection (OAuth or API Key)
  initiateConnection(
    apiKey: string,
    userId: string,
    appSlug: string,
    redirectUrl: string,
    credentials?: ConnectionCredentials
  ): Promise<ConnectionRequest>;

  // Check connection status
  getConnectionStatus(apiKey: string, connectionId: string): Promise<ConnectedAccount | null>;

  // Disconnect/revoke
  disconnect(apiKey: string, connectionId: string): Promise<boolean>;
}

// Provider registry
const providers: Map<string, IntegrationProvider> = new Map();

export function registerProvider(provider: IntegrationProvider) {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): IntegrationProvider | undefined {
  return providers.get(id);
}

export function getAllProviders(): IntegrationProvider[] {
  return Array.from(providers.values());
}

export function getProviderIds(): string[] {
  return Array.from(providers.keys());
}
