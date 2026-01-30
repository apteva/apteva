import { useState, useEffect, useCallback } from "react";
import type { Agent, AgentFeatures } from "../types";

export function useAgents(enabled: boolean) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    const res = await fetch("/api/agents");
    const data = await res.json();
    setAgents(data.agents || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled) {
      fetchAgents();
    }
  }, [enabled, fetchAgents]);

  const createAgent = async (agent: {
    name: string;
    model: string;
    provider: string;
    systemPrompt: string;
    features: AgentFeatures;
  }) => {
    await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent),
    });
    await fetchAgents();
  };

  const deleteAgent = async (id: string) => {
    await fetch(`/api/agents/${id}`, { method: "DELETE" });
    await fetchAgents();
  };

  const toggleAgent = async (agent: Agent): Promise<{ error?: string }> => {
    const action = agent.status === "running" ? "stop" : "start";
    const res = await fetch(`/api/agents/${agent.id}/${action}`, { method: "POST" });
    const data = await res.json();
    await fetchAgents();
    if (!res.ok && data.error) {
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
    deleteAgent,
    toggleAgent,
  };
}
