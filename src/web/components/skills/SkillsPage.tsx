import React, { useState, useEffect } from "react";
import { useAuth, useProjects } from "../../context";
import { useConfirm, useAlert } from "../common/Modal";
import { Select } from "../common/Select";

interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowed_tools: string[];
  source: "local" | "skillsmp" | "github" | "import";
  source_url: string | null;
  enabled: boolean;
  project_id: string | null; // null = global
  created_at: string;
  updated_at: string;
}

interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  author: string;
  version: string;
  license: string | null;
  compatibility: string | null;
  tags: string[];
  downloads: number;
  rating: number;
  repository: string | null;
}

interface GitHubSkill {
  name: string;
  description: string;
  path: string;
  size: number;
  downloadUrl: string;
}

export function SkillsPage() {
  const { authFetch } = useAuth();
  const { projects, currentProjectId } = useProjects();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"installed" | "marketplace" | "github">("installed");
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();
  const { alert, AlertDialog } = useAlert();

  const hasProjects = projects.length > 0;

  // Marketplace state
  const [searchQuery, setSearchQuery] = useState("");
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>([]);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  // GitHub state
  const [githubRepo, setGithubRepo] = useState("");
  const [githubSkills, setGithubSkills] = useState<GitHubSkill[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubRepoInfo, setGithubRepoInfo] = useState<{ owner: string; repo: string; url: string } | null>(null);
  const [installingGithub, setInstallingGithub] = useState<string | null>(null);
  const [githubProjectId, setGithubProjectId] = useState<string | null>(
    currentProjectId && currentProjectId !== "unassigned" ? currentProjectId : null
  );

  // Filter skills based on global project selector
  // When a project is selected, show global + that project's skills
  const filteredSkills = skills.filter(skill => {
    if (!currentProjectId) return true; // "All Projects" - show everything
    if (currentProjectId === "unassigned") return skill.project_id === null; // Only global
    // Project selected: show global + project-specific
    return skill.project_id === null || skill.project_id === currentProjectId;
  });

  const fetchSkills = async () => {
    try {
      const res = await authFetch("/api/skills");
      const data = await res.json();
      setSkills(data.skills || []);
    } catch (e) {
      console.error("Failed to fetch skills:", e);
    }
    setLoading(false);
  };

  const searchMarketplace = async (query?: string) => {
    setMarketplaceLoading(true);
    try {
      const q = query !== undefined ? query : searchQuery;
      const endpoint = q
        ? `/api/skills/marketplace/search?q=${encodeURIComponent(q)}`
        : "/api/skills/marketplace/featured";
      const res = await authFetch(endpoint);
      const data = await res.json();
      setMarketplaceSkills(data.skills || []);
    } catch (e) {
      console.error("Failed to search marketplace:", e);
    }
    setMarketplaceLoading(false);
  };

  useEffect(() => {
    fetchSkills();
  }, [authFetch]);

  useEffect(() => {
    if (activeTab === "marketplace" && marketplaceSkills.length === 0) {
      searchMarketplace("");
    }
  }, [activeTab]);

  const toggleSkill = async (id: string) => {
    try {
      await authFetch(`/api/skills/${id}/toggle`, { method: "POST" });
      fetchSkills();
    } catch (e) {
      console.error("Failed to toggle skill:", e);
    }
  };

  const deleteSkill = async (id: string) => {
    const confirmed = await confirm("Delete this skill?", { confirmText: "Delete", title: "Delete Skill" });
    if (!confirmed) return;
    try {
      await authFetch(`/api/skills/${id}`, { method: "DELETE" });
      if (selectedSkill?.id === id) {
        setSelectedSkill(null);
      }
      fetchSkills();
    } catch (e) {
      console.error("Failed to delete skill:", e);
    }
  };

  const installFromMarketplace = async (skill: MarketplaceSkill) => {
    setInstalling(skill.id);
    try {
      const res = await authFetch(`/api/skills/marketplace/${skill.id}/install`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        await alert(`Installed "${skill.name}" successfully!`, { title: "Skill Installed" });
        fetchSkills();
        setActiveTab("installed");
      } else {
        await alert(data.error || "Failed to install skill", { title: "Installation Failed" });
      }
    } catch (e) {
      console.error("Failed to install skill:", e);
      await alert("Failed to install skill", { title: "Error" });
    }
    setInstalling(null);
  };

  const isInstalled = (name: string) => skills.some((s) => s.name === name);

  // GitHub functions
  const browseGitHubRepo = async (repoInput?: string) => {
    const input = repoInput || githubRepo;
    if (!input.trim()) return;

    // Parse repo input: "owner/repo" or full URL
    let owner = "";
    let repo = "";

    if (input.includes("github.com")) {
      const match = input.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (match) {
        owner = match[1];
        repo = match[2].replace(/\.git$/, "");
      }
    } else if (input.includes("/")) {
      const parts = input.split("/");
      owner = parts[0];
      repo = parts[1];
    }

    if (!owner || !repo) {
      setGithubError("Invalid repo format. Use 'owner/repo' or GitHub URL");
      return;
    }

    setGithubLoading(true);
    setGithubError(null);
    setGithubSkills([]);
    setGithubRepoInfo(null);

    try {
      const res = await authFetch(`/api/skills/github/${owner}/${repo}`);
      const data = await res.json();

      if (!res.ok) {
        setGithubError(data.error || "Failed to fetch repository");
        setGithubLoading(false);
        return;
      }

      setGithubSkills(data.skills || []);
      setGithubRepoInfo(data.repo || null);
    } catch (e) {
      setGithubError("Failed to fetch repository");
    }
    setGithubLoading(false);
  };

  const installFromGitHub = async (skill: GitHubSkill) => {
    if (!githubRepoInfo) return;

    setInstallingGithub(skill.name);
    try {
      const res = await authFetch("/api/skills/github/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: githubRepoInfo.owner,
          repo: githubRepoInfo.repo,
          skillName: skill.name,
          downloadUrl: skill.downloadUrl,
          projectId: githubProjectId,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        await alert(`Installed "${skill.name}" successfully!`, { title: "Skill Installed" });
        fetchSkills();
      } else {
        await alert(data.error || "Failed to install skill", { title: "Installation Failed", variant: "error" });
      }
    } catch (e) {
      await alert("Failed to install skill", { title: "Error", variant: "error" });
    }
    setInstallingGithub(null);
  };

  const installAllFromGitHub = async () => {
    if (!githubRepoInfo || githubSkills.length === 0) return;

    const uninstalled = githubSkills.filter(s => !isInstalled(s.name));
    if (uninstalled.length === 0) {
      await alert("All skills are already installed", { title: "Info" });
      return;
    }

    const confirmed = await confirm(
      `Install ${uninstalled.length} skill(s) from ${githubRepoInfo.owner}/${githubRepoInfo.repo}?`,
      { confirmText: "Install All", title: "Install Skills" }
    );
    if (!confirmed) return;

    let installed = 0;
    for (const skill of uninstalled) {
      setInstallingGithub(skill.name);
      try {
        const res = await authFetch("/api/skills/github/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: githubRepoInfo.owner,
            repo: githubRepoInfo.repo,
            skillName: skill.name,
            downloadUrl: skill.downloadUrl,
            projectId: githubProjectId,
          }),
        });
        if (res.ok) installed++;
      } catch (e) {
        // Continue with others
      }
    }
    setInstallingGithub(null);
    fetchSkills();
    await alert(`Installed ${installed} of ${uninstalled.length} skills`, { title: "Installation Complete" });
  };

  return (
    <>
      {ConfirmDialog}
      {AlertDialog}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold mb-1">Skills</h1>
              <p className="text-[var(--color-text-muted)]">
                Manage agent skills - instructions that teach agents how to perform tasks.
              </p>
            </div>
            {activeTab === "installed" && (
              <div className="flex gap-2">
                <button
                  onClick={() => setShowImport(true)}
                  className="bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] text-white px-4 py-2 rounded font-medium transition border border-[var(--color-border-light)]"
                >
                  Import
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-2 rounded font-medium transition"
                >
                  + Create Skill
                </button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-[var(--color-surface)] card p-1 w-fit">
            <button
              onClick={() => setActiveTab("installed")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === "installed"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              Installed ({filteredSkills.length})
            </button>
            <button
              onClick={() => setActiveTab("github")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === "github"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              Browse GitHub
            </button>
            <button
              onClick={() => setActiveTab("marketplace")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === "marketplace"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              Marketplace
            </button>
          </div>

          {/* Installed Tab */}
          {activeTab === "installed" && (
            <>
              {loading ? (
                <div className="text-[var(--color-text-muted)]">Loading skills...</div>
              ) : skills.length === 0 ? (
                <div className="text-center py-20 text-[var(--color-text-muted)]">
                  <p className="text-lg">No skills installed</p>
                  <p className="text-sm mt-1">Create a skill or browse the marketplace</p>
                  <button
                    onClick={() => setActiveTab("marketplace")}
                    className="mt-4 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-2 rounded font-medium transition"
                  >
                    Browse Marketplace
                  </button>
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="bg-[var(--color-surface)] card p-6 text-center">
                  <p className="text-[var(--color-text-muted)]">No skills match this filter.</p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredSkills.map((skill) => {
                    const project = hasProjects && skill.project_id
                      ? projects.find(p => p.id === skill.project_id)
                      : null;
                    return (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        project={project}
                        onToggle={() => toggleSkill(skill.id)}
                        onDelete={() => deleteSkill(skill.id)}
                        onView={() => setSelectedSkill(skill)}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* GitHub Tab */}
          {activeTab === "github" && (
            <div className="space-y-6">
              {/* Search */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  browseGitHubRepo();
                }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  placeholder="Enter GitHub repo (e.g., WordPress/agent-skills)"
                  className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg px-4 py-3 focus:outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="submit"
                  disabled={githubLoading}
                  className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-6 py-3 rounded-lg font-medium transition"
                >
                  {githubLoading ? "..." : "Browse"}
                </button>
              </form>

              {/* Project Scope Selector */}
              {hasProjects && githubSkills.length > 0 && (
                <div className="flex items-center gap-3 p-3 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg">
                  <span className="text-sm text-[var(--color-text-muted)]">Install to:</span>
                  <Select
                    value={githubProjectId || ""}
                    onChange={(value) => setGithubProjectId(value || null)}
                    options={[
                      { value: "", label: "Global (all projects)" },
                      ...projects.map(p => ({ value: p.id, label: p.name }))
                    ]}
                    placeholder="Select scope..."
                  />
                </div>
              )}

              {/* Error */}
              {githubError && (
                <div className="text-red-400 text-sm p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                  {githubError}
                </div>
              )}

              {/* Repo Info Header */}
              {githubRepoInfo && githubSkills.length > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <a
                      href={githubRepoInfo.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-accent)] hover:underline font-medium"
                    >
                      {githubRepoInfo.owner}/{githubRepoInfo.repo}
                    </a>
                    <span className="text-sm text-[var(--color-text-muted)]">
                      {githubSkills.length} skill{githubSkills.length !== 1 ? "s" : ""} found
                    </span>
                  </div>
                  {githubSkills.some(s => !isInstalled(s.name)) && (
                    <button
                      onClick={installAllFromGitHub}
                      disabled={!!installingGithub}
                      className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-4 py-2 rounded transition disabled:opacity-50"
                    >
                      Install All
                    </button>
                  )}
                </div>
              )}

              {/* Loading */}
              {githubLoading && (
                <div className="text-center py-8 text-[var(--color-text-muted)]">
                  Fetching skills from repository...
                </div>
              )}

              {/* Empty State */}
              {!githubLoading && !githubRepoInfo && !githubError && (
                <div className="bg-[var(--color-surface)] card p-8 text-center">
                  <div className="text-4xl mb-4">📦</div>
                  <h3 className="text-lg font-medium mb-2">Browse Skills from GitHub</h3>
                  <p className="text-[var(--color-text-muted)] mb-6 max-w-md mx-auto">
                    Enter a GitHub repository to browse and install skills. Skills are markdown files with instructions that teach agents how to perform specific tasks.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {[
                      { label: "WordPress Skills", repo: "WordPress/agent-skills" },
                    ].map(({ label, repo }) => (
                      <button
                        key={repo}
                        onClick={() => {
                          setGithubRepo(repo);
                          browseGitHubRepo(repo);
                        }}
                        className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No Skills Found */}
              {!githubLoading && githubRepoInfo && githubSkills.length === 0 && (
                <div className="text-center py-8 text-[var(--color-text-muted)]">
                  No skills found in this repository. Skills should be in subdirectories with a SKILL.md file.
                </div>
              )}

              {/* Skills Grid */}
              {githubSkills.length > 0 && (
                <div className="grid gap-4 md:grid-cols-2">
                  {githubSkills.map((skill) => {
                    const installed = isInstalled(skill.name);
                    const isInstalling = installingGithub === skill.name;

                    return (
                      <div
                        key={skill.name}
                        className={`bg-[var(--color-surface)] border rounded-lg p-4 transition ${
                          installed ? "border-green-500/30" : "border-[var(--color-border)] hover:border-[var(--color-border-light)]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium truncate">{skill.name}</h3>
                              {installed && (
                                <span className="text-xs text-green-400">✓ Installed</span>
                              )}
                            </div>
                            <p className="text-sm text-[var(--color-text-muted)] mt-1 line-clamp-2">
                              {skill.description || "No description"}
                            </p>
                            <div className="flex items-center gap-2 mt-2 text-xs text-[var(--color-text-faint)]">
                              <span>{(skill.size / 1024).toFixed(1)}KB</span>
                              <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                                GitHub
                              </span>
                            </div>
                          </div>
                          <div className="flex-shrink-0">
                            {installed ? (
                              <span className="text-xs text-[var(--color-text-faint)] px-3 py-1.5">Added</span>
                            ) : (
                              <button
                                onClick={() => installFromGitHub(skill)}
                                disabled={isInstalling}
                                className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition disabled:opacity-50"
                              >
                                {isInstalling ? "Installing..." : "Install"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Info */}
              <div className="p-4 bg-[var(--color-surface)] card text-sm text-[var(--color-text-muted)]">
                <p>
                  Skills are sourced from GitHub repositories. Each skill should be in its own directory with a{" "}
                  <code className="text-[var(--color-text-secondary)] bg-[var(--color-bg)] px-1 rounded">SKILL.md</code> file containing instructions.
                </p>
              </div>
            </div>
          )}

          {/* Marketplace Tab */}
          {activeTab === "marketplace" && (
            <>
              {/* Search */}
              <div className="mb-6">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchMarketplace()}
                    placeholder="Search skills..."
                    className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-4 py-2 focus:outline-none focus:border-[var(--color-accent)]"
                  />
                  <button
                    onClick={() => searchMarketplace()}
                    disabled={marketplaceLoading}
                    className="bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] text-white px-4 py-2 rounded font-medium transition border border-[var(--color-border-light)]"
                  >
                    {marketplaceLoading ? "..." : "Search"}
                  </button>
                </div>
              </div>

              {marketplaceLoading ? (
                <div className="text-[var(--color-text-muted)]">Loading...</div>
              ) : marketplaceSkills.length === 0 ? (
                <div className="text-center py-20 text-[var(--color-text-muted)]">
                  <p className="text-lg">No skills found</p>
                  <p className="text-sm mt-1">Try a different search term</p>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {marketplaceSkills.map((skill) => (
                    <MarketplaceSkillCard
                      key={skill.id}
                      skill={skill}
                      installed={isInstalled(skill.name)}
                      installing={installing === skill.id}
                      onInstall={() => installFromMarketplace(skill)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <CreateSkillModal
          authFetch={authFetch}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            fetchSkills();
          }}
          projects={hasProjects ? projects : undefined}
          defaultProjectId={currentProjectId && currentProjectId !== "unassigned" ? currentProjectId : null}
        />
      )}

      {/* Import Modal */}
      {showImport && (
        <ImportSkillModal
          authFetch={authFetch}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            fetchSkills();
          }}
        />
      )}

      {/* View/Edit Modal */}
      {selectedSkill && (
        <ViewSkillModal
          skill={selectedSkill}
          authFetch={authFetch}
          onClose={() => setSelectedSkill(null)}
          onUpdated={() => {
            setSelectedSkill(null);
            fetchSkills();
          }}
        />
      )}
    </>
  );
}

function SkillCard({
  skill,
  project,
  onToggle,
  onDelete,
  onView,
}: {
  skill: Skill;
  project?: { id: string; name: string; color: string } | null;
  onToggle: () => void;
  onDelete: () => void;
  onView: () => void;
}) {
  const sourceLabel = {
    local: "Local",
    skillsmp: "SkillsMP",
    github: "GitHub",
    import: "Imported",
  }[skill.source];

  // Scope badge: Global or Project name
  const getScopeBadge = () => {
    if (project) {
      return (
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ backgroundColor: `${project.color}20`, color: project.color }}
        >
          {project.name}
        </span>
      );
    }
    if (skill.project_id === null) {
      return (
        <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 rounded">
          Global
        </span>
      );
    }
    return null;
  };

  return (
    <div
      className={`bg-[var(--color-surface)] rounded-lg p-5 border transition cursor-pointer ${
        skill.enabled ? "border-[var(--color-border)]" : "border-[var(--color-border)] opacity-60"
      } hover:border-[var(--color-border-light)]`}
      onClick={onView}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg truncate">{skill.name}</h3>
            {getScopeBadge()}
          </div>
          <p className="text-xs text-[var(--color-text-muted)] flex items-center gap-2 mt-0.5">
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
              skill.source === "skillsmp" ? "bg-purple-500/20 text-purple-400" :
              skill.source === "github" ? "bg-blue-500/20 text-blue-400" :
              "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)]"
            }`}>
              {sourceLabel}
            </span>
            {skill.metadata?.version && <span>v{skill.metadata.version}</span>}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={`w-10 h-5 rounded-full transition-colors relative ${
            skill.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-raised)]"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              skill.enabled ? "left-5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mb-4">{skill.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {skill.allowed_tools.slice(0, 2).map((tool) => (
            <span key={tool} className="text-xs bg-[var(--color-surface-raised)] px-2 py-0.5 rounded text-[var(--color-text-muted)]">
              {tool}
            </span>
          ))}
          {skill.allowed_tools.length > 2 && (
            <span className="text-xs text-[var(--color-text-muted)]">+{skill.allowed_tools.length - 2}</span>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-red-400 hover:text-red-300 text-sm"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function MarketplaceSkillCard({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: MarketplaceSkill;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="bg-[var(--color-surface)] rounded-lg p-5 border border-[var(--color-border)] hover:border-[var(--color-border-light)] transition">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg truncate">{skill.name}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            by {skill.author} · v{skill.version}
          </p>
        </div>
        <div className="flex items-center gap-1 text-yellow-500 text-sm">
          ★ {skill.rating.toFixed(1)}
        </div>
      </div>

      <p className="text-sm text-[var(--color-text-secondary)] line-clamp-2 mb-4">{skill.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {skill.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-xs bg-[var(--color-surface-raised)] px-2 py-0.5 rounded text-[var(--color-text-muted)]">
              {tag}
            </span>
          ))}
        </div>
        {installed ? (
          <span className="text-green-400 text-sm">✓ Installed</span>
        ) : (
          <button
            onClick={onInstall}
            disabled={installing}
            className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-3 py-1 rounded text-sm font-medium transition"
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
      </div>

      <div className="mt-3 text-xs text-[var(--color-text-faint)]">
        {skill.downloads.toLocaleString()} downloads
      </div>
    </div>
  );
}

function CreateSkillModal({
  authFetch,
  onClose,
  onCreated,
  projects,
  defaultProjectId,
}: {
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onCreated: () => void;
  projects?: Array<{ id: string; name: string; color: string }>;
  defaultProjectId?: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasProjects = projects && projects.length > 0;

  const handleSave = async () => {
    if (!name || !description || !content) {
      setError("All fields are required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name,
        description,
        content,  // Just the instructions, not wrapped in frontmatter
        source: "local",
      };

      // Add project_id if selected
      if (projectId) {
        body.project_id = projectId;
      }

      const res = await authFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create skill");
        setSaving(false);
        return;
      }

      onCreated();
    } catch (e) {
      setError("Failed to create skill");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] card w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[var(--color-border)]">
          <h2 className="text-xl font-semibold">Create Skill</h2>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="my-skill-name"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
            />
            <p className="text-xs text-[var(--color-text-faint)] mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>

          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does and when to use it..."
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Project Scope - only show when projects exist */}
          {hasProjects && (
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Scope</label>
              <Select
                value={projectId || ""}
                onChange={(value) => setProjectId(value || null)}
                options={[
                  { value: "", label: "Global (all projects)" },
                  ...projects!.map(p => ({ value: p.id, label: p.name }))
                ]}
                placeholder="Select scope..."
              />
              <p className="text-xs text-[var(--color-text-faint)] mt-1">
                Global skills are available to all agents. Project-scoped skills are only available to agents in that project.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Instructions (Markdown)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Skill Instructions&#10;&#10;Write detailed instructions here..."
              rows={12}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] font-mono text-sm"
            />
          </div>
        </div>

        <div className="p-6 border-t border-[var(--color-border)] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[var(--color-text-secondary)] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
          >
            {saving ? "Creating..." : "Create Skill"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportSkillModal({
  authFetch,
  onClose,
  onImported,
}: {
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onImported: () => void;
}) {
  const [content, setContent] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    if (!content.trim()) {
      setError("Paste SKILL.md content");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const res = await authFetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to import skill");
        setImporting(false);
        return;
      }

      onImported();
    } catch (e) {
      setError("Failed to import skill");
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] card w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[var(--color-border)]">
          <h2 className="text-xl font-semibold">Import Skill</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">Paste the contents of a SKILL.md file</p>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`---
name: skill-name
description: What this skill does...
---

# Instructions

Your skill instructions here...`}
            rows={16}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] font-mono text-sm"
          />
        </div>

        <div className="p-6 border-t border-[var(--color-border)] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[var(--color-text-secondary)] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
          >
            {importing ? "Importing..." : "Import Skill"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ViewSkillModal({
  skill,
  authFetch,
  onClose,
  onUpdated,
}: {
  skill: Skill;
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(skill.content);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await authFetch(`/api/skills/${skill.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      onUpdated();
    } catch (e) {
      console.error("Failed to save:", e);
    }
    setSaving(false);
  };

  const handleExport = async () => {
    try {
      const res = await authFetch(`/api/skills/${skill.id}/export`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.name}-SKILL.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to export:", e);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[var(--color-surface)] card w-full max-w-3xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">{skill.name}</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">{skill.description}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleExport}
              className="text-sm text-[var(--color-text-secondary)] hover:text-white transition px-3 py-1 rounded border border-[var(--color-border-light)]"
            >
              Export
            </button>
            <button
              onClick={() => setEditing(!editing)}
              className="text-sm text-[var(--color-text-secondary)] hover:text-white transition px-3 py-1 rounded border border-[var(--color-border-light)]"
            >
              {editing ? "View" : "Edit"}
            </button>
          </div>
        </div>

        <div className="p-6">
          {editing ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={20}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] font-mono text-sm"
            />
          ) : (
            <pre className="bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded p-4 font-mono text-sm overflow-auto max-h-[60vh] whitespace-pre-wrap">
              {skill.content}
            </pre>
          )}
        </div>

        <div className="p-6 border-t border-[var(--color-border)] flex justify-between">
          <div className="text-xs text-[var(--color-text-faint)]">
            {skill.source !== "local" && skill.source_url && (
              <a href={skill.source_url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">
                View source →
              </a>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[var(--color-text-secondary)] hover:text-white transition"
            >
              Close
            </button>
            {editing && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
