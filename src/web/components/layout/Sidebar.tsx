import React from "react";
import { DashboardIcon, AgentsIcon, TasksIcon, McpIcon, TelemetryIcon, ApiIcon, SettingsIcon, CloseIcon } from "../common/Icons";
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
  const handleNavigate = (newRoute: Route) => {
    onNavigate(newRoute);
    onClose?.();
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
          fixed inset-y-0 left-0 z-50 w-64 bg-[#0a0a0a] border-r border-[#1a1a1a] p-4 transform transition-transform duration-200 ease-in-out
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

        <nav className="space-y-1">
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
