import { json } from "./helpers";
import { ProviderKeys } from "../../providers";
import { SubscriptionDB, SettingsDB } from "../../db";
import {
  getTriggerProvider,
  getTriggerProviderIds,
  registerTriggerProvider,
} from "../../triggers";
import { ComposioTriggerProvider } from "../../triggers/composio";
import { AgentDojoTriggerProvider } from "../../triggers/agentdojo";
import type { AuthContext } from "../../auth/middleware";

// Register trigger providers on module load
registerTriggerProvider(ComposioTriggerProvider);
registerTriggerProvider(AgentDojoTriggerProvider);

export async function handleTriggerRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: AuthContext,
): Promise<Response | null> {

  // GET /api/settings/instance-url
  if (path === "/api/settings/instance-url" && method === "GET") {
    const url = SettingsDB.get("instance_url") || "";
    return json({ instance_url: url });
  }

  // PUT /api/settings/instance-url
  if (path === "/api/settings/instance-url" && method === "PUT") {
    try {
      const body = await req.json();
      const { instance_url } = body;
      if (instance_url) {
        SettingsDB.set("instance_url", instance_url.replace(/\/+$/, "")); // strip trailing slash
      } else {
        SettingsDB.set("instance_url", "");
      }
      return json({ success: true, instance_url: SettingsDB.get("instance_url") });
    } catch (e: any) {
      return json({ error: e.message || "Failed to save instance URL" }, 500);
    }
  }

  // GET /api/triggers/providers - List available trigger providers
  if (path === "/api/triggers/providers" && method === "GET") {
    const providerIds = getTriggerProviderIds();
    const providers = providerIds.map(id => {
      const provider = getTriggerProvider(id);
      const hasKey = !!ProviderKeys.getDecrypted(id);
      return { id, name: provider?.name || id, connected: hasKey };
    });
    return json({ providers });
  }

  // ============ Trigger Type Browsing ============

  // GET /api/triggers/types?provider=composio&toolkit_slugs=github,gmail
  if (path === "/api/triggers/types" && method === "GET") {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const toolkitSlugsParam = url.searchParams.get("toolkit_slugs");
    const toolkitSlugs = toolkitSlugsParam ? toolkitSlugsParam.split(",") : undefined;
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured`, types: [] }, 200);
    }

    try {
      const types = await provider.listTriggerTypes(apiKey, toolkitSlugs);
      return json({ types });
    } catch (e) {
      console.error(`Failed to list trigger types from ${providerId}:`, e);
      return json({ error: "Failed to fetch trigger types" }, 500);
    }
  }

  // GET /api/triggers/types/:slug?provider=composio
  const typeMatch = path.match(/^\/api\/triggers\/types\/([^/]+)$/);
  if (typeMatch && method === "GET") {
    const slug = typeMatch[1];
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const triggerType = await provider.getTriggerType(apiKey, slug);
      if (!triggerType) {
        return json({ error: "Trigger type not found" }, 404);
      }
      return json({ type: triggerType });
    } catch (e) {
      console.error(`Failed to get trigger type ${slug}:`, e);
      return json({ error: "Failed to fetch trigger type" }, 500);
    }
  }

  // ============ Trigger Instance Management ============

  // GET /api/triggers?provider=composio
  if (path === "/api/triggers" && method === "GET") {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured`, triggers: [] }, 200);
    }

    try {
      const triggers = await provider.listTriggers(apiKey);
      return json({ triggers });
    } catch (e) {
      console.error(`Failed to list triggers from ${providerId}:`, e);
      return json({ error: "Failed to fetch triggers" }, 500);
    }
  }

  // POST /api/triggers?provider=composio
  if (path === "/api/triggers" && method === "POST") {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const body = await req.json();
      const { slug, connectedAccountId, config } = body;

      if (!slug || !connectedAccountId) {
        return json({ error: "slug and connectedAccountId are required" }, 400);
      }

      const result = await provider.createTrigger(apiKey, slug, connectedAccountId, config);
      return json(result, 201);
    } catch (e: any) {
      console.error(`Failed to create trigger:`, e);
      return json({ error: e.message || "Failed to create trigger" }, 500);
    }
  }

  // POST /api/triggers/:id/enable?provider=composio
  const enableMatch = path.match(/^\/api\/triggers\/([^/]+)\/enable$/);
  if (enableMatch && method === "POST") {
    const triggerId = enableMatch[1];
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const success = await provider.enableTrigger(apiKey, triggerId);
      return json({ success });
    } catch (e) {
      console.error(`Failed to enable trigger ${triggerId}:`, e);
      return json({ error: "Failed to enable trigger" }, 500);
    }
  }

  // POST /api/triggers/:id/disable?provider=composio
  const disableMatch = path.match(/^\/api\/triggers\/([^/]+)\/disable$/);
  if (disableMatch && method === "POST") {
    const triggerId = disableMatch[1];
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const success = await provider.disableTrigger(apiKey, triggerId);
      return json({ success });
    } catch (e) {
      console.error(`Failed to disable trigger ${triggerId}:`, e);
      return json({ error: "Failed to disable trigger" }, 500);
    }
  }

  // DELETE /api/triggers/:id?provider=composio
  const deleteMatch = path.match(/^\/api\/triggers\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const triggerId = deleteMatch[1];
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const success = await provider.deleteTrigger(apiKey, triggerId);
      return json({ success });
    } catch (e) {
      console.error(`Failed to delete trigger ${triggerId}:`, e);
      return json({ error: "Failed to delete trigger" }, 500);
    }
  }

  // ============ Webhook Configuration ============

  // POST /api/triggers/webhook/setup?provider=composio
  if (path === "/api/triggers/webhook/setup" && method === "POST") {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const body = await req.json();
      const { webhookUrl } = body;

      if (!webhookUrl) {
        return json({ error: "webhookUrl is required" }, 400);
      }

      const result = await provider.setupWebhook(apiKey, webhookUrl);

      // Store the webhook secret locally for HMAC verification
      if (result.secret) {
        SettingsDB.set(`${providerId}_webhook_secret`, result.secret);
      }
      // Store the webhook URL for reference
      SettingsDB.set(`${providerId}_webhook_url`, webhookUrl);

      return json({ success: true, ...result });
    } catch (e: any) {
      console.error(`Failed to setup webhook for ${providerId}:`, e);
      return json({ error: e.message || "Failed to setup webhook" }, 500);
    }
  }

  // GET /api/triggers/webhook/status?provider=composio
  if (path === "/api/triggers/webhook/status" && method === "GET") {
    const url = new URL(req.url);
    const providerId = url.searchParams.get("provider") || "composio";
    const projectId = url.searchParams.get("project_id") || null;

    const provider = getTriggerProvider(providerId);
    if (!provider) {
      return json({ error: `Unknown trigger provider: ${providerId}` }, 404);
    }

    const apiKey = ProviderKeys.getDecryptedForProject(providerId, projectId);
    if (!apiKey) {
      return json({ error: `${provider.name} API key not configured` }, 401);
    }

    try {
      const config = await provider.getWebhookConfig(apiKey);
      return json(config);
    } catch (e) {
      console.error(`Failed to get webhook status for ${providerId}:`, e);
      return json({ error: "Failed to get webhook status" }, 500);
    }
  }

  // ============ Subscription Management (local routing) ============

  // GET /api/subscriptions?agent_id=xxx&project_id=xxx
  if (path === "/api/subscriptions" && method === "GET") {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") || null;
    const projectId = url.searchParams.get("project_id") || null;

    let subscriptions;
    if (agentId) {
      subscriptions = SubscriptionDB.findByAgentId(agentId);
    } else {
      subscriptions = SubscriptionDB.findAll(projectId);
    }

    return json({ subscriptions });
  }

  // POST /api/subscriptions
  if (path === "/api/subscriptions" && method === "POST") {
    try {
      const body = await req.json();
      const { trigger_slug, trigger_instance_id, agent_id, project_id, public_url, provider: providerParam } = body;

      if (!trigger_slug || !agent_id) {
        return json({ error: "trigger_slug and agent_id are required" }, 400);
      }

      // Determine provider (default to composio for backward compat)
      const providerId = providerParam || "composio";
      const projId = project_id || null;
      const provider = getTriggerProvider(providerId);
      const apiKey = provider ? ProviderKeys.getDecryptedForProject(providerId, projId) : null;

      if (provider && apiKey) {
        const existingWebhook = SettingsDB.get(`${providerId}_webhook_url`);
        if (!existingWebhook) {
          try {
            // Use instance_url setting first, then provided value, then request origin
            const instanceUrl = SettingsDB.get("instance_url");
            const origin = instanceUrl || public_url || new URL(req.url).origin;
            const webhookUrl = `${origin}/api/webhooks/${providerId}`;
            const result = await provider.setupWebhook(apiKey, webhookUrl);
            if (result.secret) {
              SettingsDB.set(`${providerId}_webhook_secret`, result.secret);
            }
            SettingsDB.set(`${providerId}_webhook_url`, webhookUrl);
            console.log(`[subscriptions] Auto-configured ${providerId} webhook: ${webhookUrl}`);
          } catch (e) {
            console.warn(`[subscriptions] Failed to auto-setup ${providerId} webhook:`, e);
            // Continue creating subscription — webhook can be set up manually later
          }
        }
      }

      const subscription = SubscriptionDB.create({
        trigger_slug,
        trigger_instance_id: trigger_instance_id || null,
        agent_id,
        enabled: true,
        project_id: projId,
      });

      return json({ subscription }, 201);
    } catch (e: any) {
      console.error("Failed to create subscription:", e);
      return json({ error: e.message || "Failed to create subscription" }, 500);
    }
  }

  // GET /api/subscriptions/:id
  const subGetMatch = path.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subGetMatch && method === "GET") {
    const subscription = SubscriptionDB.findById(subGetMatch[1]);
    if (!subscription) {
      return json({ error: "Subscription not found" }, 404);
    }
    return json({ subscription });
  }

  // PUT /api/subscriptions/:id
  const subUpdateMatch = path.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subUpdateMatch && method === "PUT") {
    const id = subUpdateMatch[1];
    const existing = SubscriptionDB.findById(id);
    if (!existing) {
      return json({ error: "Subscription not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Record<string, unknown> = {};

      if (body.trigger_slug !== undefined) updates.trigger_slug = body.trigger_slug;
      if (body.trigger_instance_id !== undefined) updates.trigger_instance_id = body.trigger_instance_id;
      if (body.agent_id !== undefined) updates.agent_id = body.agent_id;
      if (body.enabled !== undefined) updates.enabled = body.enabled;

      const updated = SubscriptionDB.update(id, updates);
      return json({ subscription: updated });
    } catch (e: any) {
      console.error("Failed to update subscription:", e);
      return json({ error: e.message || "Failed to update subscription" }, 500);
    }
  }

  // DELETE /api/subscriptions/:id
  const subDeleteMatch = path.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subDeleteMatch && method === "DELETE") {
    const success = SubscriptionDB.delete(subDeleteMatch[1]);
    if (!success) {
      return json({ error: "Subscription not found" }, 404);
    }
    return json({ success: true });
  }

  // POST /api/subscriptions/:id/enable
  const subEnableMatch = path.match(/^\/api\/subscriptions\/([^/]+)\/enable$/);
  if (subEnableMatch && method === "POST") {
    const sub = SubscriptionDB.findById(subEnableMatch[1]);
    if (!sub) return json({ error: "Subscription not found" }, 404);
    const updated = SubscriptionDB.update(subEnableMatch[1], { enabled: true });
    return json({ subscription: updated });
  }

  // POST /api/subscriptions/:id/disable
  const subDisableMatch = path.match(/^\/api\/subscriptions\/([^/]+)\/disable$/);
  if (subDisableMatch && method === "POST") {
    const sub = SubscriptionDB.findById(subDisableMatch[1]);
    if (!sub) return json({ error: "Subscription not found" }, 404);
    const updated = SubscriptionDB.update(subDisableMatch[1], { enabled: false });
    return json({ subscription: updated });
  }

  return null;
}
