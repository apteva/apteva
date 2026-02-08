import React, { useState, useEffect, useCallback, useRef } from "react";
import { TasksIcon, CloseIcon } from "../common/Icons";
import { useAuth, useProjects } from "../../context";
import { useTelemetry } from "../../context/TelemetryContext";
import type { Task, TaskTrajectoryStep, ToolUseBlock, ToolResultBlock } from "../../types";

interface TasksPageProps {
  onSelectAgent?: (agentId: string) => void;
}

export function TasksPage({ onSelectAgent }: TasksPageProps) {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const lastProcessedEventRef = useRef<string | null>(null);

  // Subscribe to task telemetry events for real-time updates
  const { events: taskEvents } = useTelemetry({ category: "TASK" });

  const fetchTasks = useCallback(async () => {
    try {
      let url = `/api/tasks?status=${filter}`;
      if (currentProjectId !== null) {
        url += `&project_id=${encodeURIComponent(currentProjectId)}`;
      }
      const res = await authFetch(url);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (e) {
      console.error("Failed to fetch tasks:", e);
    } finally {
      setLoading(false);
    }
  }, [authFetch, filter, currentProjectId]);

  // Initial fetch
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Handle real-time task events from telemetry - use as trigger to refetch
  // since telemetry data is incomplete (missing id, agentId, status, etc.)
  useEffect(() => {
    if (!taskEvents.length) return;

    const latestEvent = taskEvents[0];
    if (!latestEvent || latestEvent.id === lastProcessedEventRef.current) return;

    // Only react to task mutation events
    const eventType = latestEvent.type;
    if (eventType === "task_created" || eventType === "task_updated" || eventType === "task_deleted") {
      lastProcessedEventRef.current = latestEvent.id;
      console.log("[TasksPage] Telemetry event:", eventType);
      // Refetch to get complete task data
      fetchTasks();
    }
  }, [taskEvents, fetchTasks]);

  // Fetch full task details (including trajectory) when selecting a task
  const selectTask = useCallback(async (task: Task) => {
    // Set task immediately for quick feedback
    setSelectedTask(task);
    setLoadingTask(true);

    try {
      const res = await authFetch(`/api/tasks/${task.agentId}/${task.id}`);
      console.log("[TasksPage] Fetch task response status:", res.status);
      if (res.ok) {
        const data = await res.json();
        console.log("[TasksPage] Task data:", data);
        console.log("[TasksPage] Has trajectory:", !!data.task?.trajectory, "Length:", data.task?.trajectory?.length);
        if (data.task) {
          // Merge with agentId/agentName since API might not include them
          setSelectedTask({ ...data.task, agentId: task.agentId, agentName: task.agentName });
        }
      } else {
        console.error("[TasksPage] Failed to fetch task:", res.status, await res.text());
      }
    } catch (e) {
      console.error("Failed to fetch task details:", e);
    } finally {
      setLoadingTask(false);
    }
  }, [authFetch]);

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
    <div className="flex-1 flex overflow-hidden">
      {/* Task List */}
      <div className={`flex-1 p-4 md:p-6 overflow-auto ${selectedTask ? 'hidden md:block md:w-1/2 lg:w-2/3' : ''}`}>
        <div className="max-w-4xl">
          <div className="mb-6">
            <div className="mb-4">
              <h1 className="text-xl md:text-2xl font-semibold mb-1">Tasks</h1>
              <p className="text-sm text-[#666]">
                View tasks from all running agents
              </p>
            </div>
            <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
              {filterOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={`px-3 py-1.5 rounded text-sm transition whitespace-nowrap ${
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
                  onClick={() => selectTask(task)}
                  className={`bg-[#111] border rounded-lg p-4 cursor-pointer transition ${
                    selectedTask?.id === task.id && selectedTask?.agentId === task.agentId
                      ? "border-[#f97316]"
                      : "border-[#1a1a1a] hover:border-[#333]"
                  }`}
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

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#555]">
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

      {/* Task Detail Panel */}
      {selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          statusColors={statusColors}
          onClose={() => setSelectedTask(null)}
          onSelectAgent={onSelectAgent}
          loading={loadingTask}
        />
      )}
    </div>
  );
}

interface TaskDetailPanelProps {
  task: Task;
  statusColors: Record<string, string>;
  onClose: () => void;
  onSelectAgent?: (agentId: string) => void;
  loading?: boolean;
}

function TaskDetailPanel({ task, statusColors, onClose, onSelectAgent, loading }: TaskDetailPanelProps) {
  return (
    <div className="w-full md:w-1/2 lg:w-1/3 border-l border-[#1a1a1a] bg-[#0a0a0a] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#1a1a1a]">
        <h2 className="font-medium truncate pr-2">Task Details</h2>
        <button onClick={onClose} className="text-[#666] hover:text-[#e0e0e0] transition">
          <CloseIcon />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Title & Status */}
        <div>
          <div className="flex items-start justify-between gap-2 mb-2">
            <h3 className="text-lg font-medium">{task.title}</h3>
            <span className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${statusColors[task.status]}`}>
              {task.status}
            </span>
          </div>
          <button
            onClick={() => onSelectAgent?.(task.agentId)}
            className="text-sm text-[#f97316] hover:underline"
          >
            {task.agentName}
          </button>
        </div>

        {/* Description */}
        {task.description && (
          <div>
            <h4 className="text-xs text-[#666] uppercase tracking-wider mb-1">Description</h4>
            <p className="text-sm text-[#888] whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-[#666]">Type</span>
            <p className="capitalize">{task.type}</p>
          </div>
          <div>
            <span className="text-[#666]">Priority</span>
            <p>{task.priority}</p>
          </div>
          <div>
            <span className="text-[#666]">Source</span>
            <p className="capitalize">{task.source}</p>
          </div>
          {task.recurrence && (
            <div>
              <span className="text-[#666]">Recurrence</span>
              <p>{task.recurrence}</p>
            </div>
          )}
        </div>

        {/* Timestamps */}
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[#666]">Created</span>
            <span>{new Date(task.created_at).toLocaleString()}</span>
          </div>
          {task.execute_at && (
            <div className="flex justify-between">
              <span className="text-[#666]">Scheduled</span>
              <span>{new Date(task.execute_at).toLocaleString()}</span>
            </div>
          )}
          {task.executed_at && (
            <div className="flex justify-between">
              <span className="text-[#666]">Started</span>
              <span>{new Date(task.executed_at).toLocaleString()}</span>
            </div>
          )}
          {task.completed_at && (
            <div className="flex justify-between">
              <span className="text-[#666]">Completed</span>
              <span>{new Date(task.completed_at).toLocaleString()}</span>
            </div>
          )}
          {task.next_run && (
            <div className="flex justify-between">
              <span className="text-[#666]">Next Run</span>
              <span>{new Date(task.next_run).toLocaleString()}</span>
            </div>
          )}
        </div>

        {/* Error */}
        {task.status === "failed" && task.error && (
          <div className="min-w-0">
            <h4 className="text-xs text-red-400 uppercase tracking-wider mb-1">Error</h4>
            <div className="bg-red-500/10 border border-red-500/20 rounded p-3 overflow-x-auto">
              <pre className="text-sm text-red-400 whitespace-pre-wrap break-words">{task.error}</pre>
            </div>
          </div>
        )}

        {/* Result */}
        {task.status === "completed" && task.result && (
          <div className="min-w-0">
            <h4 className="text-xs text-green-400 uppercase tracking-wider mb-1">Result</h4>
            <div className="bg-green-500/10 border border-green-500/20 rounded p-3 overflow-x-auto">
              <pre className="text-sm text-green-400 whitespace-pre-wrap break-words">
                {typeof task.result === "string" ? task.result : JSON.stringify(task.result, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* Trajectory */}
        {loading && !task.trajectory && (
          <div>
            <h4 className="text-xs text-[#666] uppercase tracking-wider mb-2">Trajectory</h4>
            <div className="text-sm text-[#555]">Loading trajectory...</div>
          </div>
        )}
        {task.trajectory && task.trajectory.length > 0 && (
          <div>
            <h4 className="text-xs text-[#666] uppercase tracking-wider mb-2">
              Trajectory ({task.trajectory.length} steps)
            </h4>
            <TrajectoryView trajectory={task.trajectory} />
          </div>
        )}
      </div>
    </div>
  );
}

function TrajectoryView({ trajectory }: { trajectory: TaskTrajectoryStep[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleStep = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const roleStyles = {
    user: { bg: "bg-blue-500/10", text: "text-blue-400", icon: "👤", label: "User" },
    assistant: { bg: "bg-purple-500/10", text: "text-purple-400", icon: "🤖", label: "Assistant" },
  };

  // Render content which can be string or array of blocks
  const renderContent = (step: TaskTrajectoryStep) => {
    const content = step.content;

    // String content (text message)
    if (typeof content === "string") {
      const isLong = content.length > 200;
      const isExpanded = expanded.has(step.id);

      return (
        <div>
          <p className={`text-sm text-[#ccc] whitespace-pre-wrap break-words ${!isExpanded && isLong ? 'line-clamp-4' : ''}`}>
            {content}
          </p>
          {isLong && (
            <button
              onClick={() => toggleStep(step.id)}
              className="text-xs text-[#666] hover:text-[#888] mt-1"
            >
              {isExpanded ? "Show less" : "Show more..."}
            </button>
          )}
        </div>
      );
    }

    // Array content (tool_use or tool_result blocks)
    return (
      <div className="space-y-2">
        {content.map((block, idx) => {
          if (block.type === "tool_use") {
            const inputStr = JSON.stringify(block.input, null, 2);
            const isLong = inputStr.length > 150;
            const blockId = `${step.id}-${idx}`;
            const isExpanded = expanded.has(blockId);

            return (
              <div key={idx} className="bg-orange-500/10 border border-orange-500/20 rounded p-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-orange-400">🔧</span>
                  <span className="text-xs font-medium text-orange-400">Tool Call</span>
                  <span className="text-xs text-[#888]">{block.name}</span>
                </div>
                <pre className={`text-xs text-[#888] overflow-x-auto ${!isExpanded && isLong ? 'line-clamp-3' : ''}`}>
                  {inputStr}
                </pre>
                {isLong && (
                  <button
                    onClick={() => toggleStep(blockId)}
                    className="text-xs text-[#666] hover:text-[#888] mt-1"
                  >
                    {isExpanded ? "Show less" : "Show more..."}
                  </button>
                )}
              </div>
            );
          }

          if (block.type === "tool_result") {
            const isError = block.is_error;
            const blockId = `${step.id}-${idx}`;
            const isExpanded = expanded.has(blockId);
            const isLong = block.content.length > 150;

            return (
              <div
                key={idx}
                className={`${isError ? 'bg-red-500/10 border-red-500/20' : 'bg-teal-500/10 border-teal-500/20'} border rounded p-2`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span>{isError ? "❌" : "📋"}</span>
                  <span className={`text-xs font-medium ${isError ? 'text-red-400' : 'text-teal-400'}`}>
                    Tool Result
                  </span>
                </div>
                <pre className={`text-xs text-[#888] overflow-x-auto whitespace-pre-wrap break-words ${!isExpanded && isLong ? 'line-clamp-3' : ''}`}>
                  {block.content}
                </pre>
                {isLong && (
                  <button
                    onClick={() => toggleStep(blockId)}
                    className="text-xs text-[#666] hover:text-[#888] mt-1"
                  >
                    {isExpanded ? "Show less" : "Show more..."}
                  </button>
                )}
              </div>
            );
          }

          return null;
        })}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {trajectory.map((step) => {
        const style = roleStyles[step.role] || roleStyles.assistant;

        return (
          <div
            key={step.id}
            className={`${style.bg} border border-[#1a1a1a] rounded overflow-hidden p-3`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span>{style.icon}</span>
              <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              {step.model && (
                <span className="text-xs text-[#555]">· {step.model}</span>
              )}
              <span className="text-xs text-[#555]">
                · {new Date(step.created_at).toLocaleTimeString()}
              </span>
            </div>
            {renderContent(step)}
          </div>
        );
      })}
    </div>
  );
}
