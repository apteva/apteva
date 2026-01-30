import React, { useState, useEffect } from "react";
import { Chat } from "@apteva/apteva-kit";
import { CloseIcon, MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon } from "../common/Icons";
import { Select } from "../common/Select";
import type { Agent, Provider, AgentFeatures, McpServer } from "../../types";

type Tab = "chat" | "settings";

interface AgentPanelProps {
  agent: Agent;
  providers: Provider[];
  onClose: () => void;
  onStartAgent: (e?: React.MouseEvent) => void;
  onUpdateAgent: (updates: Partial<Agent>) => Promise<{ error?: string }>;
  onDeleteAgent: () => void;
}

const FEATURE_CONFIG = [
  { key: "memory" as keyof AgentFeatures, label: "Memory", description: "Persistent recall", icon: MemoryIcon },
  { key: "tasks" as keyof AgentFeatures, label: "Tasks", description: "Schedule and execute tasks", icon: TasksIcon },
  { key: "vision" as keyof AgentFeatures, label: "Vision", description: "Process images and PDFs", icon: VisionIcon },
  { key: "operator" as keyof AgentFeatures, label: "Operator", description: "Browser automation", icon: OperatorIcon },
  { key: "mcp" as keyof AgentFeatures, label: "MCP", description: "External tools/services", icon: McpIcon },
  { key: "realtime" as keyof AgentFeatures, label: "Realtime", description: "Voice conversations", icon: RealtimeIcon },
];

export function AgentPanel({ agent, providers, onClose, onStartAgent, onUpdateAgent, onDeleteAgent }: AgentPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[#0a0a0a] border-l border-[#1a1a1a]">
      {/* Header with tabs */}
      <div className="border-b border-[#1a1a1a] flex items-center justify-between px-4">
        <div className="flex gap-1">
          <TabButton active={activeTab === "chat"} onClick={() => setActiveTab("chat")}>
            Chat
          </TabButton>
          <TabButton active={activeTab === "settings"} onClick={() => setActiveTab("settings")}>
            Settings
          </TabButton>
        </div>
        <button
          onClick={onClose}
          className="text-[#666] hover:text-[#e0e0e0] transition p-2"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === "chat" && (
          <ChatTab agent={agent} onStartAgent={onStartAgent} />
        )}
        {activeTab === "settings" && (
          <SettingsTab agent={agent} providers={providers} onUpdateAgent={onUpdateAgent} onDeleteAgent={onDeleteAgent} />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition ${
        active
          ? "border-[#f97316] text-[#e0e0e0]"
          : "border-transparent text-[#666] hover:text-[#888]"
      }`}
    >
      {children}
    </button>
  );
}

function ChatTab({ agent, onStartAgent }: { agent: Agent; onStartAgent: (e?: React.MouseEvent) => void }) {
  if (agent.status === "running" && agent.port) {
    return (
      <Chat
        agentId="default"
        apiUrl={`/api/agents/${agent.id}`}
        placeholder="Message this agent..."
        context={agent.systemPrompt}
        variant="terminal"
        headerTitle={agent.name}
      />
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center text-[#666]">
      <div className="text-center">
        <p className="text-lg mb-2">Agent is not running</p>
        <button
          onClick={onStartAgent}
          className="bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/30 px-4 py-2 rounded font-medium transition"
        >
          Start Agent
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ agent, providers, onUpdateAgent, onDeleteAgent }: {
  agent: Agent;
  providers: Provider[];
  onUpdateAgent: (updates: Partial<Agent>) => Promise<{ error?: string }>;
  onDeleteAgent: () => void;
}) {
  const [form, setForm] = useState({
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    features: { ...agent.features },
    mcpServers: [...(agent.mcpServers || [])],
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);

  // Fetch available MCP servers
  useEffect(() => {
    const fetchMcpServers = async () => {
      try {
        const res = await fetch("/api/mcp/servers");
        const data = await res.json();
        setAvailableMcpServers(data.servers || []);
      } catch (e) {
        console.error("Failed to fetch MCP servers:", e);
      }
    };
    fetchMcpServers();
  }, []);

  // Reset form when agent changes
  useEffect(() => {
    setForm({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      features: { ...agent.features },
      mcpServers: [...(agent.mcpServers || [])],
    });
    setMessage(null);
  }, [agent.id]);

  const selectedProvider = providers.find(p => p.id === form.provider);

  const providerOptions = providers
    .filter(p => p.configured)
    .map(p => ({ value: p.id, label: p.name }));

  const modelOptions = selectedProvider?.models.map(m => ({
    value: m.value,
    label: m.label,
    recommended: m.recommended,
  })) || [];

  const handleProviderChange = (providerId: string) => {
    const provider = providers.find(p => p.id === providerId);
    const defaultModel = provider?.models.find(m => m.recommended)?.value || provider?.models[0]?.value || "";
    setForm(prev => ({ ...prev, provider: providerId, model: defaultModel }));
  };

  const toggleFeature = (key: keyof AgentFeatures) => {
    setForm(prev => ({
      ...prev,
      features: { ...prev.features, [key]: !prev.features[key] },
    }));
  };

  const toggleMcpServer = (serverId: string) => {
    setForm(prev => ({
      ...prev,
      mcpServers: prev.mcpServers.includes(serverId)
        ? prev.mcpServers.filter(id => id !== serverId)
        : [...prev.mcpServers, serverId],
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    const result = await onUpdateAgent(form);
    setSaving(false);
    if (result.error) {
      setMessage({ type: "error", text: result.error });
    } else {
      setMessage({ type: "success", text: "Settings saved" });
      setTimeout(() => setMessage(null), 2000);
    }
  };

  const hasChanges =
    form.name !== agent.name ||
    form.provider !== agent.provider ||
    form.model !== agent.model ||
    form.systemPrompt !== agent.systemPrompt ||
    JSON.stringify(form.features) !== JSON.stringify(agent.features) ||
    JSON.stringify(form.mcpServers.sort()) !== JSON.stringify((agent.mcpServers || []).sort());

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="space-y-4">
        <FormField label="Name">
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
          />
        </FormField>

        <FormField label="Provider">
          <Select
            value={form.provider}
            options={providerOptions}
            onChange={handleProviderChange}
          />
        </FormField>

        <FormField label="Model">
          <Select
            value={form.model}
            options={modelOptions}
            onChange={(value) => setForm(prev => ({ ...prev, model: value }))}
          />
        </FormField>

        <FormField label="System Prompt">
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
          />
        </FormField>

        <FormField label="Features">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleFeature(key)}
                className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                  form.features[key]
                    ? "border-[#f97316] bg-[#f97316]/10"
                    : "border-[#222] hover:border-[#333]"
                }`}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${form.features[key] ? "text-[#f97316]" : "text-[#666]"}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${form.features[key] ? "text-[#f97316]" : ""}`}>
                    {label}
                  </div>
                  <div className="text-xs text-[#666]">{description}</div>
                </div>
              </button>
            ))}
          </div>
        </FormField>

        {/* MCP Server Selection - shown when MCP is enabled */}
        {form.features.mcp && (
          <FormField label="MCP Servers">
            {availableMcpServers.length === 0 ? (
              <p className="text-sm text-[#666]">
                No MCP servers configured. Add servers in the MCP page first.
              </p>
            ) : (
              <div className="space-y-2">
                {availableMcpServers.map(server => (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => toggleMcpServer(server.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded border text-left transition ${
                      form.mcpServers.includes(server.id)
                        ? "border-[#f97316] bg-[#f97316]/10"
                        : "border-[#222] hover:border-[#333]"
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      server.status === "running" ? "bg-green-400" : "bg-[#444]"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${form.mcpServers.includes(server.id) ? "text-[#f97316]" : ""}`}>
                        {server.name}
                      </div>
                      <div className="text-xs text-[#666]">
                        {server.type} • {server.package || server.command || "custom"}
                        {server.status === "running" && server.port && ` • :${server.port}`}
                      </div>
                    </div>
                    <div className={`text-xs px-2 py-0.5 rounded ${
                      server.status === "running"
                        ? "bg-green-500/20 text-green-400"
                        : "bg-[#222] text-[#666]"
                    }`}>
                      {server.status}
                    </div>
                  </button>
                ))}
                <p className="text-xs text-[#666] mt-2">
                  Only running servers will be connected to the agent.
                </p>
              </div>
            )}
          </FormField>
        )}

        {message && (
          <div className={`text-sm px-3 py-2 rounded ${
            message.type === "success"
              ? "bg-green-500/10 text-green-400"
              : "bg-red-500/10 text-red-400"
          }`}>
            {message.text}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={!hasChanges || saving || !form.name}
          className="w-full bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>

        {agent.status === "running" && hasChanges && (
          <p className="text-xs text-[#666] text-center">
            Changes will be applied to the running agent
          </p>
        )}

        {/* Danger Zone */}
        <div className="mt-8 pt-6 border-t border-[#222]">
          <p className="text-sm text-[#666] mb-3">Danger Zone</p>
          {confirmDelete ? (
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 border border-[#333] hover:border-[#444] px-4 py-2 rounded font-medium transition"
              >
                Cancel
              </button>
              <button
                onClick={onDeleteAgent}
                className="flex-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 px-4 py-2 rounded font-medium transition"
              >
                Confirm Delete
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full border border-red-500/30 text-red-400/70 hover:border-red-500/50 hover:text-red-400 px-4 py-2 rounded font-medium transition"
            >
              Delete Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-[#666] mb-1">{label}</label>
      {children}
    </div>
  );
}
