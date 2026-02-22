import { json } from "./helpers";
import { AgentDB, SkillDB, type Skill } from "../../db";
import { ProviderKeys } from "../../providers";
import { SkillsmpProvider, parseSkillMd } from "../../integrations/skillsmp";
import { buildAgentConfig, pushConfigToAgent, pushSkillsToAgent } from "./agent-utils";

export async function handleSkillRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // ============ Skills CRUD ============

  // GET /api/skills - List skills (optionally filtered by project)
  if (path === "/api/skills" && method === "GET") {
    const url = new URL(req.url);
    const projectFilter = url.searchParams.get("project"); // "all", "global", or project ID
    const forAgent = url.searchParams.get("forAgent"); // agent's project ID (shows global + project)

    let skills;
    if (forAgent !== null) {
      // Get skills available for an agent (global + agent's project)
      skills = SkillDB.findForAgent(forAgent || null);
    } else if (projectFilter === "global") {
      skills = SkillDB.findGlobal();
    } else if (projectFilter && projectFilter !== "all") {
      skills = SkillDB.findByProject(projectFilter);
    } else {
      skills = SkillDB.findAll();
    }
    return json({ skills });
  }

  // POST /api/skills - Create a new skill
  if (path === "/api/skills" && method === "POST") {
    try {
      const body = await req.json();
      const { name, description, content, version, license, compatibility, metadata, allowed_tools, source, source_url, enabled, project_id } = body;

      if (!name || !description || !content) {
        return json({ error: "name, description, and content are required" }, 400);
      }

      // Validate name format (lowercase, hyphens only)
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(name)) {
        return json({ error: "name must be lowercase letters, numbers, and hyphens only" }, 400);
      }

      if (SkillDB.exists(name)) {
        return json({ error: "A skill with this name already exists" }, 400);
      }

      const skill = SkillDB.create({
        name,
        description,
        content,
        version: version || "1.0.0",
        license: license || null,
        compatibility: compatibility || null,
        metadata: metadata || {},
        allowed_tools: allowed_tools || [],
        source: source || "local",
        source_url: source_url || null,
        enabled: enabled !== false,
        project_id: project_id || null,
      });

      return json({ skill }, 201);
    } catch (err) {
      console.error("Failed to create skill:", err);
      return json({ error: `Failed to create skill: ${err}` }, 500);
    }
  }

  // POST /api/skills/import - Import a skill from SKILL.md content
  if (path === "/api/skills/import" && method === "POST") {
    try {
      const body = await req.json();
      const { content, source, source_url } = body;

      if (!content) {
        return json({ error: "content is required" }, 400);
      }

      const parsed = parseSkillMd(content);
      if (!parsed) {
        return json({ error: "Invalid SKILL.md format. Must have YAML frontmatter with name and description." }, 400);
      }

      if (SkillDB.exists(parsed.name)) {
        return json({ error: `A skill named "${parsed.name}" already exists` }, 400);
      }

      const skill = SkillDB.create({
        name: parsed.name,
        description: parsed.description,
        content: content, // Store full content including frontmatter
        version: (parsed as any).version || "1.0.0",
        license: parsed.license || null,
        compatibility: parsed.compatibility || null,
        metadata: parsed.metadata || {},
        allowed_tools: parsed.allowedTools || [],
        source: source || "import",
        source_url: source_url || null,
        enabled: true,
        project_id: null,
      });

      return json({ skill }, 201);
    } catch (err) {
      console.error("Failed to import skill:", err);
      return json({ error: `Failed to import skill: ${err}` }, 500);
    }
  }

  // GET /api/skills/:id - Get a skill
  const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);

  // GET /api/skills/:id/export - Export a skill as SKILL.md
  const skillExportMatch = path.match(/^\/api\/skills\/([^/]+)\/export$/);
  if (skillExportMatch && method === "GET") {
    const skill = SkillDB.findById(skillExportMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    // Return the raw content
    return new Response(skill.content, {
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": `attachment; filename="${skill.name}-SKILL.md"`,
      },
    });
  }

  // POST /api/skills/:id/toggle - Toggle skill enabled/disabled
  const skillToggleMatch = path.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (skillToggleMatch && method === "POST") {
    const skill = SkillDB.findById(skillToggleMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    const updated = SkillDB.setEnabled(skillToggleMatch[1], !skill.enabled);
    return json({ skill: updated });
  }

  // ============ SkillsMP Marketplace ============

  // GET /api/skills/marketplace/search - Search skills marketplace
  if (path === "/api/skills/marketplace/search" && method === "GET") {
    const url = new URL(req.url);
    const query = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);

    // Get SkillsMP API key if configured
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");

    const result = await SkillsmpProvider.search(skillsmpKey || "", query, page);
    return json(result);
  }

  // GET /api/skills/marketplace/featured - Get featured skills
  if (path === "/api/skills/marketplace/featured" && method === "GET") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const skills = await SkillsmpProvider.getFeatured(skillsmpKey || "");
    return json({ skills });
  }

  // GET /api/skills/marketplace/:id - Get skill details from marketplace
  const marketplaceSkillMatch = path.match(/^\/api\/skills\/marketplace\/([^/]+)$/);
  if (marketplaceSkillMatch && method === "GET") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const skill = await SkillsmpProvider.getSkill(skillsmpKey || "", marketplaceSkillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found in marketplace" }, 404);
    }
    return json({ skill });
  }

  // POST /api/skills/marketplace/:id/install - Install a skill from marketplace
  const marketplaceInstallMatch = path.match(/^\/api\/skills\/marketplace\/([^/]+)\/install$/);
  if (marketplaceInstallMatch && method === "POST") {
    const skillsmpKey = ProviderKeys.getDecrypted("skillsmp");
    const marketplaceSkill = await SkillsmpProvider.getSkill(skillsmpKey || "", marketplaceInstallMatch[1]);

    if (!marketplaceSkill) {
      return json({ error: "Skill not found in marketplace" }, 404);
    }

    if (SkillDB.exists(marketplaceSkill.name)) {
      return json({ error: `A skill named "${marketplaceSkill.name}" already exists` }, 400);
    }

    const skill = SkillDB.create({
      name: marketplaceSkill.name,
      description: marketplaceSkill.description,
      content: marketplaceSkill.content,
      version: marketplaceSkill.version || "1.0.0",
      license: marketplaceSkill.license,
      compatibility: marketplaceSkill.compatibility,
      metadata: {
        author: marketplaceSkill.author,
        version: marketplaceSkill.version,
        ...(marketplaceSkill.repository ? { repository: marketplaceSkill.repository } : {}),
      },
      allowed_tools: [],
      source: "skillsmp",
      project_id: null,
      source_url: marketplaceSkill.repository || `https://skillsmp.com/skills/${marketplaceSkill.id}`,
      enabled: true,
    });

    return json({ skill }, 201);
  }

  // ============ GitHub Skills ============

  // GET /api/skills/github/:owner/:repo - List skills from a GitHub repo
  const githubRepoMatch = path.match(/^\/api\/skills\/github\/([^/]+)\/([^/]+)$/);
  if (githubRepoMatch && method === "GET") {
    const [, owner, repo] = githubRepoMatch;

    const githubHeaders = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Apteva-Skills-Browser",
    };

    // Helper to fetch directory contents
    const fetchDir = async (dirPath: string) => {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`;
      const res = await fetch(url, { headers: githubHeaders });
      if (!res.ok) return [];
      return await res.json() as Array<{
        name: string;
        path: string;
        type: "file" | "dir";
        size?: number;
        download_url?: string;
      }>;
    };

    // Helper to find skills in a directory (looks for subdirs with SKILL.md)
    const findSkillsInDir = async (basePath: string) => {
      const skills: Array<{
        name: string;
        description: string;
        path: string;
        size: number;
        downloadUrl: string;
      }> = [];

      const contents = await fetchDir(basePath);
      const skillDirs = contents.filter(item => item.type === "dir");

      for (const dir of skillDirs) {
        try {
          const dirContents = await fetchDir(dir.path);
          const skillFile = dirContents.find(
            f => f.type === "file" && f.name.toLowerCase() === "skill.md"
          );

          if (skillFile && skillFile.download_url) {
            const skillResponse = await fetch(skillFile.download_url);
            if (skillResponse.ok) {
              const content = await skillResponse.text();

              // Parse frontmatter for description
              let description = "";
              const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (frontmatterMatch) {
                const descMatch = frontmatterMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
                if (descMatch) {
                  description = descMatch[1].trim();
                }
              }

              // If no frontmatter description, try to get first paragraph
              if (!description) {
                const contentWithoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
                const firstPara = contentWithoutFrontmatter.split("\n\n")[0];
                if (firstPara && !firstPara.startsWith("#")) {
                  description = firstPara.slice(0, 200);
                }
              }

              skills.push({
                name: dir.name,
                description: description || `Skill from ${dir.name}`,
                path: skillFile.path,
                size: skillFile.size || 0,
                downloadUrl: skillFile.download_url,
              });
            }
          }
        } catch (e) {
          // Skip this directory on error
        }
      }

      return skills;
    };

    try {
      // Fetch root contents
      const rootContents = await fetchDir("");

      if (rootContents.length === 0) {
        return json({ error: "Repository not found or empty" }, 404);
      }

      let skills: Array<{
        name: string;
        description: string;
        path: string;
        size: number;
        downloadUrl: string;
      }> = [];

      // Check common skill directory patterns: skills/, src/skills/, .claude/skills/
      const skillsDirs = ["skills", "src/skills", ".claude/skills"];
      for (const skillsDir of skillsDirs) {
        const dirExists = rootContents.find(
          item => item.type === "dir" && item.name === skillsDir.split("/")[0]
        );
        if (dirExists || skillsDir.includes("/")) {
          const foundSkills = await findSkillsInDir(skillsDir);
          if (foundSkills.length > 0) {
            skills = foundSkills;
            break;
          }
        }
      }

      // If no skills found in common dirs, check root level subdirectories
      if (skills.length === 0) {
        skills = await findSkillsInDir("");
      }

      // Also check for SKILL.md in root (single-skill repo)
      const rootSkillFile = rootContents.find(
        f => f.type === "file" && f.name.toLowerCase() === "skill.md"
      );
      if (rootSkillFile && rootSkillFile.download_url) {
        const skillResponse = await fetch(rootSkillFile.download_url);
        if (skillResponse.ok) {
          const content = await skillResponse.text();
          let name = repo;
          let description = "";

          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const nameMatch = frontmatterMatch[1].match(/name:\s*["']?([^"'\n]+)["']?/);
            const descMatch = frontmatterMatch[1].match(/description:\s*["']?([^"'\n]+)["']?/);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }

          skills.unshift({
            name,
            description: description || `Skill from ${repo}`,
            path: rootSkillFile.path,
            size: rootSkillFile.size || 0,
            downloadUrl: rootSkillFile.download_url,
          });
        }
      }

      return json({
        skills,
        repo: { owner, repo, url: `https://github.com/${owner}/${repo}` }
      });
    } catch (e) {
      console.error("GitHub API error:", e);
      return json({ error: "Failed to fetch from GitHub" }, 500);
    }
  }

  // POST /api/skills/github/install - Install a skill from GitHub
  if (path === "/api/skills/github/install" && method === "POST") {
    try {
      const body = await req.json() as {
        owner: string;
        repo: string;
        skillName: string;
        downloadUrl: string;
        projectId?: string | null;
      };

      const { owner, repo, skillName, downloadUrl, projectId } = body;

      if (!owner || !repo || !skillName || !downloadUrl) {
        return json({ error: "owner, repo, skillName, and downloadUrl are required" }, 400);
      }

      // Check if skill already exists
      if (SkillDB.exists(skillName)) {
        return json({ error: `A skill named "${skillName}" already exists` }, 400);
      }

      // Fetch the skill content
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        return json({ error: "Failed to fetch skill content" }, 500);
      }

      const content = await response.text();

      // Parse frontmatter
      let name = skillName;
      let description = "";
      let version = "1.0.0";
      let license = null;
      let compatibility = null;
      let skillContent = content;

      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        skillContent = frontmatterMatch[2].trim();

        const nameMatch = frontmatter.match(/name:\s*["']?([^"'\n]+)["']?/);
        const descMatch = frontmatter.match(/description:\s*["']?([^"'\n]+)["']?/);
        const versionMatch = frontmatter.match(/version:\s*["']?([^"'\n]+)["']?/);
        const licenseMatch = frontmatter.match(/license:\s*["']?([^"'\n]+)["']?/);
        const compatMatch = frontmatter.match(/compatibility:\s*["']?([^"'\n]+)["']?/);

        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
        if (versionMatch) version = versionMatch[1].trim();
        if (licenseMatch) license = licenseMatch[1].trim();
        if (compatMatch) compatibility = compatMatch[1].trim();
      }

      // Create the skill in DB
      const skill = SkillDB.create({
        name,
        description: description || `Skill from ${owner}/${repo}`,
        content: skillContent,
        version,
        license,
        compatibility,
        metadata: { owner, repo, originalName: skillName },
        allowed_tools: [],
        source: "github",
        source_url: `https://github.com/${owner}/${repo}/blob/main/${skillName}/SKILL.md`,
        enabled: true,
        project_id: projectId || null,
      });

      return json({ skill }, 201);
    } catch (e) {
      console.error("GitHub install error:", e);
      return json({ error: "Failed to install skill from GitHub" }, 500);
    }
  }

  // Skill CRUD by ID (must come after more specific routes like /toggle, /export, /marketplace, /github)
  if (skillMatch && method === "GET") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }
    return json({ skill });
  }

  // PUT /api/skills/:id - Update a skill
  if (skillMatch && method === "PUT") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Partial<Skill> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.content !== undefined) updates.content = body.content;
      if (body.license !== undefined) updates.license = body.license;
      if (body.compatibility !== undefined) updates.compatibility = body.compatibility;
      if (body.metadata !== undefined) updates.metadata = body.metadata;
      if (body.allowed_tools !== undefined) updates.allowed_tools = body.allowed_tools;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.project_id !== undefined) updates.project_id = body.project_id;

      // Auto-increment version if content changed
      if (body.content !== undefined && body.content !== skill.content) {
        const [major, minor, patch] = (skill.version || "1.0.0").split(".").map(Number);
        updates.version = `${major}.${minor}.${patch + 1}`;
      } else if (body.version !== undefined) {
        updates.version = body.version;
      }

      const updated = SkillDB.update(skillMatch[1], updates);

      // Push updated skill to all running agents that have it
      const agentsWithSkill = AgentDB.findBySkill(skillMatch[1]);
      const runningAgents = agentsWithSkill.filter(a => a.status === "running" && a.port);

      await Promise.allSettled(runningAgents.map(async (agent) => {
        try {
          const providerKey = ProviderKeys.getDecrypted(agent.provider);
          if (providerKey) {
            const config = buildAgentConfig(agent, providerKey);
            await pushConfigToAgent(agent.id, agent.port!, config);
            if (config.skills?.definitions?.length > 0) {
              await pushSkillsToAgent(agent.id, agent.port!, config.skills.definitions);
            }
            console.log(`Pushed skill update to agent ${agent.name}`);
          }
        } catch (err) {
          console.error(`Failed to push skill update to agent ${agent.name}:`, err);
        }
      }));

      return json({ skill: updated, agents_updated: runningAgents.length });
    } catch (err) {
      console.error("Failed to update skill:", err);
      return json({ error: `Failed to update skill: ${err}` }, 500);
    }
  }

  // DELETE /api/skills/:id - Delete a skill
  if (skillMatch && method === "DELETE") {
    const skill = SkillDB.findById(skillMatch[1]);
    if (!skill) {
      return json({ error: "Skill not found" }, 404);
    }

    SkillDB.delete(skillMatch[1]);
    return json({ success: true });
  }

  return null;
}
