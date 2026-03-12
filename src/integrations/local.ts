// Local Integration Provider - uses @apteva/integrations package for self-contained app connections
// This is an optional provider that works when @apteva/integrations is installed

import type { IntegrationProvider, IntegrationApp, ConnectedAccount, ConnectionRequest, ConnectionCredentials } from "./index";
import { IntegrationConnectionDB, McpServerDB, McpServerToolDB, generateId } from "../db";
import { encrypt, decrypt, encryptObject } from "../crypto";

// Lazy-load the integrations package (optional dependency)
let integrationsPackage: typeof import("@apteva/integrations") | null = null;

/** Reset cached package reference so next call re-imports (used after install/update) */
export function resetIntegrationsCache() {
  integrationsPackage = null;
}

async function getIntegrationsPackage() {
  if (integrationsPackage) return integrationsPackage;
  try {
    integrationsPackage = await import("@apteva/integrations");
    return integrationsPackage;
  } catch {
    return null;
  }
}

export function isIntegrationsInstalled(): boolean {
  try {
    require.resolve("@apteva/integrations");
    return true;
  } catch {
    return false;
  }
}

export function getIntegrationsVersion(): string | null {
  try {
    const pkgPath = require.resolve("@apteva/integrations/package.json");
    const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

export async function getLatestIntegrationsVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@apteva/integrations/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

// Handle OAuth callback — exchange code for tokens, activate connection, create MCP server
export async function handleOAuthCallback(
  code: string,
  encryptedState: string,
  callbackUrl: string,
): Promise<{ connectionId: string; appName: string }> {
  const pkg = await getIntegrationsPackage();
  if (!pkg) throw new Error("Integrations package not installed");

  // Decrypt state to get connectionId, appSlug, and projectId
  let state: { connectionId: string; appSlug: string; projectId?: string | null };
  try {
    state = JSON.parse(decrypt(encryptedState));
  } catch {
    throw new Error("Invalid OAuth state");
  }

  const conn = IntegrationConnectionDB.findById(state.connectionId);
  if (!conn) throw new Error("Connection not found");
  if (conn.status !== "pending") throw new Error("Connection is not pending OAuth");

  const app = pkg.getAppTemplate(state.appSlug);
  if (!app) throw new Error(`Unknown app: ${state.appSlug}`);

  // Get stored client credentials
  let clientCreds: Record<string, string>;
  try {
    clientCreds = JSON.parse(decrypt(conn.credentials));
  } catch {
    throw new Error("Failed to decrypt connection credentials");
  }

  // Exchange code for tokens
  const tokens = await pkg.exchangeCode({
    app,
    clientId: clientCreds.client_id,
    clientSecret: clientCreds.client_secret,
    redirectUri: callbackUrl,
    code,
  });

  // Build full credential object with tokens
  const fullCreds = {
    ...clientCreds,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || "",
    token_expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : "",
  };
  const encryptedCreds = encrypt(JSON.stringify(fullCreds));

  // Update connection to active
  IntegrationConnectionDB.update(state.connectionId, {
    credentials: encryptedCreds,
    status: "active",
  });

  // Create MCP server — inherit project_id from connection (set during initiateConnection)
  const mcpServerId = await createMcpServerForConnection(
    state.connectionId, state.appSlug, app.name, encryptedCreds, conn.project_id ?? state.projectId ?? null
  );
  if (mcpServerId) {
    IntegrationConnectionDB.update(state.connectionId, { mcp_server_id: mcpServerId });
  }

  return { connectionId: state.connectionId, appName: app.name };
}

// Create an MCP server from a connection + app template
async function createMcpServerForConnection(
  connectionId: string,
  appSlug: string,
  appName: string,
  credentials: string, // encrypted
  projectId: string | null,
): Promise<string | null> {
  const pkg = await getIntegrationsPackage();
  if (!pkg) return null;

  const app = pkg.getAppTemplate(appSlug);
  if (!app) return null;

  // Decrypt credentials to build MCP tools
  let creds: Record<string, string> = {};
  try {
    const decrypted = decrypt(credentials);
    creds = JSON.parse(decrypted);
  } catch {
    return null;
  }

  // Create a fake connection for the generator
  // Map flat credential keys into the ConnectionCredentials structure
  const connCreds: any = {
    api_key: creds.api_key,
    bearer_token: creds.bearer_token,
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    fields: { ...creds }, // All keys available via fields for template resolution
  };

  const fakeConn = {
    id: connectionId,
    app_slug: appSlug,
    app_name: appName,
    name: `${appName} Connection`,
    auth_type: "api_key" as const,
    credentials: connCreds,
    status: "active" as const,
    project_id: projectId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const generated = pkg.generateMcpServer(fakeConn as any, app);

  // Create the MCP server in DB
  const serverId = generateId();
  const server = McpServerDB.create({
    id: serverId,
    name: `${appName} (Local)`,
    description: `Auto-generated from ${appName} connection`,
    type: "local",
    package: null,
    pip_module: null,
    command: null,
    args: null,
    env: creds, // Store decrypted creds as env (will be re-encrypted by McpServerDB.create)
    url: null,
    headers: {},
    source: "local-integration",
    project_id: projectId,
  });

  // Create tools for this MCP server
  for (const tool of generated.tools) {
    McpServerToolDB.create({
      id: generateId(),
      server_id: serverId,
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, any>,
      handler_type: "http",
      mock_response: null,
      http_config: tool.http_config,
      code: null,
      enabled: true,
    });
  }

  // Start the server (local servers are always "running")
  McpServerDB.setStatus(serverId, "running");

  return serverId;
}

// Remove MCP server associated with a connection
function removeMcpServerForConnection(mcpServerId: string): void {
  McpServerToolDB.deleteByServer(mcpServerId);
  McpServerDB.delete(mcpServerId);
}

export const LocalIntegrationProvider: IntegrationProvider = {
  id: "local",
  name: "Local Integrations",

  async listApps(_apiKey: string): Promise<IntegrationApp[]> {
    const pkg = await getIntegrationsPackage();
    if (!pkg) return [];

    const apps = pkg.listApps();
    return apps.map(app => {
      const template = pkg.getAppTemplate(app.slug);
      const authSchemes: string[] = [];
      if (template?.auth.types.includes("oauth2")) authSchemes.push("OAUTH2");
      if (template?.auth.types.includes("api_key")) authSchemes.push("API_KEY");
      if (template?.auth.types.includes("bearer")) authSchemes.push("BEARER_TOKEN");
      if (template?.auth.types.includes("basic")) authSchemes.push("BASIC");

      // Map credential_fields from template
      const credentialFields = template?.auth.credential_fields?.map(f => ({
        name: f.name,
        description: f.description || f.label,
        required: f.required !== false,
      }));

      // Pass OAuth config for setup guidance
      const oauthConfig = template?.auth.oauth2 ? {
        setup_url: template.auth.oauth2.setup_url,
        setup_steps: template.auth.oauth2.setup_steps,
        scopes: template.auth.oauth2.scopes,
      } : undefined;

      return {
        id: app.slug,
        name: app.name,
        slug: app.slug,
        description: app.description,
        logo: template?.logo || null,
        categories: app.categories,
        authSchemes,
        credentialFields,
        oauthConfig,
      };
    });
  },

  async listConnectedAccounts(_apiKey: string, _userId: string, projectId?: string | null): Promise<ConnectedAccount[]> {
    // When projectId is set, show project-scoped + global connections
    const connections = IntegrationConnectionDB.findAll(projectId);
    return connections.map(conn => ({
      id: conn.id,
      appId: conn.app_slug,
      appName: conn.app_name,
      status: conn.status === "active" ? "active" : conn.status === "expired" ? "expired" : conn.status === "pending" ? "pending" : "failed",
      createdAt: conn.created_at,
      metadata: { projectId: conn.project_id },
    }));
  },

  async initiateConnection(
    _apiKey: string,
    _userId: string,
    appSlug: string,
    redirectUrl: string,
    credentials?: ConnectionCredentials,
    projectId?: string | null,
  ): Promise<ConnectionRequest> {
    const pkg = await getIntegrationsPackage();
    if (!pkg) throw new Error("@apteva/integrations package not installed");

    const app = pkg.getAppTemplate(appSlug);
    if (!app) throw new Error(`Unknown app: ${appSlug}`);

    // OAuth2 flow — create pending connection and return authorize URL
    if (credentials?.authScheme === "OAUTH2") {
      if (!credentials.fields?.client_id || !credentials.fields?.client_secret) {
        throw new Error("OAuth2 requires client_id and client_secret");
      }

      // Store OAuth client creds in a pending connection
      const credObj: Record<string, string> = {
        client_id: credentials.fields.client_id,
        client_secret: credentials.fields.client_secret,
      };
      const encryptedCreds = encrypt(JSON.stringify(credObj));

      const conn = IntegrationConnectionDB.create({
        app_slug: appSlug,
        app_name: app.name,
        name: `${app.name} Connection`,
        auth_type: "oauth2",
        credentials: encryptedCreds,
        status: "pending",
        mcp_server_id: null,
        project_id: projectId ?? null,
      });

      // Generate the OAuth authorization URL
      const callbackUrl = redirectUrl || `${process.env.PUBLIC_URL || ""}/api/integrations/local/oauth/callback`;
      const state = encrypt(JSON.stringify({ connectionId: conn.id, appSlug, projectId: projectId ?? null }));
      const authUrl = pkg.getAuthorizationUrl({
        app,
        clientId: credentials.fields.client_id,
        redirectUri: callbackUrl,
        state,
      });

      return {
        redirectUrl: authUrl,
        connectionId: conn.id,
        status: "pending",
      };
    }

    // API Key / Bearer Token / multi-field flow
    if (!credentials) {
      throw new Error("Credentials required for local connections");
    }

    // Build credential object — use fields for everything
    const credObj: Record<string, string> = {};
    if (credentials.apiKey) credObj.api_key = credentials.apiKey;
    if (credentials.bearerToken) credObj.bearer_token = credentials.bearerToken;
    if (credentials.fields) Object.assign(credObj, credentials.fields);

    // Encrypt and store
    const encryptedCreds = encrypt(JSON.stringify(credObj));

    const conn = IntegrationConnectionDB.create({
      app_slug: appSlug,
      app_name: app.name,
      name: `${app.name} Connection`,
      auth_type: credentials.authScheme.toLowerCase(),
      credentials: encryptedCreds,
      status: "active",
      mcp_server_id: null,
      project_id: projectId ?? null,
    });

    // Auto-generate MCP server — inherit project scope
    const mcpServerId = await createMcpServerForConnection(
      conn.id, appSlug, app.name, encryptedCreds, projectId ?? null
    );
    if (mcpServerId) {
      IntegrationConnectionDB.update(conn.id, { mcp_server_id: mcpServerId });
    }

    return {
      redirectUrl: null,
      connectionId: conn.id,
      status: "active",
    };
  },

  async getConnectionStatus(_apiKey: string, connectionId: string): Promise<ConnectedAccount | null> {
    const conn = IntegrationConnectionDB.findById(connectionId);
    if (!conn) return null;
    return {
      id: conn.id,
      appId: conn.app_slug,
      appName: conn.app_name,
      status: conn.status === "active" ? "active" : "failed",
      createdAt: conn.created_at,
    };
  },

  async disconnect(_apiKey: string, connectionId: string): Promise<boolean> {
    const conn = IntegrationConnectionDB.findById(connectionId);
    if (!conn) return false;

    // Remove auto-generated MCP server
    if (conn.mcp_server_id) {
      removeMcpServerForConnection(conn.mcp_server_id);
    }

    return IntegrationConnectionDB.delete(connectionId);
  },
};
