import React from "react";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { MemoryIcon, TasksIcon, FilesIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, MultiAgentIcon } from "../common/Icons";
import { useProjects, useAuth } from "../../context";
import type { Provider, NewAgentForm, AgentFeatures, MultiAgentConfig, RealtimeConfig } from "../../types";
import { getMultiAgentConfig, getRealtimeConfig, isRealtimeEnabled, REALTIME_PROVIDERS } from "../../types";

interface CreateAgentModalProps {
  form: NewAgentForm;
  providers: Provider[];
  configuredProviders: Provider[];
  onFormChange: (form: NewAgentForm) => void;
  onProviderChange: (providerId: string) => void;
  onCreate: () => void;
  onClose: () => void;
  onGoToSettings: () => void;
}

const FEATURE_CONFIG = [
  { key: "memory" as keyof AgentFeatures, label: "Memory", description: "Persistent recall", icon: MemoryIcon },
  { key: "tasks" as keyof AgentFeatures, label: "Tasks", description: "Schedule and execute tasks", icon: TasksIcon },
  { key: "files" as keyof AgentFeatures, label: "Files", description: "File storage and management", icon: FilesIcon },
  { key: "vision" as keyof AgentFeatures, label: "Vision", description: "Process images and PDFs", icon: VisionIcon },
  { key: "operator" as keyof AgentFeatures, label: "Operator", description: "Browser automation", icon: OperatorIcon },
  { key: "mcp" as keyof AgentFeatures, label: "MCP", description: "External tools/services", icon: McpIcon },
  { key: "realtime" as keyof AgentFeatures, label: "Realtime", description: "Voice conversations", icon: RealtimeIcon },
  { key: "agents" as keyof AgentFeatures, label: "Multi-Agent", description: "Communicate with peer agents", icon: MultiAgentIcon },
];

export function CreateAgentModal({
  form,
  providers,
  configuredProviders,
  onFormChange,
  onProviderChange,
  onCreate,
  onClose,
  onGoToSettings,
}: CreateAgentModalProps) {
  const { projects, currentProjectId } = useProjects();
  const { authFetch } = useAuth();
  const selectedProvider = providers.find(p => p.id === form.provider);
  const [ollamaModels, setOllamaModels] = React.useState<Array<{ value: string; label: string }>>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = React.useState(false);

  // Fetch Ollama models when Ollama is selected
  React.useEffect(() => {
    if (form.provider === "ollama") {
      setLoadingOllamaModels(true);
      authFetch("/api/providers/ollama/models")
        .then(res => res.json())
        .then(data => {
          if (data.models && data.models.length > 0) {
            setOllamaModels(data.models.map((m: { value: string; label?: string }) => ({
              value: m.value,
              label: m.label || m.value,
            })));
            // Auto-select first model if none selected
            if (!form.model && data.models.length > 0) {
              onFormChange({ ...form, model: data.models[0].value });
            }
          }
        })
        .catch(() => setOllamaModels([]))
        .finally(() => setLoadingOllamaModels(false));
    }
  }, [form.provider]);

  const providerOptions = configuredProviders
    .filter(p => p.type === "llm")
    .map(p => ({
      value: p.id,
      label: p.name,
    }));

  // Use dynamic Ollama models if available, otherwise use provider's default models
  const modelOptions = form.provider === "ollama" && ollamaModels.length > 0
    ? ollamaModels
    : selectedProvider?.models.map(m => ({
        value: m.value,
        label: m.label,
        recommended: m.recommended,
      })) || [];

  const projectOptions = projects.map(p => ({ value: p.id, label: p.name }));

  // Set default project from current selection (but not "unassigned" or "all")
  React.useEffect(() => {
    if (form.projectId === undefined && currentProjectId && currentProjectId !== "unassigned") {
      onFormChange({ ...form, projectId: currentProjectId });
    }
  }, [currentProjectId]);

  const toggleFeature = (key: keyof AgentFeatures) => {
    if (key === "agents") {
      // Special handling for agents feature
      const isEnabled = typeof form.features.agents === "boolean"
        ? form.features.agents
        : (form.features.agents as MultiAgentConfig)?.enabled ?? false;
      if (isEnabled) {
        onFormChange({ ...form, features: { ...form.features, agents: false } });
      } else {
        onFormChange({
          ...form,
          features: {
            ...form.features,
            agents: { enabled: true, group: form.projectId || undefined },
          },
        });
      }
    } else if (key === "realtime") {
      // Special handling for realtime feature
      if (isRealtimeEnabled(form.features)) {
        onFormChange({ ...form, features: { ...form.features, realtime: false } });
      } else {
        onFormChange({
          ...form,
          features: {
            ...form.features,
            realtime: { enabled: true },
          },
        });
      }
    } else {
      onFormChange({
        ...form,
        features: {
          ...form.features,
          [key]: !form.features[key],
        },
      });
    }
  };

  // Helper to check if agents feature is enabled
  const isAgentsEnabled = () => {
    const agentsVal = form.features.agents;
    if (typeof agentsVal === "boolean") return agentsVal;
    return (agentsVal as MultiAgentConfig)?.enabled ?? false;
  };


  return (
    <Modal>
      <h2 className="text-xl font-semibold mb-4">Create New Agent</h2>

      {providerOptions.length === 0 ? (
        <NoProvidersMessage onGoToSettings={onGoToSettings} />
      ) : (
        <>
          <div className="space-y-4">
            <FormField label="Name">
              <input
                type="text"
                value={form.name}
                onChange={(e) => onFormChange({ ...form, name: e.target.value })}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]"
                placeholder="My Agent"
              />
            </FormField>

            <FormField label="Description">
              <input
                type="text"
                value={form.description}
                onChange={(e) => onFormChange({ ...form, description: e.target.value })}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]"
                placeholder="Short description of what this agent does"
              />
            </FormField>

            {projects.length > 0 && (
              <FormField label="Project">
                <Select
                  value={form.projectId || ""}
                  options={projectOptions}
                  onChange={(value) => onFormChange({ ...form, projectId: value || null })}
                  placeholder="Select project..."
                />
              </FormField>
            )}

            <FormField label="Provider">
              <Select
                value={form.provider}
                options={providerOptions}
                onChange={onProviderChange}
                placeholder="Select provider..."
              />
            </FormField>

            <FormField label="Model">
              {loadingOllamaModels ? (
                <div className="text-sm text-[var(--color-text-muted)] py-2">Loading Ollama models...</div>
              ) : form.provider === "ollama" && modelOptions.length === 0 ? (
                <div className="text-sm text-yellow-400/80 py-2">
                  No models found. Run <code className="bg-[var(--color-surface-raised)] px-1 rounded">ollama pull llama3.3</code> to download a model.
                </div>
              ) : (
                <Select
                  value={form.model}
                  options={modelOptions}
                  onChange={(value) => onFormChange({ ...form, model: value })}
                  placeholder="Select model..."
                />
              )}
            </FormField>

            <FormField label="System Prompt">
              <textarea
                value={form.systemPrompt}
                onChange={(e) => onFormChange({ ...form, systemPrompt: e.target.value })}
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[var(--color-accent)] text-[var(--color-text)]"
              />
            </FormField>

            <FormField label="Features">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => {
                  const isEnabled = key === "agents" ? isAgentsEnabled()
                    : key === "realtime" ? isRealtimeEnabled(form.features)
                    : !!form.features[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleFeature(key)}
                      className={`flex items-center gap-3 p-3 btn border text-left transition ${
                        isEnabled
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-10)]"
                          : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)]"
                      }`}
                    >
                      <Icon className={`w-5 h-5 flex-shrink-0 ${isEnabled ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium ${isEnabled ? "text-[var(--color-accent)]" : ""}`}>
                          {label}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)]">{description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </FormField>

            {/* Voice Configuration - shown when Realtime is enabled */}
            {isRealtimeEnabled(form.features) && (() => {
              const rtConfig = getRealtimeConfig(form.features);
              const hasOpenAI = providers.some(p => p.id === "openai" && p.hasKey);
              const hasGemini = providers.some(p => p.id === "gemini" && p.hasKey);
              const voiceProviders = providers.filter(p => p.type === "voice" && p.hasKey);
              const hasStandard = voiceProviders.length > 0;
              const currentMode = rtConfig.provider || "standard";

              const updateRt = (updates: Partial<RealtimeConfig>) => {
                onFormChange({
                  ...form,
                  features: {
                    ...form.features,
                    realtime: { ...rtConfig, ...updates },
                  },
                });
              };

              // STT/TTS options for standard mode
              const sttOptions = voiceProviders
                .filter(p => !(p as any).voiceSubtype || (p as any).voiceSubtype === "stt" || (p as any).voiceSubtype === "both")
                .map(p => ({ value: p.id, label: p.name }));
              const ttsOptions = voiceProviders
                .filter(p => !(p as any).voiceSubtype || (p as any).voiceSubtype === "tts" || (p as any).voiceSubtype === "both")
                .map(p => ({ value: p.id, label: p.name }));

              return (
                <div className="p-3 bg-[var(--color-surface)] rounded border border-[var(--color-border-light)] space-y-3">
                  <p className="text-xs text-[var(--color-text-muted)] font-medium uppercase tracking-wider">Voice Configuration</p>

                  {/* Voice Mode Selection */}
                  <FormField label="Voice Mode">
                    <div className="flex gap-2 flex-wrap">
                      {hasOpenAI && (
                        <button type="button" onClick={() => updateRt({ provider: "openai", model: "gpt-realtime", voice: "alloy" })}
                          className={`px-3 py-1.5 text-sm btn border transition ${currentMode === "openai" ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]" : "border-[var(--color-border-light)]"}`}>
                          OpenAI Realtime
                        </button>
                      )}
                      {hasGemini && (
                        <button type="button" onClick={() => updateRt({ provider: "gemini", geminiVoice: "Kore" })}
                          className={`px-3 py-1.5 text-sm btn border transition ${currentMode === "gemini" ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]" : "border-[var(--color-border-light)]"}`}>
                          Gemini Live
                        </button>
                      )}
                      {hasStandard && (
                        <button type="button" onClick={() => updateRt({ provider: "standard" })}
                          className={`px-3 py-1.5 text-sm btn border transition ${currentMode === "standard" ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]" : "border-[var(--color-border-light)]"}`}>
                          Standard (STT+LLM+TTS)
                        </button>
                      )}
                    </div>
                  </FormField>

                  {/* OpenAI Realtime options */}
                  {currentMode === "openai" && (
                    <>
                      <FormField label="Realtime Model">
                        <Select
                          value={rtConfig.model || "gpt-realtime"}
                          options={REALTIME_PROVIDERS.openai.models.map(m => ({ value: m.value, label: m.label, recommended: m.recommended }))}
                          onChange={(value) => updateRt({ model: value })}
                          placeholder="Select model..."
                        />
                      </FormField>
                      <FormField label="Voice">
                        <Select
                          value={rtConfig.voice || "alloy"}
                          options={REALTIME_PROVIDERS.openai.voices.map(v => ({ value: v.value, label: v.label, recommended: v.recommended }))}
                          onChange={(value) => updateRt({ voice: value })}
                          placeholder="Select voice..."
                        />
                      </FormField>
                    </>
                  )}

                  {/* Gemini Live options */}
                  {currentMode === "gemini" && (
                    <>
                      <FormField label="Realtime Model">
                        <Select
                          value={rtConfig.geminiModel || REALTIME_PROVIDERS.gemini.models[0].value}
                          options={REALTIME_PROVIDERS.gemini.models.map(m => ({ value: m.value, label: m.label, recommended: m.recommended }))}
                          onChange={(value) => updateRt({ geminiModel: value })}
                          placeholder="Select model..."
                        />
                      </FormField>
                      <FormField label="Voice">
                        <Select
                          value={rtConfig.geminiVoice || "Kore"}
                          options={REALTIME_PROVIDERS.gemini.voices.map(v => ({ value: v.value, label: v.label, recommended: v.recommended }))}
                          onChange={(value) => updateRt({ geminiVoice: value })}
                          placeholder="Select voice..."
                        />
                      </FormField>
                      <div className="flex items-center gap-2">
                        <button type="button"
                          onClick={() => updateRt({ googleSearch: !rtConfig.googleSearch })}
                          className={`flex items-center gap-2 px-3 py-1.5 text-sm btn border transition ${rtConfig.googleSearch ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]" : "border-[var(--color-border-light)]"}`}>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                          Google Search
                        </button>
                        <span className="text-xs text-[var(--color-text-faint)]">Enable search grounding</span>
                      </div>
                    </>
                  )}

                  {/* Standard mode: STT + TTS provider selection */}
                  {currentMode === "standard" && (
                    <>
                      {sttOptions.length > 0 && (
                        <FormField label="STT Provider">
                          <Select
                            value={rtConfig.sttProvider || (sttOptions[0]?.value ?? "")}
                            options={sttOptions}
                            onChange={(value) => updateRt({ sttProvider: value })}
                            placeholder="Select STT provider..."
                          />
                        </FormField>
                      )}
                      {ttsOptions.length > 0 && (
                        <FormField label="TTS Provider">
                          <Select
                            value={rtConfig.ttsProvider || (ttsOptions[0]?.value ?? "")}
                            options={ttsOptions}
                            onChange={(value) => updateRt({ ttsProvider: value })}
                            placeholder="Select TTS provider..."
                          />
                        </FormField>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Agent Built-in Tools - Anthropic only */}
            {form.provider === "anthropic" && (
            <FormField label="Agent Built-in Tools">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onFormChange({
                    ...form,
                    features: {
                      ...form.features,
                      builtinTools: {
                        ...form.features.builtinTools,
                        webSearch: !form.features.builtinTools?.webSearch,
                      },
                    },
                  })}
                  className={`flex items-center gap-2 px-3 py-2 btn border transition ${
                    form.features.builtinTools?.webSearch
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]"
                      : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)] text-[var(--color-text-secondary)]"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <span className="text-sm">Web Search</span>
                </button>
                <button
                  type="button"
                  onClick={() => onFormChange({
                    ...form,
                    features: {
                      ...form.features,
                      builtinTools: {
                        ...form.features.builtinTools,
                        webFetch: !form.features.builtinTools?.webFetch,
                      },
                    },
                  })}
                  className={`flex items-center gap-2 px-3 py-2 btn border transition ${
                    form.features.builtinTools?.webFetch
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-10)] text-[var(--color-accent)]"
                      : "border-[var(--color-border-light)] hover:border-[var(--color-border-light)] text-[var(--color-text-secondary)]"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  <span className="text-sm">Web Fetch</span>
                </button>
              </div>
              <p className="text-xs text-[var(--color-text-faint)] mt-2">
                Provider-native tools for real-time web access
              </p>
            </FormField>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              className="flex-1 border border-[var(--color-border-light)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] px-4 py-2 btn font-medium transition"
            >
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={!form.name}
              className="flex-1 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-black px-4 py-2 btn font-medium transition"
            >
              Create
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-[var(--color-text-muted)] mb-1">{label}</label>
      {children}
    </div>
  );
}

function NoProvidersMessage({ onGoToSettings }: { onGoToSettings: () => void }) {
  return (
    <div className="text-center py-6">
      <p className="text-[var(--color-text-muted)] mb-4">No API keys configured. Add a provider key first.</p>
      <button
        onClick={onGoToSettings}
        className="bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-black px-4 py-2 rounded font-medium transition"
      >
        Go to Settings
      </button>
    </div>
  );
}
