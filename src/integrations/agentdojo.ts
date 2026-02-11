// AgentDojo Integration Provider
// Connects to our hosted MCP API

import type {
  IntegrationProvider,
  IntegrationApp,
  ConnectedAccount,
  ConnectionRequest,
  ConnectionCredentials,
} from "./index";

// AgentDojo MCP API base URL
const AGENTDOJO_API_BASE = process.env.AGENTDOJO_API_BASE || "https://api.agentdojo.dev";

// Map MCP API provider_type to IntegrationApp authSchemes
function mapAuthSchemes(providerType: string): string[] {
  switch (providerType) {
    case "oauth": return ["OAUTH2"];
    case "api_key": return ["API_KEY"];
    case "basic_auth": return ["BASIC"];
    case "none": return ["NONE"];
    default: return ["API_KEY"];
  }
}

export const AgentDojoProvider: IntegrationProvider = {
  id: "agentdojo",
  name: "AgentDojo",

  // List toolkits + providers from MCP API, merge so we get both
  // no-auth toolkits AND OAuth/API key providers
  async listApps(apiKey: string): Promise<IntegrationApp[]> {
    const headers = { "X-API-Key": apiKey, "Content-Type": "application/json" };

    // Fetch both in parallel
    const [toolkitsRes, providersRes] = await Promise.all([
      fetch(`${AGENTDOJO_API_BASE}/toolkits?include_tools=true`, { headers }).catch(() => null),
      fetch(`${AGENTDOJO_API_BASE}/providers?is_active=true`, { headers }).catch(() => null),
    ]);

    // Parse toolkits
    let toolkits: any[] = [];
    if (toolkitsRes?.ok) {
      const data = await toolkitsRes.json();
      toolkits = data.toolkits || data.data || [];
    } else if (toolkitsRes) {
      console.error("AgentDojo listApps toolkits error:", toolkitsRes.status);
    }

    // Parse providers (for auth type info)
    let providers: any[] = [];
    if (providersRes?.ok) {
      const data = await providersRes.json();
      providers = data.providers || data.data || [];
    } else if (providersRes) {
      console.error("AgentDojo listApps providers error:", providersRes.status);
    }

    // Index providers by name for quick lookup
    const providerByName = new Map<string, any>();
    for (const p of providers) {
      providerByName.set(p.name, p);
      if (p.display_name) providerByName.set(p.display_name.toLowerCase(), p);
    }

    // Map toolkits to apps, enriching auth info from providers
    const apps: IntegrationApp[] = toolkits.map((toolkit: any) => {
      const name = toolkit.name || toolkit.slug;
      // Try to find matching provider for this toolkit
      const provider = providerByName.get(name) || providerByName.get(name?.toLowerCase());

      let authSchemes: string[];
      if (provider) {
        authSchemes = mapAuthSchemes(provider.provider_type);
      } else if (toolkit.requires_auth) {
        authSchemes = ["API_KEY"]; // Default if no provider found but auth required
      } else {
        authSchemes = ["NONE"];
      }

      return {
        id: String(toolkit.id),
        name: toolkit.display_name || toolkit.name,
        slug: name,
        description: toolkit.description || null,
        logo: provider?.favicon || toolkit.icon_url || null,
        categories: [],
        authSchemes,
      };
    });

    // Also add any providers that don't match a toolkit (standalone OAuth providers)
    const toolkitNames = new Set(toolkits.map((t: any) => t.name));
    for (const p of providers) {
      if (!toolkitNames.has(p.name)) {
        apps.push({
          id: String(p.id),
          name: p.display_name || p.name,
          slug: p.name,
          description: p.description || null,
          logo: p.favicon || p.icon_url || null,
          categories: [],
          authSchemes: mapAuthSchemes(p.provider_type),
        });
      }
    }

    return apps;
  },

  // List user's credentials
  async listConnectedAccounts(apiKey: string, userId: string): Promise<ConnectedAccount[]> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials`, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("AgentDojo listConnectedAccounts error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const credentials = data.data || data.credentials || [];

    return credentials.map((cred: any) => ({
      id: String(cred.id),
      appId: cred.provider_name || cred.toolkit_name || String(cred.provider_id || cred.toolkit_id),
      appName: cred.provider_name || cred.name || cred.toolkit_name || String(cred.provider_id),
      status: (cred.status === "active" || cred.is_valid !== false) ? "active" as const : "failed" as const,
      createdAt: cred.created_at || new Date().toISOString(),
      metadata: {
        keyHint: cred.key_hint,
        credentialType: cred.credential_type,
      },
    }));
  },

  // Initiate connection — OAuth (popup redirect) or API key (direct store)
  async initiateConnection(
    apiKey: string,
    userId: string,
    appSlug: string,
    redirectUrl: string,
    credentials?: ConnectionCredentials
  ): Promise<ConnectionRequest> {
    // OAuth flow: no credentials provided, or explicit OAUTH2 scheme
    if (!credentials?.apiKey) {
      // Init OAuth via MCP API
      const res = await fetch(`${AGENTDOJO_API_BASE}/oauth/init`, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider_name: appSlug,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("AgentDojo OAuth init error:", res.status, text);
        throw new Error(`Failed to initiate OAuth: ${text}`);
      }

      const data = await res.json();
      const flowData = data.data || data;

      if (!flowData.auth_url) {
        throw new Error("No auth URL returned from OAuth init");
      }

      return {
        redirectUrl: flowData.auth_url,
        connectionId: flowData.state_token || flowData.state || flowData.flow_id,
        status: "pending",
      };
    }

    // API key flow: store credential directly
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials`, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider_id: appSlug,
        provider_name: appSlug,
        credential_data: { api_key: credentials.apiKey },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("AgentDojo credential create error:", res.status, text);
      throw new Error(`Failed to store credentials: ${text}`);
    }

    const data = await res.json();

    return {
      redirectUrl: null,
      connectionId: String(data.data?.id || data.id),
      status: "active",
    };
  },

  // Check connection/OAuth flow status
  async getConnectionStatus(apiKey: string, connectionId: string): Promise<ConnectedAccount | null> {
    // First try OAuth status poll (connectionId = state_token)
    const oauthRes = await fetch(`${AGENTDOJO_API_BASE}/oauth/status?state=${encodeURIComponent(connectionId)}`, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (oauthRes.ok) {
      const oauthData = await oauthRes.json();
      const status = oauthData.data?.status || oauthData.status;

      if (status === "completed") {
        return {
          id: connectionId,
          appId: oauthData.data?.provider_name || oauthData.data?.provider_id || "",
          appName: oauthData.data?.provider_name || "",
          status: "active",
          createdAt: new Date().toISOString(),
        };
      } else if (status === "failed") {
        return {
          id: connectionId,
          appId: oauthData.data?.provider_name || "",
          appName: oauthData.data?.provider_name || "",
          status: "failed",
          createdAt: new Date().toISOString(),
        };
      } else if (status === "pending") {
        return null; // Still waiting
      }
    }

    // Fallback: check credentials list directly (for API key connections)
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials`, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const credentials = data.data || data.credentials || [];
    const cred = credentials.find((c: any) => String(c.id) === connectionId);

    if (!cred) return null;

    return {
      id: String(cred.id),
      appId: String(cred.provider_id || cred.toolkit_id),
      appName: cred.provider_name || cred.name || String(cred.provider_id),
      status: "active",
      createdAt: cred.created_at || new Date().toISOString(),
    };
  },

  async disconnect(apiKey: string, connectionId: string): Promise<boolean> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials/${connectionId}`, {
      method: "DELETE",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    return res.ok;
  },
};

// ============ AgentDojo MCP Server Management ============

export interface AgentDojoServer {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  tools: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  isActive: boolean;
  createdAt: string;
}

export interface AgentDojoToolkit {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  iconUrl: string | null;
  toolsCount: number;
  tools?: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
  }>;
  status: string;
  requiresAuth: boolean;
}

// List available toolkits
export async function listToolkits(apiKey: string, includeTools = false): Promise<AgentDojoToolkit[]> {
  const res = await fetch(
    `${AGENTDOJO_API_BASE}/toolkits?include_tools=${includeTools}`,
    {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    console.error("Failed to list AgentDojo toolkits:", await res.text());
    return [];
  }

  const data = await res.json();
  const toolkits = data.toolkits || [];

  return toolkits.map((t: any) => ({
    id: t.id,
    name: t.name,
    displayName: t.display_name || t.name,
    description: t.description,
    iconUrl: t.icon_url,
    toolsCount: t.tools_count || t.tools?.length || 0,
    tools: t.tools?.map((tool: any) => ({
      id: tool.id,
      name: tool.name,
      displayName: tool.display_name || tool.name,
      description: tool.description,
    })),
    status: t.status || "active",
    requiresAuth: t.requires_auth || false,
  }));
}

// List user's MCP servers (configs)
export async function listServers(apiKey: string, includeTools = false): Promise<AgentDojoServer[]> {
  const res = await fetch(
    `${AGENTDOJO_API_BASE}/servers?include_tools=${includeTools}`,
    {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    console.error("Failed to list AgentDojo servers:", await res.text());
    return [];
  }

  const data = await res.json();
  const servers = data.data || [];

  return servers.map((s: any) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    url: s.url,
    tools: s.tools || [],
    isActive: s.is_active,
    createdAt: s.created_at,
  }));
}

// Create a new MCP server with selected toolkits
export async function createServer(
  apiKey: string,
  name: string,
  toolkits: string[],
  description?: string
): Promise<AgentDojoServer | null> {
  const res = await fetch(`${AGENTDOJO_API_BASE}/servers`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      toolkits,
      description,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Failed to create AgentDojo server:", errText);
    throw new Error(`Failed to create server: ${errText}`);
  }

  const data = await res.json();
  const server = data.data || data;

  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    description: server.description,
    url: server.url,
    tools: server.tools || [],
    isActive: server.is_active ?? true,
    createdAt: server.created_at,
  };
}

// Get a specific server
export async function getServer(apiKey: string, serverId: string): Promise<AgentDojoServer | null> {
  const res = await fetch(`${AGENTDOJO_API_BASE}/servers/${serverId}`, {
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    console.error("Failed to get AgentDojo server:", await res.text());
    return null;
  }

  const data = await res.json();
  const server = data.data || data;

  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    description: server.description,
    url: server.url,
    tools: server.tools || [],
    isActive: server.is_active ?? true,
    createdAt: server.created_at,
  };
}

// Delete a server
export async function deleteServer(apiKey: string, serverId: string): Promise<boolean> {
  const res = await fetch(`${AGENTDOJO_API_BASE}/servers/${serverId}`, {
    method: "DELETE",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  return res.ok;
}

// Get the base URL for constructing MCP server URLs
export function getBaseUrl(): string {
  return AGENTDOJO_API_BASE;
}
