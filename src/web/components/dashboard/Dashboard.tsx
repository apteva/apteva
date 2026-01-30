import React from "react";
import type { Agent, Provider, Route } from "../../types";

interface DashboardProps {
  agents: Agent[];
  loading: boolean;
  runningCount: number;
  configuredProviders: Provider[];
  onNavigate: (route: Route) => void;
  onSelectAgent: (agent: Agent) => void;
}

export function Dashboard({
  agents,
  loading,
  runningCount,
  configuredProviders,
  onNavigate,
  onSelectAgent,
}: DashboardProps) {
  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Total Agents" value={agents.length} />
        <StatCard label="Running" value={runningCount} color="text-[#3b82f6]" />
        <StatCard label="Providers" value={configuredProviders.length} color="text-[#f97316]" />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Agents List */}
        <DashboardCard
          title="Agents"
          actionLabel="View All"
          onAction={() => onNavigate("agents")}
        >
          {loading ? (
            <div className="p-4 text-center text-[#666]">Loading...</div>
          ) : agents.length === 0 ? (
            <div className="p-4 text-center text-[#666]">No agents yet</div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {agents.slice(0, 5).map((agent) => (
                <div
                  key={agent.id}
                  onClick={() => onSelectAgent(agent)}
                  className="px-4 py-3 hover:bg-[#1a1a1a] cursor-pointer flex items-center justify-between"
                >
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-sm text-[#666]">{agent.provider}</p>
                  </div>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      agent.status === "running" ? "bg-[#3b82f6]" : "bg-[#444]"
                    }`}
                  />
                </div>
              ))}
            </div>
          )}
        </DashboardCard>

        {/* Configured Providers */}
        <DashboardCard
          title="Providers"
          actionLabel="Manage"
          onAction={() => onNavigate("settings")}
        >
          {configuredProviders.length === 0 ? (
            <div className="p-4 text-center text-[#666]">
              <p>No providers configured</p>
              <button
                onClick={() => onNavigate("settings")}
                className="text-[#f97316] hover:underline mt-1"
              >
                Add API Key
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {configuredProviders.map((provider) => (
                <div key={provider.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="font-medium">{provider.name}</p>
                    <p className="text-sm text-[#666]">{provider.models.length} models</p>
                  </div>
                  <span className="text-green-400 text-sm">{provider.keyHint}</span>
                </div>
              ))}
            </div>
          )}
        </DashboardCard>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  color?: string;
}

function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className="bg-[#111] rounded p-4 border border-[#1a1a1a]">
      <p className="text-sm text-[#666] mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color || ''}`}>{value}</p>
    </div>
  );
}

interface DashboardCardProps {
  title: string;
  actionLabel: string;
  onAction: () => void;
  children: React.ReactNode;
}

function DashboardCard({ title, actionLabel, onAction, children }: DashboardCardProps) {
  return (
    <div className="bg-[#111] rounded border border-[#1a1a1a] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        <button
          onClick={onAction}
          className="text-sm text-[#3b82f6] hover:text-[#60a5fa]"
        >
          {actionLabel}
        </button>
      </div>
      {children}
    </div>
  );
}
