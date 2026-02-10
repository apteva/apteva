import React, { useState, useMemo, useEffect, useRef } from "react";
import { useAgentActivity, useAuth, useProjects, useTelemetryContext } from "../../context";
import type { TelemetryEvent } from "../../context";
import type { Agent } from "../../types";
import { CloseIcon } from "../common/Icons";

interface ActivityPageProps {
  agents: Agent[];
  loading: boolean;
}

export function ActivityPage({ agents, loading }: ActivityPageProps) {
  const { currentProjectId } = useProjects();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) return agents;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const selectedAgent = filteredAgents.find(a => a.id === selectedAgentId) || null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top: Agent Visualization */}
      <div className="flex-[3] min-h-0 p-6 overflow-auto">
        <ActivityVisualization
          agents={filteredAgents}
          loading={loading}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
        />
      </div>

      {/* Bottom: Command + Stream */}
      <div className="flex-[2] min-h-0 border-t border-[#1a1a1a] flex">
        <QuickCommandPanel
          agent={selectedAgent}
          onClose={() => setSelectedAgentId(null)}
        />
        <LiveActivityStream agents={filteredAgents} />
      </div>
    </div>
  );
}

// --- Visualization Grid ---

function ActivityVisualization({ agents, loading, selectedAgentId, onSelectAgent }: {
  agents: Agent[];
  loading: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
}) {
  if (loading) {
    return <div className="flex items-center justify-center h-full text-[#666]">Loading agents...</div>;
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#666]">
        <div className="text-center">
          <p className="text-lg">No agents found</p>
          <p className="text-sm text-[#444] mt-1">Create and start agents to see them here</p>
        </div>
      </div>
    );
  }

  const runningCount = agents.filter(a => a.status === "running").length;

  return (
    <div className="h-full flex flex-col">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Activity</h2>
        <span className="text-sm text-[#666]">
          {runningCount} of {agents.length} running
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-8">
          {agents.map(agent => (
            <AgentNode
              key={agent.id}
              agent={agent}
              selected={selectedAgentId === agent.id}
              onClick={() => onSelectAgent(selectedAgentId === agent.id ? null : agent.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Agent Node ---

function AgentNode({ agent, selected, onClick }: {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
}) {
  const { isActive, type } = useAgentActivity(agent.id);
  const isRunning = agent.status === "running";

  const ringStyle = selected
    ? "ring-2 ring-[#f97316] shadow-[0_0_12px_rgba(249,115,22,0.3)]"
    : isRunning && isActive
      ? "ring-2 ring-green-400"
      : isRunning
        ? "ring-1 ring-[#3b82f6]/60"
        : "ring-1 ring-[#333]";

  const bgClass = isRunning
    ? isActive ? "bg-green-500/10" : "bg-[#1a1a1a]"
    : "bg-[#111]";

  const textClass = isRunning ? "text-[#e0e0e0]" : "text-[#555]";

  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-2 group"
    >
      <div className={`w-16 h-16 rounded-full ${bgClass} ${ringStyle} flex items-center justify-center transition-all duration-300 group-hover:scale-110 relative`}>
        <span className={`text-xl font-semibold ${textClass}`}>
          {agent.name.charAt(0).toUpperCase()}
        </span>
        {isActive && isRunning && (
          <div className="absolute inset-0 rounded-full bg-green-400/20 animate-ping" style={{ animationDuration: "1.5s" }} />
        )}
        {isRunning && isActive && (
          <div className="absolute inset-0 rounded-full animate-pulse" style={{ boxShadow: "0 0 12px 3px rgba(74, 222, 128, 0.4)" }} />
        )}
      </div>
      <div className="text-center max-w-[100px]">
        <p className={`text-xs font-medium truncate ${textClass}`}>{agent.name}</p>
        {isActive && type ? (
          <p className="text-[10px] text-green-400 truncate">{type}</p>
        ) : (
          <p className={`text-[10px] ${isRunning ? "text-[#3b82f6]" : "text-[#444]"}`}>
            {isRunning ? "idle" : "stopped"}
          </p>
        )}
      </div>
    </button>
  );
}

// --- Live Activity Stream ---

const categoryColors: Record<string, string> = {
  LLM: "bg-purple-500/20 text-purple-400",
  TOOL: "bg-blue-500/20 text-blue-400",
  CHAT: "bg-green-500/20 text-green-400",
  ERROR: "bg-red-500/20 text-red-400",
  SYSTEM: "bg-gray-500/20 text-gray-400",
  TASK: "bg-yellow-500/20 text-yellow-400",
  MEMORY: "bg-cyan-500/20 text-cyan-400",
  MCP: "bg-orange-500/20 text-orange-400",
};

function LiveActivityStream({ agents }: { agents: Agent[] }) {
  const { events } = useTelemetryContext();
  const scrollRef = useRef<HTMLDivElement>(null);

  const agentIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    agents.forEach(a => map.set(a.id, a.name));
    return map;
  }, [agents]);

  const filteredEvents = useMemo(() => {
    return events
      .filter(e => agentIds.has(e.agent_id))
      .slice(0, 50);
  }, [events, agentIds]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-l border-[#1a1a1a]">
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between shrink-0">
        <h3 className="font-semibold text-sm">Live Activity</h3>
        <span className="text-xs text-[#666]">{filteredEvents.length} events</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {filteredEvents.length === 0 ? (
          <div className="p-4 text-center text-[#666] text-sm">
            No activity yet. Events appear in real-time.
          </div>
        ) : (
          <div className="divide-y divide-[#1a1a1a]">
            {filteredEvents.map(event => (
              <div key={event.id} className="px-4 py-2 hover:bg-[#111] transition" style={{ animation: "slideIn 0.3s ease-out" }}>
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${categoryColors[event.category] || "bg-[#222] text-[#888]"}`}>
                    {event.category}
                  </span>
                  <span className="text-xs font-medium truncate flex-1">{event.type}</span>
                  <span className="text-[10px] text-[#555] shrink-0">{timeAgo(event.timestamp)}</span>
                </div>
                <div className="text-[10px] text-[#555] mt-0.5">
                  {agentNameMap.get(event.agent_id) || event.agent_id}
                  {event.duration_ms ? ` \u00b7 ${event.duration_ms}ms` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Quick Command Panel ---

function QuickCommandPanel({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const { authFetch } = useAuth();
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setCommand("");
    setToast(null);
  }, [agent?.id]);

  if (!agent) {
    return (
      <div className="w-80 shrink-0 flex items-center justify-center text-[#555] text-sm p-4 text-center">
        Click an agent to send a quick command
      </div>
    );
  }

  const handleSend = async () => {
    if (!command.trim() || sending) return;
    if (agent.status !== "running") {
      setToast("Agent is not running");
      setTimeout(() => setToast(null), 3000);
      return;
    }
    setSending(true);
    try {
      const res = await authFetch(`/api/agents/${agent.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: command, agent_id: agent.id }),
      });
      if (res.ok) {
        setToast("Command sent");
        setCommand("");
      } else {
        const data = await res.json().catch(() => ({}));
        setToast(data.error || "Failed to send");
      }
    } catch {
      setToast("Failed to send command");
    } finally {
      setSending(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  const isRunning = agent.status === "running";

  return (
    <div className="w-80 shrink-0 flex flex-col">
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
          <p className={`text-[10px] ${isRunning ? "text-green-400" : "text-[#666]"}`}>
            {isRunning ? "Running" : "Stopped"}
          </p>
        </div>
        <button onClick={onClose} className="text-[#666] hover:text-[#e0e0e0] transition shrink-0 ml-2">
          <CloseIcon className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 p-4 flex flex-col justify-end">
        {toast && (
          <div className={`mb-3 px-3 py-2 rounded text-xs ${
            toast === "Command sent"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-red-500/10 border border-red-500/20 text-red-400"
          }`}>
            {toast}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSend()}
            placeholder={isRunning ? "Quick command..." : "Agent not running"}
            disabled={sending || !isRunning}
            className="flex-1 bg-[#111] border border-[#1a1a1a] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#f97316] placeholder-[#444] disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={sending || !command.trim() || !isRunning}
            className="px-3 py-2 bg-[#f97316]/20 text-[#f97316] rounded text-sm font-medium hover:bg-[#f97316]/30 transition disabled:opacity-30"
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

function timeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
