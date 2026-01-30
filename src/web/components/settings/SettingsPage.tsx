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

  const configuredCount = providers.filter(p => p.hasKey).length;

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">AI Providers</h1>
        <p className="text-[#666]">
          Manage your API keys for AI providers. {configuredCount} of {providers.length} configured.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {providers.map(provider => (
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
  current: string;
  latest: string;
  updateAvailable: boolean;
  updateCommand: string;
}

function UpdatesSettings() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const checkForUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("Failed to check for updates");
      const data = await res.json();
      setVersion(data);
    } catch (e) {
      setError("Failed to check for updates");
    }
    setChecking(false);
  };

  useEffect(() => {
    checkForUpdates();
  }, []);

  const copyCommand = () => {
    if (version?.updateCommand) {
      navigator.clipboard.writeText(version.updateCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-1">Updates</h1>
        <p className="text-[#666]">
          Check for new versions of apteva.
        </p>
      </div>

      <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-6">
        {checking && !version ? (
          <div className="text-[#666]">Checking for updates...</div>
        ) : error ? (
          <div className="text-red-400">{error}</div>
        ) : version ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-[#666]">Current version</div>
                <div className="text-xl font-mono">v{version.current}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-[#666]">Latest version</div>
                <div className="text-xl font-mono">v{version.latest}</div>
              </div>
            </div>

            {version.updateAvailable ? (
              <div className="bg-[#f97316]/10 border border-[#f97316]/30 rounded-lg p-4">
                <div className="flex items-center gap-2 text-[#f97316] font-medium mb-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Update available!
                </div>
                <p className="text-sm text-[#888] mb-3">
                  A new version of apteva is available. Run this command to update:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-[#0a0a0a] px-3 py-2 rounded font-mono text-sm">
                    {version.updateCommand}
                  </code>
                  <button
                    onClick={copyCommand}
                    className="px-3 py-2 bg-[#1a1a1a] hover:bg-[#222] rounded text-sm"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center gap-2 text-green-400">
                <CheckIcon className="w-5 h-5" />
                You're running the latest version!
              </div>
            )}

            <button
              onClick={checkForUpdates}
              disabled={checking}
              className="text-sm text-[#666] hover:text-[#888] disabled:opacity-50"
            >
              {checking ? "Checking..." : "Check again"}
            </button>
          </div>
        ) : null}
      </div>
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
