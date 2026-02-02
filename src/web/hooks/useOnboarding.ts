import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context";

export function useOnboarding() {
  const { accessToken, isAuthenticated } = useAuth();
  const [isComplete, setIsComplete] = useState<boolean | null>(null);

  const getHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }, [accessToken]);

  useEffect(() => {
    // Only check onboarding status when authenticated
    if (!isAuthenticated) {
      setIsComplete(null);
      return;
    }

    fetch("/api/onboarding/status", { headers: getHeaders() })
      .then(res => res.json())
      .then(data => {
        setIsComplete(data.completed || data.has_any_keys);
      })
      .catch(() => setIsComplete(true)); // Fallback to showing app
  }, [isAuthenticated, getHeaders]);

  const complete = useCallback(async () => {
    await fetch("/api/onboarding/complete", { method: "POST", headers: getHeaders() });
    setIsComplete(true);
  }, [getHeaders]);

  return {
    isComplete,
    setIsComplete,
    complete,
  };
}
