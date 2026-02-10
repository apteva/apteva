import { useState, useEffect, useCallback } from "react";
import type { Agent, AgentFeatures } from "../types";
import { useAuth } from "../context";
import { useAgentStatusChange } from "../context/TelemetryContext";

export function useAgents(enabled: boolean) {
  const { accessToken } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const getHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }, [accessToken]);

  const fetchAgents = useCallback(async () => {
    const res = await fetch("/api/agents", { headers: getHeaders() });
    const data = await res.json();
    setAgents(data.agents || []);
    setLoading(false);
  }, [getHeaders]);

  // Fetch on mount + auto-refetch when agents start/stop/crash (via SSE telemetry)
  const statusChangeCounter = useAgentStatusChange();
  useEffect(() => {
    if (enabled) {
      fetchAgents();
    }
  }, [enabled, statusChangeCounter, fetchAgents]);

  const createAgent = async (agent: {
    name: string;
    model: string;
    provider: string;
    systemPrompt: string;
    features: AgentFeatures;
    mcpServers?: string[];
    projectId?: string | null;
  }) => {
    await fetch("/api/agents", {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(agent),
    });
    await fetchAgents();
  };

  const deleteAgent = async (id: string) => {
    await fetch(`/api/agents/${id}`, { method: "DELETE", headers: getHeaders() });
    await fetchAgents();
  };

  const updateAgent = async (id: string, updates: {
    name?: string;
    model?: string;
    provider?: string;
    systemPrompt?: string;
    features?: AgentFeatures;
    mcpServers?: string[];
    projectId?: string | null;
  }): Promise<{ error?: string }> => {
    const res = await fetch(`/api/agents/${id}`, {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    await fetchAgents();
    if (!res.ok && data.error) {
      return { error: data.error };
    }
    return {};
  };

  const toggleAgent = async (agent: Agent): Promise<{ error?: string }> => {
    const action = agent.status === "running" ? "stop" : "start";

    // Optimistic UI update — show transitioning state immediately
    setAgents(prev => prev.map(a =>
      a.id === agent.id ? { ...a, status: action === "start" ? "starting" as any : "stopping" as any } : a
    ));

    // Fire API call — telemetry SSE will trigger a refetch with the real status
    const res = await fetch(`/api/agents/${agent.id}/${action}`, { method: "POST", headers: getHeaders() });
    if (!res.ok) {
      const data = await res.json();
      // Revert on error
      setAgents(prev => prev.map(a =>
        a.id === agent.id ? { ...a, status: agent.status } : a
      ));
      return { error: data.error };
    }
    return {};
  };

  const runningCount = agents.filter(a => a.status === "running").length;

  return {
    agents,
    loading,
    runningCount,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgent,
  };
}
