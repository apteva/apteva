import { useState, useEffect, useCallback } from "react";
import type { Provider } from "../types";
import { useAuth } from "../context";

export function useProviders(enabled: boolean) {
  const { accessToken } = useAuth();
  const [providers, setProviders] = useState<Provider[]>([]);

  const getHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    return headers;
  }, [accessToken]);

  const fetchProviders = useCallback(async () => {
    const res = await fetch("/api/providers", { headers: getHeaders() });
    const data = await res.json();
    setProviders(data.providers || []);
  }, [getHeaders]);

  useEffect(() => {
    if (enabled) {
      fetchProviders();
    }
  }, [enabled, fetchProviders]);

  const configuredProviders = providers.filter(p => p.hasKey);

  const saveKey = async (
    providerId: string,
    apiKey: string
  ): Promise<{ success: boolean; error?: string }> => {
    // First test the key
    const testRes = await fetch(`/api/keys/${providerId}/test`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ key: apiKey }),
    });
    const testData = await testRes.json();

    if (!testData.valid) {
      return { success: false, error: testData.error || "API key is invalid" };
    }

    // Save the key
    const saveRes = await fetch(`/api/keys/${providerId}`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ key: apiKey }),
    });

    if (!saveRes.ok) {
      const data = await saveRes.json();
      return { success: false, error: data.error || "Failed to save key" };
    }

    await fetchProviders();
    return { success: true };
  };

  const deleteKey = async (providerId: string) => {
    await fetch(`/api/keys/${providerId}`, { method: "DELETE", headers: getHeaders() });
    await fetchProviders();
  };

  return {
    providers,
    configuredProviders,
    fetchProviders,
    saveKey,
    deleteKey,
  };
}
