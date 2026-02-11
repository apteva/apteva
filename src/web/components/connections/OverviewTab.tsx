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

interface Agent {
  id: string;
  name: string;
  status: string;
}

export function OverviewTab() {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      const projectParam = currentProjectId && currentProjectId !== "unassigned" ? `?project_id=${currentProjectId}` : "";

      try {
        const [subsRes, agentsRes] = await Promise.all([
          authFetch(`/api/subscriptions${projectParam}`).catch(() => null),
          authFetch(`/api/agents`).catch(() => null),
        ]);

        if (subsRes?.ok) {
          const data = await subsRes.json();
          setSubscriptions(data.subscriptions || []);
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

  const enabledSubs = subscriptions.filter(s => s.enabled);
  const disabledSubs = subscriptions.filter(s => !s.enabled);
  const agentMap = new Map(agents.map(a => [a.id, a]));

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Active" value={enabledSubs.length} />
        <StatCard label="Disabled" value={disabledSubs.length} />
        <StatCard label="Total" value={subscriptions.length} />
      </div>

      {/* Subscriptions */}
      <section>
        <h3 className="text-sm font-medium text-[#888] mb-3">Subscriptions ({subscriptions.length})</h3>
        {subscriptions.length === 0 ? (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center text-[#666] text-sm">
            No subscriptions yet. Go to the Triggers tab to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {subscriptions.map(sub => {
              const agent = agentMap.get(sub.agent_id);
              return (
                <div key={sub.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sub.enabled ? "bg-green-400" : "bg-[#555]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {sub.trigger_slug.replace(/_/g, " ").replace(/-/g, " ")}
                    </div>
                    <div className="text-xs text-[#666]">
                      {sub.trigger_instance_id
                        ? `ID: ${sub.trigger_instance_id.slice(0, 12)}...`
                        : "All instances"
                      }
                    </div>
                  </div>
                  <div className="text-xs text-[#888] flex-shrink-0">
                    <span className="text-[#555]">&rarr;</span>{" "}
                    <span className="text-[#f97316]">{agent?.name || "Unknown Agent"}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                    sub.enabled
                      ? "bg-green-500/10 text-green-400"
                      : "bg-[#1a1a1a] text-[#555]"
                  }`}>
                    {sub.enabled ? "active" : "disabled"}
                  </span>
                </div>
              );
            })}
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
