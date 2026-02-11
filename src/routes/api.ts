import type { AuthContext } from "../auth/middleware";
import { json } from "./api/helpers";
import { handleSystemRoutes } from "./api/system";
import { handleProviderRoutes } from "./api/providers";
import { handleUserRoutes } from "./api/users";
import { handleProjectRoutes } from "./api/projects";
import { handleAgentRoutes } from "./api/agents";
import { handleMcpRoutes } from "./api/mcp";
import { handleSkillRoutes } from "./api/skills";
import { handleIntegrationRoutes } from "./api/integrations";
import { handleTriggerRoutes } from "./api/triggers";
import { handleWebhookRoutes } from "./api/webhooks";
import { handleMetaAgentRoutes } from "./api/meta-agent";
import { handleTelemetryRoutes } from "./api/telemetry";
import { handleTestRoutes } from "./api/tests";
import { handleApiKeyRoutes } from "./api/api-keys";
import { handleChannelRoutes } from "./api/channels";
import { handlePlatformMcpRequest } from "../mcp-platform";

// Re-export for backward compatibility (server.ts dynamic import)
export { startAgentProcess } from "./api/agent-utils";

export async function handleApiRequest(
  req: Request,
  path: string,
  authContext?: AuthContext,
): Promise<Response> {
  const method = req.method;

  // Built-in platform MCP server (for meta agent)
  if (path === "/api/mcp/platform" && method === "POST") {
    return handlePlatformMcpRequest(req);
  }

  return (
    (await handleWebhookRoutes(req, path, method)) ?? // Public, HMAC-verified — before auth
    (await handleSystemRoutes(req, path, method, authContext)) ??
    (await handleApiKeyRoutes(req, path, method, authContext)) ?? // Must be before provider routes to handle /api/keys/personal
    (await handleProviderRoutes(req, path, method, authContext)) ??
    (await handleUserRoutes(req, path, method, authContext)) ??
    (await handleProjectRoutes(req, path, method, authContext)) ??
    (await handleAgentRoutes(req, path, method, authContext)) ??
    (await handleMcpRoutes(req, path, method)) ??
    (await handleSkillRoutes(req, path, method)) ??
    (await handleIntegrationRoutes(req, path, method, authContext)) ??
    (await handleTriggerRoutes(req, path, method, authContext)) ??
    (await handleChannelRoutes(req, path, method)) ??
    (await handleMetaAgentRoutes(req, path, method)) ??
    (await handleTelemetryRoutes(req, path, method)) ??
    (await handleTestRoutes(req, path, method)) ??
    json({ error: "Not found" }, 404)
  );
}
