import React, { useState, useEffect } from "react";
import { MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, FilesIcon, MultiAgentIcon, SkillsIcon, ActivityIcon } from "../common/Icons";
import { useAgentActivity, useProjects, useAuth } from "../../context";
import type { Agent, AgentFeatures } from "../../types";

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
  onToggle: (e?: React.MouseEvent) => void;
  showProject?: boolean;
}

const FEATURE_ICONS: { key: keyof AgentFeatures; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { key: "memory", icon: MemoryIcon, label: "Memory" },
  { key: "tasks", icon: TasksIcon, label: "Tasks" },
  { key: "files", icon: FilesIcon, label: "Files" },
  { key: "vision", icon: VisionIcon, label: "Vision" },
  { key: "operator", icon: OperatorIcon, label: "Operator" },
  { key: "mcp", icon: McpIcon, label: "MCP" },
  { key: "realtime", icon: RealtimeIcon, label: "Realtime" },
  { key: "agents", icon: MultiAgentIcon, label: "Multi-Agent" },
];

export function AgentCard({ agent, selected, onSelect, onToggle, showProject }: AgentCardProps) {
  const enabledFeatures = FEATURE_ICONS.filter(f => agent.features?.[f.key]);
  const mcpServers = agent.mcpServerDetails || [];
  const skills = agent.skillDetails || [];
  const { isActive, type } = useAgentActivity(agent.id);
  const { projects } = useProjects();
  const { authFetch } = useAuth();
  const project = agent.projectId ? projects.find(p => p.id === agent.projectId) : null;
  const [subscriptions, setSubscriptions] = useState<{ id: string; trigger_slug: string; enabled: boolean }[]>([]);

  useEffect(() => {
    authFetch(`/api/subscriptions?agent_id=${agent.id}`)
      .then(res => res.ok ? res.json() : { subscriptions: [] })
      .then(data => setSubscriptions(data.subscriptions || []))
      .catch(() => {});
  }, [agent.id, authFetch]);

  return (
    <div
      onClick={onSelect}
      className={`bg-[#111] rounded p-5 border transition cursor-pointer flex flex-col h-full ${
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
          {showProject && project && (
            <p className="text-sm text-[#666] flex items-center gap-1.5 mt-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
              {project.name}
            </p>
          )}
        </div>
        <StatusBadge status={agent.status} isActive={isActive && agent.status === "running"} activityType={type} />
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
          {mcpServers.map((server) => {
            // HTTP/remote servers are always available
            const isAvailable = (server.type === "http" && server.url) || server.status === "running";
            return (
              <span
                key={server.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                  isAvailable
                    ? "bg-green-500/10 text-green-400"
                    : "bg-[#222] text-[#666]"
                }`}
                title={`MCP: ${server.name} (${isAvailable ? "available" : server.status})`}
              >
                <McpIcon className="w-3 h-3" />
                {server.name}
              </span>
            );
          })}
        </div>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {skills.map((skill) => (
            <span
              key={skill.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                skill.enabled
                  ? "bg-purple-500/10 text-purple-400"
                  : "bg-[#222] text-[#666]"
              }`}
              title={`Skill: ${skill.name} v${skill.version}`}
            >
              <SkillsIcon className="w-3 h-3" />
              {skill.name}
            </span>
          ))}
        </div>
      )}

      {/* Subscriptions (triggers listening to) */}
      {subscriptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {subscriptions.map((sub) => (
            <span
              key={sub.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                sub.enabled
                  ? "bg-cyan-500/10 text-cyan-400"
                  : "bg-[#222] text-[#666]"
              }`}
              title={`Trigger: ${sub.trigger_slug.replace(/_/g, " ")}`}
            >
              <ActivityIcon className="w-3 h-3" />
              {sub.trigger_slug.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      <p className="text-sm text-[#666] line-clamp-2 mb-4 flex-1">
        {agent.systemPrompt}
      </p>

      <button
        onClick={onToggle}
        disabled={agent.status === "starting" || agent.status === "stopping"}
        className={`w-full px-3 py-1.5 rounded text-sm font-medium transition mt-auto ${
          agent.status === "starting" || agent.status === "stopping"
            ? "bg-[#333] text-[#666] cursor-wait"
            : agent.status === "running"
              ? "bg-[#f97316]/20 text-[#f97316] hover:bg-[#f97316]/30"
              : "bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/30"
        }`}
      >
        {agent.status === "starting" ? "Starting..." : agent.status === "stopping" ? "Stopping..." : agent.status === "running" ? "Stop" : "Start"}
      </button>
    </div>
  );
}

function StatusBadge({ status, isActive, activityType }: { status: Agent["status"]; isActive?: boolean; activityType?: string }) {
  if (status === "running" && isActive && activityType) {
    return (
      <span className="px-2 py-1 rounded text-xs font-medium bg-green-500/20 text-green-400 animate-pulse">
        {activityType}
      </span>
    );
  }

  const isTransitioning = status === "starting" || status === "stopping";

  return (
    <span
      className={`px-2 py-1 rounded text-xs font-medium ${
        isTransitioning
          ? "bg-yellow-500/20 text-yellow-400 animate-pulse"
          : status === "running"
            ? "bg-[#3b82f6]/20 text-[#3b82f6]"
            : "bg-[#333] text-[#666]"
      }`}
    >
      {status}
    </span>
  );
}
