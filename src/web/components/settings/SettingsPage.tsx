import React, { useState, useEffect } from "react";
import { CheckIcon, CloseIcon, PlusIcon } from "../common/Icons";
import { Modal, useConfirm } from "../common/Modal";
import { useProjects, useAuth, type Project } from "../../context";
import type { Provider } from "../../types";

type SettingsTab = "providers" | "projects" | "account" | "updates" | "data";

export function SettingsPage() {
  const { projectsEnabled } = useProjects();
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: "providers", label: "Providers" },
    ...(projectsEnabled ? [{ key: "projects" as SettingsTab, label: "Projects" }] : []),
    { key: "account", label: "Account" },
    { key: "updates", label: "Updates" },
    { key: "data", label: "Data" },
  ];

  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* Mobile: Horizontal scrolling tabs */}
      <div className="md:hidden border-b border-[#1a1a1a] bg-[#0a0a0a]">
        <div className="flex overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition ${
                activeTab === tab.key
                  ? "border-[#f97316] text-[#f97316]"
                  : "border-transparent text-[#666] hover:text-[#888]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop: Settings Sidebar */}
      <div className="hidden md:block w-48 border-r border-[#1a1a1a] p-4 flex-shrink-0">
        <h2 className="text-sm font-medium text-[#666] uppercase tracking-wider mb-3">Settings</h2>
        <nav className="space-y-1">
          {tabs.map(tab => (
            <SettingsNavItem
              key={tab.key}
              label={tab.label}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            />
          ))}
        </nav>
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-auto p-4 md:p-6">
        {activeTab === "providers" && <ProvidersSettings />}
        {activeTab === "projects" && projectsEnabled && <ProjectsSettings />}
        {activeTab === "account" && <AccountSettings />}
        {activeTab === "updates" && <UpdatesSettings />}
        {activeTab === "data" && <DataSettings />}
      </div>
    </div>
  );
}

function SettingsNavItem({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded text-sm transition ${
        active
          ? "bg-[#1a1a1a] text-[#e0e0e0]"
          : "text-[#666] hover:bg-[#111] hover:text-[#888]"
      }`}
    >
      {label}
    </button>
  );
}

function ProvidersSettings() {
  const { authFetch } = useAuth();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  const fetchProviders = async () => {
    const res = await authFetch("/api/providers");
    const data = await res.json();
    setProviders(data.providers || []);
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const saveKey = async () => {
    if (!selectedProvider || !apiKey) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      setTesting(true);
      const testRes = await authFetch(`/api/keys/${selectedProvider}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey }),
      });
      const testData = await testRes.json();
      setTesting(false);

      if (!testData.valid) {
        setError(testData.error || "API key is invalid");
        setSaving(false);
        return;
      }

      const saveRes = await authFetch(`/api/keys/${selectedProvider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey }),
      });

      const saveData = await saveRes.json();
      if (!saveRes.ok) {
        setError(saveData.error || "Failed to save key");
      } else {
        // Build success message including agent restart info
        let msg = "API key saved!";
        if (saveData.restartedAgents && saveData.restartedAgents.length > 0) {
          const successCount = saveData.restartedAgents.filter((a: { success: boolean }) => a.success).length;
          const failCount = saveData.restartedAgents.length - successCount;
          if (failCount === 0) {
            msg += ` Restarted ${successCount} agent${successCount > 1 ? 's' : ''} with new key.`;
          } else {
            msg += ` Restarted ${successCount}/${saveData.restartedAgents.length} agents.`;
          }
        }
        setSuccess(msg);
        setApiKey("");
        setSelectedProvider(null);
        fetchProviders();
      }
    } catch (e) {
      setError("Failed to save key");
    }
    setSaving(false);
  };

  const deleteKey = async (providerId: string) => {
    const confirmed = await confirm("Are you sure you want to remove this API key?", { confirmText: "Remove", title: "Remove API Key" });
    if (!confirmed) return;
    await authFetch(`/api/keys/${providerId}`, { method: "DELETE" });
    fetchProviders();
  };

  const llmProviders = providers.filter(p => p.type === "llm");
  const integrations = providers.filter(p => p.type === "integration");
  const llmConfiguredCount = llmProviders.filter(p => p.hasKey).length;
  const intConfiguredCount = integrations.filter(p => p.hasKey).length;

  // Auto-dismiss success message after 5 seconds
  useEffect(() => {
    if (success && !selectedProvider) {
      const timer = setTimeout(() => setSuccess(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [success, selectedProvider]);

  return (
    <>
    {ConfirmDialog}
    <div className="space-y-10">
      {/* Global Success Banner */}
      {success && !selectedProvider && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400">
            <CheckIcon className="w-5 h-5" />
            <span>{success}</span>
          </div>
          <button
            onClick={() => setSuccess(null)}
            className="text-green-400 hover:text-green-300"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* AI Providers Section */}
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold mb-1">AI Providers</h1>
          <p className="text-[#666]">
            Manage your API keys for AI providers. {llmConfiguredCount} of {llmProviders.length} configured.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {llmProviders.map(provider => (
            <ProviderKeyCard
              key={provider.id}
              provider={provider}
              isEditing={selectedProvider === provider.id}
              apiKey={apiKey}
              saving={saving}
              testing={testing}
              error={selectedProvider === provider.id ? error : null}
              success={selectedProvider === provider.id ? success : null}
              onStartEdit={() => {
                setSelectedProvider(provider.id);
                setError(null);
                setSuccess(null);
              }}
              onCancelEdit={() => {
                setSelectedProvider(null);
                setApiKey("");
                setError(null);
              }}
              onApiKeyChange={setApiKey}
              onSave={saveKey}
              onDelete={() => deleteKey(provider.id)}
            />
          ))}
        </div>
      </div>

      {/* MCP Integrations Section */}
      <div>
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-1">MCP Integrations</h2>
          <p className="text-[#666]">
            Connect to MCP gateways for tool integrations. {intConfiguredCount} of {integrations.length} configured.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {integrations.map(provider => (
            <IntegrationKeyCard
              key={provider.id}
              provider={provider}
              isEditing={selectedProvider === provider.id}
              apiKey={apiKey}
              saving={saving}
              testing={testing}
              error={selectedProvider === provider.id ? error : null}
              success={selectedProvider === provider.id ? success : null}
              onStartEdit={() => {
                setSelectedProvider(provider.id);
                setError(null);
                setSuccess(null);
              }}
              onCancelEdit={() => {
                setSelectedProvider(null);
                setApiKey("");
                setError(null);
              }}
              onApiKeyChange={setApiKey}
              onSave={saveKey}
              onDelete={() => deleteKey(provider.id)}
            />
          ))}
        </div>
      </div>
    </div>
    </>
  );
}

const DEFAULT_PROJECT_COLORS = [
  "#f97316", // orange
  "#6366f1", // indigo
  "#22c55e", // green
  "#ef4444", // red
  "#3b82f6", // blue
  "#a855f7", // purple
  "#14b8a6", // teal
  "#f59e0b", // amber
];

function ProjectsSettings() {
  const { projects, createProject, updateProject, deleteProject } = useProjects();
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  const handleDelete = async (id: string) => {
    const confirmed = await confirm("Are you sure you want to delete this project? Agents in this project will become unassigned.", { confirmText: "Delete", title: "Delete Project" });
    if (!confirmed) return;
    await deleteProject(id);
  };

  const openCreate = () => {
    setEditingProject(null);
    setShowModal(true);
  };

  const openEdit = (project: Project) => {
    setEditingProject(project);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingProject(null);
  };

  return (
    <>
    {ConfirmDialog}
    <div className="max-w-4xl w-full">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold mb-1">Projects</h1>
          <p className="text-[#666]">
            Organize agents into projects for better management.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition flex-shrink-0"
        >
          <PlusIcon className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Project List */}
      {projects.length === 0 ? (
        <div className="text-center py-12 text-[#666]">
          <p className="text-lg mb-2">No projects yet</p>
          <p className="text-sm">Create a project to organize your agents.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <div
              key={project.id}
              className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 flex items-center gap-4"
            >
              <div
                className="w-4 h-4 rounded-full flex-shrink-0"
                style={{ backgroundColor: project.color }}
              />
              <div className="flex-1 min-w-0">
                <h3 className="font-medium">{project.name}</h3>
                {project.description && (
                  <p className="text-sm text-[#666] truncate">{project.description}</p>
                )}
                <p className="text-xs text-[#666] mt-1">
                  {project.agentCount} agent{project.agentCount !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openEdit(project)}
                  className="text-sm text-[#888] hover:text-[#e0e0e0] px-2 py-1"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(project.id)}
                  className="text-sm text-red-400 hover:text-red-300 px-2 py-1"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Project Modal */}
      {showModal && (
        <ProjectModal
          project={editingProject}
          onSave={async (data) => {
            if (editingProject) {
              const result = await updateProject(editingProject.id, data);
              if (result) closeModal();
              return !!result;
            } else {
              const result = await createProject(data);
              if (result) closeModal();
              return !!result;
            }
          }}
          onClose={closeModal}
        />
      )}
    </div>
    </>
  );
}

interface ProjectModalProps {
  project: Project | null;
  onSave: (data: { name: string; description?: string; color: string }) => Promise<boolean>;
  onClose: () => void;
}

function ProjectModal({ project, onSave, onClose }: ProjectModalProps) {
  const [name, setName] = useState(project?.name || "");
  const [description, setDescription] = useState(project?.description || "");
  const [color, setColor] = useState(
    project?.color || DEFAULT_PROJECT_COLORS[Math.floor(Math.random() * DEFAULT_PROJECT_COLORS.length)]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    const success = await onSave({ name, description: description || undefined, color });
    setSaving(false);
    if (!success) {
      setError(project ? "Failed to update project" : "Failed to create project");
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 className="text-xl font-semibold mb-6">{project ? "Edit Project" : "Create New Project"}</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-[#666] mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            placeholder="My Project"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm text-[#666] mb-1">Description (optional)</label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            placeholder="A short description"
          />
        </div>

        <div>
          <label className="block text-sm text-[#666] mb-1">Color</label>
          <div className="flex gap-3 flex-wrap">
            {DEFAULT_PROJECT_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-10 h-10 rounded-full transition ${
                  color === c ? "ring-2 ring-white ring-offset-2 ring-offset-[#111]" : "hover:scale-110"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>

      <div className="flex gap-3 mt-6">
        <button
          onClick={onClose}
          className="flex-1 border border-[#333] hover:border-[#f97316] hover:text-[#f97316] px-4 py-2 rounded font-medium transition"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !name.trim()}
          className="flex-1 bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
        >
          {saving ? "Saving..." : project ? "Update" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

interface ProviderKeyCardProps {
  provider: Provider;
  isEditing: boolean;
  apiKey: string;
  saving: boolean;
  testing: boolean;
  error: string | null;
  success: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  lastChecked: string | null;
}

interface AllVersionInfo {
  apteva: VersionInfo;
  agent: VersionInfo;
  isDocker?: boolean;
}

function UpdatesSettings() {
  const { authFetch } = useAuth();
  const [versions, setVersions] = useState<AllVersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const checkForUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await authFetch("/api/version");
      if (!res.ok) throw new Error("Failed to check for updates");
      const data = await res.json();
      setVersions(data);
    } catch (e) {
      setError("Failed to check for updates");
    }
    setChecking(false);
  };

  const updateAgent = async () => {
    setUpdatingAgent(true);
    setError(null);
    setUpdateSuccess(null);
    try {
      const res = await authFetch("/api/version/update", { method: "POST" });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Update failed");
      } else {
        const restartedCount = data.restarted?.length || 0;
        const restartMsg = restartedCount > 0
          ? ` ${restartedCount} running agent${restartedCount > 1 ? 's' : ''} restarted.`
          : '';
        setUpdateSuccess(`Agent binary updated to v${data.version}.${restartMsg}`);
        await checkForUpdates();
      }
    } catch (e) {
      setError("Failed to update agent");
    }
    setUpdatingAgent(false);
  };

  useEffect(() => {
    checkForUpdates();
  }, []);

  const copyCommand = (cmd: string, id: string) => {
    navigator.clipboard.writeText(cmd);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const hasAnyUpdate = versions?.apteva.updateAvailable || versions?.agent.updateAvailable;

  return (
    <div className="max-w-4xl w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Updates</h1>
        <p className="text-[#666]">
          Check for new versions of apteva and the agent binary.
        </p>
      </div>

      {checking && !versions ? (
        <div className="text-[#666]">Checking version info...</div>
      ) : error && !versions ? (
        <div className="text-red-400">{error}</div>
      ) : versions?.isDocker ? (
        /* Docker Environment */
        <div className="space-y-6">
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.186.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.186.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.186.186 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.186.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186H5.136a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
              </svg>
              <span className="font-medium">Docker Environment</span>
            </div>
            <p className="text-sm text-[#888]">
              Updates are automatic when you pull a new image version.
            </p>
          </div>

          {/* Current Version */}
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-lg">Current Version</h3>
                <p className="text-sm text-[#666]">apteva + agent binary</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-mono">v{versions.apteva.installed || "?"}</div>
              </div>
            </div>

            {hasAnyUpdate ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <p className="text-sm text-[#888] mb-3">
                  A newer version (v{versions.apteva.latest}) is available. To update:
                </p>
                <div className="space-y-2">
                  <code className="block bg-[#0a0a0a] px-3 py-2 rounded font-mono text-sm text-[#888]">
                    docker pull apteva/apteva:latest
                  </code>
                  <code className="block bg-[#0a0a0a] px-3 py-2 rounded font-mono text-sm text-[#888]">
                    docker compose up -d
                  </code>
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText("docker pull apteva/apteva:latest && docker compose up -d");
                    setCopied("docker");
                    setTimeout(() => setCopied(null), 2000);
                  }}
                  className="mt-3 px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#222] rounded text-sm"
                >
                  {copied === "docker" ? "Copied!" : "Copy commands"}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckIcon className="w-4 h-4" />
                Up to date
              </div>
            )}
          </div>

          <p className="text-xs text-[#555]">
            Your data is stored in a Docker volume and persists across updates.
          </p>
        </div>
      ) : versions ? (
        /* Non-Docker Environment */
        <div className="space-y-6">
          {updateSuccess && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-green-400">
              {updateSuccess}
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
              {error}
            </div>
          )}

          {/* Apteva App Version */}
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-lg">apteva</h3>
                <p className="text-sm text-[#666]">The app you're running</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-mono">v{versions.apteva.installed || "?"}</div>
                {versions.apteva.updateAvailable && (
                  <div className="text-sm text-[#f97316]">→ v{versions.apteva.latest}</div>
                )}
              </div>
            </div>

            {versions.apteva.updateAvailable ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <p className="text-sm text-[#888] mb-3">
                  Update by running:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-[#0a0a0a] px-3 py-2 rounded font-mono text-sm text-[#888]">
                    npx apteva@latest
                  </code>
                  <button
                    onClick={() => copyCommand("npx apteva@latest", "apteva")}
                    className="px-3 py-2 bg-[#1a1a1a] hover:bg-[#222] rounded text-sm"
                  >
                    {copied === "apteva" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckIcon className="w-4 h-4" />
                Up to date
              </div>
            )}
          </div>

          {/* Agent Binary Version */}
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-lg">Agent Binary</h3>
                <p className="text-sm text-[#666]">The Go binary that runs agents</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-mono">v{versions.agent.installed || "?"}</div>
                {versions.agent.updateAvailable && (
                  <div className="text-sm text-[#f97316]">→ v{versions.agent.latest}</div>
                )}
              </div>
            </div>

            {versions.agent.updateAvailable ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <p className="text-sm text-[#888] mb-3">
                  A new version is available. Stop all agents before updating.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={updateAgent}
                    disabled={updatingAgent}
                    className="px-4 py-2 bg-[#f97316] text-black rounded font-medium text-sm disabled:opacity-50"
                  >
                    {updatingAgent ? "Updating..." : "Update Agent"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckIcon className="w-4 h-4" />
                Up to date
              </div>
            )}
          </div>

          {!hasAnyUpdate && !updateSuccess && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center gap-2 text-green-400">
              <CheckIcon className="w-5 h-5" />
              Everything is up to date!
            </div>
          )}

          <button
            onClick={checkForUpdates}
            disabled={checking}
            className="text-sm text-[#666] hover:text-[#888] disabled:opacity-50"
          >
            {checking ? "Checking..." : "Check for updates"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProviderKeyCard({
  provider,
  isEditing,
  apiKey,
  saving,
  testing,
  error,
  success,
  onStartEdit,
  onCancelEdit,
  onApiKeyChange,
  onSave,
  onDelete,
}: ProviderKeyCardProps) {
  const isOllama = provider.id === "ollama";
  const [ollamaStatus, setOllamaStatus] = React.useState<{ connected: boolean; modelCount?: number } | null>(null);

  // Check Ollama status when configured
  React.useEffect(() => {
    if (isOllama && provider.hasKey) {
      fetch("/api/providers/ollama/status")
        .then(res => res.json())
        .then(data => setOllamaStatus({ connected: data.connected, modelCount: data.modelCount }))
        .catch(() => setOllamaStatus({ connected: false }));
    }
  }, [isOllama, provider.hasKey]);

  return (
    <div className={`bg-[#111] border rounded-lg p-4 ${
      provider.hasKey ? 'border-green-500/20' : 'border-[#1a1a1a]'
    }`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="font-medium">{provider.name}</h3>
          <p className="text-sm text-[#666] truncate">
            {provider.type === "integration"
              ? (provider.description || "MCP integration")
              : isOllama
                ? "Run models locally"
                : `${provider.models.length} models`}
          </p>
        </div>
        {provider.hasKey ? (
          <span className={`text-xs flex items-center gap-1 px-2 py-1 rounded whitespace-nowrap flex-shrink-0 ${
            isOllama && ollamaStatus
              ? ollamaStatus.connected
                ? "text-green-400 bg-green-500/10"
                : "text-yellow-400 bg-yellow-500/10"
              : "text-green-400 bg-green-500/10"
          }`}>
            {isOllama && ollamaStatus ? (
              ollamaStatus.connected ? (
                <><CheckIcon className="w-3 h-3" />{ollamaStatus.modelCount} models</>
              ) : (
                <>Not running</>
              )
            ) : (
              <><CheckIcon className="w-3 h-3" />{provider.keyHint}</>
            )}
          </span>
        ) : (
          <span className="text-[#666] text-xs bg-[#1a1a1a] px-2 py-1 rounded whitespace-nowrap flex-shrink-0">
            Not configured
          </span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-[#1a1a1a]">
        {isEditing ? (
          <div className="space-y-3">
            <input
              type={isOllama ? "text" : "password"}
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              placeholder={isOllama
                ? "http://localhost:11434"
                : provider.hasKey ? "Enter new API key..." : "Enter API key..."}
              autoFocus
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
            {isOllama && (
              <p className="text-xs text-[#666]">
                Enter your Ollama server URL. Default is http://localhost:11434
              </p>
            )}
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {success && <p className="text-green-400 text-sm">{success}</p>}
            <div className="flex gap-2">
              <button
                onClick={onCancelEdit}
                className="flex-1 px-3 py-1.5 border border-[#333] rounded text-sm hover:border-[#666]"
              >
                Cancel
              </button>
              <button
                onClick={onSave}
                disabled={!apiKey || saving}
                className="flex-1 px-3 py-1.5 bg-[#f97316] text-black rounded text-sm font-medium disabled:opacity-50"
              >
                {testing ? "Validating..." : saving ? "Saving..." : isOllama ? "Connect" : "Save"}
              </button>
            </div>
          </div>
        ) : provider.hasKey ? (
          <div className="flex items-center justify-between">
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[#3b82f6] hover:underline"
            >
              {isOllama ? "Download Ollama" : "View docs"}
            </a>
            <div className="flex items-center gap-3">
              <button
                onClick={onStartEdit}
                className="text-sm text-[#888] hover:text-[#e0e0e0]"
              >
                {isOllama ? "Change URL" : "Update key"}
              </button>
              <button
                onClick={onDelete}
                className="text-red-400 hover:text-red-300 text-sm"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[#3b82f6] hover:underline"
            >
              {isOllama ? "Download Ollama" : "Get API key"}
            </a>
            <button
              onClick={onStartEdit}
              className="text-sm text-[#f97316] hover:text-[#fb923c]"
            >
              {isOllama ? "Configure" : "+ Add key"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function IntegrationKeyCard({
  provider,
  isEditing,
  apiKey,
  saving,
  testing,
  error,
  success,
  onStartEdit,
  onCancelEdit,
  onApiKeyChange,
  onSave,
  onDelete,
}: ProviderKeyCardProps) {
  return (
    <div className={`bg-[#111] border rounded-lg p-4 ${
      provider.hasKey ? 'border-[#f97316]/20' : 'border-[#1a1a1a]'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-medium">{provider.name}</h3>
          <p className="text-sm text-[#666]">{provider.description || "MCP integration"}</p>
        </div>
        {provider.hasKey ? (
          <span className="text-[#f97316] text-xs flex items-center gap-1 bg-[#f97316]/10 px-2 py-1 rounded">
            <CheckIcon className="w-3 h-3" />
            {provider.keyHint}
          </span>
        ) : (
          <span className="text-[#666] text-xs bg-[#1a1a1a] px-2 py-1 rounded">
            Not configured
          </span>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-[#1a1a1a]">
        {isEditing ? (
          <div className="space-y-3">
            <input
              type="password"
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              placeholder={provider.hasKey ? "Enter new API key..." : "Enter API key..."}
              autoFocus
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {success && <p className="text-green-400 text-sm">{success}</p>}
            <div className="flex gap-2">
              <button
                onClick={onCancelEdit}
                className="flex-1 px-3 py-1.5 border border-[#333] rounded text-sm hover:border-[#666]"
              >
                Cancel
              </button>
              <button
                onClick={onSave}
                disabled={!apiKey || saving}
                className="flex-1 px-3 py-1.5 bg-[#f97316] text-black rounded text-sm font-medium disabled:opacity-50"
              >
                {testing ? "Validating..." : saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : provider.hasKey ? (
          <div className="flex items-center justify-between">
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[#3b82f6] hover:underline"
            >
              View docs
            </a>
            <div className="flex items-center gap-3">
              <button
                onClick={onStartEdit}
                className="text-sm text-[#888] hover:text-[#e0e0e0]"
              >
                Update key
              </button>
              <button
                onClick={onDelete}
                className="text-red-400 hover:text-red-300 text-sm"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[#3b82f6] hover:underline"
            >
              Get API key
            </a>
            <button
              onClick={onStartEdit}
              className="text-sm text-[#f97316] hover:text-[#fb923c]"
            >
              + Add key
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountSettings() {
  const { authFetch, user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleChangePassword = async () => {
    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage({ type: "error", text: "All fields are required" });
      return;
    }

    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "New passwords do not match" });
      return;
    }

    if (newPassword.length < 8) {
      setMessage({ type: "error", text: "Password must be at least 8 characters" });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const res = await authFetch("/api/auth/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await res.json();

      if (res.ok) {
        setMessage({ type: "success", text: "Password updated successfully" });
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        setMessage({ type: "error", text: data.error || "Failed to update password" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to update password" });
    }

    setSaving(false);
  };

  return (
    <div className="max-w-4xl w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Account Settings</h1>
        <p className="text-[#666]">Manage your account and security.</p>
      </div>

      {/* User Info */}
      {user && (
        <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 mb-6">
          <h3 className="font-medium mb-3">Profile</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[#666]">Username</span>
              <span>{user.username}</span>
            </div>
            {user.email && (
              <div className="flex justify-between">
                <span className="text-[#666]">Email</span>
                <span>{user.email}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-[#666]">Role</span>
              <span className="capitalize">{user.role}</span>
            </div>
          </div>
        </div>
      )}

      {/* Change Password */}
      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4">
        <h3 className="font-medium mb-4">Change Password</h3>

        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-sm text-[#666] mb-1">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#666] mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#666] mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          {message && (
            <div className={`p-3 rounded text-sm ${
              message.type === "success"
                ? "bg-green-500/10 text-green-400 border border-green-500/30"
                : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}>
              {message.text}
            </div>
          )}

          <button
            onClick={handleChangePassword}
            disabled={saving || !currentPassword || !newPassword || !confirmPassword}
            className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black rounded text-sm font-medium transition"
          >
            {saving ? "Updating..." : "Update Password"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DataSettings() {
  const { authFetch } = useAuth();
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  const fetchStats = async () => {
    try {
      const res = await authFetch("/api/telemetry/stats");
      const data = await res.json();
      setEventCount(data.stats?.total_events || 0);
    } catch {
      setEventCount(null);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const clearTelemetry = async () => {
    const confirmed = await confirm("Are you sure you want to delete all telemetry data? This cannot be undone.", { confirmText: "Clear All", title: "Clear Telemetry Data" });
    if (!confirmed) return;

    setClearing(true);
    setMessage(null);

    try {
      const res = await authFetch("/api/telemetry/clear", { method: "POST" });
      const data = await res.json();

      if (res.ok) {
        setMessage({ type: "success", text: `Cleared ${data.deleted || 0} telemetry events.` });
        setEventCount(0);
      } else {
        setMessage({ type: "error", text: data.error || "Failed to clear telemetry" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to clear telemetry" });
    }

    setClearing(false);
  };

  return (
    <>
    {ConfirmDialog}
    <div className="max-w-4xl w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Data Management</h1>
        <p className="text-[#666]">Manage stored data and telemetry.</p>
      </div>

      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4">
        <h3 className="font-medium mb-2">Telemetry Data</h3>
        <p className="text-sm text-[#666] mb-4">
          {eventCount !== null
            ? `${eventCount.toLocaleString()} events stored`
            : "Loading..."}
        </p>

        {message && (
          <div className={`mb-4 p-3 rounded text-sm ${
            message.type === "success"
              ? "bg-green-500/10 text-green-400 border border-green-500/30"
              : "bg-red-500/10 text-red-400 border border-red-500/30"
          }`}>
            {message.text}
          </div>
        )}

        <button
          onClick={clearTelemetry}
          disabled={clearing || eventCount === 0}
          className="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition"
        >
          {clearing ? "Clearing..." : "Clear All Telemetry"}
        </button>
      </div>
    </div>
    </>
  );
}
