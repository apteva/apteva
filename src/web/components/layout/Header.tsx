import React, { useState } from "react";
import { useTelemetryContext, useAuth, useProjects } from "../../context";
import { MenuIcon, ChevronDownIcon } from "../common/Icons";
import { MetaAgentButton } from "../meta-agent/MetaAgent";

interface HeaderProps {
  onMenuClick?: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const { connected } = useTelemetryContext();
  const { user, logout } = useAuth();
  const { projects, currentProjectId, currentProject, setCurrentProjectId, unassignedCount, projectsEnabled } = useProjects();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);

  const handleLogout = async () => {
    await logout();
    setShowUserMenu(false);
  };

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
          <MetaAgentButton />
          {user && (
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 px-2 md:px-3 py-2 rounded hover:bg-[#1a1a1a] transition"
              >
                <div className="w-8 h-8 rounded-full bg-[#f97316] flex items-center justify-center text-black font-medium text-sm">
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <span className="text-sm text-[#888] hidden sm:block">{user.username}</span>
              </button>
              {showUserMenu && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-[#111] border border-[#222] rounded-lg shadow-xl z-50">
                  <div className="px-4 py-3 border-b border-[#222]">
                    <p className="text-sm font-medium">{user.username}</p>
                    <p className="text-xs text-[#f97316] mt-1">{user.role}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-[#1a1a1a] transition"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
