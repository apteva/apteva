import React, { useState } from "react";
import { DashboardIcon, ActivityIcon, AgentsIcon, TasksIcon, ConnectionsIcon, McpIcon, SkillsIcon, TestsIcon, TelemetryIcon, ApiIcon, SettingsIcon, CloseIcon } from "../common/Icons";
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
          fixed inset-y-0 left-0 z-50 w-64 bg-[#0a0a0a] border-r border-[#1a1a1a] p-4 flex flex-col transform transition-transform duration-200 ease-in-out
          md:relative md:w-56 md:translate-x-0 md:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Mobile header with close button */}
        <div className="flex items-center justify-between mb-4 md:hidden">
          <div className="flex items-center gap-2">
            <span className="text-[#f97316]">&gt;_</span>
            <span className="text-lg tracking-wider">apteva</span>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-[#666] hover:text-[#e0e0e0] transition"
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
          <div className="relative border-t border-[#1a1a1a] pt-3 mt-3">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-[#111] transition"
            >
              <div className="w-8 h-8 rounded-full bg-[#f97316] flex items-center justify-center text-black font-medium text-sm flex-shrink-0">
                {user.username.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium truncate">{user.username}</p>
                <p className="text-xs text-[#555]">{user.role}</p>
              </div>
            </button>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <div className="absolute left-3 bottom-full mb-1 w-48 bg-[#111] border border-[#222] rounded-lg shadow-xl z-50">
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-[#1a1a1a] transition rounded-lg"
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
      className={`w-full flex items-center gap-3 px-3 py-2 rounded font-medium transition ${
        active
          ? "bg-[#111] text-[#e0e0e0]"
          : "text-[#666] hover:bg-[#111] hover:text-[#888]"
      }`}
    >
      {icon}
      {label}
      {badge && (
        <span className="ml-auto bg-[#333] text-[#888] text-xs px-2 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </button>
  );
}
