import { ProviderKeysDB, SettingsDB } from "./db";
import { encrypt, decrypt, createKeyHint, validateKeyFormat } from "./crypto";

// Provider configuration with API URLs and key testing endpoints
export const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    displayName: "Anthropic",
    type: "llm" as const,
    envVar: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    testEndpoint: "https://api.anthropic.com/v1/messages",
    models: [
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", recommended: true },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 (Fast)" },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    displayName: "OpenAI",
    type: "llm" as const,
    envVar: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    testEndpoint: "https://api.openai.com/v1/models",
    models: [
      { value: "gpt-4o", label: "GPT-4o", recommended: true },
      { value: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" },
    ],
  },
  groq: {
    id: "groq",
    name: "Groq",
    displayName: "Groq",
    type: "llm" as const,
    envVar: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/keys",
    testEndpoint: "https://api.groq.com/openai/v1/models",
    models: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", recommended: true },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Fast)" },
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google",
    displayName: "Google Gemini",
    type: "llm" as const,
    envVar: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/app/apikey",
    testEndpoint: "https://generativelanguage.googleapis.com/v1/models",
    models: [
      { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview (Latest)", recommended: true },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview (Fast)" },
    ],
  },
  xai: {
    id: "xai",
    name: "xAI",
    displayName: "xAI Grok",
    type: "llm" as const,
    envVar: "XAI_API_KEY",
    docsUrl: "https://console.x.ai/",
    testEndpoint: "https://api.x.ai/v1/models",
    models: [
      { value: "grok-2", label: "Grok 2", recommended: true },
      { value: "grok-2-mini", label: "Grok 2 Mini (Fast)" },
    ],
  },
  together: {
    id: "together",
    name: "Together",
    displayName: "Together AI",
    type: "llm" as const,
    envVar: "TOGETHER_API_KEY",
    docsUrl: "https://api.together.xyz/settings/api-keys",
    testEndpoint: "https://api.together.xyz/v1/models",
    models: [
      { value: "moonshotai/Kimi-K2.5", label: "Kimi K2.5", recommended: true },
      { value: "moonshotai/Kimi-K2-Thinking", label: "Kimi K2 Thinking (Reasoning)" },
    ],
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    displayName: "Fireworks AI",
    type: "llm" as const,
    envVar: "FIREWORKS_API_KEY",
    docsUrl: "https://fireworks.ai/api-keys",
    testEndpoint: "https://api.fireworks.ai/inference/v1/models",
    models: [
      { value: "accounts/fireworks/models/kimi-k2p5", label: "Kimi K2.5", recommended: true },
      { value: "accounts/fireworks/models/kimi-k2-thinking", label: "Kimi K2 Thinking (Reasoning)" },
    ],
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot",
    displayName: "Moonshot AI",
    type: "llm" as const,
    envVar: "MOONSHOT_API_KEY",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    testEndpoint: "https://api.moonshot.cn/v1/models",
    models: [
      { value: "moonshot-v1-128k", label: "Kimi 128K", recommended: true },
      { value: "moonshot-v1-32k", label: "Kimi 32K (Fast)" },
    ],
  },
  // MCP Integrations
  composio: {
    id: "composio",
    name: "Composio",
    displayName: "Composio",
    type: "integration" as const,
    envVar: "COMPOSIO_API_KEY",
    docsUrl: "https://app.composio.dev/settings",
    description: "500+ app integrations via MCP gateway",
    models: [],
  },
  smithery: {
    id: "smithery",
    name: "Smithery",
    displayName: "Smithery",
    type: "integration" as const,
    envVar: "SMITHERY_API_KEY",
    docsUrl: "https://smithery.ai/settings",
    description: "MCP server registry and hosting",
    models: [],
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

// Provider Keys Management
export const ProviderKeys = {
  // Save an API key (encrypts before storing)
  async save(providerId: string, apiKey: string): Promise<{ success: boolean; error?: string }> {
    // Validate format
    const validation = validateKeyFormat(providerId, apiKey);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const encryptedKey = encrypt(apiKey.trim());
      const keyHint = createKeyHint(apiKey.trim());
      ProviderKeysDB.save(providerId, encryptedKey, keyHint);
      return { success: true };
    } catch (err) {
      return { success: false, error: `Failed to save key: ${err}` };
    }
  },

  // Get decrypted API key for a provider
  getDecrypted(providerId: string): string | null {
    const record = ProviderKeysDB.findByProvider(providerId);
    if (!record) return null;

    try {
      return decrypt(record.encrypted_key);
    } catch (err) {
      console.error(`Failed to decrypt key for ${providerId}:`, err);
      return null;
    }
  },

  // Check if a provider has a key configured
  hasKey(providerId: string): boolean {
    return ProviderKeysDB.findByProvider(providerId) !== null;
  },

  // Get all configured providers with their status (without exposing keys)
  getAll(): Array<{
    provider_id: string;
    key_hint: string;
    is_valid: boolean;
    last_tested_at: string | null;
    created_at: string;
  }> {
    return ProviderKeysDB.findAll().map(k => ({
      provider_id: k.provider_id,
      key_hint: k.key_hint,
      is_valid: k.is_valid,
      last_tested_at: k.last_tested_at,
      created_at: k.created_at,
    }));
  },

  // Delete a provider key
  delete(providerId: string): boolean {
    return ProviderKeysDB.delete(providerId);
  },

  // Test if an API key is valid by making a test request
  // TODO: Implement actual API testing per provider (Anthropic needs POST, others GET)
  async test(providerId: string, apiKey?: string): Promise<{ valid: boolean; error?: string }> {
    const key = apiKey || this.getDecrypted(providerId);
    if (!key) {
      return { valid: false, error: "No API key available" };
    }

    const provider = PROVIDERS[providerId as ProviderId];
    if (!provider) {
      return { valid: false, error: "Unknown provider" };
    }

    // For now, just validate format - actual API testing to be implemented later
    const validation = validateKeyFormat(providerId, key);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }

    return { valid: true };
  },

  // Get list of provider IDs that have valid keys
  getConfiguredProviders(): string[] {
    return ProviderKeysDB.getConfiguredProviders();
  },
};

// Onboarding status management
export const Onboarding = {
  isComplete(): boolean {
    return SettingsDB.get("onboarding_completed") === "true";
  },

  complete(): void {
    SettingsDB.set("onboarding_completed", "true");
  },

  reset(): void {
    SettingsDB.delete("onboarding_completed");
  },

  getStatus(): {
    completed: boolean;
    providers_configured: string[];
    has_any_keys: boolean;
  } {
    return {
      completed: this.isComplete(),
      providers_configured: ProviderKeys.getConfiguredProviders(),
      has_any_keys: ProviderKeysDB.hasAnyKeys(),
    };
  },
};

// Get provider list with configuration status for frontend
export function getProvidersWithStatus() {
  const configuredProviders = new Set(ProviderKeys.getConfiguredProviders());
  const keyStatuses = new Map(
    ProviderKeys.getAll().map(k => [k.provider_id, k])
  );

  return Object.values(PROVIDERS).map(provider => ({
    id: provider.id,
    name: provider.displayName,
    type: provider.type,
    docsUrl: provider.docsUrl,
    description: "description" in provider ? provider.description : undefined,
    models: provider.models,
    hasKey: configuredProviders.has(provider.id),
    keyHint: keyStatuses.get(provider.id)?.key_hint || null,
    isValid: keyStatuses.get(provider.id)?.is_valid ?? null,
  }));
}
