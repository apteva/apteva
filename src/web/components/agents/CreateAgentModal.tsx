import React from "react";
import { Modal } from "../common/Modal";
import { Select } from "../common/Select";
import type { Provider, NewAgentForm } from "../../types";

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
