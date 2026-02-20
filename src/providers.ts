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
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", recommended: true },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
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
      { value: "accounts/fireworks/models/minimax-m2p5", label: "MiniMax M2.5" },
      { value: "accounts/fireworks/models/glm-5", label: "GLM 5" },
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
  ollama: {
    id: "ollama",
    name: "Ollama",
    displayName: "Ollama (Local)",
    type: "llm" as const,
    envVar: "OLLAMA_BASE_URL",
    docsUrl: "https://ollama.ai/download",
    testEndpoint: "", // Dynamic - uses configured base URL
    isLocal: true,
    defaultBaseUrl: "http://localhost:11434",
    models: [
      // Default models - actual list fetched dynamically from Ollama
      { value: "llama3.3", label: "Llama 3.3 (70B)", recommended: true },
      { value: "llama3.2", label: "Llama 3.2 (3B)" },
      { value: "qwen2.5", label: "Qwen 2.5" },
      { value: "mistral", label: "Mistral" },
      { value: "deepseek-r1", label: "DeepSeek R1" },
    ],
  },
  // Browser Providers
  browserbase: {
    id: "browserbase",
    name: "Browserbase",
    displayName: "Browserbase",
    type: "browser" as const,
    envVar: "BROWSERBASE_API_KEY",
    docsUrl: "https://www.browserbase.com/",
    description: "Cloud browser sessions with proxies and stealth mode",
    models: [],
  },
  steel: {
    id: "steel",
    name: "Steel",
    displayName: "Steel.dev",
    type: "browser" as const,
    envVar: "STEEL_API_KEY",
    docsUrl: "https://steel.dev/",
    description: "Cloud browser automation with CDP",
    models: [],
  },
  browserengine: {
    id: "browserengine",
    name: "BrowserEngine",
    displayName: "BrowserEngine",
    type: "browser" as const,
    envVar: "BROWSERENGINE_API_KEY",
    docsUrl: "https://browserengine.co",
    description: "Cloud browser automation with stealth browsing and proxies",
    models: [],
  },
  cdp: {
    id: "cdp",
    name: "CDP",
    displayName: "Direct CDP",
    type: "browser" as const,
    envVar: "CDP_URL",
    docsUrl: "",
    description: "Connect directly to any browser via Chrome DevTools Protocol",
    isLocal: true,
    models: [],
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
  agentdojo: {
    id: "agentdojo",
    name: "AgentDojo",
    displayName: "AgentDojo",
    type: "integration" as const,
    envVar: "AGENTDOJO_API_KEY",
    docsUrl: "https://agentdojo.com/settings",
    description: "Hosted MCP tools and agent capabilities",
    models: [],
  },
  // Skills Integrations
  skillsmp: {
    id: "skillsmp",
    name: "SkillsMP",
    displayName: "SkillsMP",
    type: "integration" as const,
    envVar: "SKILLSMP_API_KEY",
    docsUrl: "https://skillsmp.com/settings",
    description: "Agent skills marketplace (optional - public registry available without key)",
    models: [],
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

// Provider Keys Management
export const ProviderKeys = {
  // Save an API key (encrypts before storing)
  // projectId: null = global key, string = project-scoped key
  async save(
    providerId: string,
    apiKey: string,
    projectId: string | null = null,
    name: string | null = null
  ): Promise<{ success: boolean; error?: string; id?: string }> {
    // Validate format
    const validation = validateKeyFormat(providerId, apiKey);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const encryptedKey = encrypt(apiKey.trim());
      // For multi-field JSON keys (e.g. browserbase), use the api_key field for the hint
      let hintSource = apiKey.trim();
      if (providerId === "browserbase") {
        try {
          const parsed = JSON.parse(hintSource);
          if (parsed.api_key) hintSource = parsed.api_key;
        } catch {}
      }
      const keyHint = createKeyHint(hintSource);
      const record = ProviderKeysDB.save(providerId, encryptedKey, keyHint, projectId, name);
      return { success: true, id: record.id };
    } catch (err) {
      return { success: false, error: `Failed to save key: ${err}` };
    }
  },

  // Get decrypted API key for a provider (global key, falls back to env var)
  getDecrypted(providerId: string): string | null {
    const record = ProviderKeysDB.findByProvider(providerId);
    if (record) {
      try {
        return decrypt(record.encrypted_key);
      } catch (err) {
        console.error(`Failed to decrypt key for ${providerId}:`, err);
      }
    }

    // Fall back to environment variable
    const provider = PROVIDERS[providerId as ProviderId];
    if (provider?.envVar) {
      const envVal = process.env[provider.envVar];
      if (envVal) return envVal;
    }
    return null;
  },

  // Get decrypted API key for a provider and project
  // Falls back to global key if no project-specific key exists
  getDecryptedForProject(providerId: string, projectId: string | null): string | null {
    console.log(`[ProviderKeys.getDecryptedForProject] providerId=${providerId}, projectId=${projectId}`);
    // Try project-specific key first
    if (projectId) {
      const projectRecord = ProviderKeysDB.findByProviderAndProject(providerId, projectId);
      console.log(`[ProviderKeys.getDecryptedForProject] project record found: ${!!projectRecord}`);
      if (projectRecord) {
        try {
          const key = decrypt(projectRecord.encrypted_key);
          console.log(`[ProviderKeys.getDecryptedForProject] decrypted project key OK, length=${key?.length}`);
          return key;
        } catch (err) {
          console.error(`Failed to decrypt project key for ${providerId}/${projectId}:`, err);
        }
      }
    }
    // Fall back to global key
    const globalKey = this.getDecrypted(providerId);
    console.log(`[ProviderKeys.getDecryptedForProject] global fallback: found=${!!globalKey}, length=${globalKey?.length || 0}`);
    return globalKey;
  },

  // Check if a provider has a key configured (global)
  hasKey(providerId: string): boolean {
    return ProviderKeysDB.findByProvider(providerId) !== null;
  },

  // Check if a provider has a key for a specific project (or global)
  hasKeyForProject(providerId: string, projectId: string | null): boolean {
    if (projectId && ProviderKeysDB.findByProviderAndProject(providerId, projectId)) {
      return true;
    }
    return ProviderKeysDB.findByProvider(providerId) !== null;
  },

  // Get all configured providers with their status (without exposing keys)
  getAll(): Array<{
    id: string;
    provider_id: string;
    key_hint: string;
    is_valid: boolean;
    last_tested_at: string | null;
    created_at: string;
    project_id: string | null;
    name: string | null;
  }> {
    return ProviderKeysDB.findAll().map(k => ({
      id: k.id,
      provider_id: k.provider_id,
      key_hint: k.key_hint,
      is_valid: k.is_valid,
      last_tested_at: k.last_tested_at,
      created_at: k.created_at,
      project_id: k.project_id,
      name: k.name,
    }));
  },

  // Get all keys for a specific provider
  getAllByProvider(providerId: string): Array<{
    id: string;
    provider_id: string;
    key_hint: string;
    is_valid: boolean;
    last_tested_at: string | null;
    created_at: string;
    project_id: string | null;
    name: string | null;
  }> {
    return ProviderKeysDB.findAllByProvider(providerId).map(k => ({
      id: k.id,
      provider_id: k.provider_id,
      key_hint: k.key_hint,
      is_valid: k.is_valid,
      last_tested_at: k.last_tested_at,
      created_at: k.created_at,
      project_id: k.project_id,
      name: k.name,
    }));
  },

  // Delete a provider key (global)
  delete(providerId: string): boolean {
    return ProviderKeysDB.delete(providerId);
  },

  // Delete a provider key by ID
  deleteById(id: string): boolean {
    return ProviderKeysDB.deleteById(id);
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

  // Get list of provider IDs that have valid keys (global only)
  getConfiguredProviders(): string[] {
    return ProviderKeysDB.getConfiguredProviders();
  },

  // Get list of all provider IDs that have keys (including project-scoped)
  getAllConfiguredProviders(): string[] {
    return ProviderKeysDB.getAllConfiguredProviders();
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
  const configuredProviders = new Set(ProviderKeysDB.getAllConfiguredProviders());
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
    isLocal: "isLocal" in provider ? provider.isLocal : undefined,
  }));
}
