import { json } from "./helpers";
import { AgentDB, ProjectDB, type Project } from "../../db";
import { toApiAgent, toApiAgentsBatch, toApiProject, setAgentStatus } from "./agent-utils";
import { agentProcesses } from "../../server";

export async function handleProjectRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: unknown,
): Promise<Response | null> {
  // GET /api/projects - List all projects
  if (path === "/api/projects" && method === "GET") {
    const projects = ProjectDB.findAll();
    const agentCounts = ProjectDB.getAgentCounts();
    return json({
      projects: projects.map(p => ({
        ...toApiProject(p),
        agentCount: agentCounts.get(p.id) || 0,
      })),
      unassignedCount: agentCounts.get(null) || 0,
    });
  }

  // POST /api/projects - Create a new project
  if (path === "/api/projects" && method === "POST") {
    try {
      const body = await req.json();
      const { name, description, color } = body;

      if (!name) {
        return json({ error: "Name is required" }, 400);
      }

      const project = ProjectDB.create({
        name,
        description: description || null,
        color: color || "#6366f1",
      });

      return json({ project: toApiProject(project) }, 201);
    } catch (e) {
      console.error("Create project error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/projects/:id - Get a specific project
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }
    const agents = AgentDB.findByProject(project.id);
    return json({
      project: toApiProject(project),
      agents: toApiAgentsBatch(agents),
    });
  }

  // PUT /api/projects/:id - Update a project
  if (projectMatch && method === "PUT") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<Project> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.color !== undefined) updates.color = body.color;

      const updated = ProjectDB.update(projectMatch[1], updates);
      return json({ project: updated ? toApiProject(updated) : null });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/projects/:id - Delete a project
  if (projectMatch && method === "DELETE") {
    const project = ProjectDB.findById(projectMatch[1]);
    if (!project) {
      return json({ error: "Project not found" }, 404);
    }

    // Stop any running agents in this project first - in parallel
    const projectAgents = AgentDB.findByProject(projectMatch[1]);
    await Promise.allSettled(projectAgents.map(async (agent) => {
      if (agent.status === "running") {
        const entry = agentProcesses.get(agent.id);
        if (entry) {
          try {
            await fetch(`http://localhost:${entry.port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => {});
            entry.proc.kill();
          } catch {}
          agentProcesses.delete(agent.id);
        }
        setAgentStatus(agent.id, "stopped", "project_deleted");
      }
    }));

    ProjectDB.delete(projectMatch[1]);
    return json({ success: true });
  }

  return null;
}
