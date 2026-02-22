import { existsSync } from "fs";
import { json, debug } from "./helpers";

// Detect if running inside a Docker container
async function isRunningInDocker(): Promise<boolean> {
  try {
    return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  } catch {
    return false;
  }
}
import { startAgentProcess, setAgentStatus } from "./agent-utils";
import { AgentDB, UserDB } from "../../db";
import { ProviderKeys, Onboarding, getProvidersWithStatus, PROVIDERS, type ProviderId } from "../../providers";
import { createUser } from "../../auth";
import { agentProcesses } from "../../server";

export async function handleProviderRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: unknown,
): Promise<Response | null> {
  // ==================== PROVIDERS ====================

  // GET /api/providers - List supported providers and models with key status
  if (path === "/api/providers" && method === "GET") {
    const providers = getProvidersWithStatus();
    return json({ providers });
  }

  // GET /api/providers/ollama/models - Fetch available models from Ollama
  if (path === "/api/providers/ollama/models" && method === "GET") {
    // Get configured Ollama base URL or use default
    const ollamaUrl = ProviderKeys.getDecrypted("ollama") || "http://localhost:11434";

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (!response.ok) {
        return json({ error: "Failed to connect to Ollama", models: [] }, 200);
      }

      const data = await response.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      const models = (data.models || []).map((m: { name: string; size: number }) => ({
        value: m.name,
        label: m.name,
        size: m.size,
      }));

      return json({ models, connected: true });
    } catch (err) {
      // Ollama not running or not reachable
      return json({
        error: "Ollama not reachable. Make sure Ollama is running.",
        models: [],
        connected: false,
      }, 200);
    }
  }

  // GET /api/providers/ollama/status - Check if Ollama is running
  if (path === "/api/providers/ollama/status" && method === "GET") {
    const ollamaUrl = ProviderKeys.getDecrypted("ollama") || "http://localhost:11434";
    const isDocker = await isRunningInDocker();

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = await response.json() as { models?: Array<{ name: string }> };
        return json({
          connected: true,
          url: ollamaUrl,
          modelCount: data.models?.length || 0,
          isDocker,
        });
      }
      return json({ connected: false, url: ollamaUrl, error: "Ollama not responding", isDocker });
    } catch {
      return json({ connected: false, url: ollamaUrl, error: "Ollama not reachable", isDocker });
    }
  }

  // POST /api/providers/ollama/install - Install Ollama automatically
  if (path === "/api/providers/ollama/install" && method === "POST") {
    // Don't allow install inside Docker containers
    if (await isRunningInDocker()) {
      return json({ success: false, error: "Cannot install Ollama inside a Docker container. Configure an external Ollama URL instead." }, 400);
    }

    // Only supported on Linux/macOS
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin") {
      return json({ success: false, error: "Auto-install is only supported on Linux and macOS. Please download from https://ollama.com/download" }, 400);
    }

    // Check if already installed
    try {
      const which = Bun.spawnSync(["which", "ollama"]);
      if (which.exitCode === 0) {
        // Already installed, just make sure it's running
        Bun.spawn(["ollama", "serve"], { stdout: "ignore", stderr: "ignore" });
        // Wait a moment for it to start
        await new Promise(r => setTimeout(r, 2000));
        return json({ success: true, message: "Ollama is already installed", alreadyInstalled: true });
      }
    } catch { /* not installed */ }

    // Install Ollama using official install script
    try {
      const proc = Bun.spawnSync(["bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
        timeout: 120_000, // 2 minute timeout
        stderr: "pipe",
        stdout: "pipe",
      });

      if (proc.exitCode !== 0) {
        const stderr = proc.stderr.toString().trim();
        return json({ success: false, error: `Installation failed: ${stderr || "Unknown error"}` }, 500);
      }

      // Start Ollama serve in background
      Bun.spawn(["ollama", "serve"], { stdout: "ignore", stderr: "ignore" });

      // Wait for it to come up
      await new Promise(r => setTimeout(r, 3000));

      // Verify it's running
      try {
        const check = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
        if (check.ok) {
          return json({ success: true, message: "Ollama installed and running" });
        }
      } catch { /* may still be starting */ }

      return json({ success: true, message: "Ollama installed. It may take a moment to start." });
    } catch (err: any) {
      return json({ success: false, error: `Installation failed: ${err.message}` }, 500);
    }
  }

  // POST /api/providers/ollama/pull - Pull a model
  if (path === "/api/providers/ollama/pull" && method === "POST") {
    const body = await req.json() as { model?: string };
    const model = body.model;
    if (!model) {
      return json({ error: "Model name required" }, 400);
    }

    try {
      const ollamaUrl = ProviderKeys.getDecrypted("ollama") || "http://localhost:11434";
      const response = await fetch(`${ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });

      if (!response.ok) {
        return json({ success: false, error: "Failed to start model pull" }, 500);
      }

      return json({ success: true, message: `Pulling ${model}...` });
    } catch (err: any) {
      return json({ success: false, error: `Failed to pull model: ${err.message}` }, 500);
    }
  }

  // ==================== ONBOARDING ====================

  // GET /api/onboarding/status - Check onboarding status
  if (path === "/api/onboarding/status" && method === "GET") {
    return json(Onboarding.getStatus());
  }

  // POST /api/onboarding/complete - Mark onboarding as complete
  if (path === "/api/onboarding/complete" && method === "POST") {
    Onboarding.complete();
    return json({ success: true });
  }

  // POST /api/onboarding/reset - Reset onboarding (for testing)
  if (path === "/api/onboarding/reset" && method === "POST") {
    Onboarding.reset();
    return json({ success: true });
  }

  // POST /api/onboarding/user - Create first user during onboarding
  // This endpoint only works when no users exist (enforced by middleware)
  if (path === "/api/onboarding/user" && method === "POST") {
    debug("POST /api/onboarding/user");
    // Double-check no users exist
    if (UserDB.hasUsers()) {
      debug("Users already exist");
      return json({ error: "Users already exist" }, 403);
    }

    try {
      const body = await req.json();
      debug("Onboarding body:", JSON.stringify(body));
      const { username, password, email } = body;

      if (!username || !password) {
        debug("Missing username or password");
        return json({ error: "Username and password are required" }, 400);
      }

      // Create first user as admin
      debug("Creating user:", username);
      const result = await createUser({
        username,
        password,
        email: email || undefined, // Optional, for password recovery
        role: "admin",
      });
      debug("Create user result:", result.success, result.error);

      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      return json({
        success: true,
        user: {
          id: result.user!.id,
          username: result.user!.username,
          role: result.user!.role,
        },
      }, 201);
    } catch (e) {
      debug("Onboarding error:", e);
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // ==================== API KEYS ====================

  // GET /api/keys - List all configured provider keys (without actual keys)
  if (path === "/api/keys" && method === "GET") {
    return json({ keys: ProviderKeys.getAll() });
  }

  // GET /api/keys/:provider - Get all keys for a provider
  const getProviderKeysMatch = path.match(/^\/api\/keys\/([^/]+)$/);

  // POST /api/keys/:provider/test - Test an API key (must match before generic :provider routes)
  const testKeyMatch = path.match(/^\/api\/keys\/([^/]+)\/test$/);
  if (testKeyMatch && method === "POST") {
    const providerId = testKeyMatch[1];

    // Validate provider exists
    if (!PROVIDERS[providerId as ProviderId]) {
      return json({ error: "Unknown provider" }, 400);
    }

    try {
      const body = await req.json().catch(() => ({}));
      const { key } = body as { key?: string };

      // Test with provided key or stored key
      const result = await ProviderKeys.test(providerId, key);
      return json(result);
    } catch (e) {
      return json({ error: "Test failed" }, 500);
    }
  }

  // DELETE /api/keys/by-id/:id - Remove a specific API key by ID
  const deleteKeyByIdMatch = path.match(/^\/api\/keys\/by-id\/([^/]+)$/);
  if (deleteKeyByIdMatch && method === "DELETE") {
    const keyId = deleteKeyByIdMatch[1];
    const deleted = ProviderKeys.deleteById(keyId);
    return json({ success: deleted });
  }

  if (getProviderKeysMatch && method === "GET") {
    const providerId = getProviderKeysMatch[1];
    const keys = ProviderKeys.getAllByProvider(providerId);
    return json({ keys });
  }

  // POST /api/keys/:provider - Save an API key for a provider
  if (getProviderKeysMatch && method === "POST") {
    const providerId = getProviderKeysMatch[1];

    // Validate provider exists
    if (!PROVIDERS[providerId as ProviderId]) {
      return json({ error: "Unknown provider" }, 400);
    }

    try {
      const body = await req.json();
      const { key, project_id, name } = body as { key?: string; project_id?: string | null; name?: string | null };

      if (!key) {
        return json({ error: "API key is required" }, 400);
      }

      const result = await ProviderKeys.save(providerId, key, project_id || null, name || null);
      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      // Restart any running agents that use this provider (including meta agent)
      const runningAgents = AgentDB.findAll().filter(
        a => a.status === "running" && a.provider === providerId
      );

      // Stop all agents first
      for (const agent of runningAgents) {
        const agentProc = agentProcesses.get(agent.id);
        if (agentProc) {
          agentProc.proc.kill();
          agentProcesses.delete(agent.id);
        }
        setAgentStatus(agent.id, "stopped", "provider_restart");
      }

      // Wait once for ports to be released
      if (runningAgents.length > 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      // Restart all agents in parallel
      const restartResults = await Promise.all(
        runningAgents.map(async (agent) => {
          try {
            const startResult = await startAgentProcess(agent, { silent: true });
            return { id: agent.id, name: agent.name, success: startResult.success, error: startResult.error };
          } catch (e) {
            return { id: agent.id, name: agent.name, success: false, error: String(e) };
          }
        })
      );

      return json({
        success: true,
        message: "API key saved successfully",
        restartedAgents: restartResults.length > 0 ? restartResults : undefined,
      });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // DELETE /api/keys/:provider - Remove a global API key
  if (getProviderKeysMatch && method === "DELETE") {
    const providerId = getProviderKeysMatch[1];
    const deleted = ProviderKeys.delete(providerId);
    return json({ success: deleted });
  }

  return null;
}
