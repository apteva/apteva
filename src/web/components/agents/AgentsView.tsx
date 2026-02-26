import React, { useMemo } from "react";
import { AgentCard } from "./AgentCard";
import { AgentPanel } from "./AgentPanel";
import { LoadingSpinner } from "../common/LoadingSpinner";
import { useProjects } from "../../context";
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
  onNewAgent?: () => void;
  canCreateAgent?: boolean;
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
  onNewAgent,
  canCreateAgent = true,
}: AgentsViewProps) {
  const { currentProjectId, currentProject } = useProjects();

  // Filter agents by current project
  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) {
      // "All Projects" - show all agents
      return agents;
    }
    if (currentProjectId === "unassigned") {
      // Show only agents without a project
      return agents.filter(a => !a.projectId);
    }
    // Show only agents in the selected project
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const headerTitle = currentProjectId === null
    ? "Agents"
    : currentProjectId === "unassigned"
    ? "Unassigned Agents"
    : currentProject?.name || "Agents";

  return (
    <div className="flex-1 flex overflow-hidden relative">
      {/* Agents list */}
      <div className="flex-1 overflow-auto p-6">
        {/* Header with create button */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {currentProject && (
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: currentProject.color }}
              />
            )}
            <h1 className="text-xl font-semibold">{headerTitle}</h1>
            {currentProjectId !== null && (
              <span className="text-sm text-[var(--color-text-muted)]">
                ({filteredAgents.length} agent{filteredAgents.length !== 1 ? "s" : ""})
              </span>
            )}
          </div>
          {onNewAgent && (
            <button
              onClick={onNewAgent}
              disabled={!canCreateAgent}
              className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
            >
              + New Agent
            </button>
          )}
        </div>

        {loading ? (
          <LoadingSpinner message="Loading agents..." />
        ) : filteredAgents.length === 0 ? (
          <EmptyState onNewAgent={onNewAgent} canCreateAgent={canCreateAgent} hasProjectFilter={currentProjectId !== null} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 auto-rows-fr">
            {filteredAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={selectedAgent?.id === agent.id}
                onSelect={() => onSelectAgent(agent)}
                onToggle={(e) => onToggleAgent(agent, e)}
                showProject={currentProjectId === null}
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
        <div className="absolute right-0 top-0 bottom-0 w-full sm:w-[500px] lg:w-[600px] xl:w-[700px] z-20">
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

function EmptyState({ onNewAgent, canCreateAgent, hasProjectFilter }: { onNewAgent?: () => void; canCreateAgent?: boolean; hasProjectFilter?: boolean }) {
  return (
    <div className="text-center py-20 text-[var(--color-text-muted)]">
      {hasProjectFilter ? (
        <>
          <p className="text-lg">No agents in this project</p>
          <p className="text-sm mt-1">Create an agent or assign existing agents to this project</p>
        </>
      ) : (
        <>
          <p className="text-lg">No agents yet</p>
          <p className="text-sm mt-1">Create your first agent to get started</p>
        </>
      )}
      {onNewAgent && (
        <button
          onClick={onNewAgent}
          disabled={!canCreateAgent}
          className="mt-4 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
        >
          + New Agent
        </button>
      )}
    </div>
  );
}
