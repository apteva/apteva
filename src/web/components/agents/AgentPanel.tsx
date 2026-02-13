import React, { useState, useEffect } from "react";
import { Chat, convertApiMessages } from "@apteva/apteva-kit";
import { CloseIcon, MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, FilesIcon, MultiAgentIcon, RecurringIcon, ScheduledIcon, TaskOnceIcon } from "../common/Icons";
import { formatCron, formatRelativeTime, TrajectoryView } from "../tasks/TasksPage";
import { Select } from "../common/Select";
import { useConfirm } from "../common/Modal";
import { useTelemetry } from "../../context";
import { useAuth } from "../../context";
import type { Agent, Provider, AgentFeatures, McpServer, SkillSummary, AgentMode, MultiAgentConfig, Task } from "../../types";
import { getMultiAgentConfig } from "../../types";

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
    <div className="w-full h-full flex flex-col overflow-hidden bg-[#0a0a0a] border-l border-[#1a1a1a]">
      {/* Header with tabs */}
      <div className="border-b border-[#1a1a1a] flex items-center">
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
          className="text-[#666] hover:text-[#e0e0e0] transition p-2 flex-shrink-0 mr-2"
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
          ? "border-[#f97316] text-[#e0e0e0]"
          : "border-transparent text-[#666] hover:text-[#888]"
      }`}
    >
      {children}
    </button>
  );
}

function ChatTab({ agent, onStartAgent }: { agent: Agent; onStartAgent: (e?: React.MouseEvent) => void }) {
  if (agent.status === "running" && agent.port) {
    return (
      <Chat
        agentId="default"
        apiUrl={`/api/agents/${agent.id}`}
        placeholder="Message this agent..."
        context={agent.systemPrompt}
        variant="terminal"
        headerTitle={agent.name}
      />
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center text-[#666]">
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
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <p>Start the agent to view threads</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
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
          <div className="flex-1 flex items-center justify-center text-[#666]">Loading messages...</div>
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
        <div className="flex items-center justify-center h-full text-[#666]">
          <p>No conversation threads yet</p>
        </div>
      ) : (
        <div className="divide-y divide-[#1a1a1a]">
          {threads.map(thread => (
            <div
              key={thread.id}
              onClick={() => openThread(thread.id)}
              className="p-4 cursor-pointer hover:bg-[#111] transition flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {thread.title || `Thread ${thread.id.slice(0, 8)}`}
                </p>
                <p className="text-xs text-[#666] mt-1">
                  {new Date(thread.updated_at || thread.created_at).toLocaleString()}
                  {thread.message_count !== undefined && ` • ${thread.message_count} messages`}
                </p>
              </div>
              <button
                onClick={(e) => deleteThread(thread.id, e)}
                className="text-[#666] hover:text-red-400 text-lg ml-4"
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
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <p>Start the agent to view tasks</p>
      </div>
    );
  }

  if (!agent.features?.tasks) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <div className="text-center">
          <p className="mb-2">Tasks feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to schedule tasks</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
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
        {/* Back button */}
        <div className="px-4 pt-3 pb-2 border-b border-[#1a1a1a] shrink-0">
          <button
            onClick={() => setSelectedTask(null)}
            className="text-sm text-[#666] hover:text-[#e0e0e0] transition flex items-center gap-1"
          >
            <span>←</span> Back to tasks
          </button>
        </div>

        {/* Task detail content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Title & Status */}
          <div>
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="text-lg font-medium">{selectedTask.title}</h3>
              <span className={`px-2 py-1 rounded text-xs font-medium flex-shrink-0 ${statusColors[selectedTask.status]}`}>
                {selectedTask.status}
              </span>
            </div>
          </div>

          {/* Description */}
          {selectedTask.description && (
            <div>
              <h4 className="text-xs text-[#666] uppercase tracking-wider mb-1">Description</h4>
              <p className="text-sm text-[#888] whitespace-pre-wrap">{selectedTask.description}</p>
            </div>
          )}

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-[#666]">Type</span>
              <p className="capitalize">{selectedTask.type}</p>
            </div>
            <div>
              <span className="text-[#666]">Priority</span>
              <p>{selectedTask.priority}</p>
            </div>
            {selectedTask.recurrence && (
              <div>
                <span className="text-[#666]">Recurrence</span>
                <p>{formatCron(selectedTask.recurrence)}</p>
                <p className="text-xs text-[#444] mt-0.5 font-mono">{selectedTask.recurrence}</p>
              </div>
            )}
          </div>

          {/* Timestamps */}
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-[#666]">Created</span>
              <span>{new Date(selectedTask.created_at).toLocaleString()}</span>
            </div>
            {selectedTask.execute_at && (
              <div className="flex justify-between">
                <span className="text-[#666]">Scheduled</span>
                <span className="text-[#f97316]">{formatRelativeTime(selectedTask.execute_at)}</span>
              </div>
            )}
            {selectedTask.executed_at && (
              <div className="flex justify-between">
                <span className="text-[#666]">Started</span>
                <span>{new Date(selectedTask.executed_at).toLocaleString()}</span>
              </div>
            )}
            {selectedTask.completed_at && (
              <div className="flex justify-between">
                <span className="text-[#666]">Completed</span>
                <span>{new Date(selectedTask.completed_at).toLocaleString()}</span>
              </div>
            )}
            {selectedTask.next_run && (
              <div className="flex justify-between">
                <span className="text-[#666]">Next Run</span>
                <span className="text-[#f97316]">{formatRelativeTime(selectedTask.next_run)}</span>
              </div>
            )}
          </div>

          {/* Error */}
          {selectedTask.status === "failed" && selectedTask.error && (
            <div className="min-w-0">
              <h4 className="text-xs text-red-400 uppercase tracking-wider mb-1">Error</h4>
              <div className="bg-red-500/10 border border-red-500/20 rounded p-3 overflow-x-auto">
                <pre className="text-sm text-red-400 whitespace-pre-wrap break-words">{selectedTask.error}</pre>
              </div>
            </div>
          )}

          {/* Result */}
          {selectedTask.status === "completed" && selectedTask.result && (
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
          {loadingTask && !selectedTask.trajectory && (
            <div>
              <h4 className="text-xs text-[#666] uppercase tracking-wider mb-2">Trajectory</h4>
              <div className="text-sm text-[#555]">Loading trajectory...</div>
            </div>
          )}
          {selectedTask.trajectory && selectedTask.trajectory.length > 0 && (
            <div>
              <h4 className="text-xs text-[#666] uppercase tracking-wider mb-2">
                Trajectory ({selectedTask.trajectory.length} steps)
              </h4>
              <TrajectoryView trajectory={selectedTask.trajectory} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
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

      {tasks.length === 0 ? (
        <div className="text-center py-10">
          <TasksIcon className="w-10 h-10 mx-auto mb-3 text-[#333]" />
          <p className="text-[#666]">No {filter === "all" ? "" : filter + " "}tasks</p>
          <p className="text-sm text-[#444] mt-1">Tasks will appear here when created</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div
              key={task.id}
              onClick={() => selectTask(task)}
              className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4 cursor-pointer hover:border-[#333] transition"
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
                <p className="text-sm text-[#888] mb-2 line-clamp-2">{task.description}</p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#555]">
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
                  <span className="text-[#f97316]">{formatRelativeTime(task.next_run)}</span>
                )}
                {!task.next_run && task.execute_at && (
                  <span className="text-[#f97316]">{formatRelativeTime(task.execute_at)}</span>
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
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <div className="text-center">
          <p className="mb-2">Memory feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to persist knowledge</p>
        </div>
      </div>
    );
  }

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <p>Start the agent to view memories</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
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
      <div className="flex-1 flex items-center justify-center text-[#666]">
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
        <h3 className="text-sm font-medium text-[#888]">Stored Memories ({memories.length})</h3>
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
        <div className="text-center py-10 text-[#666]">
          <p>No memories stored yet</p>
          <p className="text-sm mt-1">The agent will remember important information from conversations</p>
        </div>
      ) : (
        <div className="space-y-3">
          {memories.map(memory => (
            <div key={memory.id} className="bg-[#111] border border-[#1a1a1a] rounded p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-[#e0e0e0] flex-1">{memory.content}</p>
                <button
                  onClick={() => deleteMemory(memory.id)}
                  className="text-[#666] hover:text-red-400 text-sm flex-shrink-0"
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
                <span className="text-xs text-[#666]">
                  {new Date(memory.created_at).toLocaleString()}
                </span>
                {memory.importance && (
                  <span className="text-xs text-[#555]">
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
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <div className="text-center">
          <p className="mb-2">Files feature is not enabled</p>
          <p className="text-sm">Enable it in Settings to manage files</p>
        </div>
      </div>
    );
  }

  if (agent.status !== "running") {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <p>Start the agent to view files</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#666]">
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
      className={`flex-1 overflow-auto p-4 transition ${dragOver ? "bg-[#f97316]/5" : ""}`}
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
        <h3 className="text-sm font-medium text-[#888]">Agent Files ({files.length})</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-xs bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-3 py-1 rounded font-medium transition"
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
          <button
            onClick={fetchFiles}
            className="text-xs text-[#666] hover:text-[#888]"
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
        <div className="mb-4 border-2 border-dashed border-[#f97316] rounded-lg p-8 text-center">
          <p className="text-[#f97316]">Drop file to upload</p>
        </div>
      )}

      {files.length === 0 && !dragOver && (
        <div className="text-center py-10 text-[#666]">
          <p>No files stored yet</p>
          <p className="text-sm mt-1">Drop files here, click Upload, or attach files in Chat</p>
          {agent.features?.memory && (
            <p className="text-xs mt-2 text-[#555]">Files will be auto-ingested into memory</p>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map(file => (
            <div key={file.id} className="bg-[#111] border border-[#1a1a1a] rounded p-3 flex items-center gap-3">
              <div className="w-10 h-10 bg-[#1a1a1a] rounded flex items-center justify-center text-[#666]">
                {getFileIcon(file.mime_type)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#e0e0e0] truncate">{file.filename}</p>
                <p className="text-xs text-[#666]">
                  {formatSize(file.size_bytes)} • {new Date(file.created_at).toLocaleString()}
                  {file.source && file.source !== "upload" && ` • ${file.source}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => downloadFile(file.id, file.filename)}
                  className="text-xs text-[#666] hover:text-[#f97316] px-2 py-1"
                >
                  ↓
                </button>
                <button
                  onClick={() => deleteFile(file.id)}
                  className="text-[#666] hover:text-red-400 text-sm"
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
  const [showApiKey, setShowApiKey] = useState(false);
  const [subscriptions, setSubscriptions] = useState<{ id: string; trigger_slug: string; enabled: boolean }[]>([]);

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

  // Fetch API key (dev mode only)
  useEffect(() => {
    if (!isDev) return;
    const fetchApiKey = async () => {
      try {
        const res = await authFetch(`/api/agents/${agent.id}/api-key`);
        if (res.ok) {
          const data = await res.json();
          setApiKey(data.apiKey);
        }
      } catch (e) {
        // Ignore - not critical
      }
    };
    fetchApiKey();
  }, [agent.id, isDev, authFetch]);

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
      const current = prev => {
        const agentConfig = getMultiAgentConfig(prev.features, agent.projectId);
        return agentConfig.enabled;
      };
      setForm(prev => {
        const isEnabled = typeof prev.features.agents === "boolean"
          ? prev.features.agents
          : (prev.features.agents as MultiAgentConfig)?.enabled ?? false;
        if (isEnabled) {
          // Turning off - set to false
          return { ...prev, features: { ...prev.features, agents: false } };
        } else {
          // Turning on - set to config with defaults
          return {
            ...prev,
            features: {
              ...prev.features,
              agents: { enabled: true, mode: "worker" as AgentMode, group: agent.projectId || undefined },
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

  // Set multi-agent mode
  const setAgentMode = (mode: AgentMode) => {
    setForm(prev => {
      const currentConfig = getMultiAgentConfig(prev.features, agent.projectId);
      return {
        ...prev,
        features: {
          ...prev.features,
          agents: { ...currentConfig, enabled: true, mode },
        },
      };
    });
  };

  // Helper to check if agents feature is enabled
  const isAgentsEnabled = () => {
    const agentsVal = form.features.agents;
    if (typeof agentsVal === "boolean") return agentsVal;
    return (agentsVal as MultiAgentConfig)?.enabled ?? false;
  };

  // Get current agent mode
  const getAgentMode = (): AgentMode => {
    const config = getMultiAgentConfig(form.features, agent.projectId);
    return config.mode || "worker";
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
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
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
            className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
          />
        </FormField>

        <FormField label="Features">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => {
              // For agents feature, check the enabled property of the config
              const isEnabled = key === "agents" ? isAgentsEnabled() : !!form.features[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleFeature(key)}
                  className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                    isEnabled
                      ? "border-[#f97316] bg-[#f97316]/10"
                      : "border-[#222] hover:border-[#333]"
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isEnabled ? "text-[#f97316]" : "text-[#666]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${isEnabled ? "text-[#f97316]" : ""}`}>
                      {label}
                    </div>
                    <div className="text-xs text-[#666]">{description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </FormField>

        {/* Multi-Agent Mode Selection - shown when agents is enabled */}
        {isAgentsEnabled() && (
          <FormField label="Multi-Agent Mode">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAgentMode("coordinator")}
                className={`flex-1 p-3 rounded border text-left transition ${
                  getAgentMode() === "coordinator"
                    ? "border-[#f97316] bg-[#f97316]/10"
                    : "border-[#222] hover:border-[#333]"
                }`}
              >
                <div className={`text-sm font-medium ${getAgentMode() === "coordinator" ? "text-[#f97316]" : ""}`}>
                  Coordinator
                </div>
                <div className="text-xs text-[#666]">Orchestrates and delegates to other agents</div>
              </button>
              <button
                type="button"
                onClick={() => setAgentMode("worker")}
                className={`flex-1 p-3 rounded border text-left transition ${
                  getAgentMode() === "worker"
                    ? "border-[#f97316] bg-[#f97316]/10"
                    : "border-[#222] hover:border-[#333]"
                }`}
              >
                <div className={`text-sm font-medium ${getAgentMode() === "worker" ? "text-[#f97316]" : ""}`}>
                  Worker
                </div>
                <div className="text-xs text-[#666]">Receives tasks from coordinators</div>
              </button>
            </div>
            {agent.projectId && (
              <p className="text-xs text-[#555] mt-2">
                Group: Using project as agent group
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
                  ? "border-[#f97316] bg-[#f97316]/10 text-[#f97316]"
                  : "border-[#222] hover:border-[#333] text-[#888]"
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
                  ? "border-[#f97316] bg-[#f97316]/10 text-[#f97316]"
                  : "border-[#222] hover:border-[#333] text-[#888]"
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
              <span className="text-sm">Web Fetch</span>
            </button>
          </div>
          <p className="text-xs text-[#555] mt-2">
            Provider-native tools for real-time web access
          </p>
        </FormField>
        )}

        {/* MCP Server Selection - shown when MCP is enabled */}
        {form.features.mcp && (
          <FormField label="MCP Servers">
            {availableMcpServers.length === 0 ? (
              <p className="text-sm text-[#666]">
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
                          ? "border-[#f97316] bg-[#f97316]/10"
                          : "border-[#222] hover:border-[#333]"
                      }`}
                    >
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        isAvailable ? "bg-green-400" : "bg-[#444]"
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-medium ${form.mcpServers.includes(server.id) ? "text-[#f97316]" : ""}`}>
                            {server.name}
                          </span>
                          {server.project_id === null && (
                            <span className="text-[10px] text-[#666] bg-[#1a1a1a] px-1.5 py-0.5 rounded">Global</span>
                          )}
                        </div>
                        <div className="text-xs text-[#666]">{serverInfo}</div>
                      </div>
                      <div className={`text-xs px-2 py-0.5 rounded ${
                        isAvailable
                          ? "bg-green-500/20 text-green-400"
                          : "bg-[#222] text-[#666]"
                      }`}>
                        {isRemote ? "remote" : server.status}
                      </div>
                    </button>
                  );
                })}
                <p className="text-xs text-[#666] mt-2">
                  Remote servers are always available. Local servers must be running.
                </p>
              </div>
            )}
          </FormField>
        )}

        {/* Skills Selection */}
        <FormField label="Skills">
          {availableSkills.length === 0 ? (
            <p className="text-sm text-[#666]">
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
                      ? "border-[#f97316] bg-[#f97316]/10"
                      : "border-[#222] hover:border-[#333]"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${form.skills.includes(skill.id) ? "text-[#f97316]" : ""}`}>
                        {skill.name}
                      </span>
                      {skill.project_id === null && (
                        <span className="text-[10px] text-[#666] bg-[#1a1a1a] px-1.5 py-0.5 rounded">Global</span>
                      )}
                    </div>
                    <div className="text-xs text-[#666]">{skill.description}</div>
                  </div>
                  <div className="text-xs px-2 py-0.5 rounded bg-[#222] text-[#666]">
                    v{skill.version}
                  </div>
                </button>
              ))}
              <p className="text-xs text-[#666] mt-2">
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
          className="w-full bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>

        {agent.status === "running" && hasChanges && (
          <p className="text-xs text-[#666] text-center">
            Changes will be applied to the running agent
          </p>
        )}

        {/* Subscriptions */}
        <div className="mt-8 pt-6 border-t border-[#222]">
          <p className="text-sm text-[#666] mb-3">Subscriptions</p>
          {subscriptions.length === 0 ? (
            <p className="text-xs text-[#555]">No subscriptions. Set up triggers in Connections to have this agent listen to external events.</p>
          ) : (
            <div className="space-y-2">
              {subscriptions.map(sub => (
                <div key={sub.id} className="flex items-center gap-2 px-3 py-2 bg-[#111] rounded border border-[#1a1a1a]">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${sub.enabled ? "bg-cyan-400" : "bg-[#444]"}`} />
                  <span className={`text-sm flex-1 ${sub.enabled ? "text-cyan-400" : "text-[#666]"}`}>
                    {sub.trigger_slug.replace(/_/g, " ")}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${sub.enabled ? "bg-cyan-500/10 text-cyan-400" : "bg-[#222] text-[#555]"}`}>
                    {sub.enabled ? "active" : "disabled"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Developer Info (dev mode only) */}
        {isDev && apiKey && (
          <div className="mt-8 pt-6 border-t border-[#222]">
            <p className="text-sm text-[#666] mb-3">Developer Info</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#666]">Agent ID</span>
                <code className="text-xs bg-[#1a1a1a] px-2 py-1 rounded text-[#888]">{agent.id}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#666]">Port</span>
                <code className="text-xs bg-[#1a1a1a] px-2 py-1 rounded text-[#888]">{agent.port || "N/A"}</code>
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#666]">API Key</span>
                  <button
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="text-xs text-[#f97316] hover:text-[#fb923c]"
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
                {showApiKey && (
                  <code className="text-xs bg-[#1a1a1a] px-2 py-1 rounded text-[#888] break-all">
                    {apiKey}
                  </code>
                )}
              </div>
              {agent.status === "running" && agent.port && (
                <div className="flex flex-col gap-1 mt-2">
                  <span className="text-xs text-[#666]">Test with curl</span>
                  <code className="text-xs bg-[#1a1a1a] px-2 py-1.5 rounded text-[#666] break-all">
                    curl -H "X-API-Key: {showApiKey ? apiKey : "***"}" http://localhost:{agent.port}/config
                  </code>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Danger Zone */}
        <div className="mt-8 pt-6 border-t border-[#222]">
          <p className="text-sm text-[#666] mb-3">Danger Zone</p>
          {confirmDelete ? (
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 border border-[#333] hover:border-[#444] px-4 py-2 rounded font-medium transition"
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
      <label className="block text-sm text-[#666] mb-1">{label}</label>
      {children}
    </div>
  );
}
