import React, { useState, useEffect, useCallback } from "react";
import { useAuth, useProjects } from "../../context";
import { Select } from "../common";

interface TriggerType {
  slug: string;
  name: string;
  description: string;
  type: "webhook" | "poll";
  toolkit_slug: string;
  toolkit_name: string;
  logo: string | null;
  config_schema: Record<string, unknown>;
  payload_schema: Record<string, unknown>;
}

interface TriggerInstance {
  id: string;
  trigger_slug: string;
  connected_account_id: string | null;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  created_at: string;
}

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

interface ConnectedAccount {
  id: string;
  appId: string;
  appName: string;
  status: string;
}

interface Agent {
  id: string;
  name: string;
  status: string;
  port: number | null;
}

interface TriggerProviderInfo {
  id: string;
  name: string;
  connected: boolean;
}

export function TriggersTab() {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();

  // Provider selection
  const [providers, setProviders] = useState<TriggerProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("composio");

  // Trigger instances (from selected provider)
  const [triggers, setTriggers] = useState<TriggerInstance[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(true);

  // Subscriptions (local routing)
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);

  // Browse trigger types
  const [triggerTypes, setTriggerTypes] = useState<TriggerType[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [toolkitFilter, setToolkitFilter] = useState("");
  const [typeSearch, setTypeSearch] = useState("");

  // Create trigger
  const [showCreate, setShowCreate] = useState(false);
  const [selectedType, setSelectedType] = useState<TriggerType | null>(null);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [creating, setCreating] = useState(false);

  // Add subscription
  const [showAddSub, setShowAddSub] = useState(false);
  const [subTriggerId, setSubTriggerId] = useState("");
  const [subAgentId, setSubAgentId] = useState("");
  const [addingSub, setAddingSub] = useState(false);

  // Agents
  const [agents, setAgents] = useState<Agent[]>([]);

  const [error, setError] = useState<string | null>(null);

  const projectParam = currentProjectId && currentProjectId !== "unassigned" ? `?project_id=${currentProjectId}` : "";

  // Fetch available providers
  const fetchProviders = useCallback(async () => {
    try {
      const res = await authFetch(`/api/triggers/providers`);
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
      }
    } catch (e) {
      console.error("Failed to fetch providers:", e);
    }
  }, [authFetch]);

  // Fetch active triggers
  const fetchTriggers = useCallback(async () => {
    setTriggersLoading(true);
    try {
      const providerParam = `provider=${selectedProvider}`;
      const sep = projectParam ? "&" : "?";
      const url = projectParam
        ? `/api/triggers${projectParam}&${providerParam}`
        : `/api/triggers?${providerParam}`;
      const res = await authFetch(url);
      if (res.ok) {
        const data = await res.json();
        setTriggers(data.triggers || []);
      }
    } catch (e) {
      console.error("Failed to fetch triggers:", e);
    }
    setTriggersLoading(false);
  }, [authFetch, projectParam, selectedProvider]);

  // Fetch subscriptions
  const fetchSubscriptions = useCallback(async () => {
    try {
      const res = await authFetch(`/api/subscriptions${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        setSubscriptions(data.subscriptions || []);
      }
    } catch (e) {
      console.error("Failed to fetch subscriptions:", e);
    }
  }, [authFetch, projectParam]);

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    try {
      const res = await authFetch(`/api/agents`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
      }
    } catch (e) {
      // Ignore
    }
  }, [authFetch]);

  useEffect(() => {
    fetchProviders();
    fetchTriggers();
    fetchSubscriptions();
    fetchAgents();
  }, [fetchProviders, fetchTriggers, fetchSubscriptions, fetchAgents]);

  // Browse trigger types
  const browseTriggerTypes = async (toolkit?: string) => {
    setTypesLoading(true);
    try {
      let url = `/api/triggers/types?provider=${selectedProvider}`;
      if (toolkit) url += `&toolkit_slugs=${toolkit}`;
      if (currentProjectId && currentProjectId !== "unassigned") url += `&project_id=${currentProjectId}`;
      const res = await authFetch(url);
      if (res.ok) {
        const data = await res.json();
        setTriggerTypes(data.types || []);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to fetch trigger types");
      }
    } catch (e) {
      setError("Failed to fetch trigger types");
    }
    setTypesLoading(false);
  };

  // Fetch connected accounts when creating
  const fetchConnectedAccounts = async () => {
    try {
      const res = await authFetch(`/api/integrations/${selectedProvider}/connected${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        setConnectedAccounts((data.accounts || []).filter((a: ConnectedAccount) => a.status === "active"));
      }
    } catch (e) {
      // Ignore
    }
  };

  // Start create flow
  const startCreate = (triggerType: TriggerType) => {
    setSelectedType(triggerType);
    setSelectedAccountId("");
    setShowCreate(true);
    fetchConnectedAccounts();
  };

  // Create trigger
  const handleCreate = async () => {
    if (!selectedType || !selectedAccountId) return;

    setCreating(true);
    setError(null);
    try {
      const providerParam = `provider=${selectedProvider}`;
      const sep = projectParam ? "&" : "?";
      const url = projectParam
        ? `/api/triggers${projectParam}&${providerParam}`
        : `/api/triggers?${providerParam}`;
      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: selectedType.slug,
          connectedAccountId: selectedAccountId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create trigger");
      } else {
        setShowCreate(false);
        setSelectedType(null);
        fetchTriggers();
      }
    } catch (e: any) {
      setError(e.message || "Failed to create trigger");
    }
    setCreating(false);
  };

  // Enable/disable trigger
  const toggleTrigger = async (triggerId: string, currentStatus: string) => {
    const action = currentStatus === "active" ? "disable" : "enable";
    try {
      const providerQ = projectParam ? `&provider=${selectedProvider}` : `?provider=${selectedProvider}`;
      const res = await authFetch(`/api/triggers/${triggerId}/${action}${projectParam}${providerQ}`, {
        method: "POST",
      });
      if (res.ok) {
        fetchTriggers();
      } else {
        const data = await res.json();
        setError(data.error || `Failed to ${action} trigger`);
      }
    } catch (e) {
      setError(`Failed to ${action} trigger`);
    }
  };

  // Delete trigger
  const deleteTrigger = async (triggerId: string) => {
    try {
      const providerQ = projectParam ? `&provider=${selectedProvider}` : `?provider=${selectedProvider}`;
      const res = await authFetch(`/api/triggers/${triggerId}${projectParam}${providerQ}`, {
        method: "DELETE",
      });
      if (res.ok) {
        fetchTriggers();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to delete trigger");
      }
    } catch (e) {
      setError("Failed to delete trigger");
    }
  };

  // Add subscription — backend auto-creates webhook if needed
  const handleAddSubscription = async () => {
    if (!subTriggerId || !subAgentId) return;

    // Find the trigger instance to get its slug
    const trigger = triggers.find(t => t.id === subTriggerId);
    if (!trigger) return;

    setAddingSub(true);
    setError(null);
    try {
      const res = await authFetch(`/api/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_slug: trigger.trigger_slug,
          trigger_instance_id: trigger.id,
          agent_id: subAgentId,
          provider: selectedProvider,
          project_id: currentProjectId && currentProjectId !== "unassigned" ? currentProjectId : null,
          public_url: window.location.origin,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create subscription");
      } else {
        setShowAddSub(false);
        setSubTriggerId("");
        setSubAgentId("");
        fetchSubscriptions();
      }
    } catch (e: any) {
      setError(e.message || "Failed to create subscription");
    }
    setAddingSub(false);
  };

  // Toggle subscription
  const toggleSubscription = async (sub: Subscription) => {
    const action = sub.enabled ? "disable" : "enable";
    try {
      const res = await authFetch(`/api/subscriptions/${sub.id}/${action}`, {
        method: "POST",
      });
      if (res.ok) fetchSubscriptions();
    } catch (e) {
      setError(`Failed to ${action} subscription`);
    }
  };

  // Delete subscription
  const deleteSubscription = async (id: string) => {
    try {
      const res = await authFetch(`/api/subscriptions/${id}`, {
        method: "DELETE",
      });
      if (res.ok) fetchSubscriptions();
    } catch (e) {
      setError("Failed to delete subscription");
    }
  };

  // Filter trigger types by search
  const filteredTypes = triggerTypes.filter(t => {
    if (!typeSearch) return true;
    const s = typeSearch.toLowerCase();
    return t.name.toLowerCase().includes(s) || t.slug.toLowerCase().includes(s) || t.description.toLowerCase().includes(s);
  });

  // Agent map for quick lookups
  const agentMap = new Map(agents.map(a => [a.id, a]));

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">x</button>
        </div>
      )}

      {/* Provider Selector */}
      {providers.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#666]">Provider:</span>
          <div className="flex gap-1 bg-[#111] border border-[#1a1a1a] rounded-lg p-0.5">
            {providers.map(p => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedProvider(p.id);
                  setTriggerTypes([]);
                  setToolkitFilter("");
                  setTypeSearch("");
                }}
                className={`px-3 py-1 rounded text-xs font-medium transition ${
                  selectedProvider === p.id
                    ? "bg-[#1a1a1a] text-white"
                    : "text-[#666] hover:text-[#888]"
                }`}
              >
                {p.name}
                {!p.connected && (
                  <span className="ml-1 text-[10px] text-yellow-500" title="API key not configured">!</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Subscriptions (trigger → agent routing) */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[#888]">
            Subscriptions ({subscriptions.length})
          </h3>
          <button
            onClick={() => setShowAddSub(true)}
            className="text-xs bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-3 py-1.5 rounded transition"
          >
            + Add Subscription
          </button>
        </div>

        {subscriptions.length === 0 ? (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center text-[#666] text-sm">
            No subscriptions yet. Add one to route trigger events to an agent.
          </div>
        ) : (
          <div className="space-y-2">
            {subscriptions.map(sub => {
              const agent = agentMap.get(sub.agent_id);
              return (
                <div key={sub.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sub.enabled ? "bg-green-400" : "bg-[#666]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {sub.trigger_slug.replace(/_/g, " ")}
                      <span className="text-[#555] mx-1.5">&rarr;</span>
                      <span className="text-[#f97316]">{agent?.name || "Unknown Agent"}</span>
                    </div>
                    <div className="text-xs text-[#666]">
                      {sub.trigger_instance_id
                        ? `Instance: ${sub.trigger_instance_id.slice(0, 12)}...`
                        : "All instances"
                      }
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => toggleSubscription(sub)}
                      className={`text-xs px-3 py-1 rounded transition ${
                        sub.enabled
                          ? "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                          : "bg-green-500/10 text-green-400 hover:bg-green-500/20"
                      }`}
                    >
                      {sub.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => deleteSubscription(sub.id)}
                      className="text-xs text-[#666] hover:text-red-400 transition px-2"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Trigger Instances */}
      <section>
        <h3 className="text-sm font-medium text-[#888] mb-3">
          Trigger Instances ({triggers.length})
        </h3>
        {triggersLoading ? (
          <div className="text-center py-6 text-[#666] text-sm">Loading triggers...</div>
        ) : triggers.length === 0 ? (
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6 text-center text-[#666] text-sm">
            No trigger instances. Browse trigger types below to create one.
          </div>
        ) : (
          <div className="space-y-2">
            {triggers.map(trigger => (
              <div key={trigger.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-3 flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${trigger.status === "active" ? "bg-green-400" : "bg-[#666]"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {trigger.trigger_slug.replace(/_/g, " ")}
                  </div>
                  <div className="text-xs text-[#666]">
                    ID: {trigger.id.slice(0, 12)}... | Created: {new Date(trigger.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => toggleTrigger(trigger.id, trigger.status)}
                    className={`text-xs px-3 py-1 rounded transition ${
                      trigger.status === "active"
                        ? "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                        : "bg-green-500/10 text-green-400 hover:bg-green-500/20"
                    }`}
                  >
                    {trigger.status === "active" ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => deleteTrigger(trigger.id)}
                    className="text-xs text-[#666] hover:text-red-400 transition px-2"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Browse Trigger Types */}
      <section>
        <h3 className="text-sm font-medium text-[#888] mb-3">Browse Trigger Types</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={toolkitFilter}
            onChange={(e) => setToolkitFilter(e.target.value)}
            placeholder="Toolkit filter (e.g. github, gmail, slack)"
            className="flex-1 bg-[#111] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#f97316]"
          />
          <button
            onClick={() => browseTriggerTypes(toolkitFilter || undefined)}
            disabled={typesLoading}
            className="text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-4 py-2 rounded transition disabled:opacity-50"
          >
            {typesLoading ? "Loading..." : "Browse"}
          </button>
        </div>

        {triggerTypes.length > 0 && (
          <>
            <input
              type="text"
              value={typeSearch}
              onChange={(e) => setTypeSearch(e.target.value)}
              placeholder="Search trigger types..."
              className="w-full bg-[#111] border border-[#333] rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-[#f97316]"
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTypes.slice(0, 30).map(tt => (
                <div key={tt.slug} className="bg-[#111] border border-[#1a1a1a] hover:border-[#333] rounded-lg p-3 transition">
                  <div className="flex items-start gap-3">
                    {tt.logo ? (
                      <img src={tt.logo} alt={tt.toolkit_name} className="w-8 h-8 rounded object-contain flex-shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-[#1a1a1a] flex items-center justify-center text-xs flex-shrink-0">
                        {tt.toolkit_name?.[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{tt.name}</div>
                      <div className="text-xs text-[#666]">{tt.toolkit_name}</div>
                      <div className="text-xs text-[#555] mt-1 line-clamp-2">{tt.description}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => startCreate(tt)}
                    className="w-full mt-3 text-xs bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-3 py-1.5 rounded transition"
                  >
                    Create Trigger
                  </button>
                </div>
              ))}
            </div>
            {filteredTypes.length > 30 && (
              <p className="text-xs text-[#555] mt-3 text-center">
                Showing first 30 of {filteredTypes.length} types. Use search to filter.
              </p>
            )}
          </>
        )}
      </section>

      {/* Create Trigger Modal */}
      {showCreate && selectedType && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="font-medium mb-1">Create Trigger</h3>
            <p className="text-xs text-[#666] mb-4">{selectedType.name}</p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#888] mb-1.5">Connected Account</label>
                {connectedAccounts.length === 0 ? (
                  <div className="text-xs text-[#666] bg-[#0a0a0a] rounded p-3">
                    No connected accounts available. Connect an app first in the Integrations tab.
                  </div>
                ) : (
                  <Select
                    value={selectedAccountId}
                    onChange={setSelectedAccountId}
                    placeholder="Select account..."
                    options={connectedAccounts.map(acc => ({
                      value: acc.id,
                      label: `${acc.appName} (${acc.id.slice(0, 8)}...)`,
                    }))}
                  />
                )}
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={() => { setShowCreate(false); setSelectedType(null); }}
                className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!selectedAccountId || creating}
                className="flex-1 text-sm bg-[#f97316] hover:bg-[#ea580c] text-white px-4 py-2 rounded transition disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Subscription Modal */}
      {showAddSub && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="font-medium mb-1">Route Trigger to Agent</h3>
            <p className="text-xs text-[#666] mb-4">
              {triggers.length === 0
                ? "No trigger instances yet. Create one first from the Browse section below."
                : "Select a trigger instance and the agent that should handle its events."
              }
            </p>

            {triggers.length > 0 ? (
              <>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-[#888] mb-1.5">Trigger Instance</label>
                    <Select
                      value={subTriggerId}
                      onChange={setSubTriggerId}
                      placeholder="Select trigger..."
                      options={triggers.map(t => ({
                        value: t.id,
                        label: `${t.trigger_slug.replace(/_/g, " ")}`,
                      }))}
                    />
                    {subTriggerId && (
                      <div className="text-xs text-[#555] mt-1 font-mono">
                        ID: {subTriggerId.slice(0, 16)}...
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs text-[#888] mb-1.5">Target Agent</label>
                    <Select
                      value={subAgentId}
                      onChange={setSubAgentId}
                      placeholder="Select agent..."
                      options={agents.map(agent => ({
                        value: agent.id,
                        label: `${agent.name} (${agent.status})`,
                      }))}
                    />
                  </div>
                </div>

                <div className="flex gap-2 mt-5">
                  <button
                    onClick={() => { setShowAddSub(false); setSubTriggerId(""); setSubAgentId(""); }}
                    className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddSubscription}
                    disabled={!subTriggerId || !subAgentId || addingSub}
                    className="flex-1 text-sm bg-[#f97316] hover:bg-[#ea580c] text-white px-4 py-2 rounded transition disabled:opacity-50"
                  >
                    {addingSub ? "Adding..." : "Add"}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setShowAddSub(false)}
                  className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
