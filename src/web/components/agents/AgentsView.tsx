import React from "react";
import { AgentCard } from "./AgentCard";
import { ChatPanel } from "./ChatPanel";
import { LoadingSpinner } from "../common/LoadingSpinner";
import type { Agent } from "../../types";

interface AgentsViewProps {
  agents: Agent[];
  loading: boolean;
  selectedAgent: Agent | null;
  onSelectAgent: (agent: Agent) => void;
  onCloseAgent: () => void;
  onToggleAgent: (agent: Agent, e?: React.MouseEvent) => void;
  onDeleteAgent: (id: string, e?: React.MouseEvent) => void;
}

export function AgentsView({
  agents,
  loading,
  selectedAgent,
  onSelectAgent,
  onCloseAgent,
  onToggleAgent,
  onDeleteAgent,
}: AgentsViewProps) {
  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Agents list */}
      <div className={`${selectedAgent ? 'w-1/2 border-r border-[#1a1a1a]' : 'flex-1'} overflow-auto p-6 transition-all`}>
        {loading ? (
          <LoadingSpinner message="Loading agents..." />
        ) : agents.length === 0 ? (
          <EmptyState />
        ) : (
          <div className={`grid gap-4 ${selectedAgent ? 'grid-cols-1 xl:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3'}`}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgent?.id === agent.id}
                onSelect={() => onSelectAgent(agent)}
                onToggle={(e) => onToggleAgent(agent, e)}
                onDelete={(e) => onDeleteAgent(agent.id, e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Chat Panel */}
      {selectedAgent && (
        <ChatPanel
          agent={selectedAgent}
          onClose={onCloseAgent}
          onStartAgent={(e) => onToggleAgent(selectedAgent, e)}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-20 text-[#666]">
      <p className="text-lg">No agents yet</p>
      <p className="text-sm mt-1">Create your first agent to get started</p>
    </div>
  );
}
