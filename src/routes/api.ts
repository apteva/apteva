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
import { handleMetaAgentRoutes } from "./api/meta-agent";
import { handleTelemetryRoutes } from "./api/telemetry";
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
    (await handleSystemRoutes(req, path, method, authContext)) ??
    (await handleProviderRoutes(req, path, method, authContext)) ??
    (await handleUserRoutes(req, path, method, authContext)) ??
    (await handleProjectRoutes(req, path, method, authContext)) ??
    (await handleAgentRoutes(req, path, method, authContext)) ??
    (await handleMcpRoutes(req, path, method)) ??
    (await handleSkillRoutes(req, path, method)) ??
    (await handleIntegrationRoutes(req, path, method)) ??
    (await handleMetaAgentRoutes(req, path, method)) ??
    (await handleTelemetryRoutes(req, path, method)) ??
    json({ error: "Not found" }, 404)
  );
}
