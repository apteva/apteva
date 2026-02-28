import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Chat, convertApiMessages } from "@apteva/apteva-kit";
import { useAgentActivity, useAuth, useProjects, useTelemetryContext, useTheme } from "../../context";
import type { TelemetryEvent } from "../../context";
import type { Agent, Route } from "../../types";

interface Thread {
  id: string;
  title?: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  agent_id: string;
  agent_name: string;
}

interface ThreadsPageProps {
  agents: Agent[];
  onNavigate?: (route: Route) => void;
}

export function ThreadsPage({ agents, onNavigate }: ThreadsPageProps) {
  const { theme } = useTheme();
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const { events: realtimeEvents, statusChangeCounter } = useTelemetryContext();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [newChatAgent, setNewChatAgent] = useState<Agent | null>(null);
  const [initialMessages, setInitialMessages] = useState<any[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [historicalActivities, setHistoricalActivities] = useState<TelemetryEvent[]>([]);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [newChatKey, setNewChatKey] = useState(0);

  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) return agents;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  const runningAgents = useMemo(() => filteredAgents.filter(a => a.status === "running"), [filteredAgents]);
  const agentIds = useMemo(() => new Set(filteredAgents.map(a => a.id)), [filteredAgents]);

  // Fetch consolidated threads
  const fetchThreads = useCallback(async () => {
    try {
      const projectParam = currentProjectId ? `?project_id=${encodeURIComponent(currentProjectId)}` : "";
      const [threadsRes, activityRes] = await Promise.all([
        authFetch(`/api/threads${projectParam}`).catch(() => null),
        authFetch(`/api/telemetry/events?type=thread_activity&limit=100${projectParam ? `&${projectParam}` : ""}`).catch(() => null),
      ]);
      if (threadsRes?.ok) {
        const data = await threadsRes.json();
        setThreads(data.threads || []);
      }
      if (activityRes?.ok) {
        const data = await activityRes.json();
        setHistoricalActivities(data.events || []);
      }
    } catch (e) {
      console.error("Failed to fetch threads:", e);
    } finally {
      setLoadingThreads(false);
    }
  }, [authFetch, currentProjectId]);

  useEffect(() => { fetchThreads(); }, [fetchThreads, statusChangeCounter]);

  useEffect(() => {
    const interval = setInterval(fetchThreads, 15000);
    return () => clearInterval(interval);
  }, [fetchThreads]);

  // Open an existing thread
  const openThread = useCallback(async (thread: Thread) => {
    setNewChatAgent(null);
    setLoadingMessages(true);
    setSelectedThread(thread);
    try {
      const res = await authFetch(`/api/agents/${thread.agent_id}/threads/${thread.id}/messages`);
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
  }, [authFetch]);

  // Start a new conversation with an agent
  const startNewChat = (agent: Agent) => {
    setSelectedThread(null);
    setInitialMessages([]);
    setNewChatAgent(agent);
    setNewChatKey(k => k + 1);
    setShowAgentPicker(false);
  };

  // Merge real-time + historical activity
  const activities = useMemo(() => {
    const realtimeThreadEvents = realtimeEvents.filter(e => e.type === "thread_activity" && !e.data?.parent_id);
    const seen = new Set(realtimeThreadEvents.map(e => e.id));
    const merged = [...realtimeThreadEvents];
    for (const evt of historicalActivities) {
      if (!seen.has(evt.id) && !evt.data?.parent_id) { merged.push(evt); seen.add(evt.id); }
    }
    return merged
      .filter(e => agentIds.has(e.agent_id))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 100);
  }, [realtimeEvents, historicalActivities, agentIds]);

  // Group activities by thread_id
  const activityByThread = useMemo(() => {
    const map = new Map<string, TelemetryEvent[]>();
    for (const evt of activities) {
      const tid = evt.thread_id || evt.data?.thread_id as string;
      if (tid) {
        if (!map.has(tid)) map.set(tid, []);
        map.get(tid)!.push(evt);
      }
    }
    return map;
  }, [activities]);

  const runningCount = runningAgents.length;

  // What's currently shown in chat
  const chatAgentId = selectedThread?.agent_id || newChatAgent?.id;
  const chatAgentName = selectedThread?.agent_name || newChatAgent?.name;
  const chatThreadId = selectedThread?.id;
  const chatKey = selectedThread
    ? `${selectedThread.agent_id}-${selectedThread.id}`
    : newChatAgent
      ? `new-${newChatAgent.id}-${newChatKey}`
      : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Threads</h1>
          <span className="text-sm text-[var(--color-text-muted)]">
            {threads.length} threads from {runningCount} running agents
          </span>
        </div>
      </div>

      {/* Messenger layout: 1/4 threads | 3/4 chat */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Thread list — 1/4 */}
        <div className="w-1/4 min-w-[260px] max-w-[360px] flex flex-col overflow-hidden">
          {/* New conversation button */}
          <div className="p-2 shrink-0">
            <div className="relative">
              <button
                onClick={() => setShowAgentPicker(!showAgentPicker)}
                disabled={runningAgents.length === 0}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 btn bg-[var(--color-accent-10)] text-[var(--color-accent)] text-sm font-medium hover:bg-[var(--color-accent-20)] transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New conversation
              </button>

              {/* Agent picker dropdown */}
              {showAgentPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAgentPicker(false)} />
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--color-surface)] card shadow-xl z-50 max-h-60 overflow-auto">
                    {runningAgents.map(agent => (
                      <button
                        key={agent.id}
                        onClick={() => startNewChat(agent)}
                        className="w-full text-left px-3 py-2.5 hover:bg-[var(--color-surface-raised)] transition"
                      >
                        <p className="text-sm font-medium truncate">{agent.name}</p>
                        <p className="text-[10px] text-[var(--color-text-faint)]">{agent.provider} · {agent.model}</p>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-auto px-2 pb-2">
            {loadingThreads ? (
              <div className="p-6 text-center text-[var(--color-text-faint)] text-sm">Loading threads...</div>
            ) : threads.length === 0 ? (
              <div className="p-6 text-center text-[var(--color-text-faint)] text-sm">
                <p>No threads yet</p>
                <p className="mt-1 text-[var(--color-text-faint)]">Start a conversation or wait for agents</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {threads.map(thread => (
                  <ThreadRow
                    key={`${thread.agent_id}-${thread.id}`}
                    thread={thread}
                    selected={selectedThread?.id === thread.id && selectedThread?.agent_id === thread.agent_id}
                    activities={activityByThread.get(thread.id) || []}
                    onSelect={() => openThread(thread)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Chat — 3/4 */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {chatAgentId && chatKey ? (
            loadingMessages ? (
              <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">Loading messages...</div>
            ) : (
              <Chat
                key={chatKey}
                agentId="default"
                apiUrl={`/api/agents/${chatAgentId}`}
                threadId={chatThreadId}
                initialMessages={initialMessages}
                placeholder={`Message ${chatAgentName}...`}
                headerTitle={chatAgentName}
                variant="terminal"
                theme={theme.id as "light" | "dark"}
                showHeader={true}
              />
            )
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-[var(--color-text-faint)]">
                <svg className="w-12 h-12 mx-auto mb-3 text-[var(--color-border-light)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm">Select a thread or start a new conversation</p>
                <p className="text-xs text-[var(--color-text-faint)] mt-1">Chat with any running agent</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Thread Row ---

function ThreadRow({ thread, selected, activities, onSelect }: {
  thread: Thread;
  selected: boolean;
  activities: TelemetryEvent[];
  onSelect: () => void;
}) {
  const { isActive } = useAgentActivity(thread.agent_id);
  const latestActivity = activities[0];
  const activityText = latestActivity?.data?.activity as string | undefined;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition ${
        selected
          ? "bg-[var(--color-accent-10)]"
          : "hover:bg-[var(--color-bg-secondary)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm font-medium truncate">
          {thread.title || `Thread ${thread.id.slice(0, 8)}`}
        </span>
        <span className="text-[10px] text-[var(--color-text-faint)] shrink-0">{timeAgo(thread.updated_at)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isActive ? "bg-green-400 animate-pulse" : "bg-[var(--color-scrollbar)]"
          }`}
        />
        <span className="text-[11px] text-[var(--color-accent)]">{thread.agent_name}</span>
        {thread.message_count != null && (
          <>
            <span className="text-[var(--color-border-light)]">&middot;</span>
            <span className="text-[10px] text-[var(--color-text-faint)]">{thread.message_count} msgs</span>
          </>
        )}
      </div>
      {activityText && (
        <p className="text-[11px] text-[var(--color-text-faint)] truncate mt-1">{activityText}</p>
      )}
    </button>
  );
}

// --- Helpers ---

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
