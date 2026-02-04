import React, { useState, useEffect, createContext, useContext, type ReactNode } from "react";
import { Chat } from "@apteva/apteva-kit";
import { useAuth } from "../../context";

interface MetaAgentStatus {
  enabled: boolean;
  available?: boolean;
  reason?: string;
  agent?: {
    id: string;
    name: string;
    status: "stopped" | "running";
    port: number | null;
    provider: string;
    model: string;
  };
}

interface MetaAgentContextValue {
  status: MetaAgentStatus | null;
  isOpen: boolean;
  isStarting: boolean;
  error: string | null;
  isAvailable: boolean;
  isRunning: boolean;
  agent: MetaAgentStatus["agent"] | undefined;
  toggle: () => void;
  close: () => void;
  startAgent: () => Promise<void>;
}

const MetaAgentContext = createContext<MetaAgentContextValue | null>(null);

export function useMetaAgent() {
  return useContext(MetaAgentContext);
}

export function MetaAgentProvider({ children }: { children: ReactNode }) {
  const { authFetch, isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<MetaAgentStatus | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch meta agent status
  const fetchStatus = async () => {
    try {
      const res = await authFetch("/api/meta-agent/status");
      const data = await res.json();
      setStatus(data);
    } catch (e) {
      console.error("[MetaAgent] Failed to fetch status:", e);
    }
  };

  useEffect(() => {
    // Only fetch when authenticated
    if (!authLoading && isAuthenticated) {
      fetchStatus();
    }
  }, [authFetch, isAuthenticated, authLoading]);

  // Start the meta agent
  const startAgent = async () => {
    setIsStarting(true);
    setError(null);
    try {
      const res = await authFetch("/api/meta-agent/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to start assistant");
      } else {
        await fetchStatus();
      }
    } catch (e) {
      setError("Failed to start assistant");
    }
    setIsStarting(false);
  };

  const isAvailable = !!(status?.enabled && status?.available);
  const agent = status?.agent;
  const isRunning = !!(agent?.status === "running" && agent?.port);

  const value: MetaAgentContextValue = {
    status,
    isOpen,
    isStarting,
    error,
    isAvailable,
    isRunning,
    agent,
    toggle: () => setIsOpen(!isOpen),
    close: () => setIsOpen(false),
    startAgent,
  };

  return (
    <MetaAgentContext.Provider value={value}>
      {children}
    </MetaAgentContext.Provider>
  );
}

// Header button component - to be used in Header.tsx
export function MetaAgentButton() {
  const ctx = useMetaAgent();
  if (!ctx?.isAvailable) return null;

  return (
    <button
      onClick={ctx.toggle}
      className={`hidden md:flex items-center gap-2 px-3 py-2 rounded transition ${
        ctx.isOpen
          ? "bg-[#f97316] text-white"
          : "bg-[#151515] hover:bg-[#1a1a1a] text-[#888] hover:text-white"
      }`}
      title="Apteva Assistant"
    >
      <AssistantIcon className="w-5 h-5" />
      <span className="text-sm">Assistant</span>
      {ctx.isRunning && (
        <span className="w-2 h-2 rounded-full bg-green-400" />
      )}
    </button>
  );
}

// Chat panel component - renders as a right-side drawer
export function MetaAgentPanel() {
  const ctx = useMetaAgent();
  if (!ctx?.isAvailable || !ctx.isOpen) return null;

  const { agent, isRunning, error, isStarting, startAgent, close } = ctx;

  return (
    <>
      {/* Backdrop */}
      <div
        className="hidden md:block fixed inset-0 bg-black/20 z-40"
        onClick={close}
      />

      {/* Drawer Panel */}
      <div className="hidden md:flex fixed top-0 right-0 h-full w-[480px] lg:w-[540px] bg-[#0a0a0a] border-l border-[#1a1a1a] shadow-2xl z-50 flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a] bg-[#111]">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-green-400" : "bg-[#444]"}`} />
            <span className="font-medium text-sm">Apteva Assistant</span>
          </div>
          <button
            onClick={close}
            className="text-[#666] hover:text-[#888] transition"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 flex flex-col">
          {isRunning ? (
            <Chat
              agentId="default"
              apiUrl={`/api/agents/${agent!.id}`}
              placeholder="Ask me anything about Apteva..."
              variant="terminal"
              showHeader={false}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <AssistantIcon className="w-12 h-12 text-[#333] mb-4" />
              <h3 className="font-medium mb-2">Apteva Assistant</h3>
              <p className="text-sm text-[#666] mb-6">
                I can help you navigate Apteva, create agents, set up MCP servers, and more.
              </p>
              {error && (
                <p className="text-sm text-red-400 mb-4">{error}</p>
              )}
              <button
                onClick={startAgent}
                disabled={isStarting}
                className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-white px-6 py-2 rounded font-medium transition"
              >
                {isStarting ? "Starting..." : "Start Assistant"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AssistantIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}
