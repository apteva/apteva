import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../context";

// Types
interface IntegrationApp {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
}

interface ConnectedAccount {
  id: string;
  appId: string;
  appName: string;
  status: "active" | "pending" | "failed" | "expired";
  createdAt: string;
}

interface IntegrationProvider {
  id: string;
  name: string;
  connected: boolean;
}

// Check if app supports API_KEY auth
function supportsApiKey(app: IntegrationApp): boolean {
  return app.authSchemes.some(s => s.toUpperCase() === "API_KEY");
}

// Check if app supports OAuth
function supportsOAuth(app: IntegrationApp): boolean {
  return app.authSchemes.some(s => s.toUpperCase() === "OAUTH2");
}

// Check if app supports multiple auth methods
function hasMultipleAuthMethods(app: IntegrationApp): boolean {
  return supportsApiKey(app) && supportsOAuth(app);
}

// Main component
export function IntegrationsPanel({
  providerId = "composio",
  projectId,
  onConnectionComplete,
  onBrowseTriggers,
  hideMcpConfig,
}: {
  providerId?: string;
  projectId?: string | null;
  onConnectionComplete?: () => void;
  onBrowseTriggers?: (toolkitSlug: string) => void;
  hideMcpConfig?: boolean;
}) {
  const { authFetch } = useAuth();
  const [apps, setApps] = useState<IntegrationApp[]>([]);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{
    appSlug: string;
    connectionId?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // For auth method selection (when app supports both OAuth and API Key)
  const [authMethodModal, setAuthMethodModal] = useState<{ app: IntegrationApp } | null>(null);
  // For API Key modal
  const [apiKeyModal, setApiKeyModal] = useState<{ app: IntegrationApp } | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  // For MCP config creation modal
  const [mcpConfigModal, setMcpConfigModal] = useState<{ app: IntegrationApp } | null>(null);
  const [mcpConfigName, setMcpConfigName] = useState("");
  const [mcpConfigCreating, setMcpConfigCreating] = useState(false);
  const [mcpConfigSuccess, setMcpConfigSuccess] = useState<string | null>(null);
  // For confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Fetch apps and connected accounts
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
    try {
      const [appsRes, connectedRes] = await Promise.all([
        authFetch(`/api/integrations/${providerId}/apps${projectParam}`),
        authFetch(`/api/integrations/${providerId}/connected${projectParam}`),
      ]);

      const appsData = await appsRes.json();
      const connectedData = await connectedRes.json();

      setApps(appsData.apps || []);
      setConnectedAccounts(connectedData.accounts || []);
    } catch (e) {
      console.error("Failed to fetch integrations:", e);
      setError("Failed to load integrations");
    }
    setLoading(false);
  }, [authFetch, providerId, projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Check for connection completion from URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectedApp = params.get("connected");
    if (connectedApp) {
      // Remove the query param
      window.history.replaceState({}, "", window.location.pathname);
      // Refresh to show new connection
      fetchData();
      onConnectionComplete?.();
    }
  }, [fetchData, onConnectionComplete]);

  // Poll for pending connection status
  useEffect(() => {
    if (!pendingConnection?.connectionId) return;
    const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";

    const pollInterval = setInterval(async () => {
      try {
        const res = await authFetch(
          `/api/integrations/${providerId}/connection/${pendingConnection.connectionId}${projectParam}`
        );
        const data = await res.json();

        if (data.connection?.status === "active") {
          setPendingConnection(null);
          setConnecting(null);
          fetchData();
          onConnectionComplete?.();
        } else if (data.connection?.status === "failed") {
          setPendingConnection(null);
          setConnecting(null);
          setError(`Connection to ${pendingConnection.appSlug} failed`);
        }
      } catch (e) {
        // Keep polling
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [pendingConnection, authFetch, providerId, projectId, fetchData, onConnectionComplete]);

  // Initiate connection
  const connectApp = async (app: IntegrationApp, apiKey?: string, forceOAuth?: boolean) => {
    // If app supports multiple auth methods and user hasn't chosen, show choice
    if (hasMultipleAuthMethods(app) && !apiKey && !forceOAuth) {
      setAuthMethodModal({ app });
      return;
    }

    // If app supports API key (and user didn't choose OAuth), show API key modal
    if (supportsApiKey(app) && !apiKey && !forceOAuth) {
      setApiKeyModal({ app });
      setApiKeyInput("");
      return;
    }

    setConnecting(app.slug);
    setError(null);

    try {
      // Build request body
      const body: any = { appSlug: app.slug };
      if (apiKey) {
        body.credentials = {
          authScheme: "API_KEY",
          apiKey,
        };
      }

      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      const res = await authFetch(`/api/integrations/${providerId}/connect${projectParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to initiate connection");
        setConnecting(null);
        setApiKeyModal(null);
        return;
      }

      // API_KEY connections are immediately active (no redirect)
      if (data.status === "active" || !data.redirectUrl) {
        setConnecting(null);
        setApiKeyModal(null);
        fetchData();
        onConnectionComplete?.();
        return;
      }

      if (data.redirectUrl) {
        // Store pending connection for polling
        setPendingConnection({
          appSlug: app.slug,
          connectionId: data.connectionId,
        });

        // Open OAuth in popup
        const popup = window.open(
          data.redirectUrl,
          `connect-${app.slug}`,
          "width=600,height=700,left=200,top=100"
        );

        // If popup blocked, redirect instead
        if (!popup || popup.closed) {
          window.location.href = data.redirectUrl;
        }
      }
    } catch (e) {
      setError(`Failed to connect: ${e}`);
      setConnecting(null);
      setApiKeyModal(null);
    }
  };

  // Handle API key form submission
  const handleApiKeySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyModal || !apiKeyInput.trim()) return;
    connectApp(apiKeyModal.app, apiKeyInput.trim());
  };

  // Disconnect (called after confirmation)
  const disconnectApp = async (account: ConnectedAccount) => {
    const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
    try {
      const res = await authFetch(
        `/api/integrations/${providerId}/connection/${account.id}${projectParam}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to disconnect");
      }
    } catch (e) {
      setError(`Failed to disconnect: ${e}`);
    }
  };

  // Open MCP config creation modal
  const openMcpConfigModal = (app: IntegrationApp) => {
    setMcpConfigModal({ app });
    setMcpConfigName(`${app.name} MCP`);
    setMcpConfigSuccess(null);
  };

  // Create MCP config from connected app
  const createMcpConfig = async () => {
    if (!mcpConfigModal || !mcpConfigName.trim()) return;

    setMcpConfigCreating(true);
    setError(null);

    try {
      const projectParam = projectId && projectId !== "unassigned" ? `?project_id=${projectId}` : "";
      const res = await authFetch(`/api/integrations/${providerId}/configs${projectParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mcpConfigName.replace(/[^a-zA-Z0-9\s-]/g, "").substring(0, 30),
          toolkitSlug: mcpConfigModal.app.slug,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create MCP config");
        setMcpConfigCreating(false);
        return;
      }

      setMcpConfigSuccess(mcpConfigName);
      onConnectionComplete?.();
    } catch (e) {
      setError(`Failed to create MCP config: ${e}`);
    } finally {
      setMcpConfigCreating(false);
    }
  };

  // Handle disconnect with confirmation modal
  const handleDisconnect = (account: ConnectedAccount) => {
    setConfirmModal({
      message: `Disconnect ${account.appName}?`,
      onConfirm: () => {
        disconnectApp(account);
        setConfirmModal(null);
      },
    });
  };

  // Check if app is connected
  const isConnected = (appSlug: string) => {
    return connectedAccounts.some(
      (a) => a.appId === appSlug && a.status === "active"
    );
  };

  // Get connection for app (prefer active account)
  const getConnection = (appSlug: string) => {
    return connectedAccounts.find((a) => a.appId === appSlug && a.status === "active")
      || connectedAccounts.find((a) => a.appId === appSlug);
  };

  // Filter apps
  const filteredApps = apps.filter((app) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      app.name.toLowerCase().includes(s) ||
      app.slug.toLowerCase().includes(s) ||
      app.description?.toLowerCase().includes(s) ||
      app.categories.some((c) => c.toLowerCase().includes(s))
    );
  });

  // Group by connected/not connected
  const connectedApps = filteredApps.filter((app) => isConnected(app.slug));
  const availableApps = filteredApps.filter((app) => !isConnected(app.slug));

  if (loading) {
    return <div className="text-center py-8 text-[#666]">Loading apps...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Auth Method Choice Modal */}
      {authMethodModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              {authMethodModal.app.logo && (
                <img
                  src={authMethodModal.app.logo}
                  alt={authMethodModal.app.name}
                  className="w-10 h-10 object-contain"
                />
              )}
              <div>
                <h3 className="font-medium">Connect {authMethodModal.app.name}</h3>
                <p className="text-xs text-[#666]">Choose how to authenticate</p>
              </div>
            </div>
            <div className="space-y-3">
              <button
                onClick={() => {
                  setAuthMethodModal(null);
                  setApiKeyModal({ app: authMethodModal.app });
                  setApiKeyInput("");
                }}
                className="w-full text-left p-3 bg-[#0a0a0a] hover:bg-[#1a1a1a] border border-[#333] hover:border-[#f97316] rounded-lg transition"
              >
                <div className="font-medium text-sm">API Key</div>
                <div className="text-xs text-[#666] mt-0.5">
                  Enter your {authMethodModal.app.name} API key directly
                </div>
              </button>
              <button
                onClick={() => {
                  setAuthMethodModal(null);
                  connectApp(authMethodModal.app, undefined, true);
                }}
                className="w-full text-left p-3 bg-[#0a0a0a] hover:bg-[#1a1a1a] border border-[#333] hover:border-[#f97316] rounded-lg transition"
              >
                <div className="font-medium text-sm">OAuth</div>
                <div className="text-xs text-[#666] mt-0.5">
                  Sign in with your {authMethodModal.app.name} account
                </div>
              </button>
            </div>
            <button
              onClick={() => setAuthMethodModal(null)}
              className="w-full text-sm text-[#666] hover:text-white mt-4 py-2 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* API Key Modal */}
      {apiKeyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-md mx-4">
            <div className="flex items-center gap-3 mb-4">
              {apiKeyModal.app.logo && (
                <img
                  src={apiKeyModal.app.logo}
                  alt={apiKeyModal.app.name}
                  className="w-10 h-10 object-contain"
                />
              )}
              <div>
                <h3 className="font-medium">Connect {apiKeyModal.app.name}</h3>
                <p className="text-xs text-[#666]">Enter your API key to connect</p>
              </div>
            </div>
            <form onSubmit={handleApiKeySubmit}>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Enter API Key..."
                className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-4 py-2 mb-4 focus:outline-none focus:border-[#f97316]"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setApiKeyModal(null)}
                  className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!apiKeyInput.trim() || connecting === apiKeyModal.app.slug}
                  className="flex-1 text-sm bg-[#f97316] hover:bg-[#ea580c] text-white px-4 py-2 rounded transition disabled:opacity-50"
                >
                  {connecting === apiKeyModal.app.slug ? "Connecting..." : "Connect"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MCP Config Creation Modal */}
      {mcpConfigModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-md mx-4">
            {mcpConfigSuccess ? (
              <>
                <div className="text-center mb-4">
                  <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                    <span className="text-green-400 text-2xl">✓</span>
                  </div>
                  <h3 className="font-medium text-lg">MCP Config Created!</h3>
                  <p className="text-sm text-[#888] mt-2">
                    "{mcpConfigSuccess}" has been created successfully.
                  </p>
                  <p className="text-xs text-[#666] mt-2">
                    You can now add it to your agents from the MCP Configs tab.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setMcpConfigModal(null);
                    setMcpConfigSuccess(null);
                  }}
                  className="w-full text-sm bg-[#f97316] hover:bg-[#ea580c] text-white px-4 py-2 rounded transition"
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-4">
                  {mcpConfigModal.app.logo && (
                    <img
                      src={mcpConfigModal.app.logo}
                      alt={mcpConfigModal.app.name}
                      className="w-10 h-10 object-contain"
                    />
                  )}
                  <div>
                    <h3 className="font-medium">Create MCP Config</h3>
                    <p className="text-xs text-[#666]">
                      Create an MCP config for {mcpConfigModal.app.name}
                    </p>
                  </div>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); createMcpConfig(); }}>
                  <label className="block text-xs text-[#888] mb-1">Config Name</label>
                  <input
                    type="text"
                    value={mcpConfigName}
                    onChange={(e) => setMcpConfigName(e.target.value)}
                    placeholder="Enter config name..."
                    className="w-full bg-[#0a0a0a] border border-[#333] rounded-lg px-4 py-2 mb-4 focus:outline-none focus:border-[#f97316]"
                    autoFocus
                    maxLength={30}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setMcpConfigModal(null)}
                      className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={!mcpConfigName.trim() || mcpConfigCreating}
                      className="flex-1 text-sm bg-[#f97316] hover:bg-[#ea580c] text-white px-4 py-2 rounded transition disabled:opacity-50"
                    >
                      {mcpConfigCreating ? "Creating..." : "Create Config"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[#111] border border-[#333] rounded-lg p-6 w-full max-w-sm mx-4">
            <p className="text-center mb-4">{confirmModal.message}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 text-sm bg-[#1a1a1a] hover:bg-[#222] border border-[#333] px-4 py-2 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="flex-1 text-sm bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded transition"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-red-400 text-sm p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">
            ×
          </button>
        </div>
      )}

      {/* Pending connection notice */}
      {pendingConnection && (
        <div className="text-yellow-400 text-sm p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex items-center gap-2">
          <span className="animate-spin">⟳</span>
          <span>Waiting for {pendingConnection.appSlug} authorization...</span>
        </div>
      )}

      {/* Search */}
      <div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps..."
          className="w-full bg-[#111] border border-[#333] rounded-lg px-4 py-2 focus:outline-none focus:border-[#f97316]"
        />
      </div>

      {/* Connected Apps */}
      {connectedApps.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[#888] mb-3">
            Connected ({connectedApps.length})
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connectedApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                connection={getConnection(app.slug)}
                onConnect={() => connectApp(app)}
                onDisconnect={() => {
                  const conn = getConnection(app.slug);
                  if (conn) handleDisconnect(conn);
                }}
                onCreateMcpConfig={hideMcpConfig ? undefined : () => openMcpConfigModal(app)}
                onBrowseTriggers={onBrowseTriggers ? () => onBrowseTriggers(app.slug) : undefined}
                connecting={connecting === app.slug}
              />
            ))}
          </div>
        </div>
      )}

      {/* Available Apps */}
      <div>
        <h3 className="text-sm font-medium text-[#888] mb-3">
          Available Apps ({availableApps.length})
        </h3>
        {availableApps.length === 0 ? (
          <p className="text-[#666] text-sm">
            {search ? "No apps match your search" : "No apps available"}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {availableApps.slice(0, 50).map((app) => (
              <AppCard
                key={app.id}
                app={app}
                onConnect={() => connectApp(app)}
                connecting={connecting === app.slug}
              />
            ))}
          </div>
        )}
        {availableApps.length > 50 && (
          <p className="text-xs text-[#555] mt-3 text-center">
            Showing first 50 of {availableApps.length} apps. Use search to find more.
          </p>
        )}
      </div>
    </div>
  );
}

// App card component
function AppCard({
  app,
  connection,
  onConnect,
  onDisconnect,
  onCreateMcpConfig,
  onBrowseTriggers,
  connecting,
}: {
  app: IntegrationApp;
  connection?: ConnectedAccount;
  onConnect: () => void;
  onDisconnect?: () => void;
  onCreateMcpConfig?: () => void;
  onBrowseTriggers?: () => void;
  connecting: boolean;
}) {
  const isConnected = connection?.status === "active";
  const hasApiKey = supportsApiKey(app);
  const hasOAuth = supportsOAuth(app);
  const hasBothMethods = hasApiKey && hasOAuth;

  return (
    <div
      className={`bg-[#111] border rounded-lg p-3 transition ${
        isConnected ? "border-green-500/30" : "border-[#1a1a1a] hover:border-[#333]"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Logo */}
        <div className="w-10 h-10 rounded bg-[#1a1a1a] flex items-center justify-center flex-shrink-0 overflow-hidden">
          {app.logo ? (
            <img
              src={app.logo}
              alt={app.name}
              className="w-8 h-8 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <span className="text-lg">{app.name[0]?.toUpperCase()}</span>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">{app.name}</h4>
            {isConnected && (
              <span className="text-xs text-green-400">✓</span>
            )}
            {!isConnected && hasApiKey && !hasOAuth && (
              <span className="text-[10px] bg-[#222] text-[#888] px-1.5 py-0.5 rounded" title="Requires API Key">
                API Key
              </span>
            )}
            {!isConnected && hasBothMethods && (
              <span className="text-[10px] bg-[#1a2a1a] text-[#6a6] px-1.5 py-0.5 rounded" title="Supports API Key or OAuth">
                API Key / OAuth
              </span>
            )}
          </div>
          {app.description && (
            <p className="text-xs text-[#666] line-clamp-2 mt-0.5">
              {app.description}
            </p>
          )}
          {app.categories.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {app.categories.slice(0, 2).map((cat) => (
                <span
                  key={cat}
                  className="text-[10px] bg-[#1a1a1a] text-[#555] px-1.5 py-0.5 rounded"
                >
                  {cat}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-3 flex gap-2">
        {isConnected ? (
          <>
            {onCreateMcpConfig && (
              <button
                onClick={onCreateMcpConfig}
                className="flex-1 text-xs bg-[#1a2a1a] hover:bg-[#1a3a1a] border border-green-500/30 hover:border-green-500/50 text-green-400 px-3 py-1.5 rounded transition"
              >
                Create MCP Config
              </button>
            )}
            {onBrowseTriggers && (
              <button
                onClick={onBrowseTriggers}
                className="flex-1 text-xs bg-[#1a1a2a] hover:bg-[#1a1a3a] border border-blue-500/30 hover:border-blue-500/50 text-blue-400 px-3 py-1.5 rounded transition"
              >
                Browse Triggers
              </button>
            )}
            {onDisconnect && (
              <button
                onClick={onDisconnect}
                className="text-xs text-[#666] hover:text-red-400 transition px-2"
                title="Disconnect"
              >
                ×
              </button>
            )}
          </>
        ) : (
          <button
            onClick={onConnect}
            disabled={connecting}
            className="w-full text-xs bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#f97316] px-3 py-1.5 rounded transition disabled:opacity-50"
          >
            {connecting ? "Connecting..." : (hasApiKey && !hasOAuth) ? "Enter API Key" : "Connect"}
          </button>
        )}
      </div>
    </div>
  );
}

export default IntegrationsPanel;
