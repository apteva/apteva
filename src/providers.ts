import { ProviderKeysDB, SettingsDB } from "./db";
import { encrypt, decrypt, createKeyHint, validateKeyFormat } from "./crypto";

// Provider configuration with API URLs and key testing endpoints
export const PROVIDERS = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    displayName: "Anthropic (Claude)",
    envVar: "ANTHROPIC_API_KEY",
    docsUrl: "https://console.anthropic.com/settings/keys",
    testEndpoint: "https://api.anthropic.com/v1/messages",
    models: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", recommended: true },
      { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
      { value: "claude-4-5-sonnet", label: "Claude 4.5 Sonnet" },
      { value: "claude-4-5-haiku", label: "Claude 4.5 Haiku (Fast)" },
    ],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    displayName: "OpenAI (GPT)",
    envVar: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/api-keys",
    testEndpoint: "https://api.openai.com/v1/models",
    models: [
      { value: "gpt-4o", label: "GPT-4o", recommended: true },
      { value: "gpt-4o-mini", label: "GPT-4o Mini (Fast)" },
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
    ],
  },
  groq: {
    id: "groq",
    name: "Groq",
    displayName: "Groq (Ultra-fast)",
    envVar: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/keys",
    testEndpoint: "https://api.groq.com/openai/v1/models",
    models: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", recommended: true },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Instant)" },
      { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
    ],
  },
  gemini: {
    id: "gemini",
    name: "Google",
    displayName: "Google (Gemini)",
    envVar: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/app/apikey",
    testEndpoint: "https://generativelanguage.googleapis.com/v1/models",
    models: [
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", recommended: true },
      { value: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
      { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks",
    displayName: "Fireworks AI",
    envVar: "FIREWORKS_API_KEY",
    docsUrl: "https://fireworks.ai/api-keys",
    testEndpoint: "https://api.fireworks.ai/inference/v1/models",
    models: [
      { value: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B", recommended: true },
      { value: "accounts/fireworks/models/deepseek-v3", label: "DeepSeek V3" },
      { value: "accounts/fireworks/models/qwen2p5-72b-instruct", label: "Qwen 2.5 72B" },
    ],
  },
  xai: {
    id: "xai",
    name: "xAI",
    displayName: "xAI (Grok)",
    envVar: "XAI_API_KEY",
    docsUrl: "https://console.x.ai/",
    testEndpoint: "https://api.x.ai/v1/models",
    models: [
      { value: "grok-2-latest", label: "Grok 2", recommended: true },
      { value: "grok-beta", label: "Grok Beta" },
    ],
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot",
    displayName: "Moonshot AI (Kimi)",
    envVar: "MOONSHOT_API_KEY",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    testEndpoint: "https://api.moonshot.cn/v1/models",
    models: [
      { value: "moonshot-v1-128k", label: "Moonshot V1 128K", recommended: true },
      { value: "moonshot-v1-32k", label: "Moonshot V1 32K" },
    ],
  },
  together: {
    id: "together",
    name: "Together",
    displayName: "Together AI",
    envVar: "TOGETHER_API_KEY",
    docsUrl: "https://api.together.xyz/settings/api-keys",
    testEndpoint: "https://api.together.xyz/v1/models",
    models: [
      { value: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B", recommended: true },
      { value: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1" },
      { value: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3" },
    ],
  },
  venice: {
    id: "venice",
    name: "Venice",
    displayName: "Venice AI",
    envVar: "VENICE_API_KEY",
    docsUrl: "https://venice.ai/settings/api",
    testEndpoint: "https://api.venice.ai/api/v1/models",
    models: [
      { value: "llama-3.3-70b", label: "Llama 3.3 70B", recommended: true },
    ],
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
    docsUrl: provider.docsUrl,
    models: provider.models,
    hasKey: configuredProviders.has(provider.id),
    keyHint: keyStatuses.get(provider.id)?.key_hint || null,
    isValid: keyStatuses.get(provider.id)?.is_valid ?? null,
  }));
}
