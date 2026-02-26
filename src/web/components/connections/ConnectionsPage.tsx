import React, { useState } from "react";
import { OverviewTab } from "./OverviewTab";
import { TriggersTab } from "./TriggersTab";
import { IntegrationsTab } from "./IntegrationsTab";

type Tab = "overview" | "triggers" | "integrations";

export function ConnectionsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "triggers", label: "Triggers" },
    { id: "integrations", label: "Integrations" },
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Connections</h1>
            <p className="text-[var(--color-text-muted)]">
              Manage external app connections, triggers, and webhooks.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-1 w-fit">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded text-sm font-medium transition ${
                activeTab === tab.id
                  ? "bg-[var(--color-surface-raised)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === "overview" && <OverviewTab />}
        {activeTab === "triggers" && <TriggersTab />}
        {activeTab === "integrations" && <IntegrationsTab />}
      </div>
    </div>
  );
}
