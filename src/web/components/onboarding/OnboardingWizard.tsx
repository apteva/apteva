import React, { useState, useEffect } from "react";
import { CheckIcon } from "../common/Icons";
import type { Provider } from "../../types";

interface OnboardingWizardProps {
  onComplete: () => void;
}

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(1);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/providers")
      .then(res => res.json())
      .then(data => setProviders(data.providers || []));
  }, []);

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
      const saveData = await saveRes.json();

      if (!saveRes.ok) {
        setError(saveData.error || "Failed to save key");
      } else {
        setSuccess("API key saved successfully!");
        setApiKey("");
        const res = await fetch("/api/providers");
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
    await fetch("/api/onboarding/complete", { method: "POST" });
    onComplete();
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e0e0e0] font-mono flex items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="text-[#f97316] text-3xl">&gt;_</span>
            <span className="text-3xl tracking-wider">apteva</span>
          </div>
          <p className="text-[#666]">Run AI agents locally</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className={`w-3 h-3 rounded-full ${step >= 1 ? 'bg-[#f97316]' : 'bg-[#333]'}`} />
          <div className={`w-16 h-0.5 ${step >= 2 ? 'bg-[#f97316]' : 'bg-[#333]'}`} />
          <div className={`w-3 h-3 rounded-full ${step >= 2 ? 'bg-[#f97316]' : 'bg-[#333]'}`} />
        </div>

        <div className="bg-[#111] rounded-lg border border-[#1a1a1a] p-8">
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
        <p className="text-[#666] mb-6">
          Enter your API key below. It will be encrypted and stored locally.
        </p>

        <div className="mb-6">
          <div className="p-4 rounded border border-[#f97316] bg-[#f97316]/5 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{selectedProviderData.name}</p>
                <p className="text-sm text-[#666]">
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
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-4 py-3 focus:outline-none focus:border-[#f97316] text-lg"
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
            className="flex-1 border border-[#333] hover:border-[#666] px-4 py-3 rounded font-medium transition"
          >
            Back
          </button>
          <button
            onClick={onSaveKey}
            disabled={!apiKey || saving}
            className="flex-1 bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-3 rounded font-medium transition"
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
      <h2 className="text-2xl font-semibold mb-2">Welcome to Apteva</h2>
      <p className="text-[#666] mb-6">
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
        className="w-full bg-[#222] hover:bg-[#333] disabled:opacity-50 disabled:cursor-not-allowed px-4 py-3 rounded font-medium transition"
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
          ? 'border-[#f97316] bg-[#f97316]/5'
          : 'border-[#222] hover:border-[#333]'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{provider.name}</p>
          <p className="text-sm text-[#666]">
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
      <p className="text-[#666] mb-6">
        You've configured {configuredProviders.length} provider{configuredProviders.length > 1 ? 's' : ''}.
        You can add more providers later in Settings.
      </p>

      <div className="space-y-2 mb-6">
        {configuredProviders.map(provider => (
          <div key={provider.id} className="flex items-center gap-3 p-3 bg-[#0a0a0a] rounded">
            <CheckIcon className="w-5 h-5 text-green-400" />
            <span>{provider.name}</span>
            <span className="text-[#666] text-sm">({provider.keyHint})</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onAddMore}
          className="flex-1 border border-[#333] hover:border-[#f97316] px-4 py-3 rounded font-medium transition"
        >
          Add More
        </button>
        <button
          onClick={onComplete}
          className="flex-1 bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-3 rounded font-medium transition"
        >
          Start Using Apteva
        </button>
      </div>
    </>
  );
}
