import React, { useState, useEffect } from "react";
import { McpIcon } from "../common/Icons";
import { useAuth } from "../../context";
import { useConfirm, useAlert } from "../common/Modal";
import type { McpTool, McpToolCallResult } from "../../types";
import { IntegrationsPanel } from "./IntegrationsPanel";

interface McpServer {
  id: string;
  name: string;
  type: "npm" | "github" | "http" | "custom";
  package: string | null;
  command: string | null;
  args: string | null;
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  source: string | null; // "composio", "smithery", or null for local
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
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [activeTab, setActiveTab] = useState<"servers" | "hosted" | "registry">("servers");
  const { confirm, ConfirmDialog } = useConfirm();

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

  return (
    <>
    {ConfirmDialog}
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold mb-1">MCP Servers</h1>
            <p className="text-[#666]">
              Manage Model Context Protocol servers for tool integrations.
            </p>
          </div>
          {activeTab === "servers" && (
            <button
              onClick={() => setShowAdd(true)}
              className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
            >
              + Add Server
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-[#111] border border-[#1a1a1a] rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab("servers")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "servers"
                ? "bg-[#1a1a1a] text-white"
                : "text-[#666] hover:text-[#888]"
            }`}
          >
            My Servers
          </button>
          <button
            onClick={() => setActiveTab("hosted")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "hosted"
                ? "bg-[#1a1a1a] text-white"
                : "text-[#666] hover:text-[#888]"
            }`}
          >
            Hosted Services
          </button>
          <button
            onClick={() => setActiveTab("registry")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              activeTab === "registry"
                ? "bg-[#1a1a1a] text-white"
                : "text-[#666] hover:text-[#888]"
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
              <div className="text-center py-8 text-[#666]">Loading...</div>
            )}

            {/* Empty State */}
            {!loading && servers.length === 0 && (
              <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-8 text-center">
                <McpIcon className="w-12 h-12 text-[#333] mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No MCP servers configured</h3>
                <p className="text-[#666] mb-6 max-w-md mx-auto">
                  MCP servers extend your agents with tools like file access, web browsing,
                  database connections, and more.
                </p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => setShowAdd(true)}
                    className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
                  >
                    Add Manually
                  </button>
                  <button
                    onClick={() => setActiveTab("registry")}
                    className="border border-[#333] hover:border-[#666] px-4 py-2 rounded font-medium transition"
                  >
                    Browse Registry
                  </button>
                </div>
              </div>
            )}

            {/* Main content with server list and tools panel */}
            {!loading && servers.length > 0 && (
              <div className="flex gap-6">
                {/* Server List */}
                <div className={`space-y-3 ${selectedServer ? "w-1/2" : "w-full"}`}>
                  {servers.map(server => {
                    const isRemote = server.type === "http" && server.url;
                    const isAvailable = isRemote || server.status === "running";
                    return (
                      <McpServerCard
                        key={server.id}
                        server={server}
                        selected={selectedServer?.id === server.id}
                        onSelect={() => setSelectedServer(isAvailable ? server : null)}
                        onStart={() => startServer(server.id)}
                        onStop={() => stopServer(server.id)}
                        onDelete={() => deleteServer(server.id)}
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
          <HostedServices onServerAdded={fetchServers} />
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
          <div className="mt-8 p-4 bg-[#111] border border-[#1a1a1a] rounded-lg">
            <h3 className="font-medium mb-2">Quick Start</h3>
            <p className="text-sm text-[#666] mb-3">
              Add an MCP server by providing its npm package name. For example:
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem" },
                { name: "fetch", pkg: "@modelcontextprotocol/server-fetch" },
                { name: "memory", pkg: "@modelcontextprotocol/server-memory" },
              ].map(s => (
                <code key={s.name} className="text-xs bg-[#0a0a0a] px-2 py-1 rounded">
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
        />
      )}
    </div>
    </>
  );
}

function McpServerCard({
  server,
  selected,
  onSelect,
  onStart,
  onStop,
  onDelete,
}: {
  server: McpServer;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
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

  return (
    <div
      className={`bg-[#111] border rounded-lg p-4 cursor-pointer transition ${
        selected ? "border-[#f97316]" : "border-[#1a1a1a] hover:border-[#333]"
      }`}
      onClick={isAvailable ? onSelect : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${
            isAvailable ? "bg-green-400" : "bg-[#444]"
          }`} />
          <div>
            <h3 className="font-medium">{server.name}</h3>
            <p className="text-sm text-[#666]">{getServerInfo()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRemote ? (
            // Remote servers: no start/stop, just delete
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-sm text-[#666] hover:text-red-400 px-3 py-1 transition"
            >
              Remove
            </button>
          ) : server.status === "running" ? (
            // Local running server: tools + stop + delete
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onSelect(); }}
                className="text-sm text-[#f97316] hover:text-[#fb923c] px-3 py-1 transition"
              >
                Tools
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onStop(); }}
                className="text-sm text-[#666] hover:text-red-400 px-3 py-1 transition"
              >
                Stop
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-sm text-[#666] hover:text-red-400 px-3 py-1 transition"
              >
                Delete
              </button>
            </>
          ) : (
            // Local stopped server: start + delete
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onStart(); }}
                className="text-sm text-[#666] hover:text-green-400 px-3 py-1 transition"
              >
                Start
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-sm text-[#666] hover:text-red-400 px-3 py-1 transition"
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
    <div className="bg-[#111] border border-[#1a1a1a] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#1a1a1a] flex items-center justify-between">
        <div>
          <h3 className="font-medium">{server.name} Tools</h3>
          {serverInfo && (
            <p className="text-xs text-[#666]">
              {serverInfo.name} v{serverInfo.version}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[#666] hover:text-[#888] text-xl leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="p-4 max-h-[500px] overflow-auto">
        {loading && <p className="text-[#666]">Loading tools...</p>}

        {error && (
          <div className="text-red-400 text-sm p-3 bg-red-500/10 rounded">
            {error}
          </div>
        )}

        {!loading && !error && tools.length === 0 && (
          <p className="text-[#666]">No tools available from this server.</p>
        )}

        {!loading && !error && tools.length > 0 && !selectedTool && (
          <div className="space-y-2">
            {tools.map(tool => (
              <button
                key={tool.name}
                onClick={() => setSelectedTool(tool)}
                className="w-full text-left p-3 bg-[#0a0a0a] hover:bg-[#1a1a1a] border border-[#222] hover:border-[#333] rounded transition"
              >
                <div className="font-medium text-sm">{tool.name}</div>
                {tool.description && (
                  <div className="text-xs text-[#666] mt-1">{tool.description}</div>
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
          className="text-[#666] hover:text-[#888] text-sm"
        >
          ← Back
        </button>
        <span className="text-[#444]">/</span>
        <span className="font-medium">{tool.name}</span>
      </div>

      {/* Description */}
      {tool.description && (
        <p className="text-sm text-[#666]">{tool.description}</p>
      )}

      {/* Schema info */}
      {tool.inputSchema && (
        <div className="text-xs">
          <details className="cursor-pointer">
            <summary className="text-[#666] hover:text-[#888]">Input Schema</summary>
            <pre className="mt-2 p-2 bg-[#0a0a0a] rounded text-[#888] overflow-auto max-h-32">
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* Arguments input */}
      <div>
        <label className="block text-sm text-[#666] mb-1">Arguments (JSON)</label>
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 h-32 font-mono text-sm focus:outline-none focus:border-[#f97316] resize-none"
          placeholder="{}"
        />
      </div>

      {/* Call button */}
      <button
        onClick={callTool}
        disabled={loading}
        className="w-full bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
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
          <div className="text-sm text-[#666]">
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
          className="flex-1 bg-[#111] border border-[#333] rounded-lg px-4 py-3 focus:outline-none focus:border-[#f97316]"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-6 py-3 rounded-lg font-medium transition"
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
        <div className="text-center py-8 text-[#666]">
          No servers found. Try a different search term.
        </div>
      )}

      {servers.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 hover:border-[#333] transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium truncate">{server.name}</h3>
                  <p className="text-sm text-[#666] mt-1 line-clamp-2">
                    {server.description || "No description"}
                  </p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-[#555]">
                    {server.version && <span>v{server.version}</span>}
                    <span className={`px-1.5 py-0.5 rounded ${
                      server.npmPackage ? "bg-green-500/10 text-green-400" : "bg-blue-500/10 text-blue-400"
                    }`}>
                      {server.npmPackage ? "npm" : "remote"}
                    </span>
                  </div>
                  <code className="text-xs text-[#555] bg-[#0a0a0a] px-2 py-0.5 rounded mt-2 inline-block truncate max-w-full">
                    {server.npmPackage || server.fullName}
                  </code>
                </div>
                <div className="flex-shrink-0">
                  {server.npmPackage ? (
                    <button
                      onClick={() => installServer(server)}
                      disabled={installing === server.id}
                      className="text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-3 py-1.5 rounded transition disabled:opacity-50"
                    >
                      {installing === server.id ? "Adding..." : "Add"}
                    </button>
                  ) : server.repository ? (
                    <a
                      href={server.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[#666] hover:text-[#f97316] transition"
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
        <div className="text-center py-8 text-[#666]">
          Searching registry...
        </div>
      )}

      {/* Registry info */}
      <div className="p-4 bg-[#111] border border-[#1a1a1a] rounded-lg text-sm text-[#666]">
        <p>
          Servers are sourced from the{" "}
          <a
            href="https://github.com/modelcontextprotocol/servers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#f97316] hover:underline"
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

function HostedServices({ onServerAdded }: { onServerAdded?: () => void }) {
  const { authFetch } = useAuth();
  const [subTab, setSubTab] = useState<"configs" | "connect">("configs");
  const [composioConnected, setComposioConnected] = useState(false);
  const [smitheryConnected, setSmitheryConnected] = useState(false);
  const [composioConfigs, setComposioConfigs] = useState<ComposioConfig[]>([]);
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [addingConfig, setAddingConfig] = useState<string | null>(null);
  const { alert, AlertDialog } = useAlert();

  const fetchStatus = async () => {
    try {
      const [providersRes, serversRes] = await Promise.all([
        authFetch("/api/providers"),
        authFetch("/api/mcp/servers"),
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
      setComposioConnected(composio?.hasKey || false);
      setSmitheryConnected(smithery?.hasKey || false);

      if (composio?.hasKey) {
        fetchComposioConfigs();
      }
    } catch (e) {
      console.error("Failed to fetch providers:", e);
    }
    setLoading(false);
  };

  const fetchComposioConfigs = async () => {
    setLoadingConfigs(true);
    try {
      const res = await authFetch("/api/integrations/composio/configs");
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
      const res = await authFetch(`/api/integrations/composio/configs/${configId}/add`, {
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
  }, [authFetch]);

  if (loading) {
    return <div className="text-center py-8 text-[#666]">Loading...</div>;
  }

  const hasAnyConnection = composioConnected || smitheryConnected;

  if (!hasAnyConnection) {
    return (
      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-8 text-center">
        <p className="text-[#888] mb-2">No hosted MCP services connected</p>
        <p className="text-sm text-[#666] mb-4">
          Connect Composio or Smithery in Settings to access cloud-based MCP servers.
        </p>
        <a
          href="/settings"
          className="inline-block bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-4 py-2 rounded text-sm font-medium transition"
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
      {/* Sub-tabs for Composio */}
      {composioConnected && (
        <div className="flex gap-1 bg-[#0a0a0a] border border-[#222] rounded-lg p-1 w-fit">
          <button
            onClick={() => setSubTab("configs")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              subTab === "configs"
                ? "bg-[#1a1a1a] text-white"
                : "text-[#666] hover:text-[#888]"
            }`}
          >
            MCP Configs
          </button>
          <button
            onClick={() => setSubTab("connect")}
            className={`px-4 py-2 rounded text-sm font-medium transition ${
              subTab === "connect"
                ? "bg-[#1a1a1a] text-white"
                : "text-[#666] hover:text-[#888]"
            }`}
          >
            Connect Apps
          </button>
        </div>
      )}

      {/* Connect Apps Tab */}
      {composioConnected && subTab === "connect" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-medium">Connect Apps via Composio</h2>
              <p className="text-sm text-[#666] mt-1">
                Connect your accounts to enable tools in MCP configs
              </p>
            </div>
          </div>
          <IntegrationsPanel
            providerId="composio"
            onConnectionComplete={() => {
              // Refresh configs after connecting an app
              fetchComposioConfigs();
            }}
          />
        </div>
      )}

      {/* MCP Configs Tab */}
      {composioConnected && subTab === "configs" && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Composio MCP Configs</h2>
              <span className="text-xs text-green-400">Connected</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={fetchComposioConfigs}
                disabled={loadingConfigs}
                className="text-xs text-[#666] hover:text-[#888] transition"
              >
                {loadingConfigs ? "Loading..." : "Refresh"}
              </button>
              <a
                href="https://app.composio.dev/mcp_configs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#666] hover:text-[#f97316] transition"
              >
                Create Config →
              </a>
            </div>
          </div>

          {loadingConfigs ? (
            <div className="text-center py-6 text-[#666]">Loading configs...</div>
          ) : composioConfigs.length === 0 ? (
            <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 text-center">
              <p className="text-sm text-[#666]">No MCP configs found</p>
              <p className="text-xs text-[#555] mt-2">
                First <button onClick={() => setSubTab("connect")} className="text-[#f97316] hover:text-[#fb923c]">connect some apps</button>, then create a config.
              </p>
              <a
                href="https://app.composio.dev/mcp_configs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#f97316] hover:text-[#fb923c] mt-2 inline-block"
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
                    className={`bg-[#111] border rounded-lg p-3 transition flex items-center justify-between ${
                      added ? "border-green-500/30" : "border-[#1a1a1a] hover:border-[#333]"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{config.name}</span>
                        <span className="text-xs text-[#555]">{config.toolsCount} tools</span>
                        {added && (
                          <span className="text-xs text-green-400">Added</span>
                        )}
                      </div>
                      {config.toolkits.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {config.toolkits.slice(0, 4).map((toolkit) => (
                            <span
                              key={toolkit}
                              className="text-xs bg-[#1a1a1a] text-[#666] px-1.5 py-0.5 rounded"
                            >
                              {toolkit}
                            </span>
                          ))}
                          {config.toolkits.length > 4 && (
                            <span className="text-xs text-[#555]">+{config.toolkits.length - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      {added ? (
                        <span className="text-xs text-[#555] px-2 py-1">In Servers</span>
                      ) : (
                        <button
                          onClick={() => addComposioConfig(config.id)}
                          disabled={isAdding}
                          className="text-xs bg-[#f97316] hover:bg-[#fb923c] text-black px-3 py-1 rounded font-medium transition disabled:opacity-50"
                        >
                          {isAdding ? "Adding..." : "Add"}
                        </button>
                      )}
                      <a
                        href={`https://app.composio.dev/mcp_configs/${config.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[#666] hover:text-[#888] transition"
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

      {/* Smithery - placeholder for when we have API support */}
      {smitheryConnected && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Smithery</h2>
              <span className="text-xs text-green-400">Connected</span>
            </div>
            <a
              href="https://smithery.ai/servers"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#666] hover:text-[#f97316] transition"
            >
              View Servers →
            </a>
          </div>
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 text-center">
            <p className="text-sm text-[#666]">
              Smithery servers can be added from the Registry tab.
            </p>
          </div>
        </div>
      )}

      <div className="p-3 bg-[#0a0a0a] border border-[#222] rounded text-xs text-[#666]">
        <strong className="text-[#888]">Tip:</strong> Connect apps first, then add MCP configs to make tools available to your agents.
        {" · "}
        <a href="/settings" className="text-[#f97316] hover:text-[#fb923c]">Add more providers in Settings</a>
      </div>
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
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const { authFetch } = useAuth();
  const [mode, setMode] = useState<"npm" | "command">("npm");
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [command, setCommand] = useState("");
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    if (mode === "command" && !command) {
      setError("Command is required");
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
      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-[#1a1a1a] flex items-center justify-between sticky top-0 bg-[#111]">
          <h2 className="text-lg font-semibold">Add MCP Server</h2>
          <button onClick={onClose} className="text-[#666] hover:text-[#888]">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Quick picks */}
          <div>
            <p className="text-sm text-[#666] mb-2">Quick add:</p>
            <div className="flex flex-wrap gap-2">
              {[
                { name: "filesystem", pkg: "@modelcontextprotocol/server-filesystem" },
                { name: "fetch", pkg: "@modelcontextprotocol/server-fetch" },
                { name: "memory", pkg: "@modelcontextprotocol/server-memory" },
                { name: "github", pkg: "@modelcontextprotocol/server-github" },
              ].map(s => (
                <button
                  key={s.name}
                  onClick={() => quickAdd(s.name, s.pkg)}
                  className="text-sm bg-[#1a1a1a] hover:bg-[#222] px-3 py-1 rounded transition"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-1 bg-[#0a0a0a] border border-[#222] rounded p-1">
            <button
              onClick={() => setMode("npm")}
              className={`flex-1 px-3 py-1.5 rounded text-sm transition ${
                mode === "npm"
                  ? "bg-[#1a1a1a] text-white"
                  : "text-[#666] hover:text-[#888]"
              }`}
            >
              npm Package
            </button>
            <button
              onClick={() => setMode("command")}
              className={`flex-1 px-3 py-1.5 rounded text-sm transition ${
                mode === "command"
                  ? "bg-[#1a1a1a] text-white"
                  : "text-[#666] hover:text-[#888]"
              }`}
            >
              Custom Command
            </button>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-[#666] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., pushover"
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          {/* npm Package */}
          {mode === "npm" && (
            <div>
              <label className="block text-sm text-[#666] mb-1">npm Package</label>
              <input
                type="text"
                value={pkg}
                onChange={e => handlePackageChange(e.target.value)}
                placeholder="e.g., @modelcontextprotocol/server-filesystem or paste full command"
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
              />
              <p className="text-xs text-[#555] mt-1">
                Package name or paste a full npx command with credentials
              </p>
            </div>
          )}

          {/* Custom Command */}
          {mode === "command" && (
            <div>
              <label className="block text-sm text-[#666] mb-1">Command</label>
              <input
                type="text"
                value={command}
                onChange={e => handleCommandChange(e.target.value)}
                placeholder="e.g., npx -y pushover-mcp@latest start --token YOUR_TOKEN"
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-[#f97316]"
              />
              <p className="text-xs text-[#555] mt-1">
                Paste the full command - credentials like YOUR_TOKEN will be auto-extracted
              </p>
            </div>
          )}

          {/* Environment Variables / Credentials */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-[#666]">
                Environment Variables / Credentials
              </label>
              <button
                onClick={addEnvVar}
                className="text-xs text-[#f97316] hover:text-[#fb923c] transition"
              >
                + Add Variable
              </button>
            </div>

            {envVars.length === 0 && (
              <p className="text-xs text-[#555] bg-[#0a0a0a] border border-[#222] rounded p-3">
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
                      className="w-1/3 bg-[#0a0a0a] border border-[#333] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#f97316]"
                    />
                    <input
                      type="password"
                      value={env.value}
                      onChange={e => updateEnvVar(index, "value", e.target.value)}
                      placeholder="value"
                      className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-[#f97316]"
                    />
                    <button
                      onClick={() => removeEnvVar(index)}
                      className="text-[#666] hover:text-red-400 px-2 transition"
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

        <div className="p-4 border-t border-[#1a1a1a] flex justify-end gap-2 sticky bottom-0 bg-[#111]">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-[#333] hover:border-[#666] rounded transition"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={saving || !name || (mode === "npm" ? !pkg : !command)}
            className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] text-black rounded font-medium transition disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Server"}
          </button>
        </div>
      </div>
    </div>
  );
}
