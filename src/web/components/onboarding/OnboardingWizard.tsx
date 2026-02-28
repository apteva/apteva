import React, { useState, useEffect } from "react";
import { CheckIcon } from "../common/Icons";
import { CreateAccountStep } from "../auth";
import type { Provider } from "../../types";

interface OnboardingWizardProps {
  onComplete: () => void;
  needsAccount?: boolean; // Whether to show account creation step
}

export function OnboardingWizard({ onComplete, needsAccount = false }: OnboardingWizardProps) {
  // Step 0 = account creation (if needed), Step 1 = add keys, Step 2 = complete
  const [step, setStep] = useState(needsAccount ? 0 : 1);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [accountCreated, setAccountCreated] = useState(false);

  // Get auth token from session storage (set during account creation)
  const getAuthHeaders = (): Record<string, string> => {
    const token = sessionStorage.getItem("accessToken");
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  useEffect(() => {
    // Don't fetch providers until after account is created (if needed)
    if (needsAccount && !accountCreated && step === 0) return;

    fetch("/api/providers", { headers: getAuthHeaders() })
      .then(res => res.json())
      .then(data => {
        // Only show LLM providers in onboarding, not integrations
        const llmProviders = (data.providers || []).filter((p: Provider) => p.type === "llm");
        setProviders(llmProviders);
      });
  }, [accountCreated, step, needsAccount]);

  const configuredProviders = providers.filter(p => p.hasKey);

  const saveKey = async () => {
    if (!selectedProvider || !apiKey) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      setTesting(true);
      const testRes = await fetch(`/api/keys/${selectedProvider}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ key: apiKey }),
      });
      const saveData = await saveRes.json();

      if (!saveRes.ok) {
        setError(saveData.error || "Failed to save key");
      } else {
        setSuccess("API key saved successfully!");
        setApiKey("");
        const res = await fetch("/api/providers", { headers: getAuthHeaders() });
        const data = await res.json();
        setProviders(data.providers || []);
        setSelectedProvider(null);
      }
    } catch (e) {
      setError("Failed to save key");
    }
    setSaving(false);
  };

  const completeOnboarding = async () => {
    // Create a default project for the user
    try {
      const projectRes = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          name: "My Project",
          description: "Default project for organizing agents",
          color: "#f97316", // Orange - matches brand color
        }),
      });

      if (projectRes.ok) {
        const data = await projectRes.json();
        // Set this project as the current project in localStorage
        if (data.project?.id) {
          localStorage.setItem("apteva_current_project", data.project.id);
        }
      }
    } catch (e) {
      // Don't block onboarding if project creation fails
      console.error("Failed to create default project:", e);
    }

    await fetch("/api/onboarding/complete", { method: "POST", headers: getAuthHeaders() });
    onComplete();
  };

  const handleAccountCreated = () => {
    setAccountCreated(true);
    setStep(1);
  };

  // Calculate total steps and current progress
  const totalSteps = needsAccount ? 3 : 2;
  const currentStep = needsAccount ? step : step - 1;

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="text-[var(--color-accent)] text-3xl">&gt;_</span>
            <span className="text-3xl tracking-wider">apteva</span>
          </div>
          <p className="text-[var(--color-text-muted)]">Run AI agents locally</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {needsAccount && (
            <>
              <div className={`w-3 h-3 rounded-full ${step >= 0 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-raised)]'}`} />
              <div className={`w-16 h-0.5 ${step >= 1 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-raised)]'}`} />
            </>
          )}
          <div className={`w-3 h-3 rounded-full ${step >= 1 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-raised)]'}`} />
          <div className={`w-16 h-0.5 ${step >= 2 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-raised)]'}`} />
          <div className={`w-3 h-3 rounded-full ${step >= 2 ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-raised)]'}`} />
        </div>

        <div className="bg-[var(--color-surface)] card p-8">
          {step === 0 && needsAccount && (
            <CreateAccountStep onComplete={handleAccountCreated} />
          )}

          {step === 1 && (
            <Step1AddKeys
              providers={providers}
              configuredProviders={configuredProviders}
              selectedProvider={selectedProvider}
              apiKey={apiKey}
              saving={saving}
              testing={testing}
              error={error}
              success={success}
              onSelectProvider={setSelectedProvider}
              onApiKeyChange={setApiKey}
              onSaveKey={saveKey}
              onContinue={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <Step2Complete
              configuredProviders={configuredProviders}
              onAddMore={() => setStep(1)}
              onComplete={completeOnboarding}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface Step1Props {
  providers: Provider[];
  configuredProviders: Provider[];
  selectedProvider: string | null;
  apiKey: string;
  saving: boolean;
  testing: boolean;
  error: string | null;
  success: string | null;
  onSelectProvider: (id: string | null) => void;
  onApiKeyChange: (key: string) => void;
  onSaveKey: () => void;
  onContinue: () => void;
}

function Step1AddKeys({
  providers,
  configuredProviders,
  selectedProvider,
  apiKey,
  saving,
  testing,
  error,
  success,
  onSelectProvider,
  onApiKeyChange,
  onSaveKey,
  onContinue,
}: Step1Props) {
  const selectedProviderData = providers.find(p => p.id === selectedProvider);

  // When a provider is selected, show focused view with just that provider
  if (selectedProvider && selectedProviderData) {
    return (
      <>
        <h2 className="text-2xl font-semibold mb-2">Add {selectedProviderData.name} Key</h2>
        <p className="text-[var(--color-text-muted)] mb-6">
          Enter your API key below. It will be encrypted and stored locally.
        </p>

        <div className="mb-6">
          <div className="p-4 rounded border border-[var(--color-accent)] bg-[var(--color-accent-5)] mb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{selectedProviderData.name}</p>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {selectedProviderData.models.length} models available
                </p>
              </div>
              <a
                href={selectedProviderData.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#3b82f6] hover:underline"
              >
                Get API Key
              </a>
            </div>
          </div>

          <div className="space-y-3">
            <input
              type="password"
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              placeholder="Enter your API key..."
              autoFocus
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-4 py-3 focus:outline-none focus:border-[var(--color-accent)] text-lg"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            {success && <p className="text-green-400 text-sm">{success}</p>}
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => {
              onSelectProvider(null);
              onApiKeyChange("");
            }}
            className="flex-1 border border-[var(--color-border-light)] hover:border-[var(--color-text-muted)] px-4 py-3 rounded font-medium transition"
          >
            Back
          </button>
          <button
            onClick={onSaveKey}
            disabled={!apiKey || saving}
            className="flex-1 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-3 rounded font-medium transition"
          >
            {testing ? "Testing..." : saving ? "Saving..." : "Save API Key"}
          </button>
        </div>
      </>
    );
  }

  // Default view: show all providers
  return (
    <>
      <h2 className="text-2xl font-semibold mb-2">Welcome to apteva</h2>
      <p className="text-[var(--color-text-muted)] mb-6">
        To get started, you'll need to add at least one AI provider API key.
        Your keys are encrypted and stored locally.
      </p>

      <div className="space-y-3 mb-6">
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            selected={false}
            onSelect={() => !provider.hasKey && onSelectProvider(provider.id)}
          />
        ))}
      </div>

      <button
        onClick={onContinue}
        disabled={configuredProviders.length === 0}
        className="w-full bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50 disabled:cursor-not-allowed px-4 py-3 rounded font-medium transition"
      >
        {configuredProviders.length === 0
          ? "Add at least one API key to continue"
          : `Continue with ${configuredProviders.length} provider${configuredProviders.length > 1 ? 's' : ''}`
        }
      </button>
    </>
  );
}

interface ProviderCardProps {
  provider: Provider;
  selected: boolean;
  onSelect: () => void;
}

function ProviderCard({ provider, selected, onSelect }: ProviderCardProps) {
  return (
    <div
      onClick={onSelect}
      className={`p-4 rounded border transition cursor-pointer ${
        provider.hasKey
          ? 'border-green-500/30 bg-green-500/5'
          : selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-5)]'
          : 'border-[var(--color-border-light)] hover:border-[var(--color-border-light)]'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{provider.name}</p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {provider.models.length} models available
          </p>
        </div>
        {provider.hasKey ? (
          <span className="text-green-400 text-sm flex items-center gap-1">
            <CheckIcon />
            Configured ({provider.keyHint})
          </span>
        ) : (
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-sm text-[#3b82f6] hover:underline"
          >
            Get API Key
          </a>
        )}
      </div>
    </div>
  );
}

interface Step2Props {
  configuredProviders: Provider[];
  onAddMore: () => void;
  onComplete: () => void;
}

function Step2Complete({ configuredProviders, onAddMore, onComplete }: Step2Props) {
  return (
    <>
      <h2 className="text-2xl font-semibold mb-2">You're all set!</h2>
      <p className="text-[var(--color-text-muted)] mb-6">
        You've configured {configuredProviders.length} provider{configuredProviders.length > 1 ? 's' : ''}.
        You can add more providers later in Settings.
      </p>

      <div className="space-y-2 mb-6">
        {configuredProviders.map(provider => (
          <div key={provider.id} className="flex items-center gap-3 p-3 bg-[var(--color-bg)] rounded">
            <CheckIcon className="w-5 h-5 text-green-400" />
            <span>{provider.name}</span>
            <span className="text-[var(--color-text-muted)] text-sm">({provider.keyHint})</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onAddMore}
          className="flex-1 border border-[var(--color-border-light)] hover:border-[var(--color-accent)] px-4 py-3 rounded font-medium transition"
        >
          Add More
        </button>
        <button
          onClick={onComplete}
          className="flex-1 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-3 rounded font-medium transition"
        >
          Start Using apteva
        </button>
      </div>
    </>
  );
}
