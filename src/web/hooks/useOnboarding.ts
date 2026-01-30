import { useState, useEffect, useCallback } from "react";

export function useOnboarding() {
  const [isComplete, setIsComplete] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/onboarding/status")
      .then(res => res.json())
      .then(data => {
        setIsComplete(data.completed || data.has_any_keys);
      })
      .catch(() => setIsComplete(true)); // Fallback to showing app
  }, []);

  const complete = useCallback(async () => {
    await fetch("/api/onboarding/complete", { method: "POST" });
    setIsComplete(true);
  }, []);

  return {
    isComplete,
    setIsComplete,
    complete,
  };
}
