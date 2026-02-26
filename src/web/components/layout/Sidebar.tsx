import React, { useState } from "react";
import { DashboardIcon, ThreadsIcon, AgentsIcon, ActivityIcon, TasksIcon, ConnectionsIcon, McpIcon, SkillsIcon, TestsIcon, TelemetryIcon, ApiIcon, SettingsIcon, CloseIcon } from "../common/Icons";
import { useAuth } from "../../context";
import type { Route } from "../../types";

interface SidebarProps {
  route: Route;
  agentCount: number;
  taskCount?: number;
  onNavigate: (route: Route) => void;
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ route, agentCount, taskCount, onNavigate, isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleNavigate = (newRoute: Route) => {
    onNavigate(newRoute);
    onClose?.();
  };

  const handleLogout = async () => {
    await logout();
    setShowUserMenu(false);
  };

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar - hidden on mobile unless open, always visible on md+ */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 p-4 flex flex-col transform transition-transform duration-200 ease-in-out
          md:relative md:w-56 md:translate-x-0 md:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
        style={{ backgroundColor: "var(--color-bg)", borderRight: "1px solid var(--color-border)" }}
      >
        {/* Mobile header with close button */}
        <div className="flex items-center justify-between mb-4 md:hidden">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--color-accent)" }}>&gt;_</span>
            <span className="text-lg tracking-wider">apteva</span>
          </div>
          <button
            onClick={onClose}
            className="p-2 transition"
            style={{ color: "var(--color-text-muted)" }}
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="space-y-1 flex-1">
          <NavButton
            icon={<DashboardIcon />}
            label="Dashboard"
            active={route === "dashboard"}
            onClick={() => handleNavigate("dashboard")}
          />
          <NavButton
            icon={<AgentsIcon />}
            label="Agents"
            active={route === "agents"}
            onClick={() => handleNavigate("agents")}
            badge={agentCount > 0 ? String(agentCount) : undefined}
          />
          <NavButton
            icon={<ThreadsIcon />}
            label="Threads"
            active={route === "threads"}
            onClick={() => handleNavigate("threads")}
          />
          <NavButton
            icon={<ActivityIcon />}
            label="Activity"
            active={route === "activity"}
            onClick={() => handleNavigate("activity")}
          />
          <NavButton
            icon={<TasksIcon />}
            label="Tasks"
            active={route === "tasks"}
            onClick={() => handleNavigate("tasks")}
            badge={taskCount && taskCount > 0 ? String(taskCount) : undefined}
          />
          <NavButton
            icon={<McpIcon />}
            label="MCP"
            active={route === "mcp"}
            onClick={() => handleNavigate("mcp")}
          />
          <NavButton
            icon={<SkillsIcon />}
            label="Skills"
            active={route === "skills"}
            onClick={() => handleNavigate("skills")}
          />
          <NavButton
            icon={<ConnectionsIcon />}
            label="Connections"
            active={route === "connections"}
            onClick={() => handleNavigate("connections")}
          />
          <NavButton
            icon={<TestsIcon />}
            label="Tests"
            active={route === "tests"}
            onClick={() => handleNavigate("tests")}
          />
          <NavButton
            icon={<TelemetryIcon />}
            label="Telemetry"
            active={route === "telemetry"}
            onClick={() => handleNavigate("telemetry")}
          />
          <NavButton
            icon={<ApiIcon />}
            label="API"
            active={route === "api"}
            onClick={() => handleNavigate("api")}
          />
          <NavButton
            icon={<SettingsIcon />}
            label="Settings"
            active={route === "settings"}
            onClick={() => handleNavigate("settings")}
          />
        </nav>

        {/* User profile - pinned to bottom */}
        {user && (
          <div className="relative pt-3 mt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded transition"
              style={{ color: "var(--color-text)" }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--color-surface)"}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-black font-medium text-sm flex-shrink-0" style={{ backgroundColor: "var(--color-accent)" }}>
                {user.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium truncate">{user.username}</p>
                <p className="text-xs" style={{ color: "var(--color-text-faint)" }}>{user.role}</p>
              </div>
            </button>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <div className="absolute left-3 bottom-full mb-1 w-48 rounded-lg shadow-xl z-50" style={{ backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border-light)" }}>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2.5 text-left text-sm text-red-400 transition rounded-lg"
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--color-surface-raised)"}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = "transparent"}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
}

function NavButton({ icon, label, active, onClick, badge }: NavButtonProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2 rounded font-medium transition"
      style={{
        backgroundColor: active ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-muted)",
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.backgroundColor = "var(--color-surface)";
          e.currentTarget.style.color = "var(--color-text-secondary)";
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = "var(--color-text-muted)";
        }
      }}
    >
      {icon}
      {label}
      {badge && (
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "var(--color-surface-raised)", color: "var(--color-text-secondary)" }}>
          {badge}
        </span>
      )}
    </button>
  );
}
