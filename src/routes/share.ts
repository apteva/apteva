import { createHash } from "crypto";
import { AgentDB, type Agent } from "../db";
import { agentFetch } from "./api/agent-utils";

function deriveShareToken(apiKey: string, agentId: string): string {
  return createHash("sha256")
    .update(apiKey + ":" + agentId + ":share")
    .digest("hex")
    .substring(0, 32);
}

function findAgentByShareToken(token: string): Agent | null {
  const agents = AgentDB.findAll();
  for (const agent of agents) {
    const apiKey = AgentDB.getApiKey(agent.id);
    if (!apiKey) continue;
    if (deriveShareToken(apiKey, agent.id) === token) return agent;
  }
  return null;
}

/** Get the share token for an agent (used by API route for the UI) */
export function getShareToken(agentId: string): string | null {
  const apiKey = AgentDB.getApiKey(agentId);
  if (!apiKey) return null;
  return deriveShareToken(apiKey, agentId);
}

export async function handleShareRequest(req: Request, path: string): Promise<Response | null> {
  // Match /share/<32 hex chars> sub-paths for API calls
  const infoMatch = path.match(/^\/share\/([a-f0-9]{32})\/info$/);
  const chatMatch = path.match(/^\/share\/([a-f0-9]{32})\/chat$/);

  if (!infoMatch && !chatMatch) return null;

  const token = (infoMatch || chatMatch)![1];
  const agent = findAgentByShareToken(token);

  // Intentionally vague 404 — don't reveal whether token exists
  if (!agent) {
    return new Response("Not found", { status: 404 });
  }

  // GET /share/:token/info — agent info (no secrets)
  if (infoMatch && req.method === "GET") {
    return Response.json({
      name: agent.name,
      status: agent.status,
    });
  }

  // POST /share/:token/chat — proxy to agent
  if (chatMatch && req.method === "POST") {
    if (agent.status !== "running" || !agent.port) {
      return Response.json({ error: "Agent is currently offline" }, { status: 503 });
    }

    try {
      const body = await req.json();
      const response = await agentFetch(agent.id, agent.port, "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return Response.json({ error: `Agent error: ${errorText}` }, { status: response.status });
      }

      return new Response(response.body, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (err) {
      return Response.json({ error: "Failed to connect to agent" }, { status: 500 });
    }
  }

  return null;
}
