import React, { useState, useEffect } from "react";
import { CheckIcon } from "../common/Icons";
import type { Provider } from "../../types";

type SettingsTab = "providers" | "updates";

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("providers");

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Settings Sidebar */}
      <div className="w-48 border-r border-[#1a1a1a] p-4">
        <h2 className="text-sm font-medium text-[#666] uppercase tracking-wider mb-3">Settings</h2>
        <nav className="space-y-1">
          <SettingsNavItem
            label="Providers"
            active={activeTab === "providers"}
            onClick={() => setActiveTab("providers")}
          />
          <SettingsNavItem
            label="Updates"
            active={activeTab === "updates"}
            onClick={() => setActiveTab("updates")}
          />
        </nav>
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "providers" && <ProvidersSettings />}
        {activeTab === "updates" && <UpdatesSettings />}
      </div>
    </div>
  );
}

function SettingsNavItem({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded text-sm transition ${
        active
          ? "bg-[#1a1a1a] text-[#e0e0e0]"
          : "text-[#666] hover:bg-[#111] hover:text-[#888]"
      }`}
    >
      {label}
    </button>
  );
}

function ProvidersSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchProviders = async () => {
    const res = await fetch("/api/providers");
    const data = await res.json();
    setProviders(data.providers || []);
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const saveKey = async () => {
    if (!selectedProvider || !apiKey) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      setTesting(true);
      const testRes = await fetch(`/api/keys/${selectedProvider}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey }),
      });
      const testData = await testRes.json();
      setTesting(false);

      if (!testData.valid) {
        setError(testData.error || "API key is invalid");
        setSaving(false);
        return;
      }

      const saveRes = await fetch(`/api/keys/${selectedProvider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey }),
      });

      if (!saveRes.ok) {
        const data = await saveRes.json();
        setError(data.error || "Failed to save key");
      } else {
        setSuccess("API key saved!");
        setApiKey("");
        setSelectedProvider(null);
        fetchProviders();
      }
    } catch (e) {
      setError("Failed to save key");
    }
    setSaving(false);
  };

  const deleteKey = async (providerId: string) => {
    if (!confirm("Are you sure you want to remove this API key?")) return;
    await fetch(`/api/keys/${providerId}`, { method: "DELETE" });
    fetchProviders();
  };

  const llmProviders = providers.filter(p => p.type === "llm");
  const integrations = providers.filter(p => p.type === "integration");
  const llmConfiguredCount = llmProviders.filter(p => p.hasKey).length;
  const intConfiguredCount = integrations.filter(p => p.hasKey).length;

  return (
    <div className="max-w-4xl space-y-10">
      {/* AI Providers Section */}
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold mb-1">AI Providers</h1>
          <p className="text-[#666]">
            Manage your API keys for AI providers. {llmConfiguredCount} of {llmProviders.length} configured.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {llmProviders.map(provider => (
            <ProviderKeyCard
              key={provider.id}
              provider={provider}
              isEditing={selectedProvider === provider.id}
              apiKey={apiKey}
              saving={saving}
              testing={testing}
              error={selectedProvider === provider.id ? error : null}
              success={selectedProvider === provider.id ? success : null}
              onStartEdit={() => {
                setSelectedProvider(provider.id);
                setError(null);
                setSuccess(null);
              }}
              onCancelEdit={() => {
                setSelectedProvider(null);
                setApiKey("");
                setError(null);
              }}
              onApiKeyChange={setApiKey}
              onSave={saveKey}
              onDelete={() => deleteKey(provider.id)}
            />
          ))}
        </div>
      </div>

      {/* MCP Integrations Section */}
      <div>
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-1">MCP Integrations</h2>
          <p className="text-[#666]">
            Connect to MCP gateways for tool integrations. {intConfiguredCount} of {integrations.length} configured.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {integrations.map(provider => (
            <IntegrationKeyCard
              key={provider.id}
              provider={provider}
              isEditing={selectedProvider === provider.id}
              apiKey={apiKey}
              saving={saving}
              testing={testing}
              error={selectedProvider === provider.id ? error : null}
              success={selectedProvider === provider.id ? success : null}
              onStartEdit={() => {
                setSelectedProvider(provider.id);
                setError(null);
                setSuccess(null);
              }}
              onCancelEdit={() => {
                setSelectedProvider(null);
                setApiKey("");
                setError(null);
              }}
              onApiKeyChange={setApiKey}
              onSave={saveKey}
              onDelete={() => deleteKey(provider.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ProviderKeyCardProps {
  provider: Provider;
  isEditing: boolean;
  apiKey: string;
  saving: boolean;
  testing: boolean;
  error: string | null;
  success: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  lastChecked: string | null;
}

interface AllVersionInfo {
  apteva: VersionInfo;
  agent: VersionInfo;
}

function UpdatesSettings() {
  const [versions, setVersions] = useState<AllVersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const checkForUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("Failed to check for updates");
      const data = await res.json();
      setVersions(data);
    } catch (e) {
      setError("Failed to check for updates");
    }
    setChecking(false);
  };

  const updateAgent = async () => {
    setUpdatingAgent(true);
    setError(null);
    setUpdateSuccess(null);
    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Update failed");
      } else {
        setUpdateSuccess(`Agent updated to v${data.version}. New agents will use this version.`);
        await checkForUpdates();
      }
    } catch (e) {
      setError("Failed to update agent");
    }
    setUpdatingAgent(false);
  };

  useEffect(() => {
    checkForUpdates();
  }, []);

  const copyCommand = (cmd: string, id: string) => {
    navigator.clipboard.writeText(cmd);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const hasAnyUpdate = versions?.apteva.updateAvailable || versions?.agent.updateAvailable;

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Updates</h1>
        <p className="text-[#666]">
          Check for new versions of apteva and the agent binary.
        </p>
      </div>

      {checking && !versions ? (
        <div className="text-[#666]">Checking for updates...</div>
      ) : error && !versions ? (
        <div className="text-red-400">{error}</div>
      ) : versions ? (
        <div className="space-y-6">
          {updateSuccess && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-green-400">
              {updateSuccess}
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
              {error}
            </div>
          )}

          {/* Apteva App Version */}
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-lg">apteva</h3>
                <p className="text-sm text-[#666]">The app you're running</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-mono">v{versions.apteva.installed || "?"}</div>
                {versions.apteva.updateAvailable && (
                  <div className="text-sm text-[#f97316]">→ v{versions.apteva.latest}</div>
                )}
              </div>
            </div>

            {versions.apteva.updateAvailable ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <p className="text-sm text-[#888] mb-3">
                  Update by running:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-[#0a0a0a] px-3 py-2 rounded font-mono text-sm text-[#888]">
                    npx apteva@latest
                  </code>
                  <button
                    onClick={() => copyCommand("npx apteva@latest", "apteva")}
                    className="px-3 py-2 bg-[#1a1a1a] hover:bg-[#222] rounded text-sm"
                  >
                    {copied === "apteva" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckIcon className="w-4 h-4" />
                Up to date
              </div>
            )}
          </div>

          {/* Agent Binary Version */}
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-lg">Agent Binary</h3>
                <p className="text-sm text-[#666]">The Go binary that runs agents</p>
              </div>
              <div className="text-right">
                <div className="text-xl font-mono">v{versions.agent.installed || "?"}</div>
                {versions.agent.updateAvailable && (
                  <div className="text-sm text-[#f97316]">→ v{versions.agent.latest}</div>
                )}
              </div>
            </div>

            {versions.agent.updateAvailable ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <p className="text-sm text-[#888] mb-3">
                  A new version is available. Stop all agents before updating.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={updateAgent}
                    disabled={updatingAgent}
                    className="px-4 py-2 bg-[#f97316] text-black rounded font-medium text-sm disabled:opacity-50"
                  >
                    {updatingAgent ? "Updating..." : "Update Agent"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-400 text-sm">
                <CheckIcon className="w-4 h-4" />
                Up to date
              </div>
            )}
          </div>

          {!hasAnyUpdate && !updateSuccess && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center gap-2 text-green-400">
              <CheckIcon className="w-5 h-5" />
              Everything is up to date!
            </div>
          )}

          <button
            onClick={checkForUpdates}
            disabled={checking}
            className="text-sm text-[#666] hover:text-[#888] disabled:opacity-50"
          >
            {checking ? "Checking..." : "Check for updates"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProviderKeyCard({
  provider,
  isEditing,
  apiKey,
  saving,
  testing,
  error,
  success,
  onStartEdit,
  onCancelEdit,
  onApiKeyChange,
  onSave,
  onDelete,
}: ProviderKeyCardProps) {
  return (
    <div className={`bg-[#111] border rounded-lg p-4 ${
      provider.hasKey ? 'border-green-500/20' : 'border-[#1a1a1a]'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-medium">{provider.name}</h3>
          <p className="text-sm text-[#666]">{provider.models.length} models</p>
        </div>
        {provider.hasKey ? (
          <span className="text-green-400 text-xs flex items-center gap-1 bg-green-500/10 px-2 py-1 rounded">
            <CheckIcon className="w-3 h-3" />
            {provider.keyHint}
          </span>
        ) : (
          <span className="text-[#666] text-xs bg-[#1a1a1a] px-2 py-1 rounded">
            Not configured
          </span>
        )}
      </div>

      {provider.hasKey ? (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#1a1a1a]">
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[#3b82f6] hover:underline"
          >
            View docs
          </a>
          <button
            onClick={onDelete}
            className="text-red-400 hover:text-red-300 text-sm"
          >
            Remove key
          </button>
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-[#1a1a1a]">
          {isEditing ? (
            <div className="space-y-3">
              <input
                type="password"
                value={apiKey}
                onChange={e => onApiKeyChange(e.target.value)}
                placeholder="Enter API key..."
                autoFocus
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
              />
              {error && <p className="text-red-400 text-sm">{error}</p>}
              {success && <p className="text-green-400 text-sm">{success}</p>}
              <div className="flex gap-2">
                <button
                  onClick={onCancelEdit}
                  className="flex-1 px-3 py-1.5 border border-[#333] rounded text-sm hover:border-[#666]"
                >
                  Cancel
                </button>
                <button
                  onClick={onSave}
                  disabled={!apiKey || saving}
                  className="flex-1 px-3 py-1.5 bg-[#f97316] text-black rounded text-sm font-medium disabled:opacity-50"
                >
                  {testing ? "Validating..." : saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#3b82f6] hover:underline"
              >
                Get API key
              </a>
              <button
                onClick={onStartEdit}
                className="text-sm text-[#f97316] hover:text-[#fb923c]"
              >
                + Add key
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IntegrationKeyCard({
  provider,
  isEditing,
  apiKey,
  saving,
  testing,
  error,
  success,
  onStartEdit,
  onCancelEdit,
  onApiKeyChange,
  onSave,
  onDelete,
}: ProviderKeyCardProps) {
  return (
    <div className={`bg-[#111] border rounded-lg p-4 ${
      provider.hasKey ? 'border-[#f97316]/20' : 'border-[#1a1a1a]'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-medium">{provider.name}</h3>
          <p className="text-sm text-[#666]">{provider.description || "MCP integration"}</p>
        </div>
        {provider.hasKey ? (
          <span className="text-[#f97316] text-xs flex items-center gap-1 bg-[#f97316]/10 px-2 py-1 rounded">
            <CheckIcon className="w-3 h-3" />
            {provider.keyHint}
          </span>
        ) : (
          <span className="text-[#666] text-xs bg-[#1a1a1a] px-2 py-1 rounded">
            Not configured
          </span>
        )}
      </div>

      {provider.hasKey ? (
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#1a1a1a]">
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-[#3b82f6] hover:underline"
          >
            View docs
          </a>
          <button
            onClick={onDelete}
            className="text-red-400 hover:text-red-300 text-sm"
          >
            Remove key
          </button>
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-[#1a1a1a]">
          {isEditing ? (
            <div className="space-y-3">
              <input
                type="password"
                value={apiKey}
                onChange={e => onApiKeyChange(e.target.value)}
                placeholder="Enter API key..."
                autoFocus
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 focus:outline-none focus:border-[#f97316]"
              />
              {error && <p className="text-red-400 text-sm">{error}</p>}
              {success && <p className="text-green-400 text-sm">{success}</p>}
              <div className="flex gap-2">
                <button
                  onClick={onCancelEdit}
                  className="flex-1 px-3 py-1.5 border border-[#333] rounded text-sm hover:border-[#666]"
                >
                  Cancel
                </button>
                <button
                  onClick={onSave}
                  disabled={!apiKey || saving}
                  className="flex-1 px-3 py-1.5 bg-[#f97316] text-black rounded text-sm font-medium disabled:opacity-50"
                >
                  {testing ? "Validating..." : saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#3b82f6] hover:underline"
              >
                Get API key
              </a>
              <button
                onClick={onStartEdit}
                className="text-sm text-[#f97316] hover:text-[#fb923c]"
              >
                + Add key
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
