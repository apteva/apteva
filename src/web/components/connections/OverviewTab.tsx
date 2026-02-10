import React, { useState, useEffect } from "react";
import { useAuth, useProjects } from "../../context";

interface Subscription {
  id: string;
  trigger_slug: string;
  trigger_instance_id: string | null;
  agent_id: string;
  enabled: boolean;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TriggerInstance {
  id: string;
  trigger_slug: string;
  connected_account_id: string | null;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
  status: string;
}

export function OverviewTab() {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [triggers, setTriggers] = useState<TriggerInstance[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      const projectParam = currentProjectId && currentProjectId !== "unassigned" ? `?project_id=${currentProjectId}` : "";

      try {
        const [subsRes, triggersRes, agentsRes] = await Promise.all([
          authFetch(`/api/subscriptions${projectParam}`).catch(() => null),
          authFetch(`/api/triggers${projectParam}`).catch(() => null),
          authFetch(`/api/agents`).catch(() => null),
        ]);

        if (subsRes?.ok) {
          const data = await subsRes.json();
          setSubscriptions(data.subscriptions || []);
        }
        if (triggersRes?.ok) {
          const data = await triggersRes.json();
          setTriggers(data.triggers || []);
        }
        if (agentsRes?.ok) {
          const data = await agentsRes.json();
          setAgents(data.agents || []);
        }
      } catch (e) {
        console.error("Failed to fetch overview data:", e);
      }
      setLoading(false);
    };

    fetchAll();
  }, [authFetch, currentProjectId]);

  if (loading) {
    return <div className="text-center py-12 text-[#666]">Loading...</div>;
  }

  const activeTriggers = triggers.filter(t => t.status === "active");
  const enabledSubscriptions = subscriptions.filter(s => s.enabled);
  const agentMap = new Map(agents.map(a => [a.id, a]));

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Subscriptions" value={enabledSubscriptions.length} />
        <StatCard label="Active Triggers" value={activeTriggers.length} />
        <StatCard label="Total Triggers" value={triggers.length} />
      </div>

      {/* Active Subscriptions */}
      <section>
        <h3 className="text-sm font-medium text-[#888] mb-3">Active Subscriptions ({enabledSubscriptions.length})</h3>
        {enabledSubscriptions.length === 0 ? (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center text-[#666] text-sm">
            No subscriptions. Go to the Triggers tab to route trigger events to agents.
          </div>
        ) : (
          <div className="space-y-2">
            {enabledSubscriptions.map(sub => {
              const agent = agentMap.get(sub.agent_id);
              return (
                <div key={sub.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {sub.trigger_slug.replace(/_/g, " ")}
                    </div>
                    <div className="text-xs text-[#666]">
                      {sub.trigger_instance_id
                        ? `Instance: ${sub.trigger_instance_id.slice(0, 12)}...`
                        : "All instances"
                      }
                    </div>
                  </div>
                  <div className="text-xs text-[#888] flex-shrink-0">
                    <span className="text-[#555]">&rarr;</span>{" "}
                    <span className="text-[#f97316]">{agent?.name || "Unknown Agent"}</span>
                  </div>
                  {agent && (
                    <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                      agent.status === "running"
                        ? "bg-green-500/10 text-green-400"
                        : "bg-yellow-500/10 text-yellow-400"
                    }`}>
                      {agent.status}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Active Triggers */}
      <section>
        <h3 className="text-sm font-medium text-[#888] mb-3">Active Triggers ({activeTriggers.length})</h3>
        {activeTriggers.length === 0 ? (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center text-[#666] text-sm">
            No active triggers on Composio.
          </div>
        ) : (
          <div className="space-y-2">
            {activeTriggers.map(trigger => (
              <div key={trigger.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {trigger.trigger_slug.replace(/_/g, " ")}
                  </div>
                  <div className="text-xs text-[#666]">
                    ID: {trigger.id.slice(0, 8)}...
                  </div>
                </div>
                <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded">
                  active
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string | number;
  valueColor?: string;
}) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4">
      <div className="text-xs text-[#666] mb-1">{label}</div>
      <div className={`text-2xl font-bold ${valueColor || "text-[#e0e0e0]"}`}>
        {value}
      </div>
    </div>
  );
}
