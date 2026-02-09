import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useAgentActivity, useAuth, useProjects, useTelemetryContext } from "../../context";
import type { TelemetryEvent } from "../../context";
import type { Agent, Provider, Route, DashboardStats, Task } from "../../types";

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
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const [historicalActivities, setHistoricalActivities] = useState<TelemetryEvent[]>([]);

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
      const [dashRes, tasksRes, activityRes] = await Promise.all([
        authFetch("/api/dashboard"),
        authFetch("/api/tasks?status=all"),
        authFetch("/api/telemetry/events?type=thread_activity&limit=20"),
      ]);

      if (dashRes.ok) {
        const data = await dashRes.json();
        setStats(data);
      }

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setRecentTasks((data.tasks || []).slice(0, 5));
      }

      if (activityRes.ok) {
        const data = await activityRes.json();
        setHistoricalActivities(data.events || []);
      }
    } catch (e) {
      console.error("Failed to fetch dashboard data:", e);
    }
  }, [authFetch]);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData, statusChangeCounter]);

  // Filter tasks by project agents
  const filteredTasks = useMemo(() => {
    if (!currentProjectId) return recentTasks;
    return recentTasks.filter(t => projectAgentIds.has(t.agentId));
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
    const realtimeActivities = realtimeEvents.filter(e => e.type === "thread_activity");
    const seen = new Set(realtimeActivities.map(e => e.id));
    const merged = [...realtimeActivities];
    for (const evt of historicalActivities) {
      if (!seen.has(evt.id)) {
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
    return filtered.slice(0, 8);
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
                <AgentListItem key={agent.id} agent={agent} onSelect={() => onSelectAgent(agent)} showProject={!currentProjectId} />
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

        {/* Recent Tasks */}
        <DashboardCard
          title="Recent Tasks"
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
              {filteredTasks.map((task) => (
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

function AgentListItem({ agent, onSelect, showProject }: { agent: Agent; onSelect: () => void; showProject?: boolean }) {
  const { isActive } = useAgentActivity(agent.id);
  const { projects } = useProjects();
  const project = agent.projectId ? projects.find(p => p.id === agent.projectId) : null;

  return (
    <div
      onClick={onSelect}
      className="px-4 py-3 hover:bg-[#1a1a1a] cursor-pointer flex items-center justify-between"
    >
      <div className="flex-1 min-w-0">
        <p className="font-medium">{agent.name}</p>
        <div className="flex items-center gap-2 text-sm text-[#666]">
          <span>{agent.provider}</span>
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
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          agent.status === "running"
            ? isActive
              ? "bg-green-400 animate-pulse"
              : "bg-[#3b82f6]"
            : "bg-[#444]"
        }`}
      />
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
