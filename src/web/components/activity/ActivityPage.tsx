import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useAgentActivity, useAuth, useProjects, useTelemetryContext } from "../../context";
import { useTelemetry } from "../../context/TelemetryContext";
import type { TelemetryEvent } from "../../context";
import type { Agent, Task, Route } from "../../types";
import { RecurringIcon, ScheduledIcon, TaskOnceIcon } from "../common/Icons";

interface ActivityPageProps {
  agents: Agent[];
  loading: boolean;
  onNavigate?: (route: Route) => void;
}

export function ActivityPage({ agents, loading, onNavigate }: ActivityPageProps) {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const { events: realtimeEvents, statusChangeCounter } = useTelemetryContext();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [historicalActivities, setHistoricalActivities] = useState<TelemetryEvent[]>([]);
  const lastProcessedTaskEventRef = useRef<string | null>(null);
  const { events: taskTelemetryEvents } = useTelemetry({ category: "TASK" });

  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) return agents;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const sortedAgents = useMemo(() => {
    return [...filteredAgents].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredAgents]);

  const runningCount = useMemo(() => filteredAgents.filter(a => a.status === "running").length, [filteredAgents]);

  const agentIds = useMemo(() => new Set(filteredAgents.map(a => a.id)), [filteredAgents]);
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    filteredAgents.forEach(a => map.set(a.id, a.name));
    return map;
  }, [filteredAgents]);

  // Fetch tasks + historical activity
  const fetchData = useCallback(async () => {
    const projectParam = currentProjectId ? `&project_id=${encodeURIComponent(currentProjectId)}` : "";
    const [tasksRes, activityRes] = await Promise.all([
      authFetch(`/api/tasks?status=all${projectParam}`).catch(() => null),
      authFetch(`/api/telemetry/events?type=thread_activity&limit=50${projectParam}`).catch(() => null),
    ]);
    if (tasksRes?.ok) {
      const data = await tasksRes.json();
      const list: Task[] = data.tasks || [];
      list.sort((a, b) => {
        const aPri = a.status === "running" ? 0 : a.status === "pending" ? 1 : a.status === "completed" ? 2 : 3;
        const bPri = b.status === "running" ? 0 : b.status === "pending" ? 1 : b.status === "completed" ? 2 : 3;
        if (aPri !== bPri) return aPri - bPri;
        if (aPri <= 1) {
          const aTs = (a.next_run || a.execute_at) ? new Date(a.next_run || a.execute_at!).getTime() : Infinity;
          const bTs = (b.next_run || b.execute_at) ? new Date(b.next_run || b.execute_at!).getTime() : Infinity;
          return aTs - bTs;
        }
        const aDate = a.completed_at || a.executed_at || a.created_at;
        const bDate = b.completed_at || b.executed_at || b.created_at;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });
      setTasks(list);
    }
    if (activityRes?.ok) {
      const data = await activityRes.json();
      setHistoricalActivities(data.events || []);
    }
  }, [authFetch, currentProjectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData, statusChangeCounter]);

  // Real-time task updates from telemetry (same pattern as TasksPage)
  useEffect(() => {
    if (!taskTelemetryEvents.length) return;
    const latestEvent = taskTelemetryEvents[0];
    if (!latestEvent || latestEvent.id === lastProcessedTaskEventRef.current) return;
    const eventType = latestEvent.type;
    if (eventType === "task_created" || eventType === "task_updated" || eventType === "task_deleted") {
      lastProcessedTaskEventRef.current = latestEvent.id;
      fetchData();
    }
  }, [taskTelemetryEvents, fetchData]);

  // Merge realtime + historical thread_activity
  const activities = useMemo(() => {
    const realtimeThreadEvents = realtimeEvents.filter(e => e.type === "thread_activity");
    const seen = new Set(realtimeThreadEvents.map(e => e.id));
    const merged = [...realtimeThreadEvents];
    for (const evt of historicalActivities) {
      if (!seen.has(evt.id)) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }
    let filtered = merged.filter(e => agentIds.has(e.agent_id));
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered.slice(0, 50);
  }, [realtimeEvents, historicalActivities, agentIds]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-[#666]">Loading...</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Activity</h1>
          <span className="text-sm text-[#666]">
            {runningCount} of {filteredAgents.length} agents running
          </span>
        </div>
      </div>

      {/* Three-column layout: 1/4 | 3/8 | 3/8 */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: Agents (1/4) */}
        <div className="flex-[2] flex flex-col overflow-hidden border-r border-[#1a1a1a]">
          <div className="px-4 py-2.5 border-b border-[#1a1a1a] shrink-0">
            <h3 className="text-xs font-semibold text-[#666] uppercase tracking-wider">Agents</h3>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2">
            {sortedAgents.length === 0 ? (
              <p className="text-sm text-[#555] px-2 py-4 text-center">No agents found</p>
            ) : (
              <div className="space-y-1">
                {sortedAgents.map(agent => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    selected={selectedAgentId === agent.id}
                    onSelect={() => setSelectedAgentId(selectedAgentId === agent.id ? null : agent.id)}
                  />
                ))}
              </div>
            )}

            {selectedAgentId && (
              <InlineCommand
                agent={filteredAgents.find(a => a.id === selectedAgentId) || null}
              />
            )}
          </div>
        </div>

        {/* Center: Activity Feed (3/8) */}
        <div className="flex-[3] flex flex-col min-h-0 overflow-hidden border-r border-[#1a1a1a]">
          <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between shrink-0">
            <h3 className="text-xs font-semibold text-[#666] uppercase tracking-wider">Activity Feed</h3>
            <span className="text-xs text-[#555]">{activities.length}</span>
          </div>
          <div className="flex-1 overflow-auto">
            {activities.length === 0 ? (
              <div className="p-6 text-center text-[#555] text-sm">
                No activity yet. Agent activity will appear here in real-time.
              </div>
            ) : (
              <div className="divide-y divide-[#1a1a1a]">
                {activities.map(evt => (
                  <div key={evt.id} className="px-4 py-2.5 hover:bg-[#111]/50 transition">
                    <p className="text-sm truncate">{(evt.data?.activity as string) || "Working..."}</p>
                    <div className="flex items-center gap-2 text-[10px] text-[#555] mt-0.5">
                      <span className="text-[#666]">{agentNameMap.get(evt.agent_id) || evt.agent_id}</span>
                      <span className="text-[#444]">&middot;</span>
                      <span>{timeAgo(evt.timestamp)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Tasks (3/8) */}
        <div className="flex-[3] flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 border-b border-[#1a1a1a] flex items-center justify-between shrink-0">
            <h3 className="text-xs font-semibold text-[#666] uppercase tracking-wider">Tasks</h3>
            {onNavigate && (
              <button onClick={() => onNavigate("tasks")} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">
                View All
              </button>
            )}
          </div>
          <div className="flex-1 overflow-auto px-3 py-3">
            {tasks.length === 0 ? (
              <p className="text-sm text-[#555] px-2 py-4 text-center">No tasks yet</p>
            ) : (
              <div className="space-y-2.5">
                {tasks.map(task => (
                  <TaskCard key={`${task.agentId}-${task.id}`} task={task} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Agent Row ---

function AgentRow({ agent, selected, onSelect }: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}) {
  const { isActive, type } = useAgentActivity(agent.id);
  const isRunning = agent.status === "running";

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition ${
        selected
          ? "bg-[#f97316]/10 border border-[#f97316]/30"
          : "hover:bg-[#1a1a1a] border border-transparent"
      }`}
    >
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          isRunning && isActive
            ? "bg-green-400 animate-pulse"
            : isRunning
              ? "bg-[#3b82f6]"
              : "bg-[#444]"
        }`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium truncate ${isRunning ? "" : "text-[#666]"}`}>
            {agent.name}
          </span>
          <span className="text-[10px] text-[#555] shrink-0">{agent.provider}</span>
        </div>
        {isActive && type ? (
          <p className="text-[11px] text-green-400 truncate">{type}</p>
        ) : (
          <p className={`text-[11px] ${isRunning ? "text-[#555]" : "text-[#444]"}`}>
            {isRunning ? "idle" : "stopped"}
          </p>
        )}
      </div>
    </button>
  );
}

// --- Inline Command ---

function InlineCommand({ agent }: { agent: Agent | null }) {
  const { authFetch } = useAuth();
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setCommand("");
    setToast(null);
  }, [agent?.id]);

  if (!agent) return null;

  const isRunning = agent.status === "running";

  const handleSend = async () => {
    if (!command.trim() || sending) return;
    if (!isRunning) {
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
        setToast("Sent");
        setCommand("");
      } else {
        const data = await res.json().catch(() => ({}));
        setToast(data.error || "Failed");
      }
    } catch {
      setToast("Failed to send");
    } finally {
      setSending(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  return (
    <div className="mt-2 bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-[#666]">
          Send to <span className="text-[#888]">{agent.name}</span>
        </span>
        {toast && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            toast === "Sent" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
          }`}>{toast}</span>
        )}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSend()}
          placeholder={isRunning ? "Command..." : "Not running"}
          disabled={sending || !isRunning}
          autoFocus
          className="flex-1 bg-[#111] border border-[#1a1a1a] rounded px-2 py-1.5 text-xs focus:outline-none focus:border-[#f97316] placeholder-[#444] disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={sending || !command.trim() || !isRunning}
          className="px-2.5 py-1.5 bg-[#f97316]/20 text-[#f97316] rounded text-xs font-medium hover:bg-[#f97316]/30 transition disabled:opacity-30"
        >
          {sending ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}

// --- Task Card (matches TasksPage style) ---

const taskStatusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400",
  running: "bg-blue-500/20 text-blue-400",
  completed: "bg-green-500/20 text-green-400",
  failed: "bg-red-500/20 text-red-400",
  cancelled: "bg-gray-500/20 text-gray-400",
};

const TASK_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function TaskCard({ task }: { task: Task }) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 hover:border-[#333] transition">
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium truncate">{task.title}</h4>
          <p className="text-xs text-[#666]">{task.agentName}</p>
        </div>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ml-2 ${taskStatusColors[task.status] || taskStatusColors.pending}`}>
          {task.status}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#555]">
        <span className="flex items-center gap-1">
          {task.type === "recurring"
            ? <RecurringIcon className="w-3 h-3" />
            : task.execute_at
              ? <ScheduledIcon className="w-3 h-3" />
              : <TaskOnceIcon className="w-3 h-3" />
          }
          {task.type === "recurring" && task.recurrence ? formatCronShort(task.recurrence) : task.type}
        </span>
        {task.next_run && (
          <span className="text-[#f97316]">{formatTaskRelative(task.next_run)}</span>
        )}
        {!task.next_run && task.execute_at && (
          <span className="text-[#f97316]">{formatTaskRelative(task.execute_at)}</span>
        )}
      </div>
    </div>
  );
}

// --- Helpers ---

function formatCronShort(cron: string): string {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      const n = parseInt(minute.slice(2));
      return n === 1 ? "Every min" : `Every ${n}min`;
    }
    if (minute !== "*" && !minute.includes("/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return "Hourly";
    }
    if (hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      const n = parseInt(hour.slice(2));
      return n === 1 ? "Hourly" : `Every ${n}h`;
    }

    const formatTime = (h: string, m: string): string => {
      const hr = parseInt(h);
      const mn = parseInt(m);
      if (isNaN(hr)) return "";
      const ampm = hr >= 12 ? "PM" : "AM";
      const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
      return `${h12}:${mn.toString().padStart(2, "0")} ${ampm}`;
    };

    if (hour !== "*" && !hour.includes("/") && dayOfMonth === "*" && month === "*") {
      const timeStr = formatTime(hour, minute);
      if (dayOfWeek === "*") return `Daily ${timeStr}`;
      const days = dayOfWeek.split(",").map(d => TASK_DAY_NAMES[parseInt(d.trim())] || d);
      if (days.length === 1) return `${days[0]} ${timeStr}`;
      return `${days.join(", ")} ${timeStr}`;
    }
    return cron;
  } catch {
    return cron;
  }
}

function formatTaskRelative(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const isFuture = diffMs > 0;
  const absDiffMs = Math.abs(diffMs);
  const minutes = Math.floor(absDiffMs / 60000);
  const hours = Math.floor(absDiffMs / 3600000);
  const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) {
    if (minutes < 1) return "now";
    if (minutes < 60) return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
    return isFuture ? `in ${hours}h (${timeStr})` : `${hours}h ago`;
  }
  if (isTomorrow) return `Tomorrow ${timeStr}`;
  return `${TASK_DAY_NAMES[date.getDay()]} ${timeStr}`;
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
