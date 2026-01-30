import React from "react";
import { DashboardIcon, AgentsIcon, TasksIcon, McpIcon, SettingsIcon } from "../common/Icons";
import type { Route } from "../../types";

interface SidebarProps {
  route: Route;
  agentCount: number;
  taskCount?: number;
  onNavigate: (route: Route) => void;
}

export function Sidebar({ route, agentCount, taskCount, onNavigate }: SidebarProps) {
  return (
    <aside className="w-56 border-r border-[#1a1a1a] flex-shrink-0 p-4">
      <nav className="space-y-1">
        <NavButton
          icon={<DashboardIcon />}
          label="Dashboard"
          active={route === "dashboard"}
          onClick={() => onNavigate("dashboard")}
        />
        <NavButton
          icon={<AgentsIcon />}
          label="Agents"
          active={route === "agents"}
          onClick={() => onNavigate("agents")}
          badge={agentCount > 0 ? String(agentCount) : undefined}
        />
        <NavButton
          icon={<TasksIcon />}
          label="Tasks"
          active={route === "tasks"}
          onClick={() => onNavigate("tasks")}
          badge={taskCount && taskCount > 0 ? String(taskCount) : undefined}
        />
        <NavButton
          icon={<McpIcon />}
          label="MCP"
          active={route === "mcp"}
          onClick={() => onNavigate("mcp")}
        />
        <NavButton
          icon={<SettingsIcon />}
          label="Settings"
          active={route === "settings"}
          onClick={() => onNavigate("settings")}
        />
      </nav>
    </aside>
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
