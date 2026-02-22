import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";

interface User {
  id: string;
  username: string;
  role: "admin" | "user";
}

interface AuthStatus {
  hasUsers: boolean;
  authenticated: boolean;
  isDev: boolean;
  user?: User;
}

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  hasUsers: boolean | null;
  isDev: boolean;
  accessToken: string | null;
  onboardingComplete: boolean | null;
  setOnboardingComplete: (v: boolean) => void;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<boolean>;
  checkAuth: () => Promise<void>;
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [isDev, setIsDev] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);

  // Refs to track state without causing re-renders
  const tokenRef = useRef<string | null>(null);
  const refreshingRef = useRef(false);
  const initializedRef = useRef(false);

  // Helper to set token in both state and ref
  const updateToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    setAccessToken(token);
  }, []);

  // Internal refresh function - prevents concurrent refreshes
  const refreshTokenInternal = useCallback(async (): Promise<boolean> => {
    // Prevent concurrent refresh calls
    if (refreshingRef.current) {
      return false;
    }
    refreshingRef.current = true;

    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        return false;
      }

      const data = await res.json();
      updateToken(data.accessToken);

      // User info + onboarding included in refresh response to avoid extra round trip
      if (data.user) {
        setUser(data.user);
      }
      if (data.onboarding) {
        setOnboardingComplete(data.onboarding.completed || data.onboarding.has_any_keys);
      }

      return !!data.user;
    } catch (e) {
      console.error("Token refresh failed:", e);
      return false;
    } finally {
      refreshingRef.current = false;
    }
  }, [updateToken]);

  // Check auth status
  const checkAuth = useCallback(async () => {
    try {
      const token = tokenRef.current;
      const res = await fetch("/api/auth/check", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data: AuthStatus & { onboarding?: { completed: boolean; has_any_keys: boolean } } = await res.json();

      setHasUsers(data.hasUsers);
      setIsDev(data.isDev ?? false);

      // Extract onboarding status (piggybacks on auth check to avoid extra round trip)
      if (data.onboarding) {
        setOnboardingComplete(data.onboarding.completed || data.onboarding.has_any_keys);
      }

      if (data.authenticated && data.user) {
        setUser(data.user as User);
      } else {
        setUser(null);
        // Try to refresh if we have users (meaning there might be a cookie)
        if (data.hasUsers) {
          const refreshed = await refreshTokenInternal();
          if (!refreshed) {
            updateToken(null);
          }
        }
      }
    } catch (e) {
      console.error("Auth check failed:", e);
      setUser(null);
      updateToken(null);
    } finally {
      setIsLoading(false);
    }
  }, [refreshTokenInternal, updateToken]);

  // Login
  const login = useCallback(async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error || "Login failed" };
      }

      updateToken(data.accessToken);
      setUser(data.user);
      setHasUsers(true);

      return { success: true };
    } catch (e) {
      console.error("Login failed:", e);
      return { success: false, error: "Login failed" };
    }
  }, [updateToken]);

  // Logout
  const logout = useCallback(async () => {
    try {
      const token = tokenRef.current;
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (e) {
      console.error("Logout failed:", e);
    } finally {
      setUser(null);
      updateToken(null);
    }
  }, [updateToken]);

  // Authenticated fetch wrapper - uses ref for latest token
  const authFetch = useCallback(async (url: string, options: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(options.headers);
    const token = tokenRef.current;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...options, headers });
  }, []);

  // Public refresh function
  const refreshToken = useCallback(async (): Promise<boolean> => {
    return refreshTokenInternal();
  }, [refreshTokenInternal]);

  // Check auth on mount - only once
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    checkAuth();
  }, [checkAuth]);

  // Set up token refresh interval
  useEffect(() => {
    if (!accessToken) return;

    // Refresh token 1 minute before expiry (tokens last 15 min)
    const refreshInterval = setInterval(() => {
      refreshTokenInternal();
    }, 14 * 60 * 1000); // 14 minutes

    return () => clearInterval(refreshInterval);
  }, [accessToken, refreshTokenInternal]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isAuthenticated: !!user,
    isLoading,
    hasUsers,
    isDev,
    accessToken,
    onboardingComplete,
    setOnboardingComplete,
    login,
    logout,
    refreshToken,
    checkAuth,
    authFetch,
  }), [user, isLoading, hasUsers, isDev, accessToken, onboardingComplete, setOnboardingComplete, login, logout, refreshToken, checkAuth, authFetch]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Hook to get auth headers for API calls
export function useAuthHeaders(): Record<string, string> {
  const { accessToken } = useAuth();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}
