import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "@apteva/apteva-kit";
import "@apteva/apteva-kit/styles.css";

// Types
import type { Agent, Provider, Route, NewAgentForm } from "./types";
import { DEFAULT_FEATURES } from "./types";

// Context
import { TelemetryProvider, AuthProvider, ProjectProvider, ThemeProvider, useTheme, useAuth, useProjects, useAgentStatusChange, useTaskChange } from "./context";

// Hooks
import { useAgents, useProviders, useOnboarding } from "./hooks";

// Core components (always needed)
import {
  LoadingSpinner,
  Header,
  Sidebar,
  ErrorBanner,
  OnboardingWizard,
  CreateAgentModal,
  AgentsView,
  Dashboard,
  LoginPage,
} from "./components";
import { MetaAgentProvider, MetaAgentPanel } from "./components/meta-agent/MetaAgent";

// Lazy-loaded page components (only loaded when navigated to)
const SettingsPage = lazy(() => import("./components/settings/SettingsPage").then(m => ({ default: m.SettingsPage })));
const TasksPage = lazy(() => import("./components/tasks/TasksPage").then(m => ({ default: m.TasksPage })));
const McpPage = lazy(() => import("./components/mcp/McpPage").then(m => ({ default: m.McpPage })));
const SkillsPage = lazy(() => import("./components/skills/SkillsPage").then(m => ({ default: m.SkillsPage })));
const TestsPage = lazy(() => import("./components/tests/TestsPage").then(m => ({ default: m.TestsPage })));
const ThreadsPage = lazy(() => import("./components/threads/ThreadsPage").then(m => ({ default: m.ThreadsPage })));
const TelemetryPage = lazy(() => import("./components/telemetry/TelemetryPage").then(m => ({ default: m.TelemetryPage })));
const ConnectionsPage = lazy(() => import("./components/connections/ConnectionsPage").then(m => ({ default: m.ConnectionsPage })));
const ActivityPage = lazy(() => import("./components/activity/ActivityPage").then(m => ({ default: m.ActivityPage })));
const ApiDocsPage = lazy(() => import("./components/api/ApiDocsPage").then(m => ({ default: m.ApiDocsPage })));

function AppContent() {
  // Auth state
  const { isAuthenticated, isLoading: authLoading, hasUsers, accessToken, checkAuth } = useAuth();
  const { currentProjectId, refreshProjects } = useProjects();
  const statusChangeCounter = useAgentStatusChange();
  const taskChangeCounter = useTaskChange();

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
  } = useAgents(shouldFetchData, currentProjectId);

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
  }, [shouldFetchData, accessToken, currentProjectId, statusChangeCounter, taskChangeCounter]);

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
    <div className="h-screen font-mono flex flex-col overflow-hidden" style={{ backgroundColor: "var(--color-bg)", color: "var(--color-text)" }}>
      <Header onMenuClick={() => setMobileMenuOpen(true)} agents={agents} />

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
          <Suspense fallback={<LoadingSpinner />}>
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

          {route === "threads" && (
            <ThreadsPage
              agents={agents}
              onNavigate={setRoute}
            />
          )}

          {route === "activity" && (
            <ActivityPage
              agents={agents}
              loading={loading}
              onNavigate={handleNavigate}
            />
          )}

          {route === "tasks" && <TasksPage />}

          {route === "connections" && <ConnectionsPage />}

          {route === "mcp" && <McpPage />}

          {route === "skills" && <SkillsPage />}

          {route === "tests" && <TestsPage />}

          {route === "telemetry" && <TelemetryPage />}

          {route === "api" && <ApiDocsPage />}
          </Suspense>
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

// ==================== Share Page (public, no auth) ====================
function SharePage({ token }: { token: string }) {
  const { theme } = useTheme();
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");
  const [agentName, setAgentName] = useState("Agent");

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`/share/${token}/info`);
        if (res.ok) {
          const data = await res.json();
          setAgentName(data.name || "Agent");
          setStatus(data.status === "running" ? "online" : "offline");
        } else {
          setStatus("offline");
        }
      } catch {
        setStatus("offline");
      }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, [token]);

  if (status === "checking") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center" style={{ backgroundColor: "var(--color-bg)" }}>
        <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>Connecting...</div>
      </div>
    );
  }

  if (status === "offline") {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center" style={{ backgroundColor: "var(--color-bg)" }}>
        <div className="text-center">
          <div className="w-2.5 h-2.5 rounded-full mx-auto mb-3" style={{ backgroundColor: "var(--color-text-muted)" }} />
          <div className="text-base font-semibold mb-1.5" style={{ color: "var(--color-text)" }}>{agentName}</div>
          <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>This agent is currently offline</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-0 md:p-4" style={{ backgroundColor: "var(--color-bg)" }}>
      <div className="w-full max-w-[640px] h-[100dvh] md:h-[calc(100dvh-32px)] md:max-h-[800px] md:rounded-xl overflow-hidden md:border flex flex-col" style={{ backgroundColor: "var(--color-bg)", borderColor: "var(--color-border)" }}>
        <Chat
          agentId="default"
          apiUrl={`/share/${token}`}
          placeholder="Type a message..."
          variant="terminal"
          theme={theme.id as "light" | "dark"}
          headerTitle={agentName}
          enableMarkdown
          enableWidgets
          availableWidgets={["form", "kpi"]}
        />
      </div>
    </div>
  );
}

// Wrapper component that provides all contexts
function App() {
  // Check if this is a /share/:token URL — render public share page without auth
  const shareMatch = window.location.pathname.match(/^\/share\/([a-f0-9]{32})$/);
  if (shareMatch) {
    return (
      <ThemeProvider>
        <SharePage token={shareMatch[1]} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <ProjectProvider>
          <MetaAgentProvider>
            <TelemetryProvider>
              <AppContent />
            </TelemetryProvider>
          </MetaAgentProvider>
        </ProjectProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

// Mount the app
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
