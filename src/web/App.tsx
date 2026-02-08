import React, { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import "@apteva/apteva-kit/styles.css";

// Types
import type { Agent, Provider, Route, NewAgentForm } from "./types";
import { DEFAULT_FEATURES } from "./types";

// Context
import { TelemetryProvider, AuthProvider, ProjectProvider, useAuth, useProjects, useAgentStatusChange } from "./context";

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
  SkillsPage,
  TestsPage,
  TelemetryPage,
  LoginPage,
} from "./components";
import { ApiDocsPage } from "./components/api/ApiDocsPage";
import { MetaAgentProvider, MetaAgentPanel } from "./components/meta-agent/MetaAgent";

function AppContent() {
  // Auth state
  const { isAuthenticated, isLoading: authLoading, hasUsers, accessToken, checkAuth } = useAuth();
  const { currentProjectId, refreshProjects } = useProjects();
  const statusChangeCounter = useAgentStatusChange();

  // Onboarding state
  const { isComplete: onboardingComplete, setIsComplete: setOnboardingComplete } = useOnboarding();

  // Helper to get auth headers
  const getAuthHeaders = (): Record<string, string> => {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  };

  // Data hooks - only fetch when authenticated and onboarding complete
  const shouldFetchData = isAuthenticated && onboardingComplete === true;

  const {
    agents,
    loading,
    runningCount,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    toggleAgent,
  } = useAgents(shouldFetchData);

  const {
    providers,
    configuredProviders,
    fetchProviders,
  } = useProviders(shouldFetchData);

  // Filter to only LLM providers for agent creation
  const llmProviders = configuredProviders.filter(p => p.type === "llm");

  // Project-scoped agent count (same logic as AgentsView)
  const filteredAgentCount = useMemo(() => {
    if (currentProjectId === null) return agents.length;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId).length;
    return agents.filter(a => a.projectId === currentProjectId).length;
  }, [agents, currentProjectId]);

  // UI state
  const [showCreate, setShowCreate] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [route, setRoute] = useState<Route>("dashboard");
  const [startError, setStartError] = useState<string | null>(null);
  const [taskCount, setTaskCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Fetch task count on telemetry status changes (project-scoped)
  useEffect(() => {
    if (!shouldFetchData) return;

    const fetchTaskCount = async () => {
      try {
        let url = "/api/tasks?status=pending";
        if (currentProjectId !== null) {
          url += `&project_id=${encodeURIComponent(currentProjectId)}`;
        }
        const res = await fetch(url, { headers: getAuthHeaders() });
        if (res.ok) {
          const data = await res.json();
          setTaskCount(data.count ?? (data.tasks || []).length);
        }
      } catch {
        // Ignore errors
      }
    };

    fetchTaskCount();
  }, [shouldFetchData, accessToken, currentProjectId, agents, statusChangeCounter]);

  // Form state
  const [newAgent, setNewAgent] = useState<NewAgentForm>({
    name: "",
    model: "",
    provider: "",
    systemPrompt: "You are a helpful assistant.",
    features: { ...DEFAULT_FEATURES },
    mcpServers: [],
    skills: [],
  });

  // Set default provider when providers are loaded
  useEffect(() => {
    if (llmProviders.length > 0 && !newAgent.provider) {
      const defaultProvider = llmProviders[0];
      const defaultModel = defaultProvider.models.find(m => m.recommended)?.value || defaultProvider.models[0]?.value || "";
      setNewAgent(prev => ({
        ...prev,
        provider: defaultProvider.id,
        model: defaultModel,
      }));
    }
  }, [llmProviders, newAgent.provider]);

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
    await refreshProjects(); // Refresh project agent counts
    const defaultProvider = llmProviders[0];
    const defaultModel = defaultProvider?.models.find(m => m.recommended)?.value || defaultProvider?.models[0]?.value || "";
    setNewAgent({
      name: "",
      model: defaultModel,
      provider: defaultProvider?.id || "",
      systemPrompt: "You are a helpful assistant.",
      features: { ...DEFAULT_FEATURES },
      mcpServers: [],
      skills: [],
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
    await refreshProjects(); // Refresh project agent counts
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
    // Refresh auth to pick up new state
    checkAuth();
  };

  // Show loading while checking auth
  if (authLoading || hasUsers === null) {
    return <LoadingSpinner fullScreen />;
  }

  // No users exist - show onboarding with account creation
  if (!hasUsers) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} needsAccount={true} />;
  }

  // Users exist but not authenticated - show login
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Show loading while checking onboarding
  if (onboardingComplete === null) {
    return <LoadingSpinner fullScreen />;
  }

  // Show onboarding if not complete (but already has account)
  if (!onboardingComplete) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} needsAccount={false} />;
  }

  return (
    <div className="h-screen bg-[#0a0a0a] text-[#e0e0e0] font-mono flex flex-col overflow-hidden">
      <Header onMenuClick={() => setMobileMenuOpen(true)} />

      {startError && (
        <ErrorBanner message={startError} onDismiss={() => setStartError(null)} />
      )}

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          route={route}
          agentCount={filteredAgentCount}
          taskCount={taskCount}
          onNavigate={handleNavigate}
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
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
              onNewAgent={() => setShowCreate(true)}
              canCreateAgent={llmProviders.length > 0}
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

          {route === "skills" && <SkillsPage />}

          {route === "tests" && <TestsPage />}

          {route === "telemetry" && <TelemetryPage />}

          {route === "api" && <ApiDocsPage />}
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

      {/* Meta Agent - side drawer */}
      <MetaAgentPanel />
    </div>
  );
}

// Wrapper component that provides all contexts
function App() {
  return (
    <AuthProvider>
      <ProjectProvider>
        <MetaAgentProvider>
          <TelemetryProvider>
            <AppContent />
          </TelemetryProvider>
        </MetaAgentProvider>
      </ProjectProvider>
    </AuthProvider>
  );
}

// Mount the app
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
