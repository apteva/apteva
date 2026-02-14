import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "crypto";
import { hostname, userInfo } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Cache the encryption secret to avoid repeated file reads
let cachedSecret: string | null = null;

// Get the path for storing the encryption secret
function getSecretPath(): string {
  const dataDir = process.env.DATA_DIR || join(homedir(), ".apteva");
  return join(dataDir, ".encryption-key");
}

// Get or create a persistent encryption secret
// This ensures keys can be decrypted after container/app restarts
function getOrCreateSecret(): string {
  if (cachedSecret) return cachedSecret;

  const secretPath = getSecretPath();

  // Try to read existing secret
  if (existsSync(secretPath)) {
    try {
      cachedSecret = readFileSync(secretPath, "utf8").trim();
      if (cachedSecret && cachedSecret.length >= 32) {
        return cachedSecret;
      }
    } catch {
      // Fall through to create new
    }
  }

  // Create new secret and persist it
  cachedSecret = randomBytes(32).toString("hex");
  try {
    const dir = process.env.DATA_DIR || join(homedir(), ".apteva");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(secretPath, cachedSecret, { mode: 0o600 });
  } catch (err) {
    console.error("[crypto] Warning: Could not persist encryption key:", err);
    // Continue with in-memory key - will work for this session but not across restarts
  }

  return cachedSecret;
}

// Get a machine-specific identifier for key derivation
// Now uses a persistent secret instead of volatile machine factors
function getMachineId(): string {
  return getOrCreateSecret();
}

// Derive encryption key from machine ID and salt
function deriveKey(salt: Buffer): Buffer {
  const machineId = getMachineId();
  return scryptSync(machineId, salt, KEY_LENGTH);
}

// Create a hash hint of the last 4 characters of a key
export function createKeyHint(key: string): string {
  if (key.length < 4) return "****";
  return "..." + key.slice(-4);
}

/**
 * Encrypt a string value
 * Returns: base64 encoded string containing salt + iv + encrypted + authTag
 */
export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Combine: salt (32) + iv (16) + authTag (16) + encrypted (variable)
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a previously encrypted value
 * Input: base64 encoded string from encrypt()
 */
export function decrypt(encryptedBase64: string): string {
  const combined = Buffer.from(encryptedBase64, "base64");

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Hash a value (one-way, for checking if key changed)
 */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Validate that a string looks like an API key for a given provider
 */
export function validateKeyFormat(provider: string, key: string): { valid: boolean; error?: string } {
  const trimmed = key.trim();

  if (!trimmed) {
    return { valid: false, error: "API key cannot be empty" };
  }

  // Ollama and local browser providers use base URL instead of API key
  if (provider === "ollama" || provider === "browserengine" || provider === "chrome") {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
      return { valid: true };
    }
    return { valid: false, error: `${provider} requires a valid URL (e.g., http://localhost:8098)` };
  }

  // Provider-specific format validation
  const patterns: Record<string, { pattern: RegExp; example: string }> = {
    anthropic: {
      pattern: /^sk-ant-[a-zA-Z0-9_-]+$/,
      example: "sk-ant-...",
    },
    openai: {
      pattern: /^sk-[a-zA-Z0-9_-]+$/,
      example: "sk-...",
    },
    groq: {
      pattern: /^gsk_[a-zA-Z0-9_-]+$/,
      example: "gsk_...",
    },
    gemini: {
      pattern: /^[a-zA-Z0-9_-]+$/,
      example: "AIza...",
    },
    fireworks: {
      pattern: /^fw_[a-zA-Z0-9_-]+$|^[a-zA-Z0-9_-]+$/,
      example: "fw_...",
    },
    xai: {
      pattern: /^xai-[a-zA-Z0-9_-]+$|^[a-zA-Z0-9_-]+$/,
      example: "xai-...",
    },
    moonshot: {
      pattern: /^sk-[a-zA-Z0-9_-]+$|^[a-zA-Z0-9_-]+$/,
      example: "sk-...",
    },
    together: {
      pattern: /^[a-zA-Z0-9_-]+$/,
      example: "...",
    },
    venice: {
      pattern: /^[a-zA-Z0-9_-]+$/,
      example: "...",
    },
    // MCP Integrations
    composio: {
      pattern: /^[a-zA-Z0-9_-]+$/,
      example: "...",
    },
    smithery: {
      pattern: /^[a-zA-Z0-9_-]+$/,
      example: "...",
    },
    agentdojo: {
      pattern: /^(key_)?[a-zA-Z0-9_-]+$/,
      example: "key_...",
    },
    // Browser providers
    browserbase: {
      pattern: /^bb_[a-zA-Z0-9_-]+$|^[a-zA-Z0-9_-]+$/,
      example: "bb_live_...",
    },
    steel: {
      pattern: /^steel_[a-zA-Z0-9_-]+$|^[a-zA-Z0-9_-]+$/,
      example: "steel_...",
    },
  };

  const providerPattern = patterns[provider];
  if (providerPattern && !providerPattern.pattern.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid key format for ${provider}. Expected format: ${providerPattern.example}`,
    };
  }

  // Minimum length check
  if (trimmed.length < 10) {
    return { valid: false, error: "API key seems too short" };
  }

  return { valid: true };
}

/**
 * Encrypt an object (for env vars / credentials)
 * Returns encrypted JSON string
 */
export function encryptObject(obj: Record<string, string>): string {
  if (!obj || Object.keys(obj).length === 0) {
    return "";
  }
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt an object (for env vars / credentials)
 * Handles both encrypted and legacy unencrypted JSON
 */
export function decryptObject(data: string): Record<string, string> {
  if (!data || data === "{}") {
    return {};
  }

  // Check if it looks like encrypted data (base64) or plain JSON
  if (data.startsWith("{")) {
    // Plain JSON (legacy unencrypted)
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  // Try to decrypt
  try {
    const decrypted = decrypt(data);
    return JSON.parse(decrypted);
  } catch {
    // Decryption failed, try parsing as JSON (migration case)
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
}
