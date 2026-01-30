import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@apteva/apteva-kit/styles.css";

// Types
import type { Agent, Provider, Route, NewAgentForm } from "./types";
import { DEFAULT_FEATURES } from "./types";

// Context
import { TelemetryProvider } from "./context";

// Hooks
import { useAgents, useProviders, useOnboarding } from "./hooks";

// Components
import {
  LoadingSpinner,
  Header,
  Sidebar,
  ErrorBanner,
  OnboardingWizard,
  SettingsPage,
  CreateAgentModal,
  AgentsView,
  Dashboard,
  TasksPage,
  McpPage,
  TelemetryPage,
} from "./components";

function App() {
  // Onboarding state
  const { isComplete: onboardingComplete, setIsComplete: setOnboardingComplete } = useOnboarding();

  // Data hooks
  const {
    agents,
    loading,
    runningCount,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgent,
  } = useAgents(onboardingComplete === true);

  const {
    providers,
    configuredProviders,
    fetchProviders,
  } = useProviders(onboardingComplete === true);

  // UI state
  const [showCreate, setShowCreate] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [route, setRoute] = useState<Route>("dashboard");
  const [startError, setStartError] = useState<string | null>(null);
  const [taskCount, setTaskCount] = useState(0);

  // Fetch task count periodically
  useEffect(() => {
    if (onboardingComplete !== true) return;

    const fetchTaskCount = async () => {
      try {
        const res = await fetch("/api/tasks?status=pending");
        if (res.ok) {
          const data = await res.json();
          setTaskCount(data.count || 0);
        }
      } catch {
        // Ignore errors
      }
    };

    fetchTaskCount();
    const interval = setInterval(fetchTaskCount, 15000);
    return () => clearInterval(interval);
  }, [onboardingComplete]);

  // Form state
  const [newAgent, setNewAgent] = useState<NewAgentForm>({
    name: "",
    model: "",
    provider: "",
    systemPrompt: "You are a helpful assistant.",
    features: { ...DEFAULT_FEATURES },
  });

  // Set default provider when providers are loaded
  useEffect(() => {
    if (configuredProviders.length > 0 && !newAgent.provider) {
      const defaultProvider = configuredProviders[0];
      const defaultModel = defaultProvider.models.find(m => m.recommended)?.value || defaultProvider.models[0]?.value || "";
      setNewAgent(prev => ({
        ...prev,
        provider: defaultProvider.id,
        model: defaultModel,
      }));
    }
  }, [configuredProviders, newAgent.provider]);

  // Update selected agent when agents list changes
  useEffect(() => {
    if (selectedAgent) {
      const updated = agents.find(a => a.id === selectedAgent.id);
      if (updated) {
        setSelectedAgent(updated);
      } else {
        setSelectedAgent(null);
      }
    }
  }, [agents, selectedAgent]);

  const handleProviderChange = (providerId: string) => {
    const provider = providers.find(p => p.id === providerId);
    const defaultModel = provider?.models.find(m => m.recommended)?.value || provider?.models[0]?.value || "";
    setNewAgent(prev => ({
      ...prev,
      provider: providerId,
      model: defaultModel,
    }));
  };

  const handleCreateAgent = async () => {
    if (!newAgent.name) return;
    await createAgent(newAgent);
    const defaultProvider = configuredProviders[0];
    const defaultModel = defaultProvider?.models.find(m => m.recommended)?.value || defaultProvider?.models[0]?.value || "";
    setNewAgent({
      name: "",
      model: defaultModel,
      provider: defaultProvider?.id || "",
      systemPrompt: "You are a helpful assistant.",
      features: { ...DEFAULT_FEATURES },
    });
    setShowCreate(false);
  };

  const handleToggleAgent = async (agent: Agent, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setStartError(null);
    const result = await toggleAgent(agent);
    if (result.error) {
      setStartError(result.error);
    }
  };

  const handleDeleteAgent = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (selectedAgent?.id === id) {
      setSelectedAgent(null);
    }
    await deleteAgent(id);
  };

  const handleSelectAgent = (agent: Agent) => {
    setSelectedAgent(agent);
    setStartError(null);
    setRoute("agents");
  };

  const handleNavigate = (newRoute: Route) => {
    setRoute(newRoute);
    setSelectedAgent(null);
  };

  const handleOnboardingComplete = () => {
    setOnboardingComplete(true);
    fetchProviders();
  };

  // Show loading while checking onboarding
  if (onboardingComplete === null) {
    return <LoadingSpinner fullScreen />;
  }

  // Show onboarding if not complete
  if (!onboardingComplete) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />;
  }

  return (
    <div className="h-screen bg-[#0a0a0a] text-[#e0e0e0] font-mono flex flex-col overflow-hidden">
      <Header
        onNewAgent={() => setShowCreate(true)}
        canCreateAgent={configuredProviders.length > 0}
      />

      {startError && (
        <ErrorBanner message={startError} onDismiss={() => setStartError(null)} />
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          route={route}
          agentCount={agents.length}
          taskCount={taskCount}
          onNavigate={handleNavigate}
        />

        <main className="flex-1 overflow-hidden flex">
          {route === "settings" && <SettingsPage />}

          {route === "agents" && (
            <AgentsView
              agents={agents}
              loading={loading}
              selectedAgent={selectedAgent}
              providers={providers}
              onSelectAgent={handleSelectAgent}
              onCloseAgent={() => setSelectedAgent(null)}
              onToggleAgent={handleToggleAgent}
              onDeleteAgent={handleDeleteAgent}
              onUpdateAgent={updateAgent}
            />
          )}

          {route === "dashboard" && (
            <Dashboard
              agents={agents}
              loading={loading}
              runningCount={runningCount}
              configuredProviders={configuredProviders}
              onNavigate={handleNavigate}
              onSelectAgent={handleSelectAgent}
            />
          )}

          {route === "tasks" && <TasksPage />}

          {route === "mcp" && <McpPage />}

          {route === "telemetry" && <TelemetryPage />}
        </main>
      </div>

      {showCreate && (
        <CreateAgentModal
          form={newAgent}
          providers={providers}
          configuredProviders={configuredProviders}
          onFormChange={setNewAgent}
          onProviderChange={handleProviderChange}
          onCreate={handleCreateAgent}
          onClose={() => setShowCreate(false)}
          onGoToSettings={() => {
            setShowCreate(false);
            setRoute("settings");
          }}
        />
      )}
    </div>
  );
}

// Mount the app
const root = createRoot(document.getElementById("root")!);
root.render(
  <TelemetryProvider>
    <App />
  </TelemetryProvider>
);
