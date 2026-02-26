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

interface IntegrationApp {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
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

  // Provider selection — only show configured providers
  const [providers, setProviders] = useState<TriggerProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");

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
  const [createAgentId, setCreateAgentId] = useState(""); // For AgentDojo direct subscription flow
  const [browseConfig, setBrowseConfig] = useState<Record<string, string>>({});
  const [browseSelectedAccountId, setBrowseSelectedAccountId] = useState("");

  // AgentDojo add subscription modal
  const [showAddDojo, setShowAddDojo] = useState(false);
  const [dojoTriggerTypes, setDojoTriggerTypes] = useState<TriggerType[]>([]);
  const [dojoTypesLoading, setDojoTypesLoading] = useState(false);
  const [dojoAccounts, setDojoAccounts] = useState<ConnectedAccount[]>([]);
  const [dojoApps, setDojoApps] = useState<IntegrationApp[]>([]);
  const [dojoSelectedToolkit, setDojoSelectedToolkit] = useState("");
  const [dojoSelectedType, setDojoSelectedType] = useState<string>("");
  const [dojoAgentId, setDojoAgentId] = useState("");
  const [dojoCreating, setDojoCreating] = useState(false);
  const [dojoConfig, setDojoConfig] = useState<Record<string, string>>({});
  const [dojoSelectedAccountId, setDojoSelectedAccountId] = useState("");
  const [dojoAppDropdownOpen, setDojoAppDropdownOpen] = useState(false);
  const [dojoAppSearch, setDojoAppSearch] = useState("");
  const [dojoTriggerDropdownOpen, setDojoTriggerDropdownOpen] = useState(false);
  const [dojoTriggerSearch, setDojoTriggerSearch] = useState("");

  // Add subscription
  const [showAddSub, setShowAddSub] = useState(false);
  const [subTriggerId, setSubTriggerId] = useState("");
  const [subAgentId, setSubAgentId] = useState("");
  const [addingSub, setAddingSub] = useState(false);

  // Agents
  const [agents, setAgents] = useState<Agent[]>([]);

  const [error, setError] = useState<string | null>(null);

  const projectParam = currentProjectId && currentProjectId !== "unassigned" ? `?project_id=${currentProjectId}` : "";

  // Fetch available providers — only show ones with API keys configured
  const fetchProviders = useCallback(async () => {
    try {
      const res = await authFetch(`/api/triggers/providers${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        const connected = (data.providers || []).filter((p: TriggerProviderInfo) => p.connected);
        setProviders(connected);
        // Auto-select first connected provider if none selected
        if (connected.length > 0) {
          setSelectedProvider(prev => {
            if (!prev || !connected.find((p: TriggerProviderInfo) => p.id === prev)) return connected[0].id;
            return prev;
          });
        }
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

  // Fetch agents (project-scoped)
  const fetchAgents = useCallback(async () => {
    try {
      const res = await authFetch(`/api/agents${projectParam}`);
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents || []);
      }
    } catch (e) {
      // Ignore
    }
  }, [authFetch, projectParam]);

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
    setCreateAgentId("");
    setBrowseConfig({});
    setBrowseSelectedAccountId("");
    setShowCreate(true);
    fetchConnectedAccounts();
  };

  const isAgentDojo = selectedProvider === "agentdojo";

  // Open AgentDojo add subscription modal — fetches from agentdojo provider (same as Integrations tab)
  const openAddDojoSub = async () => {
    setShowAddDojo(true);
    setDojoSelectedType("");
    setDojoSelectedToolkit("");
    setDojoAgentId("");
    setDojoConfig({});
    setDojoSelectedAccountId("");

    const loadTypes = async () => {
      if (dojoTriggerTypes.length > 0) return;
      setDojoTypesLoading(true);
      try {
        let url = `/api/triggers/types?provider=agentdojo`;
        if (currentProjectId && currentProjectId !== "unassigned") url += `&project_id=${currentProjectId}`;
        const res = await authFetch(url);
        const data = await res.json();
        setDojoTriggerTypes(data.types || []);
      } catch (e) {
        console.error("Failed to load trigger types:", e);
      }
      setDojoTypesLoading(false);
    };

    const loadAccounts = async () => {
      try {
        const url = `/api/integrations/agentdojo/connected${projectParam}`;
        const res = await authFetch(url);
        const data = await res.json();
        const active = (data.accounts || []).filter((a: ConnectedAccount) => a.status === "active");
        setDojoAccounts(active);
      } catch (e) {
        console.error("Failed to load connected accounts:", e);
      }
    };

    const loadApps = async () => {
      if (dojoApps.length > 0) return;
      try {
        const url = `/api/integrations/agentdojo/apps${projectParam}`;
        const res = await authFetch(url);
        const data = await res.json();
        setDojoApps((data.apps || []).map((a: any) => ({ id: a.id, name: a.name, slug: a.slug, logo: a.logo })));
      } catch (e) {
        console.error("Failed to load apps:", e);
      }
    };

    await Promise.all([loadTypes(), loadAccounts(), loadApps()]);
  };

  // Create AgentDojo subscription from the add-subscription modal
  const handleAddDojoSub = async () => {
    const tt = dojoTriggerTypes.find(t => t.slug === dojoSelectedType);
    // Use derived dojoMatchedAccount (respects user dropdown selection + auto-match fallback)
    const matched = dojoMatchedAccount;
    if (!tt || !dojoAgentId || !matched) return;

    setDojoCreating(true);
    setError(null);
    try {
      const agent = agents.find(a => a.id === dojoAgentId);
      const providerParam = `provider=agentdojo`;
      const url = projectParam
        ? `/api/triggers${projectParam}&${providerParam}`
        : `/api/triggers?${providerParam}`;
      const configPayload = {
        callback_url: `${window.location.origin}/api/webhooks/agentdojo`,
        title: `${tt.name} → ${agent?.name || "Agent"}`,
        server: tt.toolkit_slug,
        agent_id: dojoAgentId,
        ...dojoConfig,
      };
      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: tt.slug,
          connectedAccountId: matched.id,
          config: configPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create subscription");
      } else {
        setShowAddDojo(false);
        fetchTriggers();
      }
    } catch (e: any) {
      setError(e.message || "Failed to create subscription");
    }
    setDojoCreating(false);
  };

  // Create trigger (Composio: trigger instance, AgentDojo: subscription + agent routing)
  const handleCreate = async () => {
    if (!selectedType) return;

    // AgentDojo: create remote subscription directly (callback_url points to apteva webhook handler)
    if (isAgentDojo) {
      if (!createAgentId || !browseMatchedAccount) return;
      setCreating(true);
      setError(null);
      try {
        const agent = agents.find(a => a.id === createAgentId);
        const instanceUrl = window.location.origin;
        const providerParam = `provider=${selectedProvider}`;
        const url = projectParam
          ? `/api/triggers${projectParam}&${providerParam}`
          : `/api/triggers?${providerParam}`;
        const res = await authFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: selectedType.slug,
            connectedAccountId: browseMatchedAccount.id,
            config: {
              callback_url: `${instanceUrl}/api/webhooks/agentdojo`,
              title: `${selectedType.name} → ${agent?.name || "Agent"}`,
              server: selectedType.toolkit_slug,
              agent_id: createAgentId,
              ...browseConfig, // Dynamic config fields (e.g. owner, repo)
            },
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to create subscription");
        } else {
          setShowCreate(false);
          setSelectedType(null);
          fetchTriggers();
        }
      } catch (e: any) {
        setError(e.message || "Failed to create subscription");
      }
      setCreating(false);
      return;
    }

    // Composio: standard trigger instance creation
    if (!selectedAccountId) return;
    setCreating(true);
    setError(null);
    try {
      const providerParam = `provider=${selectedProvider}`;
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

  // Best-effort match connected account from toolkit slug
  // A single credential can serve multiple toolkits (e.g. "OmniKit Platform" for "OmniKit Messaging")
  const matchAccount = (accounts: ConnectedAccount[], toolkitSlug: string): ConnectedAccount | null => {
    if (!toolkitSlug || accounts.length === 0) return null;
    const slug = toolkitSlug.toLowerCase().replace(/[-_]/g, " ");
    // Exact match
    const exact = accounts.find(a =>
      a.appId?.toLowerCase() === toolkitSlug.toLowerCase() ||
      a.appName?.toLowerCase() === toolkitSlug.toLowerCase()
    );
    if (exact) return exact;
    // Contains match
    const contains = accounts.find(a =>
      a.appId?.toLowerCase().includes(slug) ||
      a.appName?.toLowerCase().replace(/[-_]/g, " ").includes(slug) ||
      slug.includes(a.appId?.toLowerCase() || "") ||
      slug.includes(a.appName?.toLowerCase().replace(/[-_]/g, " ") || "")
    );
    if (contains) return contains;
    // Prefix match — first word overlap (e.g. "omnikit" matches "omnikit platform" and "omnikit messaging")
    const slugWords = slug.split(/\s+/);
    return accounts.find(a => {
      const nameWords = (a.appName || "").toLowerCase().replace(/[-_]/g, " ").split(/\s+/);
      return slugWords[0] && nameWords[0] && slugWords[0] === nameWords[0];
    }) || null;
  };

  // Derived: auto-matched or user-selected account for Add Subscription modal
  const dojoSelectedTriggerType = dojoTriggerTypes.find(t => t.slug === dojoSelectedType);
  const dojoAutoMatch = dojoSelectedTriggerType ? matchAccount(dojoAccounts, dojoSelectedTriggerType.toolkit_slug) : null;
  const dojoMatchedAccount = dojoSelectedAccountId
    ? dojoAccounts.find(a => a.id === dojoSelectedAccountId) || dojoAutoMatch
    : dojoAutoMatch;

  // Derived: auto-matched or user-selected account for Browse Subscribe modal
  const browseAutoMatch = selectedType && isAgentDojo ? matchAccount(connectedAccounts, selectedType.toolkit_slug) : null;
  const browseMatchedAccount = browseSelectedAccountId
    ? connectedAccounts.find(a => a.id === browseSelectedAccountId) || browseAutoMatch
    : browseAutoMatch;

  // Derived: group trigger types by toolkit, enriched with logos from apps list
  const dojoToolkits = React.useMemo(() => {
    const appLogos = new Map<string, string>();
    for (const app of dojoApps) {
      if (app.logo) appLogos.set(app.slug, app.logo);
    }
    const map = new Map<string, { slug: string; name: string; logo: string | null; count: number }>();
    for (const t of dojoTriggerTypes) {
      const existing = map.get(t.toolkit_slug);
      if (existing) {
        existing.count++;
      } else {
        const logo = appLogos.get(t.toolkit_slug) || t.logo || null;
        map.set(t.toolkit_slug, { slug: t.toolkit_slug, name: t.toolkit_name, logo, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [dojoTriggerTypes, dojoApps]);

  // Derived: triggers for the selected toolkit
  const dojoToolkitTriggers = dojoSelectedToolkit
    ? dojoTriggerTypes.filter(t => t.toolkit_slug === dojoSelectedToolkit)
    : [];

  // Derived: selected toolkit info (for logo in trigger dropdown)
  const dojoSelectedToolkitInfo = dojoToolkits.find(t => t.slug === dojoSelectedToolkit);

  // Agent map for quick lookups
  const agentMap = new Map(agents.map(a => [a.id, a]));

  if (providers.length === 0 && !triggersLoading) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-8 text-center">
        <p className="text-[var(--color-text-muted)]">No trigger providers configured.</p>
        <p className="text-sm text-[var(--color-text-faint)] mt-1">Add API keys for Composio or AgentDojo in Settings to enable triggers.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">x</button>
        </div>
      )}

      {/* Provider Selector — only show if multiple configured */}
      {providers.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-text-muted)]">Provider:</span>
          <div className="flex gap-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-0.5">
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
                    ? "bg-[var(--color-surface-raised)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Subscriptions (trigger → agent routing) — hide entirely for AgentDojo (handled in Active Subscriptions) */}
      {!isAgentDojo && (
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--color-text-secondary)]">
            Subscriptions ({subscriptions.length})
          </h3>
          <button
            onClick={() => setShowAddSub(true)}
            className="text-xs bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition"
          >
            + Add Subscription
          </button>
        </div>

        {subscriptions.length === 0 ? (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-6 text-center text-[var(--color-text-muted)] text-sm">
            No subscriptions yet. Add one to route trigger events to an agent.
          </div>
        ) : (
          <div className="space-y-2">
            {subscriptions.map(sub => {
              const agent = agentMap.get(sub.agent_id);
              return (
                <div key={sub.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sub.enabled ? "bg-green-400" : "bg-[var(--color-text-muted)]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {sub.trigger_slug.replace(/_/g, " ")}
                      <span className="text-[var(--color-text-faint)] mx-1.5">&rarr;</span>
                      <span className="text-[var(--color-accent)]">{agent?.name || "Unknown Agent"}</span>
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
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
                      className="text-xs text-[var(--color-text-muted)] hover:text-red-400 transition px-2"
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
      )}

      {/* Trigger Instances — only show for providers that have them (not AgentDojo) */}
      {!isAgentDojo && (
        <section>
          <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">
            Trigger Instances ({triggers.length})
          </h3>
          {triggersLoading ? (
            <div className="text-center py-6 text-[var(--color-text-muted)] text-sm">Loading triggers...</div>
          ) : triggers.length === 0 ? (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-6 text-center text-[var(--color-text-muted)] text-sm">
              No trigger instances. Browse trigger types below to create one.
            </div>
          ) : (
            <div className="space-y-2">
              {triggers.map(trigger => (
                <div key={trigger.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${trigger.status === "active" ? "bg-green-400" : "bg-[var(--color-text-muted)]"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {trigger.trigger_slug.replace(/_/g, " ")}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">
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
                      className="text-xs text-[var(--color-text-muted)] hover:text-red-400 transition px-2"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* AgentDojo Active Subscriptions — shows remote subscriptions directly */}
      {isAgentDojo && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-[var(--color-text-secondary)]">
              Active Subscriptions ({triggers.length})
            </h3>
            <button
              onClick={openAddDojoSub}
              className="text-xs bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition"
            >
              + Add Subscription
            </button>
          </div>
          {triggersLoading ? (
            <div className="text-center py-6 text-[var(--color-text-muted)] text-sm">Loading subscriptions...</div>
          ) : triggers.length === 0 ? (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-6 text-center text-[var(--color-text-muted)] text-sm">
              No active subscriptions. Browse trigger types below to create one.
            </div>
          ) : (
            <div className="space-y-2">
              {triggers.map(trigger => {
                const localSub = subscriptions.find(s => s.trigger_instance_id === trigger.id);
                const agent = localSub ? agentMap.get(localSub.agent_id) : null;
                return (
                  <div key={trigger.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-3 flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${trigger.status === "active" ? "bg-green-400" : "bg-[var(--color-text-muted)]"}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {(trigger.config?.title as string) || trigger.trigger_slug.replace(/_/g, " ")}
                        {agent && (
                          <>
                            <span className="text-[var(--color-text-faint)] mx-1.5">&rarr;</span>
                            <span className="text-[var(--color-accent)]">{agent.name}</span>
                          </>
                        )}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)]">
                        {trigger.config?.server && <span>{String(trigger.config.server)} | </span>}
                        ID: {String(trigger.id).slice(0, 8)} | Created: {new Date(trigger.created_at).toLocaleDateString()}
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
                        className="text-xs text-[var(--color-text-muted)] hover:text-red-400 transition px-2"
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
      )}

      {/* Browse Trigger Types */}
      <section>
        <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-3">Browse Trigger Types</h3>
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={toolkitFilter}
            onChange={(e) => setToolkitFilter(e.target.value)}
            placeholder="Toolkit filter (e.g. github, gmail, slack)"
            className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => browseTriggerTypes(toolkitFilter || undefined)}
            disabled={typesLoading}
            className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-4 py-2 rounded transition disabled:opacity-50"
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
              className="w-full bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-[var(--color-accent)]"
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTypes.slice(0, 30).map(tt => (
                <div key={tt.slug} className="bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-light)] rounded-lg p-3 transition">
                  <div className="flex items-start gap-3">
                    {tt.logo ? (
                      <img src={tt.logo} alt={tt.toolkit_name} className="w-8 h-8 rounded object-contain flex-shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-[var(--color-surface-raised)] flex items-center justify-center text-xs flex-shrink-0">
                        {tt.toolkit_name?.[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{tt.name}</div>
                      <div className="text-xs text-[var(--color-text-muted)]">{tt.toolkit_name}</div>
                      <div className="text-xs text-[var(--color-text-faint)] mt-1 line-clamp-2">{tt.description}</div>
                    </div>
                  </div>
                  <button
                    onClick={() => startCreate(tt)}
                    className="w-full mt-3 text-xs bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-3 py-1.5 rounded transition"
                  >
                    {isAgentDojo ? "Subscribe" : "Create Trigger"}
                  </button>
                </div>
              ))}
            </div>
            {filteredTypes.length > 30 && (
              <p className="text-xs text-[var(--color-text-faint)] mt-3 text-center">
                Showing first 30 of {filteredTypes.length} types. Use search to filter.
              </p>
            )}
          </>
        )}
      </section>

      {/* Create Trigger Modal */}
      {showCreate && selectedType && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="font-medium mb-1">
              {isAgentDojo ? "Create Subscription" : "Create Trigger"}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              {selectedType.name}
              {selectedType.toolkit_name && <span className="text-[var(--color-text-faint)]"> ({selectedType.toolkit_name})</span>}
            </p>

            <div className="space-y-4">
              {/* Connected Account — only for Composio */}
              {!isAgentDojo && (
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Connected Account</label>
                  {connectedAccounts.length === 0 ? (
                    <div className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded p-3">
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
              )}

              {/* Agent selection — for AgentDojo direct subscription */}
              {isAgentDojo && (
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Route to Agent</label>
                  {agents.length === 0 ? (
                    <div className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded p-3">
                      No agents available. Create an agent first.
                    </div>
                  ) : (
                    <Select
                      value={createAgentId}
                      onChange={setCreateAgentId}
                      placeholder="Select agent..."
                      options={agents.map(agent => ({
                        value: agent.id,
                        label: `${agent.name} (${agent.status})`,
                      }))}
                    />
                  )}

                  {/* Connected account — auto-matched from toolkit */}
                  <div className="mt-3">
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Connected Account</label>
                    {browseMatchedAccount ? (
                      <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded p-3">
                        Connected: {browseMatchedAccount.appName}
                      </div>
                    ) : (
                      <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded p-3">
                        No connected account for {selectedType?.toolkit_name || "this app"}. Connect it first in the Integrations tab.
                      </div>
                    )}
                  </div>

                  {/* Dynamic config fields from config_schema */}
                  {selectedType.config_schema && Object.keys((selectedType.config_schema as any).properties || {}).length > 0 && (
                    <div className="mt-3">
                      <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Configuration</label>
                      <div className="space-y-2">
                        {Object.entries((selectedType.config_schema as any).properties || {}).map(([key, schema]: [string, any]) => {
                          const required = ((selectedType.config_schema as any).required || []).includes(key);
                          return (
                            <div key={key}>
                              <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                                {schema.title || key}
                                {required && <span className="text-red-400 ml-0.5">*</span>}
                              </label>
                              <input
                                type="text"
                                value={browseConfig[key] || ""}
                                onChange={(e) => setBrowseConfig(prev => ({ ...prev, [key]: e.target.value }))}
                                placeholder={schema.description || `Enter ${schema.title || key}...`}
                                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={() => { setShowCreate(false); setSelectedType(null); }}
                className="flex-1 text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] px-4 py-2 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={isAgentDojo ? (
                  !createAgentId || !browseMatchedAccount || creating ||
                  (selectedType?.config_schema && ((selectedType.config_schema as any).required || []).some((key: string) => !browseConfig[key]?.trim()))
                ) : (!selectedAccountId || creating)}
                className="flex-1 text-sm bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white px-4 py-2 rounded transition disabled:opacity-50"
              >
                {creating ? "Creating..." : isAgentDojo ? "Subscribe" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Subscription Modal */}
      {showAddSub && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="font-medium mb-1">Route Trigger to Agent</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              {triggers.length === 0
                ? "No trigger instances yet. Create one first from the Browse section below."
                : "Select a trigger instance and the agent that should handle its events."
              }
            </p>

            {triggers.length > 0 ? (
              <>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Trigger Instance</label>
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
                      <div className="text-xs text-[var(--color-text-faint)] mt-1 font-mono">
                        ID: {subTriggerId.slice(0, 16)}...
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Target Agent</label>
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
                    className="flex-1 text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] px-4 py-2 rounded transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddSubscription}
                    disabled={!subTriggerId || !subAgentId || addingSub}
                    className="flex-1 text-sm bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white px-4 py-2 rounded transition disabled:opacity-50"
                  >
                    {addingSub ? "Adding..." : "Add"}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setShowAddSub(false)}
                  className="flex-1 text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] px-4 py-2 rounded transition"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* AgentDojo Add Subscription Modal */}
      {showAddDojo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg p-6 w-full max-w-lg mx-4">
            <h3 className="font-medium mb-1">Add Subscription</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Select an app and trigger, then route it to an agent.
            </p>

            {dojoTypesLoading ? (
              <div className="text-center py-8 text-[var(--color-text-muted)] text-sm">Loading...</div>
            ) : dojoTriggerTypes.length === 0 ? (
              <div className="text-center py-8 text-[var(--color-text-muted)] text-sm">
                No triggers available. Connect an app first in the Integrations tab.
              </div>
            ) : (
              <div className="space-y-4">
                {/* App selector — custom dropdown with logos */}
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">App</label>
                  <div className="relative">
                    <button
                      onClick={() => { setDojoAppDropdownOpen(!dojoAppDropdownOpen); setDojoTriggerDropdownOpen(false); setDojoAppSearch(""); }}
                      className="w-full flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm text-left hover:border-[var(--color-text-faint)] transition"
                    >
                      {dojoSelectedToolkitInfo ? (
                        <>
                          {dojoSelectedToolkitInfo.logo ? (
                            <img src={dojoSelectedToolkitInfo.logo} alt="" className="w-5 h-5 rounded object-contain flex-shrink-0" />
                          ) : (
                            <div className="w-5 h-5 rounded bg-[var(--color-surface-raised)] flex items-center justify-center text-[10px] flex-shrink-0">
                              {dojoSelectedToolkitInfo.name?.[0]?.toUpperCase() || "?"}
                            </div>
                          )}
                          <span className="flex-1 truncate">{dojoSelectedToolkitInfo.name}</span>
                          <span className="text-[10px] text-[var(--color-text-muted)]">{dojoSelectedToolkitInfo.count} triggers</span>
                        </>
                      ) : (
                        <span className="text-[var(--color-text-muted)] flex-1">Select app...</span>
                      )}
                      <span className="text-[var(--color-text-muted)] text-xs ml-1">&#9662;</span>
                    </button>
                    {dojoAppDropdownOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setDojoAppDropdownOpen(false)} />
                        <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg shadow-xl z-20 max-h-64 flex flex-col">
                          <div className="p-2 border-b border-[var(--color-border)] flex-shrink-0">
                            <input
                              type="text"
                              value={dojoAppSearch}
                              onChange={(e) => setDojoAppSearch(e.target.value)}
                              placeholder="Search apps..."
                              className="w-full bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                              autoFocus
                            />
                          </div>
                          <div className="overflow-y-auto flex-1">
                            {dojoToolkits
                              .filter(tk => {
                                if (!dojoAppSearch) return true;
                                const s = dojoAppSearch.toLowerCase();
                                return tk.name.toLowerCase().includes(s) || tk.slug.toLowerCase().includes(s);
                              })
                              .map(tk => (
                                <button
                                  key={tk.slug}
                                  onClick={() => {
                                    setDojoSelectedToolkit(tk.slug);
                                    setDojoSelectedType("");
                                    setDojoConfig({});
                                    setDojoAppDropdownOpen(false);
                                  }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition hover:bg-[var(--color-surface-raised)] ${
                                    dojoSelectedToolkit === tk.slug ? "bg-[var(--color-surface-raised)] text-[var(--color-accent)]" : ""
                                  }`}
                                >
                                  {tk.logo ? (
                                    <img src={tk.logo} alt="" className="w-5 h-5 rounded object-contain flex-shrink-0" />
                                  ) : (
                                    <div className="w-5 h-5 rounded bg-[var(--color-surface-raised)] flex items-center justify-center text-[10px] flex-shrink-0">
                                      {tk.name?.[0]?.toUpperCase() || "?"}
                                    </div>
                                  )}
                                  <span className="flex-1 truncate">{tk.name}</span>
                                  <span className="text-[10px] text-[var(--color-text-muted)]">{tk.count}</span>
                                </button>
                              ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Trigger selector — only shown when app is selected */}
                {dojoSelectedToolkit && (
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Trigger</label>
                    <div className="relative">
                      <button
                        onClick={() => { setDojoTriggerDropdownOpen(!dojoTriggerDropdownOpen); setDojoAppDropdownOpen(false); setDojoTriggerSearch(""); }}
                        className="w-full flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm text-left hover:border-[var(--color-text-faint)] transition"
                      >
                        {dojoSelectedTriggerType ? (
                          <>
                            <span className="flex-1 truncate">{dojoSelectedTriggerType.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                              dojoSelectedTriggerType.type === "webhook" ? "bg-blue-500/10 text-blue-400" : "bg-yellow-500/10 text-yellow-400"
                            }`}>
                              {dojoSelectedTriggerType.type}
                            </span>
                          </>
                        ) : (
                          <span className="text-[var(--color-text-muted)] flex-1">Select trigger...</span>
                        )}
                        <span className="text-[var(--color-text-muted)] text-xs ml-1">&#9662;</span>
                      </button>
                      {dojoTriggerDropdownOpen && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setDojoTriggerDropdownOpen(false)} />
                          <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded-lg shadow-xl z-20 max-h-64 flex flex-col">
                            {dojoToolkitTriggers.length > 3 && (
                              <div className="p-2 border-b border-[var(--color-border)] flex-shrink-0">
                                <input
                                  type="text"
                                  value={dojoTriggerSearch}
                                  onChange={(e) => setDojoTriggerSearch(e.target.value)}
                                  placeholder="Search triggers..."
                                  className="w-full bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                                  autoFocus
                                />
                              </div>
                            )}
                            <div className="overflow-y-auto flex-1">
                              {dojoToolkitTriggers
                                .filter(t => {
                                  if (!dojoTriggerSearch) return true;
                                  const s = dojoTriggerSearch.toLowerCase();
                                  return t.name.toLowerCase().includes(s) || t.slug.toLowerCase().includes(s) || t.description.toLowerCase().includes(s);
                                })
                                .map(t => (
                                  <button
                                    key={t.slug}
                                    onClick={() => {
                                      setDojoSelectedType(t.slug);
                                      setDojoConfig({});
                                      setDojoTriggerDropdownOpen(false);
                                    }}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition hover:bg-[var(--color-surface-raised)] ${
                                      dojoSelectedType === t.slug ? "bg-[var(--color-surface-raised)] text-[var(--color-accent)]" : ""
                                    }`}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="truncate">{t.name}</div>
                                      <div className="text-[10px] text-[var(--color-text-muted)] truncate">{t.description}</div>
                                    </div>
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                                      t.type === "webhook" ? "bg-blue-500/10 text-blue-400" : "bg-yellow-500/10 text-yellow-400"
                                    }`}>
                                      {t.type}
                                    </span>
                                  </button>
                                ))}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Connected account — auto-matched */}
                {dojoSelectedType && (
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Connected Account</label>
                    {dojoMatchedAccount ? (
                      <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded p-3">
                        Connected: {dojoMatchedAccount.appName}
                      </div>
                    ) : (
                      <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded p-3">
                        No connected account for {dojoSelectedTriggerType?.toolkit_name || "this app"}. Connect it first in the Integrations tab.
                      </div>
                    )}
                  </div>
                )}

                {/* Dynamic config fields from config_schema */}
                {dojoSelectedTriggerType && dojoSelectedTriggerType.config_schema && Object.keys(dojoSelectedTriggerType.config_schema.properties || {}).length > 0 && (
                  <div>
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Configuration</label>
                    <div className="space-y-2">
                      {Object.entries((dojoSelectedTriggerType.config_schema as any).properties || {}).map(([key, schema]: [string, any]) => {
                        const required = ((dojoSelectedTriggerType.config_schema as any).required || []).includes(key);
                        return (
                          <div key={key}>
                            <label className="block text-[11px] text-[var(--color-text-secondary)] mb-1">
                              {schema.title || key}
                              {required && <span className="text-red-400 ml-0.5">*</span>}
                            </label>
                            <input
                              type="text"
                              value={dojoConfig[key] || ""}
                              onChange={(e) => setDojoConfig(prev => ({ ...prev, [key]: e.target.value }))}
                              placeholder={schema.description || `Enter ${schema.title || key}...`}
                              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-accent)]"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Agent selection */}
                <div>
                  <label className="block text-xs text-[var(--color-text-secondary)] mb-1.5">Target Agent</label>
                  {agents.length === 0 ? (
                    <div className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded p-3">
                      No agents available. Create an agent first.
                    </div>
                  ) : (
                    <Select
                      value={dojoAgentId}
                      onChange={setDojoAgentId}
                      placeholder="Select agent..."
                      options={agents.map(agent => ({
                        value: agent.id,
                        label: `${agent.name} (${agent.status})`,
                      }))}
                    />
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowAddDojo(false)}
                className="flex-1 text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] px-4 py-2 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={handleAddDojoSub}
                disabled={!dojoSelectedType || !dojoAgentId || !dojoMatchedAccount || dojoCreating || (
                  dojoSelectedTriggerType?.config_schema &&
                  ((dojoSelectedTriggerType.config_schema as any).required || []).some((key: string) => !dojoConfig[key]?.trim())
                )}
                className="flex-1 text-sm bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white px-4 py-2 rounded transition disabled:opacity-50"
              >
                {dojoCreating ? "Creating..." : "Subscribe"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
