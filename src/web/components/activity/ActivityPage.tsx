import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useAuth, useProjects, useTelemetryContext } from "../../context";
import type { TelemetryEvent } from "../../context";
import type { Agent, Route } from "../../types";
import { Select } from "../common/Select";

interface ActivityPageProps {
  agents: Agent[];
  loading: boolean;
  onNavigate?: (route: Route) => void;
}

// Event types we show in the timeline (skip noisy internal ones)
const VISIBLE_TYPES = new Set([
  "thread_activity",
  "agent_started",
  "agent_stopped",
  "agent_error",
  "task_created",
  "task_updated",
  "task_deleted",
  "task_executed",
  "llm_request",
  "tool_invocation",
  "mcp_request",
  "mcp_tool_execution",
]);

// Category colors for the timeline dot
const CATEGORY_COLORS: Record<string, string> = {
  CHAT: "bg-green-400",
  LLM: "bg-purple-400",
  TOOL: "bg-blue-400",
  TASK: "bg-yellow-400",
  MEMORY: "bg-cyan-400",
  MCP: "bg-orange-400",
  SYSTEM: "bg-gray-400",
  ERROR: "bg-red-400",
};

function describeEvent(evt: TelemetryEvent, agentName: string): string {
  const data = evt.data || {};
  switch (evt.type) {
    case "thread_activity":
      return (data.activity as string) || "Working...";
    case "agent_started":
      return "Agent started";
    case "agent_stopped":
      return data.reason ? `Agent stopped (${data.reason})` : "Agent stopped";
    case "agent_error":
      return evt.error || "Agent error";
    case "llm_request":
      return "Thinking...";
    case "tool_invocation": {
      const toolRaw = (data.tool_name || "") as string;
      if (!toolRaw) return "Using tools";
      const toolFormatted = toolRaw.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      return `Tool: ${toolFormatted}`;
    }
    case "task_created":
      return data.title ? `Task created: ${data.title}` : "Task created";
    case "task_updated": {
      const status = data.status as string | undefined;
      const title = data.title as string | undefined;
      const statusLabel = status ? status.charAt(0).toUpperCase() + status.slice(1) : null;
      if (title && statusLabel) return `Task ${statusLabel}: ${title}`;
      if (statusLabel) return `Task ${statusLabel}`;
      if (title) return `Task updated: ${title}`;
      return "Task updated";
    }
    case "task_deleted":
      return "Task deleted";
    case "task_executed": {
      const title = data.title as string | undefined;
      return title ? `Task started: ${title}` : "Task started";
    }
    case "memory_stored":
      return "Memory stored";
    case "memory_retrieved":
      return "Memory retrieved";
    case "mcp_request":
      return data.server ? `MCP request to ${data.server}` : "MCP request";
    case "mcp_tool_execution": {
      const rawName = (data.tool_name || data.tool || "") as string;
      if (!rawName) return "MCP tool call";
      // "Server__tool-name-here" -> take part after __, format dashes/underscores to spaces, title case
      const toolPart = rawName.includes("__") ? rawName.split("__").slice(1).join("__") : rawName;
      const formatted = toolPart.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      return `MCP: ${formatted}`;
    }
    default:
      return evt.type.replace(/_/g, " ");
  }
}

export function ActivityPage({ agents, loading, onNavigate }: ActivityPageProps) {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const { events: realtimeEvents, statusChangeCounter } = useTelemetryContext();
  const [historicalEvents, setHistoricalEvents] = useState<TelemetryEvent[]>([]);
  const [filterAgentId, setFilterAgentId] = useState<string>("");
  const [seenIds] = useState(() => new Set<string>());
  const hasLoadedHistory = useRef(false);

  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) return agents;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const agentIds = useMemo(() => new Set(filteredAgents.map(a => a.id)), [filteredAgents]);
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    filteredAgents.forEach(a => map.set(a.id, a.name));
    return map;
  }, [filteredAgents]);

  // Fetch historical events
  const fetchHistory = useCallback(async () => {
    const projectParam = currentProjectId ? `&project_id=${encodeURIComponent(currentProjectId)}` : "";
    try {
      const res = await authFetch(`/api/telemetry/events?limit=200${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        setHistoricalEvents(data.events || []);
      }
    } catch {}
  }, [authFetch, currentProjectId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory, statusChangeCounter]);

  // Mark historical events as seen so they don't animate
  useEffect(() => {
    if (historicalEvents.length > 0 && !hasLoadedHistory.current) {
      for (const evt of historicalEvents) {
        seenIds.add(evt.id);
      }
      // Also mark any realtime events already present at mount
      for (const evt of realtimeEvents) {
        seenIds.add(evt.id);
      }
      hasLoadedHistory.current = true;
    }
  }, [historicalEvents, realtimeEvents, seenIds]);

  // Merge realtime + historical, filter, sort
  const timeline = useMemo(() => {
    const seen = new Set<string>();
    const merged: TelemetryEvent[] = [];

    const shouldShow = (evt: TelemetryEvent) => {
      if (!VISIBLE_TYPES.has(evt.type) || !agentIds.has(evt.agent_id) || evt.data?.parent_id) return false;
      // MCP tool: only show completed calls (with duration), skip the start event
      if (evt.type === "mcp_tool_execution" && !evt.duration_ms) return false;
      return true;
    };

    for (const evt of realtimeEvents) {
      if (!seen.has(evt.id) && shouldShow(evt)) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }
    for (const evt of historicalEvents) {
      if (!seen.has(evt.id) && shouldShow(evt)) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }

    let filtered = merged;
    if (filterAgentId) {
      filtered = filtered.filter(e => e.agent_id === filterAgentId);
    }

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered.slice(0, 200);
  }, [realtimeEvents, historicalEvents, agentIds, filterAgentId]);

  // Group by date for section headers
  const groupedTimeline = useMemo(() => {
    const groups: { label: string; events: TelemetryEvent[] }[] = [];
    let currentLabel = "";
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    for (const evt of timeline) {
      const dateStr = new Date(evt.timestamp).toDateString();
      const label = dateStr === today ? "Today" : dateStr === yesterday ? "Yesterday" : dateStr;
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, events: [] });
      }
      groups[groups.length - 1].events.push(evt);
    }
    return groups;
  }, [timeline]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">Loading...</div>;
  }

  const runningCount = filteredAgents.filter(a => a.status === "running").length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Activity</h1>
            <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
              {runningCount} of {filteredAgents.length} agents running
            </p>
          </div>
          <div className="w-48">
            <Select
              value={filterAgentId}
              onChange={setFilterAgentId}
              placeholder="All agents"
              options={[
                { value: "", label: "All agents" },
                ...filteredAgents.map(a => ({ value: a.id, label: a.name })),
              ]}
            />
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {timeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[var(--color-text-faint)]">
            <p className="text-lg mb-2">No activity yet</p>
            <p className="text-sm">Agent activity will appear here in real-time.</p>
          </div>
        ) : (
          <div className="max-w-2xl">
            {groupedTimeline.map(group => (
              <div key={group.label}>
                {/* Date header */}
                <div className="sticky top-0 z-10 bg-[var(--color-bg)] backdrop-blur-sm py-2 mb-1">
                  <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    {group.label}
                  </span>
                </div>

                {/* Events */}
                <div className="relative ml-3 border-l border-[var(--color-border)]">
                  {group.events.map(evt => {
                    const isNew = !seenIds.has(evt.id);
                    if (isNew) seenIds.add(evt.id); // mark seen after first render
                    const agentName = agentNameMap.get(evt.agent_id) || evt.agent_id.slice(0, 8);
                    const dotColor = evt.level === "error"
                      ? "bg-red-400"
                      : CATEGORY_COLORS[evt.category] || "bg-[var(--color-text-faint)]";

                    return (
                      <div
                        key={evt.id}
                        className={`relative pl-6 pr-3 py-2.5 hover:bg-[var(--color-surface-hover)] transition-colors ${
                          isNew ? "animate-slideIn" : ""
                        }`}
                      >
                        {/* Timeline dot */}
                        <span className={`absolute left-[-4.5px] top-[14px] w-[9px] h-[9px] rounded-full ${dotColor} ring-2 ring-[#0a0a0a]`} />

                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm ${evt.level === "error" ? "text-red-400" : ""}`}>
                              {describeEvent(evt, agentName)}
                            </p>
                            <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-faint)] mt-0.5">
                              <span className="text-[var(--color-text-secondary)] font-medium">{agentName}</span>
                              <span className="text-[var(--color-border-light)]">&middot;</span>
                              <span className="text-[var(--color-text-faint)]">{evt.category}</span>
                              {evt.duration_ms != null && evt.duration_ms > 0 && (
                                <>
                                  <span className="text-[var(--color-border-light)]">&middot;</span>
                                  <span>{evt.duration_ms < 1000 ? `${evt.duration_ms}ms` : `${(evt.duration_ms / 1000).toFixed(1)}s`}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <span className="text-[11px] text-[var(--color-text-faint)] shrink-0 pt-0.5">
                            {timeAgo(evt.timestamp)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
