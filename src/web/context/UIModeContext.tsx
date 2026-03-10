import React, { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

export type UIMode = "developer" | "business";

interface UIModeContextValue {
  mode: UIMode;
  setMode: (mode: UIMode) => void;
  isDev: boolean;
  isBusiness: boolean;
  t: (dev: string, biz: string) => string;
}

const UIModeContext = createContext<UIModeContextValue | null>(null);

const STORAGE_KEY = "apteva_ui_mode";

export function useUIMode(): UIModeContextValue {
  const context = useContext(UIModeContext);
  if (!context) {
    throw new Error("useUIMode must be used within a UIModeProvider");
  }
  return context;
}

export function UIModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UIMode>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "developer" || stored === "business") return stored;
    }
    return "developer";
  });

  const setMode = useCallback((newMode: UIMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  }, []);

  const isDev = mode === "developer";
  const isBusiness = mode === "business";

  const t = useCallback((dev: string, biz: string) => {
    return mode === "developer" ? dev : biz;
  }, [mode]);

  const value = useMemo(() => ({ mode, setMode, isDev, isBusiness, t }), [mode, setMode, isDev, isBusiness, t]);

  return <UIModeContext.Provider value={value}>{children}</UIModeContext.Provider>;
}
