import React, { useState, useEffect } from "react";
import { TasksIcon } from "../common/Icons";
import type { Task } from "../../types";

interface TasksPageProps {
  onSelectAgent?: (agentId: string) => void;
}

export function TasksPage({ onSelectAgent }: TasksPageProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    fetchTasks();
    // Refresh every 10 seconds
    const interval = setInterval(fetchTasks, 10000);
    return () => clearInterval(interval);
  }, [filter]);

  const fetchTasks = async () => {
    try {
      const res = await fetch(`/api/tasks?status=${filter}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (e) {
      console.error("Failed to fetch tasks:", e);
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400",
    running: "bg-blue-500/20 text-blue-400",
    completed: "bg-green-500/20 text-green-400",
    failed: "bg-red-500/20 text-red-400",
    cancelled: "bg-gray-500/20 text-gray-400",
  };

  const filterOptions = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "running", label: "Running" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
  ];

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Tasks</h1>
            <p className="text-[#666]">
              View tasks from all running agents
            </p>
          </div>
          <div className="flex gap-2">
            {filterOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-3 py-1.5 rounded text-sm transition ${
                  filter === opt.value
                    ? "bg-[#f97316] text-black"
                    : "bg-[#1a1a1a] hover:bg-[#222]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-[#666]">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12">
            <TasksIcon className="w-12 h-12 mx-auto mb-4 text-[#333]" />
            <p className="text-[#666]">No tasks found</p>
            <p className="text-sm text-[#444] mt-1">
              Tasks will appear here when agents create them
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map(task => (
              <div
                key={`${task.agentId}-${task.id}`}
                className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 hover:border-[#333] transition"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <h3 className="font-medium">{task.title}</h3>
                    <p className="text-sm text-[#666]">
                      {task.agentName}
                      {task.execute_at && (
                        <span className="ml-2">
                          · Scheduled: {new Date(task.execute_at).toLocaleString()}
                        </span>
                      )}
                    </p>
                  </div>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${statusColors[task.status] || statusColors.pending}`}>
                    {task.status}
                  </span>
                </div>

                {task.description && (
                  <p className="text-sm text-[#888] mb-2 line-clamp-2">
                    {task.description}
                  </p>
                )}

                <div className="flex items-center gap-4 text-xs text-[#555]">
                  <span>Type: {task.type}</span>
                  <span>Priority: {task.priority}</span>
                  {task.recurrence && <span>Recurrence: {task.recurrence}</span>}
                  <span>Created: {new Date(task.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
