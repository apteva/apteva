import React, { useState, useEffect } from "react";
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
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchDashboardData = async () => {
    try {
      const [dashRes, tasksRes] = await Promise.all([
        fetch("/api/dashboard"),
        fetch("/api/tasks?status=all"),
      ]);

      if (dashRes.ok) {
        const data = await dashRes.json();
        setStats(data);
      }

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setRecentTasks((data.tasks || []).slice(0, 5));
      }
    } catch (e) {
      console.error("Failed to fetch dashboard data:", e);
    }
  };

  const taskStats = stats?.tasks || { total: 0, pending: 0, running: 0, completed: 0 };

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard label="Agents" value={agents.length} subValue={`${runningCount} running`} />
        <StatCard label="Tasks" value={taskStats.total} subValue={`${taskStats.pending} pending`} />
        <StatCard label="Completed" value={taskStats.completed} color="text-green-400" />
        <StatCard label="Providers" value={configuredProviders.length} color="text-[#f97316]" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Agents List */}
        <DashboardCard
          title="Agents"
          actionLabel="View All"
          onAction={() => onNavigate("agents")}
        >
          {loading ? (
            <div className="p-4 text-center text-[#666]">Loading...</div>
          ) : agents.length === 0 ? (
            <div className="p-4 text-center text-[#666]">No agents yet</div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {agents.slice(0, 5).map((agent) => (
                <div
                  key={agent.id}
                  onClick={() => onSelectAgent(agent)}
                  className="px-4 py-3 hover:bg-[#1a1a1a] cursor-pointer flex items-center justify-between"
                >
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-sm text-[#666]">{agent.provider}</p>
                  </div>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      agent.status === "running" ? "bg-[#3b82f6]" : "bg-[#444]"
                    }`}
                  />
                </div>
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
          {recentTasks.length === 0 ? (
            <div className="p-4 text-center text-[#666]">
              <p>No tasks yet</p>
              <p className="text-sm text-[#444] mt-1">Tasks will appear when agents create them</p>
            </div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {recentTasks.map((task) => (
                <div
                  key={`${task.agentId}-${task.id}`}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{task.title}</p>
                    <p className="text-sm text-[#666]">{task.agentName}</p>
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
