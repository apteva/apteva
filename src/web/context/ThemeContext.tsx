import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { themes, resolveTheme, type ThemeMode, type Theme } from "../themes";

interface ThemeContextValue {
  mode: ThemeMode;
  theme: Theme; // resolved theme
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

const STORAGE_KEY = "apteva_theme_mode";

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute("data-theme", theme.id);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "dark" || stored === "light" || stored === "auto") return stored;
    }
    return "auto";
  });

  const [prefersDark, setPrefersDark] = useState(getSystemPrefersDark);

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const theme = useMemo(() => resolveTheme(mode, prefersDark), [mode, prefersDark]);

  // Apply CSS variables whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  }, []);

  const value = useMemo(() => ({ mode, theme, setMode }), [mode, theme, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
