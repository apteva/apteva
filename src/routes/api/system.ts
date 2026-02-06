import { json } from "./helpers";
import { META_AGENT_ENABLED, fetchFromAgent, startAgentProcess, setAgentStatus } from "./agent-utils";
import { AgentDB } from "../../db";
import { ProviderKeys } from "../../providers";
import { agentProcesses, getBinaryStatus, BIN_DIR } from "../../server";
import {
  checkForUpdates,
  getInstalledVersion,
  getAptevaVersion,
  downloadLatestBinary,
  installViaNpm,
} from "../../binary";
import { openApiSpec } from "../../openapi";

export async function handleSystemRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: unknown,
): Promise<Response | null> {
  // GET /api/health - Health check endpoint (no auth required)
  if (path === "/api/health" && method === "GET") {
    const binaryStatus = getBinaryStatus(BIN_DIR);
    const installedVersion = getInstalledVersion();
    return json({
      status: "ok",
      version: getAptevaVersion(),
      timestamp: new Date().toISOString(),
      agents: {
        total: AgentDB.count(),
        running: AgentDB.countRunning(),
      },
      binary: {
        available: binaryStatus.exists,
        platform: binaryStatus.platform,
        arch: binaryStatus.arch,
        version: installedVersion,
      },
    });
  }

  // GET /api/features - Feature flags (no auth required)
  if (path === "/api/features" && method === "GET") {
    return json({
      projects: process.env.PROJECTS_ENABLED === "true",
      metaAgent: process.env.META_AGENT_ENABLED === "true",
    });
  }

  // GET /api/openapi - OpenAPI spec (no auth required)
  if (path === "/api/openapi" && method === "GET") {
    return json(openApiSpec);
  }

  // GET /api/stats - Get statistics
  if (path === "/api/stats" && method === "GET") {
    return json({
      totalAgents: AgentDB.count(),
      runningAgents: AgentDB.countRunning(),
    });
  }

  // GET /api/binary - Get binary status
  if (path === "/api/binary" && method === "GET") {
    return json(getBinaryStatus(BIN_DIR));
  }

  // GET /api/version - Check agent binary version info
  if (path === "/api/version" && method === "GET") {
    const versionInfo = await checkForUpdates();
    return json(versionInfo);
  }

  // POST /api/version/update - Download/install latest agent binary
  if (path === "/api/version/update" && method === "POST") {
    // Get all running agents to restart later
    const runningAgents = AgentDB.findAll().filter(a => a.status === "running");
    const agentsToRestart = runningAgents.map(a => a.id);

    // Stop all running agents
    for (const agent of runningAgents) {
      const agentProc = agentProcesses.get(agent.id);
      if (agentProc) {
        console.log(`Stopping agent ${agent.name} for update...`);
        agentProc.proc.kill();
        agentProcesses.delete(agent.id);
      }
      setAgentStatus(agent.id, "stopped", "binary_update");
    }

    // Try npm install first, fall back to direct download
    let result = await installViaNpm();
    if (!result.success) {
      // Fall back to direct download
      result = await downloadLatestBinary(BIN_DIR);
    }

    if (!result.success) {
      return json({ success: false, error: result.error }, 500);
    }

    // Restart agents that were running
    const restartResults: { id: string; name: string; success: boolean; error?: string }[] = [];
    for (const agentId of agentsToRestart) {
      const agent = AgentDB.findById(agentId);
      if (agent) {
        console.log(`Restarting agent ${agent.name} after update...`);
        const startResult = await startAgentProcess(agent);
        restartResults.push({
          id: agent.id,
          name: agent.name,
          success: startResult.success,
          error: startResult.error,
        });
      }
    }

    return json({
      success: true,
      version: result.version,
      restarted: restartResults,
    });
  }

  // GET /api/tasks - Get all tasks from all running agents
  if (path === "/api/tasks" && method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";

    const runningAgents = AgentDB.findAll().filter(a => a.status === "running" && a.port);
    const allTasks: any[] = [];

    for (const agent of runningAgents) {
      const data = await fetchFromAgent(agent.id, agent.port!, `/tasks?status=${status}`);
      if (data?.tasks) {
        // Add agent info to each task
        for (const task of data.tasks) {
          allTasks.push({
            ...task,
            agentId: agent.id,
            agentName: agent.name,
          });
        }
      }
    }

    // Sort by created_at descending
    allTasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return json({ tasks: allTasks, count: allTasks.length });
  }

  // GET /api/tasks/:agentId/:taskId - Get a single task with full details
  const singleTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/([^/]+)$/);
  if (singleTaskMatch && method === "GET") {
    const [, agentId, taskId] = singleTaskMatch;
    const agent = AgentDB.findById(agentId);

    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    if (agent.status !== "running" || !agent.port) {
      return json({ error: "Agent is not running" }, 400);
    }

    const data = await fetchFromAgent(agent.id, agent.port, `/tasks/${taskId}`);
    if (!data) {
      return json({ error: "Failed to fetch task from agent" }, 500);
    }

    return json({ task: { ...data, agentId: agent.id, agentName: agent.name } });
  }

  // GET /api/dashboard - Get dashboard statistics
  if (path === "/api/dashboard" && method === "GET") {
    const agents = AgentDB.findAll();
    const runningAgents = agents.filter(a => a.status === "running" && a.port);

    let totalTasks = 0;
    let pendingTasks = 0;
    let completedTasks = 0;
    let runningTasks = 0;

    for (const agent of runningAgents) {
      const data = await fetchFromAgent(agent.id, agent.port!, "/tasks?status=all");
      if (data?.tasks) {
        totalTasks += data.tasks.length;
        for (const task of data.tasks) {
          if (task.status === "pending") pendingTasks++;
          else if (task.status === "completed") completedTasks++;
          else if (task.status === "running") runningTasks++;
        }
      }
    }

    return json({
      agents: {
        total: agents.length,
        running: runningAgents.length,
      },
      tasks: {
        total: totalTasks,
        pending: pendingTasks,
        running: runningTasks,
        completed: completedTasks,
      },
      providers: {
        configured: ProviderKeys.getConfiguredProviders().length,
      },
    });
  }

  return null;
}
