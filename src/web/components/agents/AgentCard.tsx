import React from "react";
import type { Agent } from "../../types";

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onToggle: (e?: React.MouseEvent) => void;
  onDelete: (e?: React.MouseEvent) => void;
}

export function AgentCard({ agent, selected, onSelect, onToggle, onDelete }: AgentCardProps) {
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
