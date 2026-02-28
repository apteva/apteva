import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { themes, resolveTheme, type ThemeMode, type ThemeStyle, type Theme } from "../themes";

interface ThemeContextValue {
  mode: ThemeMode;
  style: ThemeStyle;
  theme: Theme; // resolved theme
  setMode: (mode: ThemeMode) => void;
  setStyle: (style: ThemeStyle) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

const MODE_KEY = "apteva_theme_mode";
const STYLE_KEY = "apteva_theme_style";

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme, style: ThemeStyle) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute("data-theme", theme.id);
  root.setAttribute("data-style", style);
  // Set font directly as inline style — CSS variable alone gets overridden by Tailwind base
  document.body.style.fontFamily = style === "professional"
    ? "'Inter', system-ui, -apple-system, sans-serif"
    : "'JetBrains Mono', monospace";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(MODE_KEY);
      if (stored === "dark" || stored === "light" || stored === "auto") return stored;
    }
    return "auto";
  });

  const [style, setStyleState] = useState<ThemeStyle>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STYLE_KEY);
      if (stored === "classic" || stored === "professional") return stored;
    }
    return "classic";
  });

  const [prefersDark, setPrefersDark] = useState(getSystemPrefersDark);

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const theme = useMemo(() => resolveTheme(mode, style, prefersDark), [mode, style, prefersDark]);

  // Apply CSS variables + style attribute whenever theme or style changes
  useEffect(() => {
    applyTheme(theme, style);
  }, [theme, style]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(MODE_KEY, newMode);
  }, []);

  const setStyle = useCallback((newStyle: ThemeStyle) => {
    setStyleState(newStyle);
    localStorage.setItem(STYLE_KEY, newStyle);
  }, []);

  const value = useMemo(() => ({ mode, style, theme, setMode, setStyle }), [mode, style, theme, setMode, setStyle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
