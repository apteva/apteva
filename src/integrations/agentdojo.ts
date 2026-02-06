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

export const AgentDojoProvider: IntegrationProvider = {
  id: "agentdojo",
  name: "AgentDojo",

  // List available toolkits as "apps"
  async listApps(apiKey: string): Promise<IntegrationApp[]> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/toolkits?include_tools=true`, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      console.error("AgentDojo listApps error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const toolkits = data.toolkits || [];

    return toolkits.map((toolkit: any) => ({
      id: toolkit.id,
      name: toolkit.display_name || toolkit.name,
      slug: toolkit.name,
      description: toolkit.description || null,
      logo: toolkit.icon_url || null,
      categories: [],
      // If toolkit requires auth, it needs API_KEY connection
      authSchemes: toolkit.requires_auth ? ["API_KEY"] : ["NONE"],
      toolsCount: toolkit.tools_count || toolkit.tools?.length || 0,
      tools: toolkit.tools || [],
    }));
  },

  // List user's credentials (stored locally, validated against toolkits)
  async listConnectedAccounts(apiKey: string, userId: string): Promise<ConnectedAccount[]> {
    // Get list of credentials from our credentials API
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
      id: cred.id,
      appId: cred.provider_id || cred.toolkit_id || cred.provider_name,
      appName: cred.provider_name || cred.toolkit_name || cred.provider_id,
      status: cred.is_valid !== false ? "active" : "failed",
      createdAt: cred.created_at || new Date().toISOString(),
      metadata: {
        keyHint: cred.key_hint,
      },
    }));
  },

  // Store credentials for a toolkit
  async initiateConnection(
    apiKey: string,
    userId: string,
    appSlug: string,
    redirectUrl: string,
    credentials?: ConnectionCredentials
  ): Promise<ConnectionRequest> {
    if (!credentials?.apiKey) {
      throw new Error("API key is required for AgentDojo connections");
    }

    // Store the credential
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials`, {
      method: "POST",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider_id: appSlug,
        provider_name: appSlug,
        api_key: credentials.apiKey,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("AgentDojo initiateConnection error:", res.status, text);
      throw new Error(`Failed to store credentials: ${text}`);
    }

    const data = await res.json();

    return {
      redirectUrl: null, // No OAuth redirect
      connectionId: data.data?.id || data.id,
      status: "active", // Credentials are immediately active
    };
  },

  async getConnectionStatus(apiKey: string, connectionId: string): Promise<ConnectedAccount | null> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/credentials`, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const credentials = data.data || data.credentials || [];
    const cred = credentials.find((c: any) => c.id === connectionId);

    if (!cred) return null;

    return {
      id: cred.id,
      appId: cred.provider_id || cred.toolkit_id,
      appName: cred.provider_name || cred.toolkit_name,
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
