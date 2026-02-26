/** Theme system — extensible for future custom themes */

export type ThemeMode = "auto" | "dark" | "light";

export interface ThemeColors {
  "--color-bg": string;
  "--color-bg-secondary": string;
  "--color-surface": string;
  "--color-surface-hover": string;
  "--color-surface-raised": string;
  "--color-border": string;
  "--color-border-light": string;
  "--color-text": string;
  "--color-text-secondary": string;
  "--color-text-muted": string;
  "--color-text-faint": string;
  "--color-accent": string;
  "--color-accent-hover": string;
  "--color-selection-bg": string;
  "--color-selection-text": string;
  "--color-scrollbar": string;
  "--color-scrollbar-hover": string;
  [key: string]: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export const themes: Record<string, Theme> = {
  dark: {
    id: "dark",
    name: "Dark",
    colors: {
      "--color-bg": "#0a0a0a",
      "--color-bg-secondary": "#0f0f0f",
      "--color-surface": "#111111",
      "--color-surface-hover": "#0a0a0a",
      "--color-surface-raised": "#1a1a1a",
      "--color-border": "#1a1a1a",
      "--color-border-light": "#222222",
      "--color-text": "#e0e0e0",
      "--color-text-secondary": "#888888",
      "--color-text-muted": "#666666",
      "--color-text-faint": "#555555",
      "--color-accent": "#f97316",
      "--color-accent-hover": "#ea580c",
      "--color-accent-5": "rgba(249, 115, 22, 0.05)",
      "--color-accent-10": "rgba(249, 115, 22, 0.1)",
      "--color-accent-15": "rgba(249, 115, 22, 0.15)",
      "--color-accent-20": "rgba(249, 115, 22, 0.2)",
      "--color-accent-30": "rgba(249, 115, 22, 0.3)",
      "--color-accent-70": "rgba(249, 115, 22, 0.7)",
      "--color-selection-bg": "#f97316",
      "--color-selection-text": "#0a0a0a",
      "--color-scrollbar": "#222222",
      "--color-scrollbar-hover": "#444444",
    },
  },
  light: {
    id: "light",
    name: "Light",
    colors: {
      "--color-bg": "#ffffff",
      "--color-bg-secondary": "#f7f7f7",
      "--color-surface": "#ffffff",
      "--color-surface-hover": "#f5f5f5",
      "--color-surface-raised": "#f0f0f0",
      "--color-border": "#e0e0e0",
      "--color-border-light": "#e8e8e8",
      "--color-text": "#1a1a1a",
      "--color-text-secondary": "#555555",
      "--color-text-muted": "#777777",
      "--color-text-faint": "#999999",
      "--color-accent": "#ea580c",
      "--color-accent-hover": "#c2410c",
      "--color-accent-5": "rgba(234, 88, 12, 0.05)",
      "--color-accent-10": "rgba(234, 88, 12, 0.1)",
      "--color-accent-15": "rgba(234, 88, 12, 0.15)",
      "--color-accent-20": "rgba(234, 88, 12, 0.2)",
      "--color-accent-30": "rgba(234, 88, 12, 0.3)",
      "--color-accent-70": "rgba(234, 88, 12, 0.7)",
      "--color-selection-bg": "#ea580c",
      "--color-selection-text": "#ffffff",
      "--color-scrollbar": "#cccccc",
      "--color-scrollbar-hover": "#aaaaaa",
    },
  },
};

/** Resolve the effective theme ID from a mode + system preference */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): Theme {
  if (mode === "auto") {
    return prefersDark ? themes.dark : themes.light;
  }
  return themes[mode] || themes.dark;
}
