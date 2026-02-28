import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { TasksIcon, CloseIcon, RecurringIcon, ScheduledIcon, TaskOnceIcon } from "../common/Icons";
import { Select } from "../common/Select";
import { useConfirm } from "../common/Modal";
import { useAuth, useProjects } from "../../context";
import { useTelemetry } from "../../context/TelemetryContext";
import type { Task, TaskTrajectoryStep, ToolUseBlock, ToolResultBlock, Agent } from "../../types";

interface TasksPageProps {
  onSelectAgent?: (agentId: string) => void;
}

export function TasksPage({ onSelectAgent }: TasksPageProps) {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
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

  // Extract unique agents from tasks for the agent filter
  const uniqueAgents = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      const id = t.agentId || (t as any).agent_id;
      const name = t.agentName || (t as any).agent_name;
      if (id && name && !map.has(id)) {
        map.set(id, name);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);

  // Sort tasks: running first, then pending by next execution (soonest first), then completed/failed by date
  const sortedTasks = useMemo(() => {
    const filtered = agentFilter === "all" ? tasks : tasks.filter(t => (t.agentId || (t as any).agent_id) === agentFilter);
    return [...filtered].sort((a, b) => {
      // Running tasks first
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      // Pending tasks next
      const aIsPending = a.status === "pending";
      const bIsPending = b.status === "pending";
      if (aIsPending && !bIsPending) return -1;
      if (bIsPending && !aIsPending) return 1;
      // For running/pending: sort by next execution time (soonest first)
      if (aIsPending && bIsPending || a.status === "running" && b.status === "running") {
        const aTime = a.next_run || a.execute_at || null;
        const bTime = b.next_run || b.execute_at || null;
        const aTs = aTime ? new Date(aTime).getTime() : Infinity;
        const bTs = bTime ? new Date(bTime).getTime() : Infinity;
        return aTs - bTs;
      }
      // For completed/failed: most recent first
      const aDate = a.completed_at || a.executed_at || a.created_at;
      const bDate = b.completed_at || b.executed_at || b.created_at;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  }, [tasks, agentFilter]);

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
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h1 className="text-xl md:text-2xl font-semibold mb-1">Tasks</h1>
                <p className="text-sm text-[var(--color-text-muted)]">
                  View tasks from all running agents
                </p>
              </div>
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition flex items-center gap-1.5 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                Create Task
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap pb-1">
              <div className="flex gap-2 overflow-x-auto scrollbar-hide">
                {filterOptions.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setFilter(opt.value)}
                    className={`px-3 py-1.5 rounded text-sm transition whitespace-nowrap ${
                      filter === opt.value
                        ? "bg-[var(--color-accent)] text-black"
                        : "bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {uniqueAgents.length > 0 && (
                <div className="w-48">
                  <Select
                    value={agentFilter}
                    onChange={setAgentFilter}
                    placeholder="All agents"
                    compact
                    options={[
                      { value: "all", label: "All agents" },
                      ...uniqueAgents.map(([id, name]) => ({ value: id, label: name })),
                    ]}
                  />
                </div>
              )}
            </div>
          </div>

          {loading ? (
            <div className="text-center py-12 text-[var(--color-text-muted)]">Loading tasks...</div>
          ) : sortedTasks.length === 0 ? (
            <div className="text-center py-12">
              <TasksIcon className="w-12 h-12 mx-auto mb-4 text-[var(--color-border-light)]" />
              <p className="text-[var(--color-text-muted)]">No tasks found</p>
              <p className="text-sm text-[var(--color-text-faint)] mt-1">
                Tasks will appear here when agents create them
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {sortedTasks.map(task => (
                <div
                  key={`${task.agentId}-${task.id}`}
                  onClick={() => selectTask(task)}
                  className={`bg-[var(--color-surface)] border rounded-lg p-4 cursor-pointer transition ${
                    selectedTask?.id === task.id && selectedTask?.agentId === task.agentId
                      ? "border-[var(--color-accent)]"
                      : "border-[var(--color-border)] hover:border-[var(--color-border-light)]"
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1">
                      <h3 className="font-medium">{task.title}</h3>
                      <p className="text-sm text-[var(--color-text-muted)]">{task.agentName}</p>
                    </div>
                    <span className={`px-2 py-1 rounded text-xs font-medium ${statusColors[task.status] || statusColors.pending}`}>
                      {task.status}
                    </span>
                  </div>

                  {task.description && (
                    <p className="text-sm text-[var(--color-text-secondary)] mb-2 line-clamp-2">
                      {task.description}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-faint)]">
                    <span className="flex items-center gap-1">
                      {task.type === "recurring"
                        ? <RecurringIcon className="w-3.5 h-3.5" />
                        : task.execute_at
                          ? <ScheduledIcon className="w-3.5 h-3.5" />
                          : <TaskOnceIcon className="w-3.5 h-3.5" />
                      }
                      {task.type === "recurring" && task.recurrence ? formatCron(task.recurrence) : task.type}
                    </span>
                    <span>Priority: {task.priority}</span>
                    {task.next_run && (
                      <span className="text-[var(--color-accent)]">{formatRelativeTime(task.next_run)}</span>
                    )}
                    {!task.next_run && task.execute_at && (
                      <span className="text-[var(--color-accent)]">{formatRelativeTime(task.execute_at)}</span>
                    )}
                    <span>Created: {new Date(task.created_at).toLocaleDateString()}</span>
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
          authFetch={authFetch}
          onRefresh={() => { fetchTasks(); setSelectedTask(null); }}
        />
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          authFetch={authFetch}
          currentProjectId={currentProjectId}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { fetchTasks(); setShowCreateModal(false); }}
        />
      )}
    </div>
  );
}

export interface TaskDetailPanelProps {
  task: Task;
  statusColors: Record<string, string>;
  onClose: () => void;
  onSelectAgent?: (agentId: string) => void;
  loading?: boolean;
  authFetch?: (url: string, options?: RequestInit) => Promise<Response>;
  onRefresh?: () => void;
}

export function TaskDetailPanel({ task, statusColors, onClose, onSelectAgent, loading, authFetch, onRefresh }: TaskDetailPanelProps) {
  const [executing, setExecuting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({
    title: task.title,
    description: task.description || "",
    type: task.type as "once" | "recurring",
    priority: task.priority,
    execute_at: task.execute_at ? new Date(task.execute_at).toISOString().slice(0, 16) : "",
    recurrence: task.recurrence || "",
  });
  const { confirm, ConfirmDialog } = useConfirm();

  // Reset edit form when task changes
  useEffect(() => {
    setEditForm({
      title: task.title,
      description: task.description || "",
      type: task.type as "once" | "recurring",
      priority: task.priority,
      execute_at: task.execute_at ? new Date(task.execute_at).toISOString().slice(0, 16) : "",
      recurrence: task.recurrence || "",
    });
    setEditing(false);
  }, [task.id, task.agentId]);

  const handleSave = async () => {
    if (!authFetch || saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: editForm.title.trim(),
        description: editForm.description.trim() || undefined,
        type: editForm.type,
        priority: editForm.priority,
      };
      if (editForm.type === "once" && editForm.execute_at) {
        body.execute_at = new Date(editForm.execute_at).toISOString();
      }
      if (editForm.type === "recurring" && editForm.recurrence.trim()) {
        body.recurrence = editForm.recurrence.trim();
      }
      const res = await authFetch(`/api/tasks/${task.agentId}/${task.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setEditing(false);
        onRefresh?.();
      }
    } catch (e) {
      console.error("Failed to update task:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleExecute = async () => {
    if (!authFetch || executing) return;
    setExecuting(true);
    try {
      await authFetch(`/api/tasks/${task.agentId}/${task.id}/execute`, { method: "POST" });
      onRefresh?.();
    } catch (e) {
      console.error("Failed to execute task:", e);
    } finally {
      setExecuting(false);
    }
  };

  const handleDelete = async () => {
    if (!authFetch || deleting) return;
    const ok = await confirm(`Are you sure you want to delete "${task.title}"?`, {
      title: "Delete Task",
      confirmText: "Delete",
      confirmVariant: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await authFetch(`/api/tasks/${task.agentId}/${task.id}`, { method: "DELETE" });
      onRefresh?.();
    } catch (e) {
      console.error("Failed to delete task:", e);
    } finally {
      setDeleting(false);
    }
  };

  const inputClass = "w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]";

  return (
    <div className="w-full md:w-1/2 lg:w-1/3 border-l border-[var(--color-border)] bg-[var(--color-bg)] flex flex-col overflow-hidden">
      {ConfirmDialog}
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)]">
        <h2 className="font-medium truncate pr-2">{editing ? "Edit Task" : "Task Details"}</h2>
        <div className="flex items-center gap-2">
          {authFetch && !editing && (task.status === "pending" || task.status === "completed" || task.status === "failed") && (
            <button
              onClick={() => setEditing(true)}
              title="Edit task"
              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
          )}
          {authFetch && !editing && (task.status === "pending" || task.status === "completed") && (
            <button
              onClick={handleExecute}
              disabled={executing}
              title="Execute now"
              className="text-[var(--color-accent)] hover:opacity-80 transition disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>
          )}
          {authFetch && !editing && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="Delete task"
              className="text-red-400 hover:text-red-300 transition disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={() => {
                  setEditing(false);
                  setEditForm({
                    title: task.title,
                    description: task.description || "",
                    type: task.type as "once" | "recurring",
                    priority: task.priority,
                    execute_at: task.execute_at ? new Date(task.execute_at).toISOString().slice(0, 16) : "",
                    recurrence: task.recurrence || "",
                  });
                }}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !editForm.title.trim()}
                className="px-3 py-1 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </>
          )}
          {!editing && (
            <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition">
              <CloseIcon />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Title & Status */}
        <div>
          <div className="flex items-start justify-between gap-2 mb-2">
            {editing ? (
              <input
                type="text"
                value={editForm.title}
                onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                className={`${inputClass} text-lg font-medium`}
                placeholder="Task title"
              />
            ) : (
              <h3 className="text-lg font-medium">{task.title}</h3>
            )}
            {!editing && (
              <span className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${statusColors[task.status]}`}>
                {task.status}
              </span>
            )}
          </div>
          {!editing && (
            <button
              onClick={() => onSelectAgent?.(task.agentId)}
              className="text-sm text-[var(--color-accent)] hover:underline"
            >
              {task.agentName}
            </button>
          )}
        </div>

        {/* Description */}
        {editing ? (
          <div>
            <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Description</h4>
            <textarea
              value={editForm.description}
              onChange={e => setEditForm({ ...editForm, description: e.target.value })}
              className={`${inputClass} resize-none`}
              rows={3}
              placeholder="Task description..."
            />
          </div>
        ) : task.description ? (
          <div>
            <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Description</h4>
            <p className="text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap">{task.description}</p>
          </div>
        ) : null}

        {/* Metadata */}
        {editing ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block">Type</label>
              <select
                value={editForm.type}
                onChange={e => setEditForm({ ...editForm, type: e.target.value as "once" | "recurring" })}
                className={inputClass}
              >
                <option value="once">One-time</option>
                <option value="recurring">Recurring</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block">Priority</label>
              <input
                type="number"
                min={1}
                max={10}
                value={editForm.priority}
                onChange={e => setEditForm({ ...editForm, priority: Number(e.target.value) })}
                className={inputClass}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-[var(--color-text-muted)]">Type</span>
              <p className="capitalize">{task.type}</p>
            </div>
            <div>
              <span className="text-[var(--color-text-muted)]">Priority</span>
              <p>{task.priority}</p>
            </div>
            <div>
              <span className="text-[var(--color-text-muted)]">Source</span>
              <p className="capitalize">{task.source}</p>
            </div>
            {task.recurrence && (
              <div>
                <span className="text-[var(--color-text-muted)]">Recurrence</span>
                <p>{formatCron(task.recurrence)}</p>
                <p className="text-xs text-[var(--color-text-faint)] mt-0.5 font-mono">{task.recurrence}</p>
              </div>
            )}
          </div>
        )}

        {/* Schedule (edit mode) */}
        {editing && editForm.type === "once" && (
          <div>
            <label className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block">Schedule</label>
            <input
              type="datetime-local"
              value={editForm.execute_at}
              onChange={e => setEditForm({ ...editForm, execute_at: e.target.value })}
              className={inputClass}
            />
            <p className="text-xs text-[var(--color-text-faint)] mt-1">Leave empty for manual execution</p>
          </div>
        )}
        {editing && editForm.type === "recurring" && (
          <div>
            <label className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1 block">Cron Schedule</label>
            <input
              type="text"
              value={editForm.recurrence}
              onChange={e => setEditForm({ ...editForm, recurrence: e.target.value })}
              className={`${inputClass} font-mono`}
              placeholder="*/30 * * * *"
            />
            <p className="text-xs text-[var(--color-text-faint)] mt-1">e.g. */30 * * * * = every 30 min</p>
          </div>
        )}

        {/* Timestamps (view mode only) */}
        {!editing && (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Created</span>
            <span>{new Date(task.created_at).toLocaleString()}</span>
          </div>
          {task.execute_at && (
            <div className="flex justify-between">
              <span className="text-[var(--color-text-muted)]">Scheduled</span>
              <span className="text-[var(--color-accent)]">{formatRelativeTime(task.execute_at)}</span>
            </div>
          )}
          {task.executed_at && (
            <div className="flex justify-between">
              <span className="text-[var(--color-text-muted)]">Started</span>
              <span>{new Date(task.executed_at).toLocaleString()}</span>
            </div>
          )}
          {task.completed_at && (
            <div className="flex justify-between">
              <span className="text-[var(--color-text-muted)]">Completed</span>
              <span>{new Date(task.completed_at).toLocaleString()}</span>
            </div>
          )}
          {task.next_run && (
            <div className="flex justify-between">
              <span className="text-[var(--color-text-muted)]">Next Run</span>
              <span className="text-[var(--color-accent)]">{formatRelativeTime(task.next_run)}</span>
            </div>
          )}
        </div>
        )}

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
            <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Trajectory</h4>
            <div className="text-sm text-[var(--color-text-faint)]">Loading trajectory...</div>
          </div>
        )}
        {task.trajectory && task.trajectory.length > 0 && (
          <div>
            <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
              Trajectory ({task.trajectory.length} steps)
            </h4>
            <TrajectoryView trajectory={task.trajectory} />
          </div>
        )}
      </div>
    </div>
  );
}

export function TrajectoryView({ trajectory }: { trajectory: TaskTrajectoryStep[] }) {
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
          <p className={`text-sm text-[var(--color-text)] whitespace-pre-wrap break-words ${!isExpanded && isLong ? 'line-clamp-4' : ''}`}>
            {content}
          </p>
          {isLong && (
            <button
              onClick={() => toggleStep(step.id)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] mt-1"
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
                  <span className="text-xs text-[var(--color-text-secondary)]">{block.name}</span>
                </div>
                <pre className={`text-xs text-[var(--color-text-secondary)] overflow-x-auto ${!isExpanded && isLong ? 'line-clamp-3' : ''}`}>
                  {inputStr}
                </pre>
                {isLong && (
                  <button
                    onClick={() => toggleStep(blockId)}
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] mt-1"
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
                <pre className={`text-xs text-[var(--color-text-secondary)] overflow-x-auto whitespace-pre-wrap break-words ${!isExpanded && isLong ? 'line-clamp-3' : ''}`}>
                  {block.content}
                </pre>
                {isLong && (
                  <button
                    onClick={() => toggleStep(blockId)}
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] mt-1"
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
            className={`${style.bg} border border-[var(--color-border)] rounded overflow-hidden p-3`}
          >
            <div className="flex items-center gap-2 mb-2">
              <span>{style.icon}</span>
              <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              {step.model && (
                <span className="text-xs text-[var(--color-text-faint)]">· {step.model}</span>
              )}
              <span className="text-xs text-[var(--color-text-faint)]">
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

// --- Create Task Modal ---

interface CreateTaskModalProps {
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
  currentProjectId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

function CreateTaskModal({ authFetch, currentProjectId, onClose, onCreated }: CreateTaskModalProps) {
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<"once" | "recurring">("once");
  const [priority, setPriority] = useState(5);
  const [executeAt, setExecuteAt] = useState("");
  const [recurrence, setRecurrence] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    authFetch("/api/agents").then(r => r.json()).then(data => {
      const running = (data.agents || []).filter((a: Agent) => a.status === "running" && a.features?.tasks);
      setAgents(running.map((a: Agent) => ({ id: a.id, name: a.name })));
      if (running.length === 1) setAgentId(running[0].id);
    }).catch(() => {});
  }, [authFetch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId || !title.trim()) return;
    setCreating(true);
    setError("");

    const body: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || undefined,
      type,
      priority,
    };
    if (type === "once" && executeAt) {
      body.execute_at = new Date(executeAt).toISOString();
    }
    if (type === "recurring" && recurrence.trim()) {
      body.recurrence = recurrence.trim();
    }

    try {
      const res = await authFetch(`/api/tasks/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--color-surface)] card w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-border)]">
          <h2 className="font-medium">Create Task</h2>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition">
            <CloseIcon />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Agent */}
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Agent</label>
            {agents.length === 0 ? (
              <p className="text-sm text-[var(--color-text-faint)]">No running agents with tasks enabled</p>
            ) : (
              <select
                value={agentId}
                onChange={e => setAgentId(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
                required
              >
                <option value="">Select agent...</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
              placeholder="e.g. Check email for new orders"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm text-[var(--color-text-muted)] mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm resize-none"
              rows={2}
              placeholder="Optional instructions for the agent..."
            />
          </div>

          {/* Type & Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as "once" | "recurring")}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
              >
                <option value="once">One-time</option>
                <option value="recurring">Recurring</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Priority</label>
              <input
                type="number"
                min={1}
                max={10}
                value={priority}
                onChange={e => setPriority(Number(e.target.value))}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Schedule */}
          {type === "once" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Schedule (optional)</label>
              <input
                type="datetime-local"
                value={executeAt}
                onChange={e => setExecuteAt(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm"
              />
              <p className="text-xs text-[var(--color-text-faint)] mt-1">Leave empty to execute immediately</p>
            </div>
          )}

          {type === "recurring" && (
            <div>
              <label className="block text-sm text-[var(--color-text-muted)] mb-1">Cron Schedule</label>
              <input
                type="text"
                value={recurrence}
                onChange={e => setRecurrence(e.target.value)}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono"
                placeholder="*/30 * * * *"
                required
              />
              <p className="text-xs text-[var(--color-text-faint)] mt-1">e.g. */30 * * * * = every 30 min, 0 9 * * 1-5 = weekdays at 9am</p>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-border)] transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating || !agentId || !title.trim() || agents.length === 0}
              className="px-4 py-2 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Schedule formatting helpers ---

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatCron(cron: string): string {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return cron;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Every N minutes: */N * * * *
    if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      const n = parseInt(minute.slice(2));
      if (n === 1) return "Every minute";
      return `Every ${n} minutes`;
    }

    // Every hour: 0 * * * *
    if (minute !== "*" && !minute.includes("/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return "Every hour";
    }

    // Every N hours: 0 */N * * *
    if (hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      const n = parseInt(hour.slice(2));
      if (n === 1) return "Every hour";
      return `Every ${n} hours`;
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

      if (dayOfWeek === "*") return `Daily at ${timeStr}`;

      const days = dayOfWeek.split(",").map(d => {
        const num = parseInt(d.trim());
        return DAY_NAMES[num] || d;
      });

      if (days.length === 7) return `Daily at ${timeStr}`;
      if (days.length === 5 && !days.includes("Sat") && !days.includes("Sun")) {
        return `Weekdays at ${timeStr}`;
      }
      if (days.length === 1) return `Weekly on ${days[0]} at ${timeStr}`;
      return `${days.join(" & ")} at ${timeStr}`;
    }

    return cron;
  } catch {
    return cron;
  }
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isFuture = diffMs > 0;

  const minutes = Math.floor(absDiffMs / 60000);
  const hours = Math.floor(absDiffMs / 3600000);
  const days = Math.floor(absDiffMs / 86400000);

  const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) {
    if (minutes < 1) return isFuture ? "now" : "just now";
    if (minutes < 60) return isFuture ? `in ${minutes} min (${timeStr})` : `${minutes} min ago`;
    return isFuture ? `in ${hours}h (${timeStr})` : `${hours}h ago`;
  }

  if (isTomorrow) return `Tomorrow at ${timeStr}`;
  if (isYesterday) return `Yesterday at ${timeStr}`;

  if (days < 7) {
    const dayName = DAY_NAMES[date.getDay()];
    return `${dayName} at ${timeStr}`;
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ` at ${timeStr}`;
}
