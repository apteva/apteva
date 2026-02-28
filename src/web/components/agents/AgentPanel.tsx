import React, { useState, useEffect } from "react";
import { Chat, convertApiMessages } from "@apteva/apteva-kit";
import { CloseIcon, MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, FilesIcon, MultiAgentIcon, RecurringIcon, ScheduledIcon, TaskOnceIcon } from "../common/Icons";
import { formatCron, formatRelativeTime, TrajectoryView } from "../tasks/TasksPage";
import { Select } from "../common/Select";
import { useConfirm } from "../common/Modal";
import { useTelemetry, useTheme } from "../../context";
import { useAuth } from "../../context";
import type { Agent, Provider, AgentFeatures, McpServer, SkillSummary, MultiAgentConfig, OperatorConfig, Task } from "../../types";
import { getMultiAgentConfig, getOperatorConfig } from "../../types";

type Tab = "chat" | "threads" | "tasks" | "memory" | "files" | "settings";

interface AgentPanelProps {
  agent: Agent;
  providers: Provider[];
  onClose: () => void;
  onStartAgent: (e?: React.MouseEvent) => void;
  onUpdateAgent: (updates: Partial<Agent>) => Promise<{ error?: string }>;
  onDeleteAgent: () => void;
}

const FEATURE_CONFIG = [
  { key: "memory" as keyof AgentFeatures, label: "Memory", description: "Persistent recall", icon: MemoryIcon },
  { key: "tasks" as keyof AgentFeatures, label: "Tasks", description: "Schedule and execute tasks", icon: TasksIcon },
  { key: "files" as keyof AgentFeatures, label: "Files", description: "File storage and management", icon: FilesIcon },
  { key: "vision" as keyof AgentFeatures, label: "Vision", description: "Process images and PDFs", icon: VisionIcon },
  { key: "operator" as keyof AgentFeatures, label: "Operator", description: "Browser automation", icon: OperatorIcon },
  { key: "mcp" as keyof AgentFeatures, label: "MCP", description: "External tools/services", icon: McpIcon },
  { key: "realtime" as keyof AgentFeatures, label: "Realtime", description: "Voice conversations", icon: RealtimeIcon },
  { key: "agents" as keyof AgentFeatures, label: "Multi-Agent", description: "Communicate with peer agents", icon: MultiAgentIcon },
];

export function AgentPanel({ agent, providers, onClose, onStartAgent, onUpdateAgent, onDeleteAgent }: AgentPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-[var(--color-bg)] border-l border-[var(--color-border)]">
      {/* Header with tabs */}
      <div className="border-b border-[var(--color-border)] flex items-center">
        {/* Scrollable tabs */}
        <div className="flex-1 overflow-x-auto scrollbar-hide px-2 md:px-4">
          <div className="flex gap-1">
            <TabButton active={activeTab === "chat"} onClick={() => setActiveTab("chat")}>
              Chat
            </TabButton>
            <TabButton active={activeTab === "threads"} onClick={() => setActiveTab("threads")}>
              Threads
            </TabButton>
            <TabButton active={activeTab === "tasks"} onClick={() => setActiveTab("tasks")}>
              Tasks
            </TabButton>
            <TabButton active={activeTab === "memory"} onClick={() => setActiveTab("memory")}>
              Memory
            </TabButton>
            <TabButton active={activeTab === "files"} onClick={() => setActiveTab("files")}>
              Files
            </TabButton>
            <TabButton active={activeTab === "settings"} onClick={() => setActiveTab("settings")}>
              Settings
            </TabButton>
          </div>
        </div>

        {/* Close button - fixed on right */}
        <button
          onClick={onClose}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition p-2 flex-shrink-0 mr-2"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === "chat" && (
          <ChatTab agent={agent} onStartAgent={onStartAgent} />
        )}
        {activeTab === "threads" && (
          <ThreadsTab agent={agent} />
        )}
        {activeTab === "tasks" && (
          <TasksTab agent={agent} />
        )}
        {activeTab === "memory" && (
          <MemoryTab agent={agent} />
        )}
        {activeTab === "files" && (
          <FilesTab agent={agent} />
        )}
        {activeTab === "settings" && (
          <SettingsTab agent={agent} providers={providers} onUpdateAgent={onUpdateAgent} onDeleteAgent={onDeleteAgent} />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm font-medium border-b-2 transition ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

function ChatTab({ agent, onStartAgent }: { agent: Agent; onStartAgent: (e?: React.MouseEvent) => void }) {
  const { theme } = useTheme();
  if (agent.status === "running" && agent.port) {
    return (
      <Chat
        agentId="default"
        apiUrl={`/api/agents/${agent.id}`}
        placeholder="Message this agent..."
        context={agent.systemPrompt}
        variant="terminal"
        theme={theme.id as "light" | "dark"}
        headerTitle={agent.name}
        enableVoice={!!agent.features.realtime}
      />
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
      <div className="text-center">
        <p className="text-lg mb-2">Agent is not running</p>
        <button
          onClick={onStartAgent}
          className="bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/30 px-4 py-2 rounded font-medium transition"
        >
          Start Agent
        </button>
      </div>
    </div>
  );
}

interface Thread {
  id: string;
  title?: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

function ThreadsTab({ agent }: { agent: Agent }) {
  const { theme: themeObj } = useTheme();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  // Reset state when agent changes
  useEffect(() => {
    setThreads([]);
    setSelectedThread(null);
    setError(null);
    setLoading(true);
  }, [agent.id]);

  useEffect(() => {
    if (agent.status !== "running") {
      setLoading(false);
      return;
    }

    const fetchThreads = async () => {
      try {
        const res = await fetch(`/api/agents/${agent.id}/threads`);
        if (!res.ok) throw new Error("Failed to fetch threads");
        const data = await res.json();
        setThreads(data.threads || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load threads");
      } finally {
        setLoading(false);
      }
    };

    fetchThreads();
  }, [agent.id, agent.status]);

  const openThread = async (threadId: string) => {
    setLoadingMessages(true);
    setSelectedThread(threadId);
    try {
      const res = await fetch(`/api/agents/${agent.id}/threads/${threadId}/messages`);
      if (res.ok) {
        const data = await res.json();
        setInitialMessages(convertApiMessages(data.messages || []));
      } else {
        setInitialMessages([]);
      }
    } catch {
      setInitialMessages([]);
    }
    setLoadingMessages(false);
  };

  const deleteThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await confirm("Delete this thread?", { confirmText: "Delete", title: "Delete Thread" });
    if (!confirmed) return;

    try {
      await fetch(`/api/agents/${agent.id}/threads/${threadId}`, { method: "DELETE" });
      setThreads(prev => prev.filter(t => t.id !== threadId));
      if (selectedThread === threadId) {
        setSelectedThread(null);
      }
    } catch {
      // Ignore errors
    }
  };

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Start the agent to view threads</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Loading threads...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  // Show live chat for selected thread
  if (selectedThread) {
    return (
      <>
      {ConfirmDialog}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loadingMessages ? (
          <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">Loading messages...</div>
        ) : (
          <Chat
            key={selectedThread}
            agentId="default"
            apiUrl={`/api/agents/${agent.id}`}
            threadId={selectedThread}
            initialMessages={initialMessages}
            placeholder="Continue this conversation..."
            context={agent.systemPrompt}
            variant="terminal"
            theme={themeObj.id as "light" | "dark"}
            showHeader={true}
            onHeaderBack={() => { setSelectedThread(null); setInitialMessages([]); }}
          />
        )}
      </div>
      </>
    );
  }

  // Show threads list (full width)
  return (
    <>
    {ConfirmDialog}
    <div className="flex-1 overflow-auto">
      {threads.length === 0 ? (
        <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
          <p>No conversation threads yet</p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {threads.map(thread => (
            <div
              key={thread.id}
              onClick={() => openThread(thread.id)}
              className="p-4 cursor-pointer hover:bg-[var(--color-surface)] transition flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {thread.title || `Thread ${thread.id.slice(0, 8)}`}
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {new Date(thread.updated_at || thread.created_at).toLocaleString()}
                  {thread.message_count !== undefined && ` • ${thread.message_count} messages`}
                </p>
              </div>
              <button
                onClick={(e) => deleteThread(thread.id, e)}
                className="text-[var(--color-text-muted)] hover:text-red-400 text-lg ml-4"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function TasksTab({ agent }: { agent: Agent }) {
  const { authFetch } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({ title: "", description: "", type: "once" as "once" | "recurring", priority: 5, execute_at: "", recurrence: "" });
  const { confirm, ConfirmDialog } = useConfirm();
  const { events } = useTelemetry({ agent_id: agent.id, category: "task" });

  // Reset state when agent changes
  useEffect(() => {
    setTasks([]);
    setError(null);
    setLoading(true);
    setSelectedTask(null);
  }, [agent.id]);

  const fetchTasks = async () => {
    if (agent.status !== "running") {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/agents/${agent.id}/tasks?status=${filter}`);
      if (!res.ok) throw new Error("Failed to fetch tasks");
      const data = await res.json();
      setTasks(data.tasks || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  };

  const selectTask = async (task: Task) => {
    setSelectedTask(task);
    setLoadingTask(true);
    try {
      const res = await authFetch(`/api/tasks/${task.agentId || agent.id}/${task.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.task) {
          setSelectedTask({ ...data.task, agentId: task.agentId || agent.id, agentName: task.agentName || agent.name });
        }
      }
    } catch (e) {
      console.error("Failed to fetch task details:", e);
    } finally {
      setLoadingTask(false);
    }
  };

  const handleExecuteTask = async () => {
    if (!selectedTask || executing) return;
    setExecuting(true);
    try {
      await authFetch(`/api/tasks/${agent.id}/${selectedTask.id}/execute`, { method: "POST" });
      setSelectedTask(null);
      fetchTasks();
    } catch (e) {
      console.error("Failed to execute task:", e);
    } finally {
      setExecuting(false);
    }
  };

  const handleDeleteTask = async () => {
    if (!selectedTask || deleting) return;
    const ok = await confirm(`Are you sure you want to delete "${selectedTask.title}"?`, {
      title: "Delete Task",
      confirmText: "Delete",
      confirmVariant: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await authFetch(`/api/tasks/${agent.id}/${selectedTask.id}`, { method: "DELETE" });
      setSelectedTask(null);
      fetchTasks();
    } catch (e) {
      console.error("Failed to delete task:", e);
    } finally {
      setDeleting(false);
    }
  };

  const handleCreateTask = async (data: { title: string; description: string; type: string; priority: number; execute_at?: string; recurrence?: string }) => {
    try {
      const body: Record<string, unknown> = { ...data };
      if (data.execute_at) body.execute_at = new Date(data.execute_at).toISOString();
      const res = await authFetch(`/api/tasks/${agent.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setShowCreateForm(false);
        fetchTasks();
      }
    } catch (e) {
      console.error("Failed to create task:", e);
    }
  };

  const startEditing = (task: Task) => {
    setEditForm({
      title: task.title,
      description: task.description || "",
      type: task.type as "once" | "recurring",
      priority: task.priority,
      execute_at: task.execute_at ? new Date(task.execute_at).toISOString().slice(0, 16) : "",
      recurrence: task.recurrence || "",
    });
    setEditing(true);
  };

  const handleUpdateTask = async () => {
    if (!selectedTask || saving) return;
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
      const res = await authFetch(`/api/tasks/${agent.id}/${selectedTask.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setEditing(false);
        setSelectedTask(null);
        fetchTasks();
      }
    } catch (e) {
      console.error("Failed to update task:", e);
    } finally {
      setSaving(false);
    }
  };

  // Refetch when agent changes, filter changes, or task telemetry arrives
  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [agent.id, agent.status, filter, events.length]);

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-500/20 text-yellow-400",
    running: "bg-blue-500/20 text-blue-400",
    completed: "bg-green-500/20 text-green-400",
    failed: "bg-red-500/20 text-red-400",
    cancelled: "bg-gray-500/20 text-gray-400",
  };

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Start the agent to view tasks</p>
      </div>
    );
  }

  if (!agent.features?.tasks) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <div className="text-center">
          <p className="mb-2">Tasks feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to schedule tasks</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Loading tasks...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  const filterOptions = [
    { value: "all", label: "All" },
    { value: "pending", label: "Pending" },
    { value: "running", label: "Running" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
  ];

  // Show task detail view when a task is selected
  if (selectedTask) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        {ConfirmDialog}
        {/* Back button + actions */}
        <div className="px-4 pt-3 pb-2 border-b border-[var(--color-border)] shrink-0 flex items-center justify-between">
          <button
            onClick={() => { setSelectedTask(null); setEditing(false); }}
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition flex items-center gap-1"
          >
            <span>←</span> {editing ? "Cancel" : "Back to tasks"}
          </button>
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button
                  onClick={() => setEditing(false)}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateTask}
                  disabled={saving || !editForm.title.trim()}
                  className="px-3 py-1 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              <>
                {(selectedTask.status === "pending" || selectedTask.status === "completed" || selectedTask.status === "failed") && (
                  <button
                    onClick={() => startEditing(selectedTask)}
                    title="Edit task"
                    className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition"
                  >
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                  </button>
                )}
                {(selectedTask.status === "pending" || selectedTask.status === "completed") && (
                  <button
                    onClick={handleExecuteTask}
                    disabled={executing}
                    title="Execute now"
                    className="text-[var(--color-accent)] hover:opacity-80 transition disabled:opacity-50"
                  >
                    <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  </button>
                )}
                <button
                  onClick={handleDeleteTask}
                  disabled={deleting}
                  title="Delete task"
                  className="text-red-400 hover:text-red-300 transition disabled:opacity-50"
                >
                  <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Task detail content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {(() => {
            const inputClass = "w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]";
            return <>
          {/* Title & Status */}
          <div>
            <div className="flex items-start justify-between gap-2 mb-1">
              {editing ? (
                <input
                  type="text"
                  value={editForm.title}
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                  className={`${inputClass} text-lg font-medium`}
                  placeholder="Task title"
                />
              ) : (
                <h3 className="text-lg font-medium">{selectedTask.title}</h3>
              )}
              {!editing && (
                <span className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${statusColors[selectedTask.status]}`}>
                  {selectedTask.status}
                </span>
              )}
            </div>
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
          ) : selectedTask.description ? (
            <div>
              <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-1">Description</h4>
              <p className="text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap">{selectedTask.description}</p>
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
                <p className="capitalize">{selectedTask.type}</p>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">Priority</span>
                <p>{selectedTask.priority}</p>
              </div>
              {selectedTask.recurrence && (
                <div>
                  <span className="text-[var(--color-text-muted)]">Recurrence</span>
                  <p>{formatCron(selectedTask.recurrence)}</p>
                  <p className="text-xs text-[var(--color-text-faint)] mt-0.5 font-mono">{selectedTask.recurrence}</p>
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
              <span>{new Date(selectedTask.created_at).toLocaleString()}</span>
            </div>
            {selectedTask.execute_at && (
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Scheduled</span>
                <span className="text-[var(--color-accent)]">{formatRelativeTime(selectedTask.execute_at)}</span>
              </div>
            )}
            {selectedTask.executed_at && (
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Started</span>
                <span>{new Date(selectedTask.executed_at).toLocaleString()}</span>
              </div>
            )}
            {selectedTask.completed_at && (
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Completed</span>
                <span>{new Date(selectedTask.completed_at).toLocaleString()}</span>
              </div>
            )}
            {selectedTask.next_run && (
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">Next Run</span>
                <span className="text-[var(--color-accent)]">{formatRelativeTime(selectedTask.next_run)}</span>
              </div>
            )}
          </div>
          )}

          {/* Error */}
          {!editing && selectedTask.status === "failed" && selectedTask.error && (
            <div className="min-w-0">
              <h4 className="text-xs text-red-400 uppercase tracking-wider mb-1">Error</h4>
              <div className="bg-red-500/10 border border-red-500/20 rounded p-3 overflow-x-auto">
                <pre className="text-sm text-red-400 whitespace-pre-wrap break-words">{selectedTask.error}</pre>
              </div>
            </div>
          )}

          {/* Result */}
          {!editing && selectedTask.status === "completed" && selectedTask.result && (
            <div className="min-w-0">
              <h4 className="text-xs text-green-400 uppercase tracking-wider mb-1">Result</h4>
              <div className="bg-green-500/10 border border-green-500/20 rounded p-3 overflow-x-auto">
                <pre className="text-sm text-green-400 whitespace-pre-wrap break-words">
                  {typeof selectedTask.result === "string" ? selectedTask.result : JSON.stringify(selectedTask.result, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Trajectory */}
          {!editing && loadingTask && !selectedTask.trajectory && (
            <div>
              <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Trajectory</h4>
              <div className="text-sm text-[var(--color-text-faint)]">Loading trajectory...</div>
            </div>
          )}
          {!editing && selectedTask.trajectory && selectedTask.trajectory.length > 0 && (
            <div>
              <h4 className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
                Trajectory ({selectedTask.trajectory.length} steps)
              </h4>
              <TrajectoryView trajectory={selectedTask.trajectory} />
            </div>
          )}
            </>;
          })()}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      {/* Create Task Button + Filter tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          {filterOptions.map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 rounded text-sm transition ${
              filter === opt.value
                ? "bg-[var(--color-accent)] text-black"
                : "bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
        </div>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition flex items-center gap-1 flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          New
        </button>
      </div>

      {/* Inline Create Form */}
      {showCreateForm && (
        <AgentCreateTaskForm
          onSubmit={handleCreateTask}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {tasks.length === 0 ? (
        <div className="text-center py-10">
          <TasksIcon className="w-10 h-10 mx-auto mb-3 text-[var(--color-border-light)]" />
          <p className="text-[var(--color-text-muted)]">No {filter === "all" ? "" : filter + " "}tasks</p>
          <p className="text-sm text-[var(--color-text-faint)] mt-1">Tasks will appear here when created</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div
              key={task.id}
              onClick={() => selectTask(task)}
              className="bg-[var(--color-surface)] card p-4 cursor-pointer hover:border-[var(--color-border-light)] transition"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium">{task.title || task.name}</h3>
                </div>
                <span className={`px-2 py-1 rounded text-xs font-medium ml-2 ${statusColors[task.status] || statusColors.pending}`}>
                  {task.status}
                </span>
              </div>

              {task.description && (
                <p className="text-sm text-[var(--color-text-secondary)] mb-2 line-clamp-2">{task.description}</p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--color-text-faint)]">
                <span className="flex items-center gap-1">
                  {task.type === "recurring"
                    ? <RecurringIcon className="w-3.5 h-3.5" />
                    : task.execute_at
                      ? <ScheduledIcon className="w-3.5 h-3.5" />
                      : <TaskOnceIcon className="w-3.5 h-3.5" />
                  }
                  {task.type === "recurring" && task.recurrence ? formatCron(task.recurrence) : task.type || "once"}
                </span>
                {task.priority !== undefined && (
                  <span>Priority: {task.priority}</span>
                )}
                {task.next_run && (
                  <span className="text-[var(--color-accent)]">{formatRelativeTime(task.next_run)}</span>
                )}
                {!task.next_run && task.execute_at && (
                  <span className="text-[var(--color-accent)]">{formatRelativeTime(task.execute_at)}</span>
                )}
                <span>Created: {new Date(task.created_at).toLocaleDateString()}</span>
              </div>

              {task.status === "completed" && task.result && (
                <div className="mt-3 bg-green-500/10 border border-green-500/20 rounded p-3">
                  <h4 className="text-xs text-green-400 uppercase tracking-wider mb-1">Result</h4>
                  <pre className="text-sm text-green-400 whitespace-pre-wrap break-words">
                    {typeof task.result === "string" ? task.result : JSON.stringify(task.result, null, 2)}
                  </pre>
                </div>
              )}

              {task.status === "failed" && task.error && (
                <div className="mt-3 bg-red-500/10 border border-red-500/20 rounded p-3">
                  <h4 className="text-xs text-red-400 uppercase tracking-wider mb-1">Error</h4>
                  <pre className="text-sm text-red-400 whitespace-pre-wrap break-words">{task.error}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCreateTaskForm({ onSubmit, onCancel }: {
  onSubmit: (data: { title: string; description: string; type: string; priority: number; execute_at?: string; recurrence?: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("once");
  const [priority, setPriority] = useState(5);
  const [executeAt, setExecuteAt] = useState("");
  const [recurrence, setRecurrence] = useState("");

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-accent)]/30 rounded-lg p-3 mb-4 space-y-3">
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm"
        placeholder="Task title..."
        autoFocus
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm resize-none"
        rows={2}
        placeholder="Description (optional)..."
      />
      <div className="grid grid-cols-2 gap-2">
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm"
        >
          <option value="once">One-time</option>
          <option value="recurring">Recurring</option>
        </select>
        <input
          type="number"
          min={1}
          max={10}
          value={priority}
          onChange={e => setPriority(Number(e.target.value))}
          className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1.5 text-sm"
          placeholder="Priority"
        />
      </div>
      {type === "once" && (
        <input
          type="datetime-local"
          value={executeAt}
          onChange={e => setExecuteAt(e.target.value)}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm"
        />
      )}
      {type === "recurring" && (
        <input
          type="text"
          value={recurrence}
          onChange={e => setRecurrence(e.target.value)}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm font-mono"
          placeholder="*/30 * * * * (cron)"
        />
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 rounded text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-border)] transition">Cancel</button>
        <button
          onClick={() => title.trim() && onSubmit({ title: title.trim(), description: description.trim(), type, priority, execute_at: executeAt || undefined, recurrence: recurrence || undefined })}
          disabled={!title.trim()}
          className="px-3 py-1.5 rounded text-sm bg-[var(--color-accent)] text-black hover:opacity-90 transition disabled:opacity-50"
        >Create</button>
      </div>
    </div>
  );
}

interface Memory {
  id: string;
  content: string;
  type: string;
  importance: number;
  thread_id?: string;
  created_at: string;
}

function MemoryTab({ agent }: { agent: Agent }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  // Reset state when agent changes
  useEffect(() => {
    setMemories([]);
    setError(null);
    setLoading(true);
  }, [agent.id]);

  const fetchMemories = async () => {
    if (agent.status !== "running") {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/agents/${agent.id}/memories`);
      if (!res.ok) throw new Error("Failed to fetch memories");
      const data = await res.json();
      setMemories(data.memories || []);
      setEnabled(data.enabled ?? false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, [agent.id, agent.status]);

  const deleteMemory = async (memoryId: string) => {
    try {
      await fetch(`/api/agents/${agent.id}/memories/${memoryId}`, { method: "DELETE" });
      setMemories(prev => prev.filter(m => m.id !== memoryId));
    } catch {
      // Ignore errors
    }
  };

  const clearAllMemories = async () => {
    const confirmed = await confirm("Clear all memories?", { confirmText: "Clear", title: "Clear Memories" });
    if (!confirmed) return;
    try {
      await fetch(`/api/agents/${agent.id}/memories`, { method: "DELETE" });
      setMemories([]);
    } catch {
      // Ignore errors
    }
  };

  if (!agent.features?.memory) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <div className="text-center">
          <p className="mb-2">Memory feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to persist knowledge</p>
        </div>
      </div>
    );
  }

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Start the agent to view memories</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Loading memories...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <div className="text-center">
          <p className="mb-2">Memory system not initialized</p>
          <p className="text-sm">Check OPENAI_API_KEY for embeddings</p>
        </div>
      </div>
    );
  }

  return (
    <>
    {ConfirmDialog}
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--color-text-secondary)]">Stored Memories ({memories.length})</h3>
        {memories.length > 0 && (
          <button
            onClick={clearAllMemories}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Clear All
          </button>
        )}
      </div>

      {memories.length === 0 ? (
        <div className="text-center py-10 text-[var(--color-text-muted)]">
          <p>No memories stored yet</p>
          <p className="text-sm mt-1">The agent will remember important information from conversations</p>
        </div>
      ) : (
        <div className="space-y-3">
          {memories.map(memory => (
            <div key={memory.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-[var(--color-text)] flex-1">{memory.content}</p>
                <button
                  onClick={() => deleteMemory(memory.id)}
                  className="text-[var(--color-text-muted)] hover:text-red-400 text-sm flex-shrink-0"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  memory.type === "preference"
                    ? "bg-purple-500/20 text-purple-400"
                    : memory.type === "fact"
                    ? "bg-green-500/20 text-green-400"
                    : "bg-blue-500/20 text-blue-400"
                }`}>
                  {memory.type}
                </span>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {new Date(memory.created_at).toLocaleString()}
                </span>
                {memory.importance && (
                  <span className="text-xs text-[var(--color-text-faint)]">
                    importance: {memory.importance.toFixed(1)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

interface AgentFile {
  id: string;
  filename: string;
  mime_type: string;
  file_type: string;
  size_bytes: number;
  source: string;
  source_tool?: string;
  url?: string;
  created_at: string;
}

function FilesTab({ agent }: { agent: Agent }) {
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const { confirm, ConfirmDialog } = useConfirm();

  // Reset state when agent changes
  useEffect(() => {
    setFiles([]);
    setError(null);
    setLoading(true);
  }, [agent.id]);

  const fetchFiles = async () => {
    if (agent.status !== "running") {
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/agents/${agent.id}/files`);
      if (!res.ok) throw new Error("Failed to fetch files");
      const data = await res.json();
      setFiles(data.files || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, [agent.id, agent.status]);

  const deleteFile = async (fileId: string) => {
    const confirmed = await confirm("Delete this file?", { confirmText: "Delete", title: "Delete File" });
    if (!confirmed) return;
    try {
      await fetch(`/api/agents/${agent.id}/files/${fileId}`, { method: "DELETE" });
      setFiles(prev => prev.filter(f => f.id !== fileId));
    } catch {
      // Ignore errors
    }
  };

  const downloadFile = (fileId: string, filename: string) => {
    const link = document.createElement("a");
    link.href = `/api/agents/${agent.id}/files/${fileId}/download`;
    link.download = filename;
    link.click();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/agents/${agent.id}/files`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Upload failed");
      }

      // Refresh file list
      await fetchFiles();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      uploadFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith("image/")) return "🖼";
    if (mimeType.includes("pdf")) return "📕";
    if (mimeType.includes("json")) return "{}";
    if (mimeType.includes("javascript") || mimeType.includes("typescript")) return "⚡";
    if (mimeType.startsWith("text/")) return "📄";
    if (mimeType.startsWith("audio/")) return "🎵";
    if (mimeType.startsWith("video/")) return "🎬";
    return "📁";
  };

  if (!agent.features?.files) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <div className="text-center">
          <p className="mb-2">Files feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to manage files</p>
        </div>
      </div>
    );
  }

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Start the agent to view files</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
        <p>Loading files...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <>
    {ConfirmDialog}
    <div
      className={`flex-1 overflow-auto p-4 transition ${dragOver ? "bg-[var(--color-accent-5)]" : ""}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
      />

      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[var(--color-text-secondary)]">Agent Files ({files.length})</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-3 py-1 rounded font-medium transition"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
          <button
            onClick={fetchFiles}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            Refresh
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="mb-4 text-sm bg-red-500/10 text-red-400 px-3 py-2 rounded">
          {uploadError}
        </div>
      )}

      {dragOver && (
        <div className="mb-4 border-2 border-dashed border-[var(--color-accent)] rounded-lg p-8 text-center">
          <p className="text-[var(--color-accent)]">Drop file to upload</p>
        </div>
      )}

      {files.length === 0 && !dragOver && (
        <div className="text-center py-10 text-[var(--color-text-muted)]">
          <p>No files stored yet</p>
          <p className="text-sm mt-1">Drop files here, click Upload, or attach files in Chat</p>
          {agent.features?.memory && (
            <p className="text-xs mt-2 text-[var(--color-text-faint)]">Files will be auto-ingested into memory</p>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map(file => (
            <div key={file.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3 flex items-center gap-3">
              <div className="w-10 h-10 bg-[var(--color-surface-raised)] rounded flex items-center justify-center text-[var(--color-text-muted)]">
                {getFileIcon(file.mime_type)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--color-text)] truncate">{file.filename}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {formatSize(file.size_bytes)} • {new Date(file.created_at).toLocaleString()}
                  {file.source && file.source !== "upload" && ` • ${file.source}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadFile(file.id, file.filename)}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] px-2 py-1"
                >
                  ↓
                </button>
                <button
                  onClick={() => deleteFile(file.id)}
                  className="text-[var(--color-text-muted)] hover:text-red-400 text-sm"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

interface AvailableSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  project_id: string | null;
}

function SettingsTab({ agent, providers, onUpdateAgent, onDeleteAgent }: {
  agent: Agent;
  providers: Provider[];
  onUpdateAgent: (updates: Partial<Agent>) => Promise<{ error?: string }>;
  onDeleteAgent: () => void;
}) {
  const { authFetch, isDev } = useAuth();
  const [form, setForm] = useState({
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    features: {
      ...agent.features,
      builtinTools: agent.features.builtinTools || { webSearch: false, webFetch: false },
    },
    mcpServers: [...(agent.mcpServers || [])],
    skills: [...(agent.skills || [])],
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([]);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyFull, setApiKeyFull] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [subscriptions, setSubscriptions] = useState<{ id: string; trigger_slug: string; enabled: boolean }[]>([]);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  // Fetch subscriptions for this agent
  useEffect(() => {
    authFetch(`/api/subscriptions?agent_id=${agent.id}`)
      .then(res => res.ok ? res.json() : { subscriptions: [] })
      .then(data => setSubscriptions(data.subscriptions || []))
      .catch(() => {});
  }, [agent.id, authFetch]);

  // Fetch available MCP servers
  useEffect(() => {
    const fetchMcpServers = async () => {
      try {
        const res = await authFetch("/api/mcp/servers");
        const data = await res.json();
        setAvailableMcpServers(data.servers || []);
      } catch (e) {
        console.error("Failed to fetch MCP servers:", e);
      }
    };
    fetchMcpServers();
  }, [authFetch]);

  // Fetch API key
  useEffect(() => {
    const fetchApiKey = async () => {
      try {
        const res = await authFetch(`/api/agents/${agent.id}/api-key`);
        if (res.ok) {
          const data = await res.json();
          setApiKey(data.apiKey);
          setApiKeyFull(data.fullKey || null);
        }
      } catch (e) {
        // Ignore - not critical
      }
    };
    fetchApiKey();
  }, [agent.id, authFetch]);

  // Fetch share token
  useEffect(() => {
    const fetchShareToken = async () => {
      try {
        const res = await authFetch(`/api/agents/${agent.id}/share-token`);
        if (res.ok) {
          const data = await res.json();
          setShareToken(data.token || null);
        }
      } catch {}
    };
    fetchShareToken();
  }, [agent.id, authFetch]);

  // Fetch available skills
  useEffect(() => {
    const fetchSkills = async () => {
      try {
        const res = await authFetch("/api/skills");
        const data = await res.json();
        setAvailableSkills(data.skills || []);
      } catch (e) {
        console.error("Failed to fetch skills:", e);
      }
    };
    fetchSkills();
  }, [authFetch]);

  // Reset form when agent changes
  useEffect(() => {
    setForm({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      features: {
        ...agent.features,
        builtinTools: agent.features.builtinTools || { webSearch: false, webFetch: false },
      },
      mcpServers: [...(agent.mcpServers || [])],
      skills: [...(agent.skills || [])],
    });
    setMessage(null);
  }, [agent.id]);

  const selectedProvider = providers.find(p => p.id === form.provider);

  const providerOptions = providers
    .filter(p => p.hasKey && p.type === "llm")
    .map(p => ({ value: p.id, label: p.name }));

  const modelOptions = selectedProvider?.models.map(m => ({
    value: m.value,
    label: m.label,
    recommended: m.recommended,
  })) || [];

  const handleProviderChange = (providerId: string) => {
    const provider = providers.find(p => p.id === providerId);
    const defaultModel = provider?.models.find(m => m.recommended)?.value || provider?.models[0]?.value || "";
    setForm(prev => ({ ...prev, provider: providerId, model: defaultModel }));
  };

  const toggleFeature = (key: keyof AgentFeatures) => {
    if (key === "agents") {
      // Special handling for agents feature - convert to MultiAgentConfig
      setForm(prev => {
        const isEnabled = typeof prev.features.agents === "boolean"
          ? prev.features.agents
          : (prev.features.agents as MultiAgentConfig)?.enabled ?? false;
        if (isEnabled) {
          return { ...prev, features: { ...prev.features, agents: false } };
        } else {
          return {
            ...prev,
            features: {
              ...prev.features,
              agents: { enabled: true, group: agent.projectId || undefined },
            },
          };
        }
      });
    } else if (key === "operator") {
      // Special handling for operator feature - convert to OperatorConfig
      setForm(prev => {
        const opConfig = getOperatorConfig(prev.features);
        if (opConfig.enabled) {
          return { ...prev, features: { ...prev.features, operator: false } };
        } else {
          return {
            ...prev,
            features: {
              ...prev.features,
              operator: { enabled: true },
            },
          };
        }
      });
    } else {
      setForm(prev => ({
        ...prev,
        features: { ...prev.features, [key]: !prev.features[key] },
      }));
    }
  };

  // Helper to check if agents feature is enabled
  const isAgentsEnabled = () => {
    const agentsVal = form.features.agents;
    if (typeof agentsVal === "boolean") return agentsVal;
    return (agentsVal as MultiAgentConfig)?.enabled ?? false;
  };

  // Helper to check if operator feature is enabled
  const isOperatorEnabled = () => {
    return getOperatorConfig(form.features).enabled;
  };

  // Get current operator config
  const getOperatorCfg = (): OperatorConfig => {
    return getOperatorConfig(form.features);
  };

  // Get browser providers from the providers list
  const browserProviders = providers.filter(p => p.type === "browser" && p.hasKey);

  // Set operator browser provider
  const setOperatorBrowserProvider = (browserProvider: string) => {
    setForm(prev => {
      const current = getOperatorConfig(prev.features);
      return {
        ...prev,
        features: {
          ...prev.features,
          operator: { ...current, enabled: true, browser_provider: browserProvider },
        },
      };
    });
  };

  const toggleMcpServer = (serverId: string) => {
    setForm(prev => ({
      ...prev,
      mcpServers: prev.mcpServers.includes(serverId)
        ? prev.mcpServers.filter(id => id !== serverId)
        : [...prev.mcpServers, serverId],
    }));
  };

  const toggleSkill = (skillId: string) => {
    setForm(prev => ({
      ...prev,
      skills: prev.skills.includes(skillId)
        ? prev.skills.filter(id => id !== skillId)
        : [...prev.skills, skillId],
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    const result = await onUpdateAgent(form);
    setSaving(false);
    if (result.error) {
      setMessage({ type: "error", text: result.error });
    } else {
      setMessage({ type: "success", text: "Settings saved" });
      setTimeout(() => setMessage(null), 2000);
    }
  };

  const hasChanges =
    form.name !== agent.name ||
    form.provider !== agent.provider ||
    form.model !== agent.model ||
    form.systemPrompt !== agent.systemPrompt ||
    JSON.stringify(form.features) !== JSON.stringify(agent.features) ||
    JSON.stringify(form.mcpServers.sort()) !== JSON.stringify((agent.mcpServers || []).sort()) ||
    JSON.stringify(form.skills.sort()) !== JSON.stringify((agent.skills || []).sort());

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="space-y-4">
        <FormField label="Name">
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]"
          />
        </FormField>

        <FormField label="Provider">
          <Select
            value={form.provider}
            options={providerOptions}
            onChange={handleProviderChange}
          />
        </FormField>

        <FormField label="Model">
          <Select
            value={form.model}
            options={modelOptions}
            onChange={(value) => setForm(prev => ({ ...prev, model: value }))}
          />
        </FormField>

        <FormField label="System Prompt">
          <textarea
            value={form.systemPrompt}
            onChange={(e) => setForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
            className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]"
          />
        </FormField>

        <FormField label="Features">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => {
              // For agents/operator features, check the enabled property of the config
              const isEnabled = key === "agents" ? isAgentsEnabled()
                : key === "operator" ? isOperatorEnabled()
                : !!form.features[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleFeature(key)}
                  className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                    isEnabled
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-10)]"
                      : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)]"
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isEnabled ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${isEnabled ? "text-[var(--color-accent)]" : ""}`}>
                      {label}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">{description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </FormField>

        {/* Operator Browser Provider - shown when operator is enabled */}
        {isOperatorEnabled() && (
          <FormField label="Browser Provider">
            {browserProviders.length > 0 ? (
              <Select
                value={getOperatorCfg().browser_provider || ""}
                options={[
                  { value: "", label: "Auto (first available)" },
                  ...browserProviders.map(p => ({
                    value: p.id,
                    label: p.name,
                  })),
                ]}
                onChange={(value) => setOperatorBrowserProvider(value)}
              />
            ) : (
              <p className="text-sm text-[var(--color-text-muted)] p-3 border border-[var(--color-border-light)] rounded bg-[var(--color-bg)]">
                No browser providers configured. Go to Settings &rarr; Providers to add one.
              </p>
            )}
          </FormField>
        )}

        {/* Agent Built-in Tools - Anthropic only */}
        {form.provider === "anthropic" && (
        <FormField label="Agent Built-in Tools">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setForm(prev => ({
                ...prev,
                features: {
                  ...prev.features,
                  builtinTools: {
                    ...prev.features.builtinTools,
                    webSearch: !prev.features.builtinTools?.webSearch,
                  },
                },
              }))}
              className={`flex items-center gap-2 px-3 py-2 rounded border transition ${
                form.features.builtinTools?.webSearch
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]"
                  : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)] text-[var(--color-text-secondary)]"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="text-sm">Web Search</span>
            </button>
            <button
              type="button"
              onClick={() => setForm(prev => ({
                ...prev,
                features: {
                  ...prev.features,
                  builtinTools: {
                    ...prev.features.builtinTools,
                    webFetch: !prev.features.builtinTools?.webFetch,
                  },
                },
              }))}
              className={`flex items-center gap-2 px-3 py-2 rounded border transition ${
                form.features.builtinTools?.webFetch
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]"
                  : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)] text-[var(--color-text-secondary)]"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
              <span className="text-sm">Web Fetch</span>
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-faint)] mt-2">
            Provider-native tools for real-time web access
          </p>
        </FormField>
        )}

        {/* MCP Server Selection - shown when MCP is enabled */}
        {form.features.mcp && (
          <FormField label="MCP Servers">
            {availableMcpServers.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No MCP servers configured. Add servers in the MCP page first.
              </p>
            ) : (
              <div className="space-y-2">
                {availableMcpServers
                  .filter(server => server.project_id === null || server.project_id === agent.projectId)
                  .map(server => {
                  const isRemote = server.type === "http" && server.url;
                  const isAvailable = isRemote || server.status === "running";
                  const serverInfo = isRemote
                    ? `${server.source || "remote"} • http`
                    : `${server.type} • ${server.package || server.command || "custom"}${server.status === "running" && server.port ? ` • :${server.port}` : ""}`;
                  return (
                    <button
                      key={server.id}
                      type="button"
                      onClick={() => toggleMcpServer(server.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded border text-left transition ${
                        form.mcpServers.includes(server.id)
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-10)]"
                          : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)]"
                      }`}
                    >
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        isAvailable ? "bg-green-400" : "bg-[var(--color-scrollbar)]"
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${form.mcpServers.includes(server.id) ? "text-[var(--color-accent)]" : ""}`}>
                            {server.name}
                          </span>
                          {server.project_id === null && (
                            <span className="text-[10px] text-[var(--color-text-muted)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 rounded">Global</span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)]">{serverInfo}</div>
                      </div>
                      <div className={`text-xs px-2 py-0.5 rounded ${
                        isAvailable
                          ? "bg-green-500/20 text-green-400"
                          : "bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]"
                      }`}>
                        {isRemote ? "remote" : server.status}
                      </div>
                    </button>
                  );
                })}
                <p className="text-xs text-[var(--color-text-muted)] mt-2">
                  Remote servers are always available. Local servers must be running.
                </p>
              </div>
            )}
          </FormField>
        )}

        {/* Skills Selection */}
        <FormField label="Skills">
          {availableSkills.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No skills configured. Add skills in the Skills page first.
            </p>
          ) : (
            <div className="space-y-2">
              {availableSkills
                .filter(s => s.enabled && (s.project_id === null || s.project_id === agent.projectId))
                .map(skill => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleSkill(skill.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded border text-left transition ${
                    form.skills.includes(skill.id)
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-10)]"
                      : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)]"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${form.skills.includes(skill.id) ? "text-[var(--color-accent)]" : ""}`}>
                        {skill.name}
                      </span>
                      {skill.project_id === null && (
                        <span className="text-[10px] text-[var(--color-text-muted)] bg-[var(--color-surface-raised)] px-1.5 py-0.5 rounded">Global</span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">{skill.description}</div>
                  </div>
                  <div className="text-xs px-2 py-0.5 rounded bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
                    v{skill.version}
                  </div>
                </button>
              ))}
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
                Skills provide reusable instructions for the agent.
              </p>
            </div>
          )}
        </FormField>

        {message && (
          <div className={`text-sm px-3 py-2 rounded ${
            message.type === "success"
              ? "bg-green-500/10 text-green-400"
              : "bg-red-500/10 text-red-400"
          }`}>
            {message.text}
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={!hasChanges || saving || !form.name}
          className="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>

        {agent.status === "running" && hasChanges && (
          <p className="text-xs text-[var(--color-text-muted)] text-center">
            Changes will be applied to the running agent
          </p>
        )}

        {/* Subscriptions */}
        <div className="mt-8 pt-6 border-t border-[var(--color-border-light)]">
          <p className="text-sm text-[var(--color-text-muted)] mb-3">Subscriptions</p>
          {subscriptions.length === 0 ? (
            <p className="text-xs text-[var(--color-text-faint)]">No subscriptions. Set up triggers in Connections to have this agent listen to external events.</p>
          ) : (
            <div className="space-y-2">
              {subscriptions.map(sub => (
                <div key={sub.id} className="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${sub.enabled ? "bg-cyan-400" : "bg-[var(--color-scrollbar)]"}`} />
                  <span className={`text-sm flex-1 ${sub.enabled ? "text-cyan-400" : "text-[var(--color-text-muted)]"}`}>
                    {sub.trigger_slug.replace(/_/g, " ")}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${sub.enabled ? "bg-cyan-500/10 text-cyan-400" : "bg-[var(--color-surface-raised)] text-[var(--color-text-faint)]"}`}>
                    {sub.enabled ? "active" : "disabled"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Developer Info (dev mode only) */}
        {apiKey && (
          <div className="mt-8 pt-6 border-t border-[var(--color-border-light)]">
            <p className="text-sm text-[var(--color-text-muted)] mb-3">Developer Info</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-text-muted)]">Agent ID</span>
                <code className="text-xs bg-[var(--color-surface-raised)] px-2 py-1 rounded text-[var(--color-text-secondary)]">{agent.id}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-text-muted)]">Port</span>
                <code className="text-xs bg-[var(--color-surface-raised)] px-2 py-1 rounded text-[var(--color-text-secondary)]">{agent.port || "N/A"}</code>
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--color-text-muted)]">API Key</span>
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
                <code className="text-xs bg-[var(--color-surface-raised)] px-2 py-1 rounded text-[var(--color-text-secondary)] break-all">
                  {showApiKey ? (apiKeyFull || apiKey) : apiKey}
                </code>
              </div>
              {agent.status === "running" && agent.port && (
                <div className="flex flex-col gap-1 mt-2">
                  <span className="text-xs text-[var(--color-text-muted)]">Test with curl</span>
                  <code className="text-xs bg-[var(--color-surface-raised)] px-2 py-1.5 rounded text-[var(--color-text-muted)] break-all">
                    curl -H "X-API-Key: {showApiKey ? (apiKeyFull || apiKey) : "***"}" http://localhost:{agent.port}/config
                  </code>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Share Link */}
        {shareToken && (
          <div className="mt-8 pt-6 border-t border-[var(--color-border-light)]">
            <p className="text-sm text-[var(--color-text-muted)] mb-3">Share Link</p>
            <p className="text-xs text-[var(--color-text-faint)] mb-3">
              Anyone with this link can chat with this agent. No login required. Regenerate the API key to invalidate.
            </p>
            <div className="flex gap-2">
              <code className="flex-1 text-xs bg-[var(--color-surface-raised)] px-3 py-2 rounded text-[var(--color-text-secondary)] break-all border border-[var(--color-border-light)]">
                {`${window.location.origin}/share/${shareToken}`}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.origin}/share/${shareToken}`);
                  setShareCopied(true);
                  setTimeout(() => setShareCopied(false), 2000);
                }}
                className="px-3 py-2 text-xs bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition flex-shrink-0"
              >
                {shareCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="mt-3">
              <p className="text-xs text-[var(--color-text-faint)] mb-1">Embed</p>
              <code className="block text-xs bg-[var(--color-surface-raised)] px-3 py-2 rounded text-[var(--color-text-muted)] break-all border border-[var(--color-border-light)]">
                {`<iframe src="${window.location.origin}/share/${shareToken}" width="400" height="600" style="border:none; border-radius:12px;" />`}
              </code>
            </div>
          </div>
        )}

        {/* Danger Zone */}
        <div className="mt-8 pt-6 border-t border-[var(--color-border-light)]">
          <p className="text-sm text-[var(--color-text-muted)] mb-3">Danger Zone</p>
          {confirmDelete ? (
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 border border-[var(--color-border-light)] hover:border-[var(--color-scrollbar)] px-4 py-2 rounded font-medium transition"
              >
                Cancel
              </button>
              <button
                onClick={onDeleteAgent}
                className="flex-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 px-4 py-2 rounded font-medium transition"
              >
                Confirm Delete
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-full border border-red-500/30 text-red-400/70 hover:border-red-500/50 hover:text-red-400 px-4 py-2 rounded font-medium transition"
            >
              Delete Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-[var(--color-text-muted)] mb-1">{label}</label>
      {children}
    </div>
  );
}
