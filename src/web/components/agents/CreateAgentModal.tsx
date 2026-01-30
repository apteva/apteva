import React from "react";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import { MemoryIcon, TasksIcon, VisionIcon, OperatorIcon, McpIcon, RealtimeIcon } from "../common/Icons";
import type { Provider, NewAgentForm, AgentFeatures } from "../../types";

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
  { key: "memory" as keyof AgentFeatures, label: "Memory", description: "Remember information across conversations", icon: MemoryIcon },
  { key: "tasks" as keyof AgentFeatures, label: "Tasks", description: "Create and execute scheduled tasks", icon: TasksIcon },
  { key: "vision" as keyof AgentFeatures, label: "Vision", description: "Process images and PDFs", icon: VisionIcon },
  { key: "operator" as keyof AgentFeatures, label: "Operator", description: "Browser automation (computer use)", icon: OperatorIcon },
  { key: "mcp" as keyof AgentFeatures, label: "MCP", description: "Connect to external tools and services", icon: McpIcon },
  { key: "realtime" as keyof AgentFeatures, label: "Realtime", description: "Voice conversations", icon: RealtimeIcon },
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
  const selectedProvider = providers.find(p => p.id === form.provider);

  const providerOptions = configuredProviders.map(p => ({
    value: p.id,
    label: p.name,
  }));

  const modelOptions = selectedProvider?.models.map(m => ({
    value: m.value,
    label: m.label,
    recommended: m.recommended,
  })) || [];

  const toggleFeature = (key: keyof AgentFeatures) => {
    onFormChange({
      ...form,
      features: {
        ...form.features,
        [key]: !form.features[key],
      },
    });
  };

  return (
    <Modal>
      <h2 className="text-xl font-semibold mb-4">Create New Agent</h2>

      {configuredProviders.length === 0 ? (
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

            <FormField label="Provider">
              <Select
                value={form.provider}
                options={providerOptions}
                onChange={onProviderChange}
                placeholder="Select provider..."
              />
            </FormField>

            <FormField label="Model">
              <Select
                value={form.model}
                options={modelOptions}
                onChange={(value) => onFormChange({ ...form, model: value })}
                placeholder="Select model..."
              />
            </FormField>

            <FormField label="System Prompt">
              <textarea
                value={form.systemPrompt}
                onChange={(e) => onFormChange({ ...form, systemPrompt: e.target.value })}
                className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 h-24 resize-none focus:outline-none focus:border-[#f97316] text-[#e0e0e0]"
              />
            </FormField>

            <FormField label="Features">
              <div className="grid grid-cols-2 gap-2">
                {FEATURE_CONFIG.map(({ key, label, description, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleFeature(key)}
                    className={`flex items-center gap-3 p-3 rounded border text-left transition ${
                      form.features[key]
                        ? "border-[#f97316] bg-[#f97316]/10"
                        : "border-[#222] hover:border-[#333]"
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${form.features[key] ? "text-[#f97316]" : "text-[#666]"}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${form.features[key] ? "text-[#f97316]" : ""}`}>
                        {label}
                      </div>
                      <div className="text-xs text-[#666] truncate">{description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </FormField>
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
