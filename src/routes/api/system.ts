import { json } from "./helpers";
import { fetchFromAgent, agentFetch, startAgentProcess, setAgentStatus } from "./agent-utils";
import { AgentDB, SettingsDB } from "../../db";
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
import { resetIntegrationsCache } from "../../integrations/local";

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
        source: binaryStatus.source,
        path: binaryStatus.path,
      },
    });
  }

  // GET /api/features - Feature flags (no auth required)
  if (path === "/api/features" && method === "GET") {
    return json({
      projects: SettingsDB.getBool("projects_enabled"),
      metaAgent: SettingsDB.getBool("meta_agent_enabled"),
      costTracking: SettingsDB.getBool("cost_tracking_enabled", true),
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

    // Restart agents that were running - in parallel
    const restartResults = await Promise.all(
      agentsToRestart.map(async (agentId) => {
        const agent = AgentDB.findById(agentId);
        if (!agent) return null;
        console.log(`Restarting agent ${agent.name} after update...`);
        const startResult = await startAgentProcess(agent);
        return { id: agent.id, name: agent.name, success: startResult.success, error: startResult.error };
      })
    ).then(r => r.filter(Boolean));

    return json({
      success: true,
      version: result.version,
      restarted: restartResults,
    });
  }

  // POST /api/version/install-integrations - Install or update @apteva/integrations
  if (path === "/api/version/install-integrations" && method === "POST") {
    try {
      const { readFileSync, existsSync, rmSync } = await import("fs");
      const { join, resolve } = await import("path");
      const projectRoot = resolve(import.meta.dir, "../../..");

      // Remove cached package to force fresh install
      const cachedDir = join(projectRoot, "node_modules", "@apteva", "integrations");
      if (existsSync(cachedDir)) {
        rmSync(cachedDir, { recursive: true, force: true });
      }

      console.log(`[install-integrations] Installing in ${projectRoot}`);
      const proc = Bun.spawn(["npm", "install", "@apteva/integrations@latest", "--save"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, npm_config_cache: "/tmp/npm-cache-" + Date.now() },
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      console.log(`[install-integrations] exit=${exitCode} stdout=${stdout.substring(0, 200)}`);

      if (exitCode !== 0) {
        console.error(`[install-integrations] stderr=${stderr}`);
        return json({ success: false, error: stderr || "Install failed" }, 500);
      }

      // Read installed version
      let version: string | null = null;
      try {
        const pkgPath = join(projectRoot, "node_modules", "@apteva", "integrations", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        version = pkg.version;
      } catch (e) {
        console.error(`[install-integrations] Failed to read version:`, e);
      }

      // Reset cached import so next API call picks up the new package
      resetIntegrationsCache();

      return json({ success: true, version, output: stdout });
    } catch (err) {
      return json({ success: false, error: `Install failed: ${err}` }, 500);
    }
  }

  // GET /api/tasks - Get all tasks from all running agents
  if (path === "/api/tasks" && method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "all";
    const projectId = url.searchParams.get("project_id");

    let runningAgents = AgentDB.findAll().filter(a => a.status === "running" && a.port);

    // Filter agents by project if requested
    if (projectId === "unassigned") {
      runningAgents = runningAgents.filter(a => !a.project_id);
    } else if (projectId) {
      runningAgents = runningAgents.filter(a => a.project_id === projectId);
    }

    const allTasks: any[] = [];

    // Fetch tasks from all agents in parallel
    const results = await Promise.all(
      runningAgents.map(async (agent) => {
        try {
          const data = await fetchFromAgent(agent.id, agent.port!, `/tasks?status=${status}`);
          return { agent, tasks: data?.tasks || [] };
        } catch {
          return { agent, tasks: [] };
        }
      })
    );

    for (const { agent, tasks } of results) {
      for (const task of tasks) {
        allTasks.push({ ...task, agentId: agent.id, agentName: agent.name });
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

  // POST /api/tasks/:agentId/:taskId/execute - Execute a task immediately
  const executeTaskMatch = path.match(/^\/api\/tasks\/([^/]+)\/([^/]+)\/execute$/);
  if (executeTaskMatch && method === "POST") {
    const [, agentId, taskId] = executeTaskMatch;
    const agent = AgentDB.findById(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const res = await agentFetch(agentId, agent.port, `/tasks/${taskId}/execute`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.error || `HTTP ${res.status}` }, res.status);
      return json(data);
    } catch (err) {
      return json({ error: `Failed to execute task: ${err}` }, 500);
    }
  }

  // POST /api/tasks/:agentId - Create a task on an agent
  const createTaskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (createTaskMatch && method === "POST") {
    const agentId = createTaskMatch[1];
    const agent = AgentDB.findById(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const body = await req.json();
      const res = await agentFetch(agentId, agent.port, "/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.error || `HTTP ${res.status}` }, res.status);
      return json(data, 201);
    } catch (err) {
      return json({ error: `Failed to create task: ${err}` }, 500);
    }
  }

  // PUT /api/tasks/:agentId/:taskId - Update a task on an agent
  if (singleTaskMatch && method === "PUT") {
    const [, agentId, taskId] = singleTaskMatch;
    const agent = AgentDB.findById(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const body = await req.json();
      const res = await agentFetch(agentId, agent.port, `/tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.error || `HTTP ${res.status}` }, res.status);
      return json(data);
    } catch (err) {
      return json({ error: `Failed to update task: ${err}` }, 500);
    }
  }

  // DELETE /api/tasks/:agentId/:taskId - Delete a task on an agent
  if (singleTaskMatch && method === "DELETE") {
    const [, agentId, taskId] = singleTaskMatch;
    const agent = AgentDB.findById(agentId);
    if (!agent) return json({ error: "Agent not found" }, 404);
    if (agent.status !== "running" || !agent.port) return json({ error: "Agent is not running" }, 400);

    try {
      const res = await agentFetch(agentId, agent.port, `/tasks/${taskId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!res.ok) return json({ error: data.error || `HTTP ${res.status}` }, res.status);
      return json(data);
    } catch (err) {
      return json({ error: `Failed to delete task: ${err}` }, 500);
    }
  }

  // GET /api/dashboard - Get dashboard statistics
  if (path === "/api/dashboard" && method === "GET") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id");

    let agents = AgentDB.findAll();

    // Filter agents by project if specified
    if (projectId === "unassigned") {
      agents = agents.filter(a => !a.project_id);
    } else if (projectId) {
      agents = agents.filter(a => a.project_id === projectId);
    }

    const runningAgents = agents.filter(a => a.status === "running" && a.port);

    let totalTasks = 0;
    let pendingTasks = 0;
    let completedTasks = 0;
    let runningTasks = 0;

    // Fetch task stats from all agents in parallel
    const taskResults = await Promise.all(
      runningAgents.map(async (agent) => {
        try {
          return await fetchFromAgent(agent.id, agent.port!, "/tasks?status=all");
        } catch {
          return null;
        }
      })
    );

    for (const data of taskResults) {
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
