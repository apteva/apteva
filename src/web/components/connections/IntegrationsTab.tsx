import React, { useState, useEffect, useCallback } from "react";
import { useAuth, useProjects } from "../../context";
import { IntegrationsPanel } from "../mcp/IntegrationsPanel";

interface TriggerType {
  slug: string;
  name: string;
  description: string;
  type: "webhook" | "poll";
  toolkit_slug: string;
  toolkit_name: string;
  logo: string | null;
}

interface ProviderInfo {
  id: string;
  name: string;
  connected: boolean;
}

export function IntegrationsTab() {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();

  const projectId = currentProjectId && currentProjectId !== "unassigned" ? currentProjectId : null;
  const projectParam = projectId ? `?project_id=${projectId}` : "";

  // Provider selection — only show configured providers
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");

  useEffect(() => {
    authFetch(`/api/triggers/providers${projectParam}`)
      .then(r => r.json())
      .then(data => {
        const connected = (data.providers || []).filter((p: ProviderInfo) => p.connected);
        setProviders(connected);
        if (connected.length > 0 && !connected.find((p: ProviderInfo) => p.id === selectedProvider)) {
          setSelectedProvider(connected[0].id);
        }
      })
      .catch(() => {});
  }, [authFetch]);

  // Trigger type browsing
  const [browsingToolkit, setBrowsingToolkit] = useState<string | null>(null);
  const [triggerTypes, setTriggerTypes] = useState<TriggerType[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);

  const handleBrowseTriggers = useCallback(async (toolkitSlug: string) => {
    setBrowsingToolkit(toolkitSlug);
    setTypesLoading(true);
    try {
      let url = `/api/triggers/types?provider=${selectedProvider}&toolkit_slugs=${toolkitSlug}`;
      if (projectId) url += `&project_id=${projectId}`;
      const res = await authFetch(url);
      if (res.ok) {
        const data = await res.json();
        setTriggerTypes(data.types || []);
      }
    } catch (e) {
      console.error("Failed to fetch trigger types:", e);
    }
    setTypesLoading(false);
  }, [authFetch, projectId, selectedProvider]);

  return (
    <div>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Connect external apps via OAuth or API Key. Connected apps can be used for triggers and MCP integrations.
      </p>

      {/* Provider Selector — only show if multiple configured */}
      {providers.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-[var(--color-text-muted)]">Provider:</span>
          <div className="flex gap-1 bg-[var(--color-surface)] card p-0.5">
            {providers.map(p => (
              <button
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
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

      {providers.length === 0 ? (
        <div className="bg-[var(--color-surface)] card p-8 text-center">
          <p className="text-[var(--color-text-muted)]">No integration providers configured.</p>
          <p className="text-sm text-[var(--color-text-faint)] mt-1">Add API keys for Composio or AgentDojo in Settings.</p>
        </div>
      ) : (
        <IntegrationsPanel
          providerId={selectedProvider}
          projectId={projectId}
          hideMcpConfig
          onBrowseTriggers={handleBrowseTriggers}
        />
      )}

      {/* Trigger Types Panel */}
      {browsingToolkit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border-light)] rounded-lg w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col">
            <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <h3 className="font-medium">Trigger Types</h3>
                <p className="text-xs text-[var(--color-text-muted)]">{browsingToolkit}</p>
              </div>
              <button
                onClick={() => { setBrowsingToolkit(null); setTriggerTypes([]); }}
                className="text-[var(--color-text-muted)] hover:text-white transition text-lg px-2"
              >
                x
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {typesLoading ? (
                <div className="text-center py-8 text-[var(--color-text-muted)]">Loading trigger types...</div>
              ) : triggerTypes.length === 0 ? (
                <div className="text-center py-8 text-[var(--color-text-muted)]">
                  No trigger types available for this app.
                </div>
              ) : (
                <div className="space-y-2">
                  {triggerTypes.map(tt => (
                    <div key={tt.slug} className="bg-[var(--color-bg)] card p-3">
                      <div className="flex items-start gap-3">
                        {tt.logo ? (
                          <img src={tt.logo} alt={tt.toolkit_name} className="w-6 h-6 rounded object-contain flex-shrink-0 mt-0.5" />
                        ) : (
                          <div className="w-6 h-6 rounded bg-[var(--color-surface-raised)] flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">
                            {tt.toolkit_name?.[0]?.toUpperCase() || "?"}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{tt.name}</div>
                          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{tt.description}</div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] bg-[var(--color-surface-raised)] text-[var(--color-text-faint)] px-1.5 py-0.5 rounded font-mono">
                              {tt.slug}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              tt.type === "webhook" ? "bg-blue-500/10 text-blue-400" : "bg-yellow-500/10 text-yellow-400"
                            }`}>
                              {tt.type}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
