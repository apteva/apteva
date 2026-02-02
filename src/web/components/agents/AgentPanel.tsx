import React, { useState, useEffect } from "react";
import { Chat } from "@apteva/apteva-kit";
import { CloseIcon, MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, FilesIcon, MultiAgentIcon } from "../common/Icons";
import { Select } from "../common/Select";
import { useConfirm } from "../common/Modal";
import { useAuth } from "../../context";
import type { Agent, Provider, AgentFeatures, McpServer } from "../../types";

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
  const [messages, setMessages] = useState<Array<{ role: string; content: string; created_at: string }>>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();

  // Reset state when agent changes
  useEffect(() => {
    setThreads([]);
    setSelectedThread(null);
    setMessages([]);
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

  const loadMessages = async (threadId: string) => {
    setSelectedThread(threadId);
    setLoadingMessages(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/threads/${threadId}/messages`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      const data = await res.json();
      setMessages(data.messages || []);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
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
        setMessages([]);
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

  // Show messages view when a thread is selected
  if (selectedThread) {
    const selectedThreadData = threads.find(t => t.id === selectedThread);
    return (
      <>
      {ConfirmDialog}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header with back button */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1a1a1a]">
          <button
            onClick={() => { setSelectedThread(null); setMessages([]); }}
            className="text-[#666] hover:text-[#e0e0e0] transition text-lg"
          >
            ←
          </button>
          <div className="flex-1">
            <p className="text-sm font-medium">
              {selectedThreadData?.title || `Thread ${selectedThread.slice(0, 8)}`}
            </p>
            <p className="text-xs text-[#666]">
              {selectedThreadData && new Date(selectedThreadData.updated_at || selectedThreadData.created_at).toLocaleString()}
            </p>
          </div>
          <button
            onClick={(e) => deleteThread(selectedThread, e)}
            className="text-[#666] hover:text-red-400 text-sm px-2 py-1"
          >
            Delete
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto p-4">
          {loadingMessages ? (
            <p className="text-[#666]">Loading messages...</p>
          ) : messages.length === 0 ? (
            <p className="text-[#666]">No messages in this thread</p>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, i) => (
                <div key={i} className={`${msg.role === "user" ? "text-right" : ""}`}>
                  <div
                    className={`inline-block max-w-[80%] p-3 rounded ${
                      msg.role === "user"
                        ? "bg-[#f97316]/20 text-[#f97316]"
                        : "bg-[#1a1a1a] text-[#e0e0e0]"
                    }`}
                  >
                    <div className="text-sm whitespace-pre-wrap">
                      {typeof msg.content === "string"
                        ? msg.content
                        : Array.isArray(msg.content)
                          ? msg.content.map((block: any, j: number) => (
                              <div key={j}>
                                {block.type === "text" && block.text}
                                {block.type === "tool_use" && (
                                  <div className="bg-[#222] p-2 rounded mt-1 text-xs text-[#888]">
                                    🔧 Tool: {block.name}
                                  </div>
                                )}
                                {block.type === "tool_result" && (
                                  <div className="bg-[#222] p-2 rounded mt-1 text-xs text-[#888]">
                                    📋 Result: {typeof block.content === "string" ? block.content.slice(0, 200) : "..."}
                                  </div>
                                )}
                              </div>
                            ))
                          : JSON.stringify(msg.content)
                      }
                    </div>
                    <p className="text-xs text-[#666] mt-1">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
              onClick={() => loadMessages(thread.id)}
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

interface Task {
  id: string;
  name: string;
  description?: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at?: string;
  scheduled_at?: string;
  completed_at?: string;
  result?: string;
  error?: string;
}

function TasksTab({ agent }: { agent: Agent }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "running" | "completed">("all");

  // Reset state when agent changes
  useEffect(() => {
    setTasks([]);
    setError(null);
    setLoading(true);
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

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [agent.id, agent.status, filter]);

  // Auto-refresh every 5 seconds when agent is running
  useEffect(() => {
    if (agent.status !== "running") return;
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [agent.id, agent.status, filter]);

  const getStatusColor = (status: Task["status"]) => {
    switch (status) {
      case "pending": return "bg-yellow-500/20 text-yellow-400";
      case "running": return "bg-blue-500/20 text-blue-400";
      case "completed": return "bg-green-500/20 text-green-400";
      case "failed": return "bg-red-500/20 text-red-400";
      default: return "bg-[#222] text-[#666]";
    }
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

  return (
    <div className="flex-1 overflow-auto p-4">
      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {(["all", "pending", "running", "completed"] as const).map(status => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`px-3 py-1 text-xs rounded transition ${
              filter === status
                ? "bg-[#f97316] text-black"
                : "bg-[#1a1a1a] text-[#666] hover:text-[#888]"
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <div className="text-center py-10 text-[#666]">
          <p>No {filter === "all" ? "" : filter + " "}tasks</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(task => (
            <div key={task.id} className="bg-[#111] border border-[#1a1a1a] rounded p-3">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#e0e0e0]">{task.name}</p>
                  {task.description && (
                    <p className="text-xs text-[#666] mt-1 line-clamp-2">{task.description}</p>
                  )}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ml-2 ${getStatusColor(task.status)}`}>
                  {task.status}
                </span>
              </div>

              <div className="flex items-center gap-4 mt-2 text-xs text-[#666]">
                <span>Created: {new Date(task.created_at).toLocaleString()}</span>
                {task.scheduled_at && (
                  <span>Scheduled: {new Date(task.scheduled_at).toLocaleString()}</span>
                )}
              </div>

              {task.status === "completed" && task.result && (
                <div className="mt-2 p-2 bg-[#0a0a0a] rounded text-xs text-[#888]">
                  <p className="text-[#666] mb-1">Result:</p>
                  <p className="whitespace-pre-wrap">{task.result}</p>
                </div>
              )}

              {task.status === "failed" && task.error && (
                <div className="mt-2 p-2 bg-red-500/10 rounded text-xs text-red-400">
                  <p className="text-red-400/70 mb-1">Error:</p>
                  <p className="whitespace-pre-wrap">{task.error}</p>
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
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-[#888]">Agent Files ({files.length})</h3>
        <button
          onClick={fetchFiles}
          className="text-xs text-[#666] hover:text-[#888]"
        >
          Refresh
        </button>
      </div>

      {files.length === 0 ? (
        <div className="text-center py-10 text-[#666]">
          <p>No files stored yet</p>
          <p className="text-sm mt-1">Files created or uploaded by the agent will appear here</p>
        </div>
      ) : (
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

function SettingsTab({ agent, providers, onUpdateAgent, onDeleteAgent }: {
  agent: Agent;
  providers: Provider[];
  onUpdateAgent: (updates: Partial<Agent>) => Promise<{ error?: string }>;
  onDeleteAgent: () => void;
}) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState({
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    features: { ...agent.features },
    mcpServers: [...(agent.mcpServers || [])],
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [availableMcpServers, setAvailableMcpServers] = useState<McpServer[]>([]);

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

  // Reset form when agent changes
  useEffect(() => {
    setForm({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      features: { ...agent.features },
      mcpServers: [...(agent.mcpServers || [])],
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
    setForm(prev => ({
      ...prev,
      features: { ...prev.features, [key]: !prev.features[key] },
    }));
  };

  const toggleMcpServer = (serverId: string) => {
    setForm(prev => ({
      ...prev,
      mcpServers: prev.mcpServers.includes(serverId)
        ? prev.mcpServers.filter(id => id !== serverId)
        : [...prev.mcpServers, serverId],
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
    JSON.stringify(form.mcpServers.sort()) !== JSON.stringify((agent.mcpServers || []).sort());

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
            {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => toggleFeature(key)}
                className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                  form.features[key]
                    ? "border-[#f97316] bg-[#f97316]/10"
                    : "border-[#222] hover:border-[#333]"
                }`}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${form.features[key] ? "text-[#f97316]" : "text-[#666]"}`} />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${form.features[key] ? "text-[#f97316]" : ""}`}>
                    {label}
                  </div>
                  <div className="text-xs text-[#666]">{description}</div>
                </div>
              </button>
            ))}
          </div>
        </FormField>

        {/* MCP Server Selection - shown when MCP is enabled */}
        {form.features.mcp && (
          <FormField label="MCP Servers">
            {availableMcpServers.length === 0 ? (
              <p className="text-sm text-[#666]">
                No MCP servers configured. Add servers in the MCP page first.
              </p>
            ) : (
              <div className="space-y-2">
                {availableMcpServers.map(server => {
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
                        <div className={`text-sm font-medium ${form.mcpServers.includes(server.id) ? "text-[#f97316]" : ""}`}>
                          {server.name}
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
