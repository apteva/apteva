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

export function SkillsPage() {
  const { authFetch } = useAuth();
  const { projects, currentProjectId } = useProjects();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"installed" | "marketplace">("installed");
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
              <p className="text-[#666]">
                Manage agent skills - instructions that teach agents how to perform tasks.
              </p>
            </div>
            {activeTab === "installed" && (
              <div className="flex gap-2">
                <button
                  onClick={() => setShowImport(true)}
                  className="bg-[#1a1a1a] hover:bg-[#222] text-white px-4 py-2 rounded font-medium transition border border-[#333]"
                >
                  Import
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
                >
                  + Create Skill
                </button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-[#111] border border-[#1a1a1a] rounded-lg p-1 w-fit">
            <button
              onClick={() => setActiveTab("installed")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === "installed"
                  ? "bg-[#1a1a1a] text-white"
                  : "text-[#666] hover:text-[#888]"
              }`}
            >
              Installed ({skills.length})
            </button>
            <button
              onClick={() => setActiveTab("marketplace")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === "marketplace"
                  ? "bg-[#1a1a1a] text-white"
                  : "text-[#666] hover:text-[#888]"
              }`}
            >
              Marketplace
            </button>
          </div>

          {/* Installed Tab */}
          {activeTab === "installed" && (
            <>
              {loading ? (
                <div className="text-[#666]">Loading skills...</div>
              ) : skills.length === 0 ? (
                <div className="text-center py-20 text-[#666]">
                  <p className="text-lg">No skills installed</p>
                  <p className="text-sm mt-1">Create a skill or browse the marketplace</p>
                  <button
                    onClick={() => setActiveTab("marketplace")}
                    className="mt-4 bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
                  >
                    Browse Marketplace
                  </button>
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center">
                  <p className="text-[#666]">No skills match this filter.</p>
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
                    className="flex-1 bg-[#111] border border-[#1a1a1a] rounded px-4 py-2 focus:outline-none focus:border-[#f97316]"
                  />
                  <button
                    onClick={() => searchMarketplace()}
                    disabled={marketplaceLoading}
                    className="bg-[#1a1a1a] hover:bg-[#222] text-white px-4 py-2 rounded font-medium transition border border-[#333]"
                  >
                    {marketplaceLoading ? "..." : "Search"}
                  </button>
                </div>
              </div>

              {marketplaceLoading ? (
                <div className="text-[#666]">Loading...</div>
              ) : marketplaceSkills.length === 0 ? (
                <div className="text-center py-20 text-[#666]">
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
        <span className="text-xs text-[#666] bg-[#1a1a1a] px-1.5 py-0.5 rounded">
          Global
        </span>
      );
    }
    return null;
  };

  return (
    <div
      className={`bg-[#111] rounded-lg p-5 border transition cursor-pointer ${
        skill.enabled ? "border-[#1a1a1a]" : "border-[#1a1a1a] opacity-60"
      } hover:border-[#333]`}
      onClick={onView}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-lg truncate">{skill.name}</h3>
            {getScopeBadge()}
          </div>
          <p className="text-xs text-[#666] flex items-center gap-2 mt-0.5">
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
              skill.source === "skillsmp" ? "bg-purple-500/20 text-purple-400" :
              skill.source === "github" ? "bg-blue-500/20 text-blue-400" :
              "bg-[#222] text-[#888]"
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
            skill.enabled ? "bg-[#f97316]" : "bg-[#333]"
          }`}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              skill.enabled ? "left-5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <p className="text-sm text-[#888] line-clamp-2 mb-4">{skill.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {skill.allowed_tools.slice(0, 2).map((tool) => (
            <span key={tool} className="text-xs bg-[#222] px-2 py-0.5 rounded text-[#666]">
              {tool}
            </span>
          ))}
          {skill.allowed_tools.length > 2 && (
            <span className="text-xs text-[#666]">+{skill.allowed_tools.length - 2}</span>
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
    <div className="bg-[#111] rounded-lg p-5 border border-[#1a1a1a] hover:border-[#333] transition">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg truncate">{skill.name}</h3>
          <p className="text-xs text-[#666] mt-0.5">
            by {skill.author} · v{skill.version}
          </p>
        </div>
        <div className="flex items-center gap-1 text-yellow-500 text-sm">
          ★ {skill.rating.toFixed(1)}
        </div>
      </div>

      <p className="text-sm text-[#888] line-clamp-2 mb-4">{skill.description}</p>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          {skill.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-xs bg-[#222] px-2 py-0.5 rounded text-[#666]">
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
            className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-3 py-1 rounded text-sm font-medium transition"
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
      </div>

      <div className="mt-3 text-xs text-[#555]">
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
        className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[#1a1a1a]">
          <h2 className="text-xl font-semibold">Create Skill</h2>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm text-[#888] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="my-skill-name"
              className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
            <p className="text-xs text-[#555] mt-1">Lowercase letters, numbers, and hyphens only</p>
          </div>

          <div>
            <label className="block text-sm text-[#888] mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does and when to use it..."
              className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          {/* Project Scope - only show when projects exist */}
          {hasProjects && (
            <div>
              <label className="block text-sm text-[#888] mb-1">Scope</label>
              <Select
                value={projectId || ""}
                onChange={(value) => setProjectId(value || null)}
                options={[
                  { value: "", label: "Global (all projects)" },
                  ...projects!.map(p => ({ value: p.id, label: p.name }))
                ]}
                placeholder="Select scope..."
              />
              <p className="text-xs text-[#555] mt-1">
                Global skills are available to all agents. Project-scoped skills are only available to agents in that project.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm text-[#888] mb-1">Instructions (Markdown)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Skill Instructions&#10;&#10;Write detailed instructions here..."
              rows={12}
              className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] font-mono text-sm"
            />
          </div>
        </div>

        <div className="p-6 border-t border-[#1a1a1a] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[#888] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
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
        className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[#1a1a1a]">
          <h2 className="text-xl font-semibold">Import Skill</h2>
          <p className="text-sm text-[#666] mt-1">Paste the contents of a SKILL.md file</p>
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
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] font-mono text-sm"
          />
        </div>

        <div className="p-6 border-t border-[#1a1a1a] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[#888] hover:text-white transition"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing}
            className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
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
        className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-3xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-[#1a1a1a] flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">{skill.name}</h2>
            <p className="text-sm text-[#666] mt-0.5">{skill.description}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleExport}
              className="text-sm text-[#888] hover:text-white transition px-3 py-1 rounded border border-[#333]"
            >
              Export
            </button>
            <button
              onClick={() => setEditing(!editing)}
              className="text-sm text-[#888] hover:text-white transition px-3 py-1 rounded border border-[#333]"
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
              className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] font-mono text-sm"
            />
          ) : (
            <pre className="bg-[#0a0a0a] border border-[#222] rounded p-4 font-mono text-sm overflow-auto max-h-[60vh] whitespace-pre-wrap">
              {skill.content}
            </pre>
          )}
        </div>

        <div className="p-6 border-t border-[#1a1a1a] flex justify-between">
          <div className="text-xs text-[#555]">
            {skill.source !== "local" && skill.source_url && (
              <a href={skill.source_url} target="_blank" rel="noopener noreferrer" className="text-[#f97316] hover:underline">
                View source →
              </a>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[#888] hover:text-white transition"
            >
              Close
            </button>
            {editing && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
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
