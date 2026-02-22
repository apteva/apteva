import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAgentActivity, useAuth, useProjects, useTelemetryContext } from "../../context";
import { useTelemetry } from "../../context/TelemetryContext";
import type { TelemetryEvent } from "../../context";
import type { Agent, Provider, Route, DashboardStats, Task } from "../../types";
import { CloseIcon } from "../common/Icons";

interface DashboardProps {
  agents: Agent[];
  loading: boolean;
  runningCount: number;
  configuredProviders: Provider[];
  onNavigate: (route: Route) => void;
  onSelectAgent: (agent: Agent) => void;
}

export function Dashboard({
  agents,
  loading,
  runningCount,
  configuredProviders,
  onNavigate,
  onSelectAgent,
}: DashboardProps) {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const { events: realtimeEvents, statusChangeCounter } = useTelemetryContext();
  const { events: taskTelemetryEvents } = useTelemetry({ category: "TASK" });
  const lastProcessedTaskEventRef = useRef<string | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const [historicalActivities, setHistoricalActivities] = useState<TelemetryEvent[]>([]);
  const [quickMessageAgent, setQuickMessageAgent] = useState<Agent | null>(null);

  // Filter agents by current project
  const filteredAgents = useMemo(() => {
    if (!currentProjectId) return agents; // "All Projects"
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const filteredRunningCount = useMemo(() => {
    return filteredAgents.filter(a => a.status === "running").length;
  }, [filteredAgents]);

  // Get agent IDs for filtering tasks
  const projectAgentIds = useMemo(() => {
    return new Set(filteredAgents.map(a => a.id));
  }, [filteredAgents]);

  const fetchDashboardData = useCallback(async () => {
    try {
      const projectParam = currentProjectId ? `project_id=${encodeURIComponent(currentProjectId)}` : "";
      const [dashRes, tasksRes, activityRes] = await Promise.all([
        authFetch(`/api/dashboard${projectParam ? `?${projectParam}` : ""}`),
        authFetch(`/api/tasks?status=all${projectParam ? `&${projectParam}` : ""}`),
        authFetch(`/api/telemetry/events?type=thread_activity&limit=20${projectParam ? `&${projectParam}` : ""}`),
      ]);

      if (dashRes.ok) {
        const data = await dashRes.json();
        setStats(data);
      }

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setRecentTasks(data.tasks || []);
      }

      if (activityRes.ok) {
        const data = await activityRes.json();
        setHistoricalActivities(data.events || []);
      }
    } catch (e) {
      console.error("Failed to fetch dashboard data:", e);
    }
  }, [authFetch, currentProjectId]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData, statusChangeCounter]);

  // Real-time task updates from telemetry
  useEffect(() => {
    if (!taskTelemetryEvents.length) return;
    const latestEvent = taskTelemetryEvents[0];
    if (!latestEvent || latestEvent.id === lastProcessedTaskEventRef.current) return;
    if (latestEvent.type === "task_created" || latestEvent.type === "task_updated" || latestEvent.type === "task_deleted") {
      lastProcessedTaskEventRef.current = latestEvent.id;
      fetchDashboardData();
    }
  }, [taskTelemetryEvents, fetchDashboardData]);

  // Filter tasks by project agents and sort by next execution (soonest first)
  const filteredTasks = useMemo(() => {
    let list = currentProjectId
      ? recentTasks.filter(t => projectAgentIds.has(t.agentId))
      : recentTasks;
    return sortTasksByNextExecution(list);
  }, [recentTasks, currentProjectId, projectAgentIds]);

  // Calculate task stats from filtered tasks
  const taskStats = useMemo(() => {
    if (!currentProjectId) {
      return stats?.tasks || { total: 0, pending: 0, running: 0, completed: 0 };
    }
    // When filtering by project, calculate from filtered tasks
    const total = filteredTasks.length;
    const pending = filteredTasks.filter(t => t.status === "pending").length;
    const running = filteredTasks.filter(t => t.status === "running").length;
    const completed = filteredTasks.filter(t => t.status === "completed").length;
    return { total, pending, running, completed };
  }, [stats, currentProjectId, filteredTasks]);

  // Merge real-time + historical thread_activity events, deduplicate
  const activities = useMemo(() => {
    const realtimeActivities = realtimeEvents.filter(e => e.type === "thread_activity" && !e.data?.parent_id);
    const seen = new Set(realtimeActivities.map(e => e.id));
    const merged = [...realtimeActivities];
    for (const evt of historicalActivities) {
      if (!seen.has(evt.id) && !evt.data?.parent_id) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }
    // Filter by project
    let filtered = merged;
    if (currentProjectId) {
      filtered = merged.filter(e => projectAgentIds.has(e.agent_id));
    }
    // Sort newest first
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered.slice(0, 12);
  }, [realtimeEvents, historicalActivities, currentProjectId, projectAgentIds]);

  // Build agent name lookup
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      map.set(a.id, a.name);
    }
    return map;
  }, [agents]);

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Agents" value={filteredAgents.length} subValue={`${filteredRunningCount} running`} />
        <StatCard label="Tasks" value={taskStats.total} subValue={`${taskStats.pending} pending`} />
        <StatCard label="Completed" value={taskStats.completed} color="text-green-400" />
        <StatCard label="Providers" value={configuredProviders.length} color="text-[#f97316]" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents List */}
        <DashboardCard
          title="Agents"
          actionLabel="View All"
          onAction={() => onNavigate("agents")}
        >
          {loading ? (
            <div className="p-4 text-center text-[#666]">Loading...</div>
          ) : filteredAgents.length === 0 ? (
            <div className="p-4 text-center text-[#666]">No agents yet</div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {filteredAgents.slice(0, 5).map((agent) => (
                <AgentListItem
                  key={agent.id}
                  agent={agent}
                  onSelect={() => onSelectAgent(agent)}
                  onMessage={agent.status === "running" ? () => setQuickMessageAgent(agent) : undefined}
                  showProject={!currentProjectId}
                />
              ))}
            </div>
          )}
        </DashboardCard>

        {/* Activity Feed */}
        <DashboardCard
          title="Activity"
          actionLabel="Telemetry"
          onAction={() => onNavigate("telemetry")}
        >
          {activities.length === 0 ? (
            <div className="p-4 text-center text-[#666]">
              <p>No activity yet</p>
              <p className="text-sm text-[#444] mt-1">Agent activity will appear here in real-time</p>
            </div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {activities.map((evt) => (
                <ActivityItem
                  key={evt.id}
                  activity={(evt.data?.activity as string) || "Working..."}
                  agentName={agentNameMap.get(evt.agent_id) || evt.agent_id}
                  timestamp={evt.timestamp}
                />
              ))}
            </div>
          )}
        </DashboardCard>

        {/* Tasks */}
        <DashboardCard
          title="Tasks"
          actionLabel="View All"
          onAction={() => onNavigate("tasks")}
        >
          {filteredTasks.length === 0 ? (
            <div className="p-4 text-center text-[#666]">
              <p>No tasks yet</p>
              <p className="text-sm text-[#444] mt-1">Tasks will appear when agents create them</p>
            </div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {filteredTasks.slice(0, 5).map((task) => (
                <div
                  key={`${task.agentId}-${task.id}`}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{task.title}</p>
                    <p className="text-sm text-[#666]">
                      {task.agentName}
                      {task.recurrence && (
                        <span className="ml-1 text-[#555]">· {formatCronShort(task.recurrence)}</span>
                      )}
                      {task.next_run && (
                        <span className="ml-1 text-[#f97316]">· {formatRelativeShort(task.next_run)}</span>
                      )}
                      {!task.next_run && task.execute_at && (
                        <span className="ml-1 text-[#f97316]">· {formatRelativeShort(task.execute_at)}</span>
                      )}
                    </p>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </div>
              ))}
            </div>
          )}
        </DashboardCard>
      </div>

      {/* Quick Message Modal */}
      {quickMessageAgent && (
        <QuickMessageModal
          agent={quickMessageAgent}
          onClose={() => setQuickMessageAgent(null)}
        />
      )}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  subValue?: string;
  color?: string;
}

function StatCard({ label, value, subValue, color }: StatCardProps) {
  return (
    <div className="bg-[#111] rounded p-4 border border-[#1a1a1a]">
      <p className="text-sm text-[#666] mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color || ''}`}>{value}</p>
      {subValue && <p className="text-xs text-[#555] mt-1">{subValue}</p>}
    </div>
  );
}

interface DashboardCardProps {
  title: string;
  actionLabel: string;
  onAction: () => void;
  children: React.ReactNode;
}

function DashboardCard({ title, actionLabel, onAction, children }: DashboardCardProps) {
  return (
    <div className="bg-[#111] rounded border border-[#1a1a1a] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <button
          onClick={onAction}
          className="text-sm text-[#3b82f6] hover:text-[#60a5fa]"
        >
          {actionLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

function AgentListItem({ agent, onSelect, onMessage, showProject }: { agent: Agent; onSelect: () => void; onMessage?: () => void; showProject?: boolean }) {
  const { isActive, label } = useAgentActivity(agent.id);
  const { projects } = useProjects();
  const project = agent.projectId ? projects.find(p => p.id === agent.projectId) : null;

  return (
    <div
      onClick={onSelect}
      className="px-4 py-3 hover:bg-[#1a1a1a] cursor-pointer flex items-center justify-between group"
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            agent.status === "running"
              ? isActive
                ? "bg-green-400 animate-pulse"
                : "bg-[#3b82f6]"
              : "bg-[#444]"
          }`}
        />
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{agent.name}</p>
          <div className="flex items-center gap-2 text-sm text-[#666]">
            {isActive && label ? (
              <span className="text-green-400 truncate">{label}</span>
            ) : (
              <span>{agent.provider} · {agent.status === "running" ? "idle" : "stopped"}</span>
            )}
            {showProject && project && (
              <>
                <span className="text-[#444]">·</span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                  {project.name}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {onMessage && (
        <button
          onClick={(e) => { e.stopPropagation(); onMessage(); }}
          className="opacity-0 group-hover:opacity-100 transition px-2 py-1 text-xs text-[#f97316] hover:bg-[#f97316]/10 rounded"
          title="Send message"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
      )}
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

function ActivityItem({ activity, agentName, timestamp }: { activity: string; agentName: string; timestamp: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-sm truncate">{activity}</p>
      <div className="flex items-center gap-2 text-xs text-[#555] mt-1">
        <span className="text-[#666]">{agentName}</span>
        <span className="text-[#444]">&middot;</span>
        <span>{timeAgo(timestamp)}</span>
      </div>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: Task["status"] }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400",
    running: "bg-blue-500/20 text-blue-400",
    completed: "bg-green-500/20 text-green-400",
    failed: "bg-red-500/20 text-red-400",
    cancelled: "bg-gray-500/20 text-gray-400",
  };

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || colors.pending}`}>
      {status}
    </span>
  );
}

// --- Quick Message Modal ---

function QuickMessageModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { authFetch } = useAuth();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      const res = await authFetch(`/api/agents/${agent.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), agent_id: agent.id }),
      });
      if (res.ok) {
        setSent(true);
        setTimeout(onClose, 1200);
      }
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#111] border border-[#222] rounded-xl shadow-2xl w-full max-w-md mx-4 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-full bg-green-400 animate-pulse" />
            <h3 className="font-medium">{agent.name}</h3>
          </div>
          <button onClick={onClose} className="text-[#666] hover:text-[#e0e0e0] transition">
            <CloseIcon />
          </button>
        </div>

        {sent ? (
          <div className="py-6 text-center">
            <p className="text-green-400 font-medium">Message sent</p>
            <p className="text-sm text-[#555] mt-1">The agent will process your message</p>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSend()}
              placeholder={`Message ${agent.name}...`}
              disabled={sending}
              className="flex-1 bg-[#0a0a0a] border border-[#222] rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-[#f97316] placeholder-[#444] disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="px-4 py-2.5 bg-[#f97316] text-black rounded-lg text-sm font-medium hover:bg-[#fb923c] transition disabled:opacity-30"
            >
              {sending ? "..." : "Send"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Task sorting helper ---

function statusPriority(task: Task): number {
  if (task.status === "running") return 0;
  if (task.status === "pending") return 1;
  if (task.status === "completed") return 2;
  if (task.status === "failed") return 3;
  return 4; // cancelled etc
}

function sortTasksByNextExecution(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aPri = statusPriority(a);
    const bPri = statusPriority(b);
    if (aPri !== bPri) return aPri - bPri;
    // Within running/pending: soonest next execution first
    if (aPri <= 1) {
      const aTime = a.next_run || a.execute_at || null;
      const bTime = b.next_run || b.execute_at || null;
      const aTs = aTime ? new Date(aTime).getTime() : Infinity;
      const bTs = bTime ? new Date(bTime).getTime() : Infinity;
      return aTs - bTs;
    }
    // Within completed/failed: most recent first
    const aDate = a.completed_at || a.executed_at || a.created_at;
    const bDate = b.completed_at || b.executed_at || b.created_at;
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });
}

// --- Schedule formatting helpers (compact versions for dashboard) ---

const DASH_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
      const days = dayOfWeek.split(",").map(d => DASH_DAY_NAMES[parseInt(d.trim())] || d);
      if (days.length === 1) return `${days[0]} ${timeStr}`;
      return `${days.join(" & ")} ${timeStr}`;
    }
    return cron;
  } catch {
    return cron;
  }
}

function formatRelativeShort(dateStr: string): string {
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
    return isFuture ? `in ${hours}h` : `${hours}h ago`;
  }
  if (isTomorrow) return `Tomorrow ${timeStr}`;
  return `${DASH_DAY_NAMES[date.getDay()]} ${timeStr}`;
}
