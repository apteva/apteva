import React from "react";
import { AgentCard } from "./AgentCard";
import { AgentPanel } from "./AgentPanel";
import { LoadingSpinner } from "../common/LoadingSpinner";
import type { Agent, Provider } from "../../types";

interface AgentsViewProps {
  agents: Agent[];
  loading: boolean;
  selectedAgent: Agent | null;
  providers: Provider[];
  onSelectAgent: (agent: Agent) => void;
  onCloseAgent: () => void;
  onToggleAgent: (agent: Agent, e?: React.MouseEvent) => void;
  onDeleteAgent: (id: string, e?: React.MouseEvent) => void;
  onUpdateAgent: (id: string, updates: Partial<Agent>) => Promise<{ error?: string }>;
}

export function AgentsView({
  agents,
  loading,
  selectedAgent,
  providers,
  onSelectAgent,
  onCloseAgent,
  onToggleAgent,
  onDeleteAgent,
  onUpdateAgent,
}: AgentsViewProps) {
  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* Agents list */}
      <div className="flex-1 overflow-auto p-6">
        {loading ? (
          <LoadingSpinner message="Loading agents..." />
        ) : agents.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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

      {/* Overlay backdrop */}
      {selectedAgent && (
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-[2px] z-10"
          onClick={onCloseAgent}
        />
      )}

      {/* Agent Panel - slides in from right */}
      {selectedAgent && (
        <div className="absolute right-0 top-0 bottom-0 w-[600px] z-20">
          <AgentPanel
            agent={selectedAgent}
            providers={providers}
            onClose={onCloseAgent}
            onStartAgent={(e) => onToggleAgent(selectedAgent, e)}
            onUpdateAgent={(updates) => onUpdateAgent(selectedAgent.id, updates)}
            onDeleteAgent={() => onDeleteAgent(selectedAgent.id)}
          />
        </div>
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
