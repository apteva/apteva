import { useCallback } from "react";
import { useAuth } from "../context";

export function useOnboarding() {
  const { authFetch, onboardingComplete, setOnboardingComplete } = useAuth();

  // Onboarding status is now included in the /api/auth/check response,
  // so no separate fetch is needed. This eliminates one round trip on load.

  const complete = useCallback(async () => {
    await authFetch("/api/onboarding/complete", { method: "POST" });
    setOnboardingComplete(true);
  }, [authFetch, setOnboardingComplete]);

  return {
    isComplete: onboardingComplete,
    setIsComplete: setOnboardingComplete,
    complete,
  };
}
