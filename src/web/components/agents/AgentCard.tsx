import React from "react";
import { MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon } from "../common/Icons";
import type { Agent, AgentFeatures } from "../../types";

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onToggle: (e?: React.MouseEvent) => void;
  onDelete: (e?: React.MouseEvent) => void;
}

const FEATURE_ICONS: { key: keyof AgentFeatures; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { key: "memory", icon: MemoryIcon, label: "Memory" },
  { key: "tasks", icon: TasksIcon, label: "Tasks" },
  { key: "vision", icon: VisionIcon, label: "Vision" },
  { key: "operator", icon: OperatorIcon, label: "Operator" },
  { key: "mcp", icon: McpIcon, label: "MCP" },
  { key: "realtime", icon: RealtimeIcon, label: "Realtime" },
];

export function AgentCard({ agent, selected, onSelect, onToggle, onDelete }: AgentCardProps) {
  const enabledFeatures = FEATURE_ICONS.filter(f => agent.features?.[f.key]);
  const mcpServers = agent.mcpServerDetails || [];

  return (
    <div
      onClick={onSelect}
      className={`bg-[#111] rounded p-5 border transition cursor-pointer ${
        selected
          ? 'border-[#f97316]'
          : 'border-[#1a1a1a] hover:border-[#333]'
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-lg">{agent.name}</h3>
          <p className="text-sm text-[#666]">
            {agent.provider} / {agent.model}
            {agent.port && <span className="text-[#444]"> · :{agent.port}</span>}
          </p>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      {enabledFeatures.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {enabledFeatures.map(({ key, icon: Icon, label }) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#f97316]/10 text-[#f97316]/70 text-xs"
              title={label}
            >
              <Icon className="w-3 h-3" />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {mcpServers.map((server) => (
            <span
              key={server.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                server.status === "running"
                  ? "bg-green-500/10 text-green-400"
                  : "bg-[#222] text-[#666]"
              }`}
              title={`MCP: ${server.name} (${server.status})`}
            >
              <McpIcon className="w-3 h-3" />
              {server.name}
            </span>
          ))}
        </div>
      )}

      <p className="text-sm text-[#666] line-clamp-2 mb-4">
        {agent.systemPrompt}
      </p>

      <div className="flex gap-2">
        <button
          onClick={onToggle}
          className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition ${
            agent.status === "running"
              ? "bg-[#f97316]/20 text-[#f97316] hover:bg-[#f97316]/30"
              : "bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/30"
          }`}
        >
          {agent.status === "running" ? "Stop" : "Start"}
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 rounded text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Agent["status"] }) {
  return (
    <span
      className={`px-2 py-1 rounded text-xs font-medium ${
        status === "running"
          ? "bg-[#3b82f6]/20 text-[#3b82f6]"
          : "bg-[#333] text-[#666]"
      }`}
    >
      {status}
    </span>
  );
}
