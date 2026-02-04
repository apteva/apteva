import React from "react";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { MemoryIcon, TasksIcon, FilesIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon, MultiAgentIcon } from "../common/Icons";
import { useProjects } from "../../context";
import type { Provider, NewAgentForm, AgentFeatures, AgentMode, MultiAgentConfig } from "../../types";
import { getMultiAgentConfig } from "../../types";

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
  const selectedProvider = providers.find(p => p.id === form.provider);
  const [ollamaModels, setOllamaModels] = React.useState<Array<{ value: string; label: string }>>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = React.useState(false);

  // Fetch Ollama models when Ollama is selected
  React.useEffect(() => {
    if (form.provider === "ollama") {
      setLoadingOllamaModels(true);
      fetch("/api/providers/ollama/models")
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
        // Turning off
        onFormChange({ ...form, features: { ...form.features, agents: false } });
      } else {
        // Turning on with defaults - use project as group
        onFormChange({
          ...form,
          features: {
            ...form.features,
            agents: { enabled: true, mode: "worker" as AgentMode, group: form.projectId || undefined },
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

  // Get current agent mode
  const getAgentMode = (): AgentMode => {
    const config = getMultiAgentConfig(form.features, form.projectId);
    return config.mode || "worker";
  };

  // Set multi-agent mode
  const setAgentMode = (mode: AgentMode) => {
    const currentConfig = getMultiAgentConfig(form.features, form.projectId);
    onFormChange({
      ...form,
      features: {
        ...form.features,
        agents: { ...currentConfig, enabled: true, mode },
      },
    });
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
                className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
                placeholder="My Agent"
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
                <div className="text-sm text-[#666] py-2">Loading Ollama models...</div>
              ) : form.provider === "ollama" && modelOptions.length === 0 ? (
                <div className="text-sm text-yellow-400/80 py-2">
                  No models found. Run <code className="bg-[#1a1a1a] px-1 rounded">ollama pull llama3.3</code> to download a model.
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
                className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
              />
            </FormField>

            <FormField label="Features">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => {
                  const isEnabled = key === "agents" ? isAgentsEnabled() : !!form.features[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleFeature(key)}
                      className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                        isEnabled
                          ? "border-[#f97316] bg-[#f97316]/10"
                          : "border-[#222] hover:border-[#333]"
                      }`}
                    >
                      <Icon className={`w-5 h-5 flex-shrink-0 ${isEnabled ? "text-[#f97316]" : "text-[#666]"}`} />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium ${isEnabled ? "text-[#f97316]" : ""}`}>
                          {label}
                        </div>
                        <div className="text-xs text-[#666]">{description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </FormField>

            {/* Multi-Agent Mode Selection */}
            {isAgentsEnabled() && (
              <FormField label="Multi-Agent Mode">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setAgentMode("coordinator")}
                    className={`flex-1 p-3 rounded border text-left transition ${
                      getAgentMode() === "coordinator"
                        ? "border-[#f97316] bg-[#f97316]/10"
                        : "border-[#222] hover:border-[#333]"
                    }`}
                  >
                    <div className={`text-sm font-medium ${getAgentMode() === "coordinator" ? "text-[#f97316]" : ""}`}>
                      Coordinator
                    </div>
                    <div className="text-xs text-[#666]">Orchestrates and delegates</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAgentMode("worker")}
                    className={`flex-1 p-3 rounded border text-left transition ${
                      getAgentMode() === "worker"
                        ? "border-[#f97316] bg-[#f97316]/10"
                        : "border-[#222] hover:border-[#333]"
                    }`}
                  >
                    <div className={`text-sm font-medium ${getAgentMode() === "worker" ? "text-[#f97316]" : ""}`}>
                      Worker
                    </div>
                    <div className="text-xs text-[#666]">Receives delegated tasks</div>
                  </button>
                </div>
                {form.projectId && (
                  <p className="text-xs text-[#555] mt-2">
                    Group: Using project as agent group
                  </p>
                )}
              </FormField>
            )}

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
                  className={`flex items-center gap-2 px-3 py-2 rounded border transition ${
                    form.features.builtinTools?.webSearch
                      ? "border-[#f97316] bg-[#f97316]/10 text-[#f97316]"
                      : "border-[#222] hover:border-[#333] text-[#888]"
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
                  className={`flex items-center gap-2 px-3 py-2 rounded border transition ${
                    form.features.builtinTools?.webFetch
                      ? "border-[#f97316] bg-[#f97316]/10 text-[#f97316]"
                      : "border-[#222] hover:border-[#333] text-[#888]"
                  }`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                  </svg>
                  <span className="text-sm">Web Fetch</span>
                </button>
              </div>
              <p className="text-xs text-[#555] mt-2">
                Provider-native tools for real-time web access
              </p>
            </FormField>
            )}
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              className="flex-1 border border-[#333] hover:border-[#f97316] hover:text-[#f97316] px-4 py-2 rounded font-medium transition"
            >
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={!form.name}
              className="flex-1 bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-black px-4 py-2 rounded font-medium transition"
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
      <label className="block text-sm text-[#666] mb-1">{label}</label>
      {children}
    </div>
  );
}

function NoProvidersMessage({ onGoToSettings }: { onGoToSettings: () => void }) {
  return (
    <div className="text-center py-6">
      <p className="text-[#666] mb-4">No API keys configured. Add a provider key first.</p>
      <button
        onClick={onGoToSettings}
        className="bg-[#f97316] hover:bg-[#fb923c] text-black px-4 py-2 rounded font-medium transition"
      >
        Go to Settings
      </button>
    </div>
  );
}
