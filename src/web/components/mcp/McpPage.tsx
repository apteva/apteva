import React, { useState, useEffect } from "react";
import { McpIcon } from "../common/Icons";
import type { McpTool, McpToolCallResult } from "../../types";

interface McpServer {
  id: string;
  name: string;
  type: "npm" | "github" | "http" | "custom";
  package: string | null;
  command: string | null;
  args: string | null;
  env: Record<string, string>;
  port: number | null;
  status: "stopped" | "running";
  created_at: string;
}

export function McpPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);

  const fetchServers = async () => {
    try {
      const res = await fetch("/api/mcp/servers");
      const data = await res.json();
      setServers(data.servers || []);
    } catch (e) {
      console.error("Failed to fetch MCP servers:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchServers();
  }, []);

  const startServer = async (id: string) => {
    try {
      await fetch(`/api/mcp/servers/${id}/start`, { method: "POST" });
      fetchServers();
    } catch (e) {
      console.error("Failed to start server:", e);
    }
  };

  const stopServer = async (id: string) => {
    try {
      await fetch(`/api/mcp/servers/${id}/stop`, { method: "POST" });
      fetchServers();
    } catch (e) {
      console.error("Failed to stop server:", e);
    }
  };

  const deleteServer = async (id: string) => {
    if (!confirm("Delete this MCP server?")) return;
    try {
      await fetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
      if (selectedServer?.id === id) {
        setSelectedServer(null);
      }
      fetchServers();
    } catch (e) {
      console.error("Failed to delete server:", e);
    }
  };

  return (
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
          <button
            onClick={() => setShowAdd(true)}
            className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
          >
            + Add Server
          </button>
        </div>

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
            <button
              onClick={() => setShowAdd(true)}
              className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
            >
              Add Your First Server
            </button>
          </div>
        )}

        {/* Main content with server list and tools panel */}
        {!loading && servers.length > 0 && (
          <div className="flex gap-6">
            {/* Server List */}
            <div className={`space-y-3 ${selectedServer ? "w-1/2" : "w-full"}`}>
              {servers.map(server => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  selected={selectedServer?.id === server.id}
                  onSelect={() => setSelectedServer(server.status === "running" ? server : null)}
                  onStart={() => startServer(server.id)}
                  onStop={() => stopServer(server.id)}
                  onDelete={() => deleteServer(server.id)}
                />
              ))}
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

        {/* Info */}
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
  return (
    <div
      className={`bg-[#111] border rounded-lg p-4 cursor-pointer transition ${
        selected ? "border-[#f97316]" : "border-[#1a1a1a] hover:border-[#333]"
      }`}
      onClick={server.status === "running" ? onSelect : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${
            server.status === "running" ? "bg-green-400" : "bg-[#444]"
          }`} />
          <div>
            <h3 className="font-medium">{server.name}</h3>
            <p className="text-sm text-[#666]">
              {server.type} • {server.package || server.command || "custom"}
              {server.status === "running" && server.port && ` • :${server.port}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {server.status === "running" ? (
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
            </>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onStart(); }}
              className="text-sm text-[#666] hover:text-green-400 px-3 py-1 transition"
            >
              Start
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-sm text-[#666] hover:text-red-400 px-3 py-1 transition"
          >
            Delete
          </button>
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
        const res = await fetch(`/api/mcp/servers/${server.id}/tools`);
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
  }, [server.id]);

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
      const res = await fetch(`/api/mcp/servers/${serverId}/tools/${encodeURIComponent(tool.name)}/call`, {
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

function AddServerModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!name || !pkg) {
      setError("Name and package are required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type: "npm",
          package: pkg,
        }),
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
    setName(serverName);
    setPkg(serverPkg);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-50 flex items-center justify-center p-4">
      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-lg">
        <div className="p-4 border-b border-[#1a1a1a] flex items-center justify-between">
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
                { name: "weather", pkg: "@dangahagan/weather-mcp" },
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

          <div>
            <label className="block text-sm text-[#666] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g., filesystem"
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          <div>
            <label className="block text-sm text-[#666] mb-1">npm Package</label>
            <input
              type="text"
              value={pkg}
              onChange={e => setPkg(e.target.value)}
              placeholder="e.g., @modelcontextprotocol/server-filesystem"
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        <div className="p-4 border-t border-[#1a1a1a] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-[#333] hover:border-[#666] rounded transition"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={saving || !name || !pkg}
            className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] text-black rounded font-medium transition disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Server"}
          </button>
        </div>
      </div>
    </div>
  );
}
