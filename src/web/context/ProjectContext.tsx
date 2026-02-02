import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  color: string;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProjectContextValue {
  projects: Project[];
  currentProjectId: string | null; // null = "All Projects", "unassigned" = unassigned agents
  currentProject: Project | null;
  isLoading: boolean;
  error: string | null;
  unassignedCount: number;
  setCurrentProjectId: (id: string | null) => void;
  createProject: (data: { name: string; description?: string; color?: string }) => Promise<Project | null>;
  updateProject: (id: string, data: { name?: string; description?: string; color?: string }) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  refreshProjects: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjects(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProjects must be used within a ProjectProvider");
  }
  return context;
}

interface ProjectProviderProps {
  children: ReactNode;
}

const STORAGE_KEY = "apteva_current_project";

export function ProjectProvider({ children }: ProjectProviderProps) {
  const { authFetch, isAuthenticated, isLoading: authLoading } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectIdState] = useState<string | null>(() => {
    // Load from localStorage
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY);
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unassignedCount, setUnassignedCount] = useState(0);

  const setCurrentProjectId = useCallback((id: string | null) => {
    setCurrentProjectIdState(id);
    if (typeof window !== "undefined") {
      if (id === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, id);
      }
    }
  }, []);

  const currentProject = projects.find(p => p.id === currentProjectId) || null;

  const refreshProjects = useCallback(async () => {
    if (!isAuthenticated && !authLoading) {
      setProjects([]);
      setIsLoading(false);
      return;
    }

    try {
      setError(null);
      const res = await authFetch("/api/projects");
      if (!res.ok) {
        throw new Error("Failed to fetch projects");
      }
      const data = await res.json();
      setProjects(data.projects || []);
      setUnassignedCount(data.unassignedCount || 0);

      // If current project no longer exists, reset to all
      if (currentProjectId && currentProjectId !== "unassigned" && !data.projects.find((p: Project) => p.id === currentProjectId)) {
        setCurrentProjectId(null);
      }
    } catch (e) {
      console.error("Failed to fetch projects:", e);
      setError("Failed to load projects");
    } finally {
      setIsLoading(false);
    }
  }, [authFetch, isAuthenticated, authLoading, currentProjectId, setCurrentProjectId]);

  const createProject = useCallback(async (data: { name: string; description?: string; color?: string }): Promise<Project | null> => {
    try {
      const res = await authFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
      const result = await res.json();
      await refreshProjects();
      return result.project;
    } catch (e) {
      console.error("Failed to create project:", e);
      return null;
    }
  }, [authFetch, refreshProjects]);

  const updateProject = useCallback(async (id: string, data: { name?: string; description?: string; color?: string }): Promise<Project | null> => {
    try {
      const res = await authFetch(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update project");
      }
      const result = await res.json();
      await refreshProjects();
      return result.project;
    } catch (e) {
      console.error("Failed to update project:", e);
      return null;
    }
  }, [authFetch, refreshProjects]);

  const deleteProject = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await authFetch(`/api/projects/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete project");
      }
      if (currentProjectId === id) {
        setCurrentProjectId(null);
      }
      await refreshProjects();
      return true;
    } catch (e) {
      console.error("Failed to delete project:", e);
      return false;
    }
  }, [authFetch, currentProjectId, setCurrentProjectId, refreshProjects]);

  // Fetch projects when authenticated
  useEffect(() => {
    if (!authLoading) {
      refreshProjects();
    }
  }, [authLoading, refreshProjects]);

  const value: ProjectContextValue = {
    projects,
    currentProjectId,
    currentProject,
    isLoading,
    error,
    unassignedCount,
    setCurrentProjectId,
    createProject,
    updateProject,
    deleteProject,
    refreshProjects,
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
