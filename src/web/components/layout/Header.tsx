import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTelemetryContext, useAuth, useAuthHeaders, useProjects, useNotificationChange } from "../../context";
import { MenuIcon, ChevronDownIcon, BellIcon } from "../common/Icons";
import { MetaAgentButton } from "../meta-agent/MetaAgent";

interface Notification {
  id: string;
  agent_id: string;
  timestamp: string;
  category: string;
  type: string;
  level: string;
  error: string | null;
  data: Record<string, unknown> | null;
  seen?: boolean;
}

interface HeaderProps {
  onMenuClick?: () => void;
  agents?: Array<{ id: string; name: string; projectId: string | null }>;
}

export function Header({ onMenuClick, agents = [] }: HeaderProps) {
  const { connected } = useTelemetryContext();
  const authHeaders = useAuthHeaders();
  const { projects, currentProjectId, currentProject, setCurrentProjectId, unassignedCount, projectsEnabled } = useProjects();
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const notificationChange = useNotificationChange();
  const { events } = useTelemetryContext();
  const { accessToken } = useAuth();
  const fetchedOnce = useRef(false);

  const agentNames = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  // Set of agent IDs matching the current project filter
  const projectAgentIds = React.useMemo(() => {
    if (!projectsEnabled || currentProjectId === null) return null; // null = show all
    if (currentProjectId === "unassigned") return new Set(agents.filter(a => !a.projectId).map(a => a.id));
    return new Set(agents.filter(a => a.projectId === currentProjectId).map(a => a.id));
  }, [agents, currentProjectId, projectsEnabled]);

  // Fetch initial unseen count once
  useEffect(() => {
    if (fetchedOnce.current || !accessToken) return;
    fetchedOnce.current = true;
    fetch("/api/notifications/count", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.json())
      .then(d => setUnseenCount(d.count || 0))
      .catch(() => {});
  }, [accessToken]);

  // Bump count live from SSE (only if event matches current project)
  useEffect(() => {
    if (notificationChange === 0) return;
    const latest = events.find(e =>
      e.level === "error" || e.category === "ERROR" || (e.category === "system" && e.type === "agent_stopped")
    );
    if (latest && (!projectAgentIds || projectAgentIds.has(latest.agent_id))) {
      setUnseenCount(c => c + 1);
    }
  }, [notificationChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-count when project filter changes (from cached notifications or reset)
  const prevProjectRef = useRef(currentProjectId);
  useEffect(() => {
    if (prevProjectRef.current === currentProjectId) return;
    prevProjectRef.current = currentProjectId;
    // Refetch count with project filter
    if (!accessToken) return;
    fetch("/api/notifications/count", { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(r => r.json())
      .then(d => {
        // API returns total unseen — client filters by project
        if (!projectAgentIds) {
          setUnseenCount(d.count || 0);
        } else {
          // We need to fetch actual notifications to filter by project
          fetch("/api/notifications?limit=200", { headers: { Authorization: `Bearer ${accessToken}` } })
            .then(r => r.json())
            .then(nd => {
              const unseen = (nd.notifications || []).filter(
                (n: Notification) => !n.seen && projectAgentIds.has(n.agent_id)
              );
              setUnseenCount(unseen.length);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [currentProjectId, accessToken, projectAgentIds]);

  const openNotifications = useCallback(async () => {
    setShowNotifications(prev => !prev);
    if (!showNotifications) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const res = await fetch("/api/notifications?limit=50", { headers });
        const data = await res.json();
        let items: Notification[] = data.notifications || [];
        if (projectAgentIds) items = items.filter(n => projectAgentIds.has(n.agent_id));
        setNotifications(items);
        // Mark all as seen
        if (unseenCount > 0) {
          await fetch("/api/notifications/mark-seen", {
            method: "POST",
            headers,
            body: JSON.stringify({ all: true }),
          });
          setUnseenCount(0);
        }
      } catch {
        // Ignore
      }
    }
  }, [showNotifications, unseenCount, accessToken, projectAgentIds]);

  const handleProjectSelect = (projectId: string | null) => {
    setCurrentProjectId(projectId);
    setShowProjectMenu(false);
  };

  const getProjectLabel = () => {
    if (currentProjectId === null) return "All Projects";
    if (currentProjectId === "unassigned") return "Unassigned";
    return currentProject?.name || "Select Project";
  };

  const getProjectColor = () => {
    if (currentProjectId === null) return "#666";
    if (currentProjectId === "unassigned") return "#888";
    return currentProject?.color || "#6366f1";
  };

  return (
    <header className="border-b border-[#1a1a1a] px-4 md:px-6 py-4 flex-shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Hamburger menu button - mobile only */}
          <button
            onClick={onMenuClick}
            className="p-2 -ml-2 text-[#666] hover:text-[#e0e0e0] transition md:hidden"
          >
            <MenuIcon />
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[#f97316]">&gt;_</span>
            <span className="text-xl tracking-wider">apteva</span>
          </div>

          {/* Project Selector */}
          {projectsEnabled && projects.length > 0 && (
            <div className="relative ml-2 md:ml-4">
              <button
                onClick={() => setShowProjectMenu(!showProjectMenu)}
                className="flex items-center gap-2 px-3 py-1.5 rounded border border-[#222] bg-[#111] hover:bg-[#1a1a1a] transition text-sm"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: getProjectColor() }}
                />
                <span className="hidden sm:inline max-w-[120px] md:max-w-[180px] truncate">
                  {getProjectLabel()}
                </span>
                <ChevronDownIcon />
              </button>
              {showProjectMenu && (
                <div className="absolute left-0 top-full mt-1 w-56 bg-[#111] border border-[#222] rounded-lg shadow-xl z-50">
                  <div className="py-1 max-h-64 overflow-y-auto">
                    <button
                      onClick={() => handleProjectSelect(null)}
                      className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-[#1a1a1a] transition ${
                        currentProjectId === null ? "bg-[#1a1a1a] text-[#f97316]" : ""
                      }`}
                    >
                      <span className="w-2.5 h-2.5 rounded-full bg-[#666]" />
                      All Projects
                    </button>
                    {projects.map(project => (
                      <button
                        key={project.id}
                        onClick={() => handleProjectSelect(project.id)}
                        className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-[#1a1a1a] transition ${
                          currentProjectId === project.id ? "bg-[#1a1a1a] text-[#f97316]" : ""
                        }`}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: project.color }}
                        />
                        <span className="truncate">{project.name}</span>
                        <span className="ml-auto text-xs text-[#666]">{project.agentCount}</span>
                      </button>
                    ))}
                    {unassignedCount > 0 && (
                      <button
                        onClick={() => handleProjectSelect("unassigned")}
                        className={`w-full px-4 py-2 text-left text-sm flex items-center gap-2 hover:bg-[#1a1a1a] transition ${
                          currentProjectId === "unassigned" ? "bg-[#1a1a1a] text-[#f97316]" : ""
                        }`}
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-[#888]" />
                        <span className="truncate">Unassigned</span>
                        <span className="ml-auto text-xs text-[#666]">{unassignedCount}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
            />
            <span className="text-xs text-[#666] hidden sm:inline">
              {connected ? "Live" : "Offline"}
            </span>
          </div>
          {/* Notification Bell */}
          <div className="relative">
            <button
              onClick={openNotifications}
              className="relative p-2 text-[#666] hover:text-[#e0e0e0] transition rounded hover:bg-[#1a1a1a]"
            >
              <BellIcon className="w-5 h-5" />
              {unseenCount > 0 && (
                <span
                  className="absolute flex items-center justify-center bg-red-500 text-white font-bold rounded-full pointer-events-none"
                  style={{
                    top: 2,
                    right: 2,
                    fontSize: 9,
                    lineHeight: 1,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                  }}
                >
                  {unseenCount > 99 ? "99+" : unseenCount}
                </span>
              )}
            </button>
            {showNotifications && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
                <div className="absolute right-0 top-full mt-1 w-80 bg-[#111] border border-[#222] rounded-lg shadow-xl z-50 max-h-96 overflow-y-auto">
                  <div className="px-4 py-3 border-b border-[#222] flex items-center justify-between">
                    <span className="text-sm font-medium">Notifications</span>
                    {notifications.length > 0 && (
                      <span className="text-xs text-[#666]">{notifications.length} recent</span>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[#666]">
                      No notifications
                    </div>
                  ) : (
                    <div className="py-1">
                      {notifications.map(n => (
                        <div key={n.id} className={`px-4 py-3 hover:bg-[#1a1a1a] transition border-b border-[#1a1a1a] ${!n.seen ? "bg-[#0f0f0f]" : ""}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              !n.seen
                                ? (n.level === "error" || n.category === "ERROR" ? "bg-red-400" : "bg-[#f97316]")
                                : "bg-[#333]"
                            }`} />
                            <span className={`text-xs font-medium truncate ${!n.seen ? "text-[#ccc]" : "text-[#666]"}`}>
                              {n.category === "system" && n.type === "agent_stopped" ? "Agent Stopped" :
                               n.category === "ERROR" ? "Error" :
                               `${n.category} / ${n.type}`}
                            </span>
                            <span className="text-[10px] text-[#555] ml-auto flex-shrink-0">
                              {formatNotifTime(n.timestamp)}
                            </span>
                          </div>
                          <div className={`text-xs truncate ${!n.seen ? "text-[#aaa]" : "text-[#666]"}`}>
                            {n.error || (n.data as any)?.message || (n.data as any)?.error || `${n.type} event`}
                          </div>
                          <div className="text-[10px] text-[#555] mt-1">
                            {agentNames[n.agent_id] || n.agent_id.slice(0, 8)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <MetaAgentButton />
        </div>
      </div>
    </header>
  );
}

function formatNotifTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
