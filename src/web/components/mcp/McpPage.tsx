import React, { useState, useEffect } from "react";
import { McpIcon } from "../common/Icons";
import { useAuth, useProjects } from "../../context";
import { useConfirm, useAlert } from "../common/Modal";
import { Select } from "../common/Select";
import type { McpTool, McpToolCallResult } from "../../types";
import { IntegrationsPanel } from "./IntegrationsPanel";

interface McpServer {
  id: string;
  name: string;
  type: "npm" | "pip" | "github" | "http" | "custom";
  package: string | null;
  pip_module: string | null;  // For pip type: module to run (e.g., "late.mcp")
  command: string | null;
  args: string | null;
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  source: string | null; // "composio", "smithery", or null for local
  project_id: string | null; // null = global
  created_at: string;
}

interface RegistryServer {
  id: string;
  name: string;
  fullName: string;
  description: string;
  version?: string;
  repository?: string;
  npmPackage: string | null;
  remoteUrl: string | null;
  transport: string;
}

export function McpPage() {
  const { authFetch } = useAuth();
  const { projects, currentProjectId } = useProjects();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [activeTab, setActiveTab] = useState<"servers" | "hosted" | "registry">("servers");
  const { confirm, ConfirmDialog } = useConfirm();

  const hasProjects = projects.length > 0;

  const fetchServers = async () => {
    try {
      const res = await authFetch("/api/mcp/servers");
      const data = await res.json();
      setServers(data.servers || []);
    } catch (e) {
      console.error("Failed to fetch MCP servers:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchServers();
  }, [authFetch]);

  // Filter servers based on global project selector
  // When a project is selected, show global + that project's servers
  const filteredServers = servers.filter(server => {
    if (!currentProjectId) return true; // "All Projects" - show everything
    if (currentProjectId === "unassigned") return server.project_id === null; // Only global
    // Project selected: show global + project-specific
    return server.project_id === null || server.project_id === currentProjectId;
  });

  const startServer = async (id: string) => {
    try {
      await authFetch(`/api/mcp/servers/${id}/start`, { method: "POST" });
      fetchServers();
    } catch (e) {
      console.error("Failed to start server:", e);
    }
  };

  const stopServer = async (id: string) => {
    try {
      await authFetch(`/api/mcp/servers/${id}/stop`, { method: "POST" });
      fetchServers();
    } catch (e) {
      console.error("Failed to stop server:", e);
    }
  };

  const deleteServer = async (id: string) => {
    const confirmed = await confirm("Delete this MCP server?", { confirmText: "Delete", title: "Delete Server" });
    if (!confirmed) return;
    try {
      await authFetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
      if (selectedServer?.id === id) {
        setSelectedServer(null);
      }
      fetchServers();
    } catch (e) {
      console.error("Failed to delete server:", e);
    }
  };

  const renameServer = async (id: string, newName: string) => {
    try {
      await authFetch(`/api/mcp/servers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      fetchServers();
    } catch (e) {
      console.error("Failed to rename server:", e);
    }
  };

  const updateServer = async (id: string, updates: Partial<McpServer>) => {
    try {
      await authFetch(`/api/mcp/servers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      fetchServers();
    } catch (e) {
      console.error("Failed to update server:", e);
      throw e;
    }
  };

  return (
    <>
    {ConfirmDialog}
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold mb-1">MCP Servers</h1>
            <p className="text-[var(--color-text-muted)]">
              Manage Model Context Protocol servers for tool integrations.
            </p>
          </div>
          {activeTab === "servers" && (
            <button
              onClick={() => setShowAdd(true)}
              className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-2 rounded font-medium transition"
            >
              + Add Server
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-[var(--color-surface)] card p-1 w-fit">
          <button
            onClick={() => setActiveTab("servers")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "servers"
                ? "bg-[var(--color-surface-raised)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            My Servers
          </button>
          <button
            onClick={() => setActiveTab("hosted")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "hosted"
                ? "bg-[var(--color-surface-raised)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            Hosted Services
          </button>
          <button
            onClick={() => setActiveTab("registry")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "registry"
                ? "bg-[var(--color-surface-raised)] text-white"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            }`}
          >
            Browse Registry
          </button>
        </div>

        {/* My Servers Tab */}
        {activeTab === "servers" && (
          <>
            {/* Loading */}
            {loading && (
              <div className="text-center py-8 text-[var(--color-text-muted)]">Loading...</div>
            )}

            {/* Empty State */}
            {!loading && filteredServers.length === 0 && servers.length === 0 && (
              <div className="bg-[var(--color-surface)] card p-8 text-center">
                <McpIcon className="w-12 h-12 text-[var(--color-border-light)] mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No MCP servers configured</h3>
                <p className="text-[var(--color-text-muted)] mb-6 max-w-md mx-auto">
                  MCP servers extend your agents with tools like file access, web browsing,
                  database connections, and more.
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => setShowAdd(true)}
                    className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-2 rounded font-medium transition"
                  >
                    Add Manually
                  </button>
                  <button
                    onClick={() => setActiveTab("registry")}
                    className="border border-[var(--color-border-light)] hover:border-[var(--color-text-muted)] px-4 py-2 rounded font-medium transition"
                  >
                    Browse Registry
                  </button>
                </div>
              </div>
            )}

            {/* Empty filter state */}
            {!loading && filteredServers.length === 0 && servers.length > 0 && (
              <div className="bg-[var(--color-surface)] card p-6 text-center">
                <p className="text-[var(--color-text-muted)]">No servers match this filter.</p>
              </div>
            )}

            {/* Main content with server list and tools panel */}
            {!loading && filteredServers.length > 0 && (
              <div className="flex gap-6">
                {/* Server List */}
                <div className={`space-y-3 ${selectedServer ? "w-1/2" : "w-full"}`}>
                  {filteredServers.map(server => {
                    const isRemote = server.type === "http" && server.url;
                    const isAvailable = isRemote || server.status === "running";
                    const project = hasProjects && server.project_id
                      ? projects.find(p => p.id === server.project_id)
                      : null;
                    return (
                      <McpServerCard
                        key={server.id}
                        server={server}
                        project={project}
                        selected={selectedServer?.id === server.id}
                        onSelect={() => setSelectedServer(isAvailable ? server : null)}
                        onStart={() => startServer(server.id)}
                        onStop={() => stopServer(server.id)}
                        onDelete={() => deleteServer(server.id)}
                        onEdit={async () => {
                          // Fetch full server details (with decrypted env/headers) for editing
                          try {
                            const res = await authFetch(`/api/mcp/servers/${server.id}`);
                            const data = await res.json();
                            setEditingServer(data.server || server);
                          } catch {
                            setEditingServer(server);
                          }
                        }}
                      />
                    );
                  })}
                </div>

                {/* Tools Panel */}
                {selectedServer && (
                  <div className="w-1/2">
                    <ToolsPanel
                      server={selectedServer}
                      onClose={() => setSelectedServer(null)}
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Hosted Services Tab */}
        {activeTab === "hosted" && (
          <HostedServices onServerAdded={fetchServers} projectId={currentProjectId} />
        )}

        {/* Browse Registry Tab */}
        {activeTab === "registry" && (
          <RegistryBrowser
            onInstall={(server) => {
              // After installing, switch to servers tab and refresh
              fetchServers();
              setActiveTab("servers");
            }}
          />
        )}

        {/* Info - only show on servers tab */}
        {activeTab === "servers" && (
          <div className="mt-8 p-4 bg-[var(--color-surface)] card">
            <h3 className="font-medium mb-2">Quick Start</h3>
            <p className="text-sm text-[var(--color-text-muted)] mb-3">
              Add an MCP server by providing its npm package name. For example:
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem" },
                { name: "fetch", pkg: "@modelcontextprotocol/server-fetch" },
                { name: "memory", pkg: "@modelcontextprotocol/server-memory" },
              ].map(s => (
                <code key={s.name} className="text-xs bg-[var(--color-bg)] px-2 py-1 rounded">
                  {s.pkg}
                </code>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add Server Modal */}
      {showAdd && (
        <AddServerModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            fetchServers();
          }}
          projects={hasProjects ? projects : undefined}
          defaultProjectId={currentProjectId && currentProjectId !== "unassigned" ? currentProjectId : null}
        />
      )}

      {editingServer && (
        <EditServerModal
          server={editingServer}
          projects={hasProjects ? projects : undefined}
          onClose={() => setEditingServer(null)}
          onSaved={() => {
            setEditingServer(null);
            fetchServers();
          }}
        />
      )}
    </div>
    </>
  );
}

function McpServerCard({
  server,
  project,
  selected,
  onSelect,
  onStart,
  onStop,
  onDelete,
  onEdit,
}: {
  server: McpServer;
  project?: { id: string; name: string; color: string } | null;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  // Remote/hosted servers (http type with url) are always available
  const isRemote = server.type === "http" && server.url;
  const isAvailable = isRemote || server.status === "running";

  // Determine what to show as the server info
  const getServerInfo = () => {
    if (isRemote) {
      // Show source (composio, smithery) or just "remote"
      const source = server.source || "remote";
      return `${source} • http`;
    }
    return `${server.type} • ${server.package || server.command || "custom"}${
      server.status === "running" && server.port ? ` • :${server.port}` : ""
    }`;
  };

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
    if (server.project_id === null) {
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
      className={`bg-[var(--color-surface)] border rounded-lg p-4 cursor-pointer transition ${
        selected ? "border-[var(--color-accent)]" : "border-[var(--color-border)] hover:border-[var(--color-border-light)]"
      }`}
      onClick={isAvailable ? onSelect : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${
            isAvailable ? "bg-green-400" : "bg-[var(--color-scrollbar)]"
          }`} />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{server.name}</h3>
              {getScopeBadge()}
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{getServerInfo()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] px-3 py-1 transition"
            title="Edit server settings"
          >
            Edit
          </button>
          {isRemote ? (
            // Remote servers: no start/stop, just delete
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-sm text-[var(--color-text-muted)] hover:text-red-400 px-3 py-1 transition"
            >
              Remove
            </button>
          ) : server.status === "running" ? (
            // Local running server: tools + stop + delete
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onSelect(); }}
                className="text-sm text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] px-3 py-1 transition"
              >
                Tools
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onStop(); }}
                className="text-sm text-[var(--color-text-muted)] hover:text-red-400 px-3 py-1 transition"
              >
                Stop
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-sm text-[var(--color-text-muted)] hover:text-red-400 px-3 py-1 transition"
              >
                Delete
              </button>
            </>
          ) : (
            // Local stopped server: start + delete
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onStart(); }}
                className="text-sm text-[var(--color-text-muted)] hover:text-green-400 px-3 py-1 transition"
              >
                Start
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-sm text-[var(--color-text-muted)] hover:text-red-400 px-3 py-1 transition"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolsPanel({
  server,
  onClose,
}: {
  server: McpServer;
  onClose: () => void;
}) {
  const { authFetch } = useAuth();
  const [tools, setTools] = useState<McpTool[]>([]);
  const [serverInfo, setServerInfo] = useState<{ name: string; version: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);

  useEffect(() => {
    const fetchTools = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`/api/mcp/servers/${server.id}/tools`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to fetch tools");
          return;
        }
        setTools(data.tools || []);
        setServerInfo(data.serverInfo || null);
      } catch (e) {
        setError(`Failed to fetch tools: ${e}`);
      } finally {
        setLoading(false);
      }
    };

    fetchTools();
  }, [server.id, authFetch]);

  return (
    <div className="bg-[var(--color-surface)] card overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
        <div>
          <h3 className="font-medium">{server.name} Tools</h3>
          {serverInfo && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {serverInfo.name} v{serverInfo.version}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] text-xl leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="p-4 max-h-[500px] overflow-auto">
        {loading && <p className="text-[var(--color-text-muted)]">Loading tools...</p>}

        {error && (
          <div className="text-red-400 text-sm p-3 bg-red-500/10 rounded">
            {error}
          </div>
        )}

        {!loading && !error && tools.length === 0 && (
          <p className="text-[var(--color-text-muted)]">No tools available from this server.</p>
        )}

        {!loading && !error && tools.length > 0 && !selectedTool && (
          <div className="space-y-2">
            {tools.map(tool => (
              <button
                key={tool.name}
                onClick={() => setSelectedTool(tool)}
                className="w-full text-left p-3 bg-[var(--color-bg)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-border-light)] rounded transition"
              >
                <div className="font-medium text-sm">{tool.name}</div>
                {tool.description && (
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">{tool.description}</div>
                )}
              </button>
            ))}
          </div>
        )}

        {selectedTool && (
          <ToolTester
            serverId={server.id}
            tool={selectedTool}
            onBack={() => setSelectedTool(null)}
          />
        )}
      </div>
    </div>
  );
}

function ToolTester({
  serverId,
  tool,
  onBack,
}: {
  serverId: string;
  tool: McpTool;
  onBack: () => void;
}) {
  const { authFetch } = useAuth();
  const [args, setArgs] = useState<string>("{}");
  const [result, setResult] = useState<McpToolCallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Generate default args from schema
  useEffect(() => {
    const schema = tool.inputSchema;
    if (schema && typeof schema === "object" && "properties" in schema) {
      const properties = schema.properties as Record<string, { type?: string; default?: unknown }>;
      const defaultArgs: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(properties)) {
        if (prop.default !== undefined) {
          defaultArgs[key] = prop.default;
        } else if (prop.type === "string") {
          defaultArgs[key] = "";
        } else if (prop.type === "number" || prop.type === "integer") {
          defaultArgs[key] = 0;
        } else if (prop.type === "boolean") {
          defaultArgs[key] = false;
        } else if (prop.type === "array") {
          defaultArgs[key] = [];
        } else if (prop.type === "object") {
          defaultArgs[key] = {};
        }
      }
      setArgs(JSON.stringify(defaultArgs, null, 2));
    }
  }, [tool]);

  const callTool = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const parsedArgs = JSON.parse(args);
      const res = await authFetch(`/api/mcp/servers/${serverId}/tools/${encodeURIComponent(tool.name)}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: parsedArgs }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to call tool");
        return;
      }

      setResult(data.result);
    } catch (e) {
      setError(`Error: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] text-sm"
        >
          ← Back
        </button>
        <span className="text-[var(--color-text-faint)]">/</span>
        <span className="font-medium">{tool.name}</span>
      </div>

      {/* Description */}
      {tool.description && (
        <p className="text-sm text-[var(--color-text-muted)]">{tool.description}</p>
      )}

      {/* Schema info */}
      {tool.inputSchema && (
        <div className="text-xs">
          <details className="cursor-pointer">
            <summary className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">Input Schema</summary>
            <pre className="mt-2 p-2 bg-[var(--color-bg)] rounded text-[var(--color-text-secondary)] overflow-auto max-h-32">
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* Arguments input */}
      <div>
        <label className="block text-sm text-[var(--color-text-muted)] mb-1">Arguments (JSON)</label>
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 h-32 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)] resize-none"
          placeholder="{}"
        />
      </div>

      {/* Call button */}
      <button
        onClick={callTool}
        disabled={loading}
        className="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
      >
        {loading ? "Calling..." : "Call Tool"}
      </button>

      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm p-3 bg-red-500/10 rounded">
          {error}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-2">
          <div className="text-sm text-[var(--color-text-muted)]">
            Result {result.isError && <span className="text-red-400">(error)</span>}
          </div>
          <div className={`p-3 rounded text-sm ${result.isError ? "bg-red-500/10" : "bg-green-500/10"}`}>
            {result.content.map((block, i) => (
              <div key={i} className="mb-2 last:mb-0">
                {block.type === "text" && (
                  <pre className="whitespace-pre-wrap font-mono text-xs">
                    {block.text}
                  </pre>
                )}
                {block.type === "image" && block.data && (
                  <img
                    src={`data:${block.mimeType || "image/png"};base64,${block.data}`}
                    alt="Tool result"
                    className="max-w-full rounded"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RegistryBrowser({
  onInstall,
}: {
  onInstall: (server: RegistryServer) => void;
}) {
  const { authFetch } = useAuth();
  const [search, setSearch] = useState("");
  const [servers, setServers] = useState<RegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const searchRegistry = async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/mcp/registry?search=${encodeURIComponent(query)}&limit=20`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to search registry");
        setServers([]);
      } else {
        setServers(data.servers || []);
      }
    } catch (e) {
      setError(`Failed to search: ${e}`);
      setServers([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (search.trim()) {
      searchRegistry(search.trim());
    }
  };

  // Load popular servers on mount
  useEffect(() => {
    searchRegistry("");
  }, []);

  const installServer = async (server: RegistryServer) => {
    if (!server.npmPackage) {
      setError("This server does not have an npm package");
      return;
    }

    setInstalling(server.id);
    setError(null);

    try {
      const res = await authFetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: server.name,
          type: "npm",
          package: server.npmPackage,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to add server");
        return;
      }

      onInstall(server);
    } catch (e) {
      setError(`Failed to add server: ${e}`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search MCP servers (e.g., filesystem, github, slack...)"
          className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg px-4 py-3 focus:outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-6 py-3 rounded-lg font-medium transition"
        >
          {loading ? "..." : "Search"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          {error}
        </div>
      )}

      {/* Results */}
      {!loading && searched && servers.length === 0 && (
        <div className="text-center py-8 text-[var(--color-text-muted)]">
          No servers found. Try a different search term.
        </div>
      )}

      {servers.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className="bg-[var(--color-surface)] card p-4 hover:border-[var(--color-border-light)] transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{server.name}</h3>
                  <p className="text-sm text-[var(--color-text-muted)] mt-1 line-clamp-2">
                    {server.description || "No description"}
                  </p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-[var(--color-text-faint)]">
                    {server.version && <span>v{server.version}</span>}
                    <span className={`px-1.5 py-0.5 rounded ${
                      server.npmPackage ? "bg-green-500/10 text-green-400" : "bg-blue-500/10 text-blue-400"
                    }`}>
                      {server.npmPackage ? "npm" : "remote"}
                    </span>
                  </div>
                  <code className="text-xs text-[var(--color-text-faint)] bg-[var(--color-bg)] px-2 py-0.5 rounded mt-2 inline-block truncate max-w-full">
                    {server.npmPackage || server.fullName}
                  </code>
                </div>
                <div className="flex-shrink-0">
                  {server.npmPackage ? (
                    <button
                      onClick={() => installServer(server)}
                      disabled={installing === server.id}
                      className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition disabled:opacity-50"
                    >
                      {installing === server.id ? "Adding..." : "Add"}
                    </button>
                  ) : server.repository ? (
                    <a
                      href={server.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition"
                    >
                      View →
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-8 text-[var(--color-text-muted)]">
          Searching registry...
        </div>
      )}

      {/* Registry info */}
      <div className="p-4 bg-[var(--color-surface)] card text-sm text-[var(--color-text-muted)]">
        <p>
          Servers are sourced from the{" "}
          <a
            href="https://github.com/modelcontextprotocol/servers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] hover:underline"
          >
            official MCP registry
          </a>
          . Not all servers have npm packages - some require manual setup.
        </p>
      </div>
    </div>
  );
}

// Hosted MCP Services (Composio, Smithery, etc.)
interface ComposioConfig {
  id: string;
  name: string;
  toolkits: string[];
  toolsCount: number;
  mcpUrl: string;
  createdAt?: string;
}

function HostedServices({ onServerAdded, projectId }: { onServerAdded?: () => void; projectId?: string | null }) {
  const { authFetch } = useAuth();
  const [activeProvider, setActiveProvider] = useState<"composio" | "smithery" | "agentdojo">("composio");
  const [subTab, setSubTab] = useState<"configs" | "connect">("configs");
  const [composioConnected, setComposioConnected] = useState(false);
  const [smitheryConnected, setSmitheryConnected] = useState(false);
  const [agentDojoConnected, setAgentDojoConnected] = useState(false);
  const [composioConfigs, setComposioConfigs] = useState<ComposioConfig[]>([]);
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [addingConfig, setAddingConfig] = useState<string | null>(null);
  const { alert, AlertDialog } = useAlert();

  const fetchStatus = async () => {
    try {
      const serversUrl = projectId && projectId !== "unassigned"
        ? `/api/mcp/servers?project=${encodeURIComponent(projectId)}`
        : "/api/mcp/servers";
      const [providersRes, serversRes] = await Promise.all([
        authFetch("/api/providers"),
        authFetch(serversUrl),
      ]);
      const providersData = await providersRes.json();
      const serversData = await serversRes.json();

      const providers = providersData.providers || [];
      const servers = serversData.servers || [];

      // Track which Composio config IDs are already added as servers
      // Extract config ID from URLs like https://backend.composio.dev/v3/mcp/{configId}/mcp?user_id=...
      const composioConfigIds = new Set(
        servers
          .filter((s: any) => s.source === "composio" && s.url)
          .map((s: any) => {
            const match = s.url.match(/\/v3\/mcp\/([^/]+)/);
            return match ? match[1] : null;
          })
          .filter(Boolean)
      );
      setAddedServers(composioConfigIds);

      const composio = providers.find((p: any) => p.id === "composio");
      const smithery = providers.find((p: any) => p.id === "smithery");
      const agentdojo = providers.find((p: any) => p.id === "agentdojo");
      const composioHasKey = composio?.hasKey || false;
      const smitheryHasKey = smithery?.hasKey || false;
      const agentdojoHasKey = agentdojo?.hasKey || false;

      setComposioConnected(composioHasKey);
      setSmitheryConnected(smitheryHasKey);
      setAgentDojoConnected(agentdojoHasKey);

      // Set initial active provider to first connected one
      if (composioHasKey) {
        setActiveProvider("composio");
        fetchComposioConfigs();
      } else if (smitheryHasKey) {
        setActiveProvider("smithery");
      } else if (agentdojoHasKey) {
        setActiveProvider("agentdojo");
      }
    } catch (e) {
      console.error("Failed to fetch providers:", e);
    }
    setLoading(false);
  };

  const fetchComposioConfigs = async () => {
    setLoadingConfigs(true);
    try {
      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      const res = await authFetch(`/api/integrations/composio/configs${projectParam}`);
      const data = await res.json();
      setComposioConfigs(data.configs || []);
    } catch (e) {
      console.error("Failed to fetch Composio configs:", e);
    }
    setLoadingConfigs(false);
  };

  const addComposioConfig = async (configId: string) => {
    setAddingConfig(configId);
    try {
      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      const res = await authFetch(`/api/integrations/composio/configs/${configId}/add${projectParam}`, {
        method: "POST",
      });
      if (res.ok) {
        // Mark as added by config ID
        setAddedServers(prev => new Set([...prev, configId]));
        onServerAdded?.();
      } else {
        const data = await res.json();
        await alert(data.error || "Failed to add config", { title: "Error", variant: "error" });
      }
    } catch (e) {
      console.error("Failed to add config:", e);
    }
    setAddingConfig(null);
  };

  const isConfigAdded = (configId: string) => {
    return addedServers.has(configId);
  };

  useEffect(() => {
    fetchStatus();
  }, [authFetch, projectId]);

  if (loading) {
    return <div className="text-center py-8 text-[var(--color-text-muted)]">Loading...</div>;
  }

  const hasAnyConnection = composioConnected || smitheryConnected || agentDojoConnected;
  const connectedCount = [composioConnected, smitheryConnected, agentDojoConnected].filter(Boolean).length;

  if (!hasAnyConnection) {
    return (
      <div className="bg-[var(--color-surface)] card p-8 text-center">
        <p className="text-[var(--color-text-secondary)] mb-2">No hosted MCP services connected</p>
        <p className="text-sm text-[var(--color-text-muted)] mb-4">
          Connect Composio, Smithery, or AgentDojo in Settings to access cloud-based MCP servers.
        </p>
        <a
          href="/settings"
          className="inline-block bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-4 py-2 rounded text-sm font-medium transition"
        >
          Go to Settings →
        </a>
      </div>
    );
  }

  return (
    <>
    {AlertDialog}
    <div className="space-y-6">
      {/* Provider Tabs - show when multiple providers are connected */}
      {connectedCount > 1 && (
        <div className="flex gap-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg p-1 w-fit">
          {composioConnected && (
            <button
              onClick={() => { setActiveProvider("composio"); setSubTab("configs"); }}
              className={`px-4 py-2 rounded text-sm font-medium transition flex items-center gap-2 ${
                activeProvider === "composio"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-purple-500" />
              Composio
            </button>
          )}
          {smitheryConnected && (
            <button
              onClick={() => setActiveProvider("smithery")}
              className={`px-4 py-2 rounded text-sm font-medium transition flex items-center gap-2 ${
                activeProvider === "smithery"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              Smithery
            </button>
          )}
          {agentDojoConnected && (
            <button
              onClick={() => setActiveProvider("agentdojo")}
              className={`px-4 py-2 rounded text-sm font-medium transition flex items-center gap-2 ${
                activeProvider === "agentdojo"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-green-500" />
              AgentDojo
            </button>
          )}
        </div>
      )}

      {/* Composio Content */}
      {composioConnected && (connectedCount === 1 || activeProvider === "composio") && (
        <>
          {/* Sub-tabs for Composio */}
          <div className="flex items-center justify-between">
            <div className="flex gap-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg p-1">
              <button
                onClick={() => setSubTab("configs")}
                className={`px-4 py-2 rounded text-sm font-medium transition ${
                  subTab === "configs"
                    ? "bg-[var(--color-surface-raised)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                MCP Configs
              </button>
              <button
                onClick={() => setSubTab("connect")}
                className={`px-4 py-2 rounded text-sm font-medium transition ${
                  subTab === "connect"
                    ? "bg-[var(--color-surface-raised)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                Connect Apps
              </button>
            </div>
            {connectedCount === 1 && (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span className="w-2 h-2 rounded-full bg-purple-500" />
                Composio
                <span className="text-green-400">Connected</span>
              </div>
            )}
          </div>

          {/* Connect Apps Tab */}
          {subTab === "connect" && (
            <div>
              <p className="text-sm text-[var(--color-text-muted)] mb-4">
                Connect your accounts to enable tools in MCP configs
              </p>
              <IntegrationsPanel
                providerId="composio"
                projectId={projectId}
                onConnectionComplete={() => {
                  // Refresh configs after connecting an app
                  fetchComposioConfigs();
                }}
              />
            </div>
          )}

          {/* MCP Configs Tab */}
          {subTab === "configs" && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-[var(--color-text-muted)]">
                  Your MCP configs from Composio
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={fetchComposioConfigs}
                    disabled={loadingConfigs}
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition"
                  >
                    {loadingConfigs ? "Loading..." : "Refresh"}
                  </button>
                  <a
                    href="https://app.composio.dev/mcp_configs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition"
                  >
                    Create Config →
                  </a>
                </div>
              </div>

              {loadingConfigs ? (
                <div className="text-center py-6 text-[var(--color-text-muted)]">Loading configs...</div>
              ) : composioConfigs.length === 0 ? (
                <div className="bg-[var(--color-surface)] card p-4 text-center">
                  <p className="text-sm text-[var(--color-text-muted)]">No MCP configs found</p>
                  <p className="text-xs text-[var(--color-text-faint)] mt-2">
                    First <button onClick={() => setSubTab("connect")} className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">connect some apps</button>, then create a config.
                  </p>
                  <a
                    href="https://app.composio.dev/mcp_configs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mt-2 inline-block"
                  >
                    Create in Composio →
                  </a>
                </div>
              ) : (
                <div className="space-y-2">
                  {composioConfigs.map((config) => {
                    const added = isConfigAdded(config.id);
                    const isAdding = addingConfig === config.id;
                    return (
                      <div
                        key={config.id}
                        className={`bg-[var(--color-surface)] border rounded-lg p-3 transition flex items-center justify-between ${
                          added ? "border-green-500/30" : "border-[var(--color-border)] hover:border-[var(--color-border-light)]"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{config.name}</span>
                            <span className="text-xs text-[var(--color-text-faint)]">{config.toolsCount} tools</span>
                            {added && (
                              <span className="text-xs text-green-400">Added</span>
                            )}
                          </div>
                          {config.toolkits.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {config.toolkits.slice(0, 4).map((toolkit) => (
                                <span
                                  key={toolkit}
                                  className="text-xs bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] px-1.5 py-0.5 rounded"
                                >
                                  {toolkit}
                                </span>
                              ))}
                              {config.toolkits.length > 4 && (
                                <span className="text-xs text-[var(--color-text-faint)]">+{config.toolkits.length - 4}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 ml-3">
                          {added ? (
                            <span className="text-xs text-[var(--color-text-faint)] px-2 py-1">In Servers</span>
                          ) : (
                            <button
                              onClick={() => addComposioConfig(config.id)}
                              disabled={isAdding}
                              className="text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-3 py-1 rounded font-medium transition disabled:opacity-50"
                            >
                              {isAdding ? "Adding..." : "Add"}
                            </button>
                          )}
                          <a
                            href={`https://app.composio.dev/mcp_configs/${config.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition"
                          >
                            Edit
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Smithery Content */}
      {smitheryConnected && (connectedCount === 1 || activeProvider === "smithery") && (
        <div>
          {connectedCount === 1 && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mb-4">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              Smithery
              <span className="text-green-400">Connected</span>
            </div>
          )}
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-[var(--color-text-muted)]">
              Add MCP servers from the Smithery registry
            </p>
            <a
              href="https://smithery.ai/servers"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition"
            >
              Browse Smithery →
            </a>
          </div>
          <div className="bg-[var(--color-surface)] card p-4 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Smithery servers can be added from the <strong>Browse Registry</strong> tab.
            </p>
            <p className="text-xs text-[var(--color-text-faint)] mt-2">
              Your API key will be used automatically when adding Smithery servers.
            </p>
          </div>
        </div>
      )}

      {/* AgentDojo Content */}
      {agentDojoConnected && (connectedCount === 1 || activeProvider === "agentdojo") && (
        <AgentDojoContent
          projectId={projectId}
          onServerAdded={onServerAdded}
          showProviderBadge={connectedCount === 1}
        />
      )}

      <div className="p-3 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded text-xs text-[var(--color-text-muted)]">
        <strong className="text-[var(--color-text-secondary)]">Tip:</strong> Connect apps first, then add MCP configs to make tools available to your agents.
        {" · "}
        <a href="/settings" className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">Add more providers in Settings</a>
      </div>
    </div>
    </>
  );
}

// AgentDojo Content Component
interface AgentDojoConfig {
  id: string;
  name: string;
  slug: string;
  toolkits: string[];
  toolsCount: number;
  mcpUrl: string;
  createdAt?: string;
}

function AgentDojoContent({
  projectId,
  onServerAdded,
  showProviderBadge,
}: {
  projectId?: string | null;
  onServerAdded?: () => void;
  showProviderBadge?: boolean;
}) {
  const { authFetch } = useAuth();
  const [subTab, setSubTab] = useState<"configs" | "toolkits">("configs");
  const [configs, setConfigs] = useState<AgentDojoConfig[]>([]);
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set());
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [addingConfig, setAddingConfig] = useState<string | null>(null);
  const { alert, AlertDialog } = useAlert();

  const fetchConfigs = async () => {
    setLoadingConfigs(true);
    try {
      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      const serversUrl = projectId && projectId !== "unassigned"
        ? `/api/mcp/servers?project=${encodeURIComponent(projectId)}`
        : "/api/mcp/servers";
      console.log(`[AgentDojo:fetchConfigs] projectId=${projectId} serversUrl=${serversUrl}`);
      const [configsRes, serversRes] = await Promise.all([
        authFetch(`/api/integrations/agentdojo/configs${projectParam}`),
        authFetch(serversUrl),
      ]);
      const configsData = await configsRes.json();
      const serversData = await serversRes.json();

      console.log(`[AgentDojo:fetchConfigs] configs=${(configsData.configs || []).length} servers=${(serversData.servers || []).length}`);
      setConfigs(configsData.configs || []);

      // Track which configs are already added as local servers
      const agentdojoServers = (serversData.servers || []).filter((s: any) => s.source === "agentdojo");
      console.log(`[AgentDojo:fetchConfigs] agentdojo servers found: ${agentdojoServers.length}`);
      for (const s of agentdojoServers) {
        const match = s.url?.match(/\/mcp\/([^/?]+)/);
        console.log(`[AgentDojo:fetchConfigs]   server: id=${s.id} name=${s.name} project_id=${s.project_id} url=${s.url?.substring(0, 80)} extracted=${match ? match[1] : s.name}`);
      }
      const agentdojoServerIds = new Set(
        agentdojoServers.map((s: any) => {
            // Extract config ID from URL or match by name
            const match = s.url?.match(/\/mcp\/([^/?]+)/);
            return match ? match[1] : s.name;
          })
      );
      console.log(`[AgentDojo:fetchConfigs] addedServers set:`, [...agentdojoServerIds]);
      setAddedServers(agentdojoServerIds);
    } catch (e) {
      console.error("Failed to fetch AgentDojo configs:", e);
    }
    setLoadingConfigs(false);
  };

  const addConfig = async (configId: string) => {
    setAddingConfig(configId);
    try {
      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      console.log(`[AgentDojo:addConfig] configId=${configId} projectParam=${projectParam}`);
      const res = await authFetch(`/api/integrations/agentdojo/configs/${configId}/add${projectParam}`, {
        method: "POST",
      });
      const data = await res.json();
      console.log(`[AgentDojo:addConfig] response status=${res.status} ok=${res.ok} message=${data.message} server.id=${data.server?.id} server.project_id=${data.server?.project_id}`);
      if (res.ok) {
        const config = configs.find(c => c.id === configId);
        const addKey = config?.slug || configId;
        console.log(`[AgentDojo:addConfig] marking as added: key=${addKey} config.slug=${config?.slug} config.id=${config?.id} config.name=${config?.name}`);
        setAddedServers(prev => new Set([...prev, addKey]));
        onServerAdded?.();
      } else {
        await alert(data.error || "Failed to add config", { title: "Error", variant: "error" });
      }
    } catch (e) {
      console.error("Failed to add config:", e);
    }
    setAddingConfig(null);
  };

  const isConfigAdded = (config: AgentDojoConfig) => {
    return addedServers.has(config.slug) || addedServers.has(config.id) || addedServers.has(config.name);
  };

  useEffect(() => {
    fetchConfigs();
  }, [authFetch, projectId]);

  return (
    <>
      {AlertDialog}
      <div>
        {showProviderBadge && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mb-4">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            AgentDojo
            <span className="text-green-400">Connected</span>
          </div>
        )}

        {/* Sub-tabs */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg p-1">
            <button
              onClick={() => setSubTab("configs")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                subTab === "configs"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              MCP Servers
            </button>
            <button
              onClick={() => setSubTab("toolkits")}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                subTab === "toolkits"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              Browse Toolkits
            </button>
          </div>
        </div>

        {/* MCP Servers Tab */}
        {subTab === "configs" && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-[var(--color-text-muted)]">
                Your MCP servers from AgentDojo
              </p>
              <button
                onClick={fetchConfigs}
                disabled={loadingConfigs}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition"
              >
                {loadingConfigs ? "Loading..." : "Refresh"}
              </button>
            </div>

            {loadingConfigs ? (
              <div className="text-center py-6 text-[var(--color-text-muted)]">Loading servers...</div>
            ) : configs.length === 0 ? (
              <div className="bg-[var(--color-surface)] card p-4 text-center">
                <p className="text-sm text-[var(--color-text-muted)]">No MCP servers found</p>
                <p className="text-xs text-[var(--color-text-faint)] mt-2">
                  <button onClick={() => setSubTab("toolkits")} className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]">
                    Browse toolkits
                  </button>
                  {" "}to create a new MCP server.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {configs.map((config) => {
                  const added = isConfigAdded(config);
                  const isAdding = addingConfig === config.id;
                  return (
                    <div
                      key={config.id}
                      className={`bg-[var(--color-surface)] border rounded-lg p-3 transition flex items-center justify-between ${
                        added ? "border-green-500/30" : "border-[var(--color-border)] hover:border-[var(--color-border-light)]"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{config.name}</span>
                          <span className="text-xs text-[var(--color-text-faint)]">{config.toolsCount} tools</span>
                          {added && (
                            <span className="text-xs text-green-400">Added</span>
                          )}
                        </div>
                        {config.mcpUrl && (
                          <code className="text-xs text-[var(--color-text-faint)] mt-1 block truncate">
                            {config.mcpUrl}
                          </code>
                        )}
                        {!config.mcpUrl && config.slug && (
                          <code className="text-xs text-[var(--color-text-faint)] mt-1 block truncate">
                            {config.slug}
                          </code>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-3">
                        {added ? (
                          <span className="text-xs text-[var(--color-text-faint)] px-2 py-1">In Servers</span>
                        ) : (
                          <button
                            onClick={() => addConfig(config.id)}
                            disabled={isAdding}
                            className="text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-3 py-1 rounded font-medium transition disabled:opacity-50"
                          >
                            {isAdding ? "Adding..." : "Add"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Browse Toolkits Tab */}
        {subTab === "toolkits" && (
          <div>
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              Browse available toolkits and create MCP servers
            </p>
            <IntegrationsPanel
              providerId="agentdojo"
              projectId={projectId}
              onConnectionComplete={() => {
                fetchConfigs();
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

// Parse command and extract credential placeholders
function parseCommandForCredentials(cmd: string): {
  cleanCommand: string;
  credentials: Array<{ key: string; flag: string }>;
  serverName: string | null;
} {
  const credentials: Array<{ key: string; flag: string }> = [];
  let cleanCommand = cmd;
  let serverName: string | null = null;

  // Try to extract server name from package (e.g., pushover-mcp@latest -> pushover)
  const pkgMatch = cmd.match(/(?:npx\s+-y\s+)?(@?[\w-]+\/)?(@?[\w-]+)(?:@[\w.-]+)?/);
  if (pkgMatch) {
    const pkg = pkgMatch[2] || pkgMatch[1];
    if (pkg) {
      // Extract name: "pushover-mcp" -> "pushover", "@org/server-github" -> "github"
      serverName = pkg
        .replace(/^@/, '')
        .replace(/-mcp$/, '')
        .replace(/-server$/, '')
        .replace(/^server-/, '')
        .replace(/^mcp-/, '');
    }
  }

  // Pattern: --flag YOUR_VALUE, --flag <value>, --flag {value}, --flag $VALUE
  // Matches: --token YOUR_TOKEN, --user YOUR_USER, --api-key <API_KEY>, etc.
  const argPattern = /--(\w+[-\w]*)\s+(YOUR_\w+|<[\w_]+>|\{[\w_]+\}|\$[\w_]+|[\w_]*(?:TOKEN|KEY|SECRET|PASSWORD|USER|ID|APIKEY)[\w_]*)/gi;

  let match;
  while ((match = argPattern.exec(cmd)) !== null) {
    const flag = match[1];
    const placeholder = match[2];

    // Convert flag to env var name: api-key -> API_KEY, token -> TOKEN
    const envKey = flag.toUpperCase().replace(/-/g, '_');

    // Add prefix based on server name if available
    const fullKey = serverName
      ? `${serverName.toUpperCase().replace(/-/g, '_')}_${envKey}`
      : envKey;

    credentials.push({ key: fullKey, flag });

    // Replace placeholder with $ENV_VAR reference in command
    cleanCommand = cleanCommand.replace(
      new RegExp(`(--${flag}\\s+)${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
      `--${flag} $${fullKey}`
    );
  }

  return { cleanCommand, credentials, serverName };
}

function AddServerModal({
  onClose,
  onAdded,
  projects,
  defaultProjectId,
}: {
  onClose: () => void;
  onAdded: () => void;
  projects?: Array<{ id: string; name: string; color: string }>;
  defaultProjectId?: string | null;
}) {
  const { authFetch } = useAuth();
  const [mode, setMode] = useState<"npm" | "pip" | "command" | "http">("npm");
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [pipModule, setPipModule] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasProjects = projects && projects.length > 0;

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
  };

  const updateEnvVar = (index: number, field: "key" | "value", value: string) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  // Handle command input - parse and extract credentials
  const handleCommandChange = (value: string) => {
    setCommand(value);

    // Only parse if it looks like a full command with placeholders
    if (value.includes('YOUR_') || value.includes('<') || value.includes('{') ||
        /TOKEN|KEY|SECRET|PASSWORD/i.test(value)) {
      const { cleanCommand, credentials, serverName } = parseCommandForCredentials(value);

      // Auto-set name if empty
      if (!name && serverName) {
        setName(serverName);
      }

      // Add any new credentials that don't already exist
      if (credentials.length > 0) {
        const existingKeys = new Set(envVars.map(e => e.key));
        const newVars = credentials
          .filter(c => !existingKeys.has(c.key))
          .map(c => ({ key: c.key, value: "" }));

        if (newVars.length > 0) {
          setEnvVars([...envVars, ...newVars]);
          // Update command to use clean version with env var references
          setCommand(cleanCommand);
        }
      }
    }
  };

  // Handle package input - detect if user pasted a full command
  const handlePackageChange = (value: string) => {
    // Check if this looks like a full command (has npx, spaces with args, or credential placeholders)
    const looksLikeCommand =
      value.startsWith('npx ') ||
      value.includes(' --') ||
      value.includes('YOUR_') ||
      value.includes('<') ||
      /\s+(TOKEN|KEY|SECRET|PASSWORD)/i.test(value);

    if (looksLikeCommand) {
      // Switch to command mode and parse
      setMode("command");
      handleCommandChange(value);
    } else {
      // Just a package name
      setPkg(value);

      // Try to auto-set name from package
      if (!name && value) {
        const serverName = value
          .replace(/^@[\w-]+\//, '')  // Remove org prefix
          .replace(/@[\w.-]+$/, '')   // Remove version
          .replace(/^server-/, '')
          .replace(/-server$/, '')
          .replace(/^mcp-/, '')
          .replace(/-mcp$/, '');
        if (serverName && serverName !== value) {
          setName(serverName);
        }
      }
    }
  };

  const handleAdd = async () => {
    if (!name) {
      setError("Name is required");
      return;
    }

    if (mode === "npm" && !pkg) {
      setError("npm package is required");
      return;
    }

    if (mode === "pip" && !pkg) {
      setError("pip package is required");
      return;
    }

    if (mode === "command" && !command) {
      setError("Command is required");
      return;
    }

    if (mode === "http" && !url) {
      setError("URL is required");
      return;
    }

    setSaving(true);
    setError(null);

    // Build env object from envVars array
    const env: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) {
        env[key.trim()] = value;
      }
    }

    try {
      const body: Record<string, unknown> = { name };

      if (mode === "npm") {
        body.type = "npm";
        body.package = pkg;
      } else if (mode === "pip") {
        body.type = "pip";
        body.package = pkg;
        if (pipModule) {
          body.pip_module = pipModule;
        }
      } else if (mode === "http") {
        body.type = "http";
        body.url = url;
        // Build headers with Basic Auth if credentials provided
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (username && password) {
          // Base64 encode username:password for Basic Auth
          const credentials = btoa(`${username}:${password}`);
          headers["Authorization"] = `Basic ${credentials}`;
        }
        body.headers = headers;
      } else {
        // Parse command into parts
        const parts = command.trim().split(/\s+/);
        body.type = "custom";
        body.command = parts[0];
        body.args = parts.slice(1).join(" ");
      }

      if (Object.keys(env).length > 0) {
        body.env = env;
      }

      // Add project_id if selected
      if (projectId) {
        body.project_id = projectId;
      }

      const res = await authFetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to add server");
        setSaving(false);
        return;
      }

      onAdded();
    } catch (e) {
      setError("Failed to add server");
      setSaving(false);
    }
  };

  const quickAdd = (serverName: string, serverPkg: string) => {
    setMode("npm");
    setName(serverName);
    setPkg(serverPkg);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-50 flex items-center justify-center p-4">
      <div className="bg-[var(--color-surface)] card w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between sticky top-0 bg-[var(--color-surface)]">
          <h2 className="text-lg font-semibold">Add MCP Server</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Quick picks */}
          <div>
            <p className="text-sm text-[var(--color-text-muted)] mb-2">Quick add:</p>
            <div className="flex flex-wrap gap-2">
              {[
                { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem", type: "npm" as const },
                { name: "fetch", pkg: "@modelcontextprotocol/server-fetch", type: "npm" as const },
                { name: "memory", pkg: "@modelcontextprotocol/server-memory", type: "npm" as const },
                { name: "github", pkg: "@modelcontextprotocol/server-github", type: "npm" as const },
                { name: "time", pkg: "mcp-server-time", module: "mcp_server_time", type: "pip" as const },
              ].map(s => (
                <button
                  key={s.name}
                  onClick={() => {
                    setMode(s.type);
                    setName(s.name);
                    setPkg(s.pkg);
                    if (s.type === "pip" && "module" in s) {
                      setPipModule(s.module || "");
                    } else {
                      setPipModule("");
                    }
                  }}
                  className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] px-3 py-1 rounded transition"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded p-1">
            <button
              onClick={() => setMode("npm")}
              className={`flex-1 px-2 py-1.5 rounded text-sm transition ${
                mode === "npm"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              npm
            </button>
            <button
              onClick={() => setMode("pip")}
              className={`flex-1 px-2 py-1.5 rounded text-sm transition ${
                mode === "pip"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              pip
            </button>
            <button
              onClick={() => setMode("command")}
              className={`flex-1 px-2 py-1.5 rounded text-sm transition ${
                mode === "command"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              Command
            </button>
            <button
              onClick={() => setMode("http")}
              className={`flex-1 px-2 py-1.5 rounded text-sm transition ${
                mode === "http"
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              HTTP
            </button>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., pushover"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Project Scope - only show when projects exist */}
          {hasProjects && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Scope</label>
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
                Global servers are available to all agents. Project-scoped servers are only available to agents in that project.
              </p>
            </div>
          )}

          {/* npm Package */}
          {mode === "npm" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">npm Package</label>
              <input
                type="text"
                value={pkg}
                onChange={e => handlePackageChange(e.target.value)}
                placeholder="e.g., @modelcontextprotocol/server-filesystem or paste full command"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
              />
              <p className="text-xs text-[var(--color-text-faint)] mt-1">
                Package name or paste a full npx command with credentials
              </p>
            </div>
          )}

          {/* pip Package (Python) */}
          {mode === "pip" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">pip Package</label>
                <input
                  type="text"
                  value={pkg}
                  onChange={e => {
                    setPkg(e.target.value);
                    // Auto-set module from package name
                    if (!pipModule && e.target.value) {
                      const basePkg = e.target.value.split("[")[0].replace(/-/g, ".");
                      setPipModule(basePkg);
                    }
                  }}
                  placeholder="e.g., late-sdk[mcp]"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
                />
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  Python package with extras, e.g., late-sdk[mcp] or mcp-server-time
                </p>
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Module (optional)</label>
                <input
                  type="text"
                  value={pipModule}
                  onChange={e => setPipModule(e.target.value)}
                  placeholder="e.g., late.mcp"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
                />
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  Python module to run with -m. Auto-detected from package name if not specified.
                </p>
              </div>
            </div>
          )}

          {/* Custom Command */}
          {mode === "command" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Command</label>
              <input
                type="text"
                value={command}
                onChange={e => handleCommandChange(e.target.value)}
                placeholder="e.g., npx -y pushover-mcp@latest start --token YOUR_TOKEN"
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
              />
              <p className="text-xs text-[var(--color-text-faint)] mt-1">
                Paste the full command - credentials like YOUR_TOKEN will be auto-extracted
              </p>
            </div>
          )}

          {/* HTTP Endpoint */}
          {mode === "http" && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="e.g., https://example.com/wp-json/mcp/v1/messages"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <div className="p-3 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded">
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  Optional: Basic Auth credentials (will be encoded and stored securely)
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[var(--color-text-faint)] mb-1">Username</label>
                    <input
                      type="text"
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                      placeholder="username"
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-text-faint)] mb-1">Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="password or app key"
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Environment Variables / Credentials */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-[var(--color-text-muted)]">
                Environment Variables / Credentials
              </label>
              <button
                onClick={addEnvVar}
                className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition"
              >
                + Add Variable
              </button>
            </div>

            {envVars.length === 0 && (
              <p className="text-xs text-[var(--color-text-faint)] bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded p-3">
                Add environment variables for API tokens and credentials.
                These are stored encrypted and passed to the server at startup.
              </p>
            )}

            {envVars.length > 0 && (
              <div className="space-y-2">
                {envVars.map((env, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="text"
                      value={env.key}
                      onChange={e => updateEnvVar(index, "key", e.target.value)}
                      placeholder="KEY"
                      className="w-1/3 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                    />
                    <input
                      type="password"
                      value={env.value}
                      onChange={e => updateEnvVar(index, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                    />
                    <button
                      onClick={() => removeEnvVar(index)}
                      className="text-[var(--color-text-muted)] hover:text-red-400 px-2 transition"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        <div className="p-4 border-t border-[var(--color-border)] flex justify-end gap-2 sticky bottom-0 bg-[var(--color-surface)]">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-[var(--color-border-light)] hover:border-[var(--color-text-muted)] rounded transition"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={saving || !name || (mode === "npm" ? !pkg : mode === "pip" ? !pkg : mode === "http" ? !url : !command)}
            className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black rounded font-medium transition disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Server"}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditServerModal({
  server,
  projects,
  onClose,
  onSaved,
}: {
  server: McpServer;
  projects?: Array<{ id: string; name: string; color: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [name, setName] = useState(server.name);
  const [pkg, setPkg] = useState(server.package || "");
  const [command, setCommand] = useState(server.command || "");
  const [args, setArgs] = useState(server.args || "");
  const [url, setUrl] = useState(server.url || "");
  // Extract username/password from existing Basic Auth header
  const [username, setUsername] = useState(() => {
    const authHeader = server.headers?.["Authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        return decoded.split(":")[0] || "";
      } catch { return ""; }
    }
    return "";
  });
  const [password, setPassword] = useState(() => {
    const authHeader = server.headers?.["Authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      try {
        const decoded = atob(authHeader.slice(6));
        const parts = decoded.split(":");
        return parts.slice(1).join(":") || "";
      } catch { return ""; }
    }
    return "";
  });
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(() => {
    // Convert env object to array format
    return Object.entries(server.env || {}).map(([key, value]) => ({ key, value }));
  });
  const [projectId, setProjectId] = useState<string | null>(server.project_id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasProjects = projects && projects.length > 0;
  const isRemote = server.type === "http";

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
  };

  const updateEnvVar = (index: number, field: "key" | "value", value: string) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    setSaving(true);
    setError(null);

    // Build env object from envVars array
    const env: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) {
        env[key.trim()] = value;
      }
    }

    try {
      const updates: Record<string, unknown> = {
        name: name.trim(),
        env,
      };

      // Only include fields that are relevant to the server type
      if (isRemote) {
        // HTTP server - update URL and headers
        if (url.trim()) {
          updates.url = url.trim();
        }
        // Build headers with Basic Auth if credentials provided
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (username && password) {
          const credentials = btoa(`${username}:${password}`);
          headers["Authorization"] = `Basic ${credentials}`;
        }
        updates.headers = headers;
      } else {
        if (server.type === "npm" && pkg.trim()) {
          updates.package = pkg.trim();
        }
        if (server.type === "pip" && pkg.trim()) {
          updates.package = pkg.trim();
        }
        if (server.type === "custom") {
          if (command.trim()) updates.command = command.trim();
          if (args.trim()) updates.args = args.trim();
        }
      }

      // Include project_id update
      updates.project_id = projectId;

      const res = await authFetch(`/api/mcp/servers/${server.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save changes");
        setSaving(false);
        return;
      }

      // If server was running, restart it to apply new env vars
      if (server.status === "running" && !isRemote) {
        try {
          // Stop the server
          await authFetch(`/api/mcp/servers/${server.id}/stop`, { method: "POST" });
          // Start it again
          await authFetch(`/api/mcp/servers/${server.id}/start`, { method: "POST" });
        } catch (e) {
          console.error("Failed to restart server:", e);
          // Don't fail the save, just log the error
        }
      }

      onSaved();
    } catch (e) {
      setError("Failed to save changes");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-50 flex items-center justify-center p-4">
      <div className="bg-[var(--color-surface)] card w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between sticky top-0 bg-[var(--color-surface)]">
          <h2 className="text-lg font-semibold">Edit MCP Server</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Server Type Info */}
          <div className="text-sm text-[var(--color-text-muted)] bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded p-3">
            Type: <span className="text-[var(--color-text-secondary)]">{server.type}</span>
            {server.package && <> • Package: <span className="text-[var(--color-text-secondary)] font-mono">{server.package}</span></>}
            {server.command && <> • Command: <span className="text-[var(--color-text-secondary)] font-mono">{server.command}</span></>}
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>

          {/* Project Scope */}
          {hasProjects && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Scope</label>
              <Select
                value={projectId || ""}
                onChange={(value) => setProjectId(value || null)}
                options={[
                  { value: "", label: "Global (all projects)" },
                  ...projects!.map(p => ({ value: p.id, label: p.name }))
                ]}
                placeholder="Select scope..."
              />
            </div>
          )}

          {/* Package (for npm type) */}
          {server.type === "npm" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">npm Package</label>
              <input
                type="text"
                value={pkg}
                onChange={e => setPkg(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          )}

          {/* Package (for pip type) */}
          {server.type === "pip" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">pip Package</label>
              <input
                type="text"
                value={pkg}
                onChange={e => setPkg(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          )}

          {/* URL & Credentials (for http type) */}
          {isRemote && (
            <>
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Server URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Authentication (Basic Auth)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="Username"
                    className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Password / App Password"
                    className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">
                  Leave empty if no authentication required
                </p>
              </div>
            </>
          )}

          {/* Command & Args (for custom type) */}
          {server.type === "custom" && (
            <>
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Command</label>
                <input
                  type="text"
                  value={command}
                  onChange={e => setCommand(e.target.value)}
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--color-text-muted)] mb-1">Arguments</label>
                <input
                  type="text"
                  value={args}
                  onChange={e => setArgs(e.target.value)}
                  placeholder="e.g., --token $TOKEN --verbose"
                  className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[var(--color-accent)]"
                />
              </div>
            </>
          )}

          {/* Environment Variables */}
          {!isRemote && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-[var(--color-text-muted)]">
                  Environment Variables / Credentials
                </label>
                <button
                  onClick={addEnvVar}
                  className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition"
                >
                  + Add Variable
                </button>
              </div>

              {envVars.length === 0 && (
                <p className="text-xs text-[var(--color-text-faint)] bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded p-3">
                  No environment variables configured.
                </p>
              )}

              {envVars.length > 0 && (
                <div className="space-y-2">
                  {envVars.map((env, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        type="text"
                        value={env.key}
                        onChange={e => updateEnvVar(index, "key", e.target.value)}
                        placeholder="KEY"
                        className="w-1/3 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                      />
                      <input
                        type="password"
                        value={env.value}
                        onChange={e => updateEnvVar(index, "value", e.target.value)}
                        placeholder="value"
                        className="flex-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]"
                      />
                      <button
                        onClick={() => removeEnvVar(index)}
                        className="text-[var(--color-text-muted)] hover:text-red-400 px-2 transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-[var(--color-text-faint)] mt-2">
                {server.status === "running" ? "Server will be automatically restarted to apply changes." : "Changes will take effect when the server is started."}
              </p>
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        <div className="p-4 border-t border-[var(--color-border)] flex justify-end gap-2 sticky bottom-0 bg-[var(--color-surface)]">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-[var(--color-border-light)] hover:border-[var(--color-text-muted)] rounded transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black rounded font-medium transition disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
