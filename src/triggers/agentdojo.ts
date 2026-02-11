// AgentDojo Trigger Provider
// Uses our MCP API's subscription and trigger system
// Docs: POST /subscribe, GET /subscriptions, GET /triggers

import { createHmac, timingSafeEqual } from "crypto";
import type { TriggerProvider, TriggerType, TriggerInstance } from "./index";

const AGENTDOJO_API_BASE = process.env.AGENTDOJO_API_BASE || "https://api.agentdojo.dev";

function headers(apiKey: string) {
  return { "X-API-Key": apiKey, "Content-Type": "application/json" };
}

export const AgentDojoTriggerProvider: TriggerProvider = {
  id: "agentdojo",
  name: "AgentDojo",

  async listTriggerTypes(apiKey: string, toolkitSlugs?: string[]): Promise<TriggerType[]> {
    const params = new URLSearchParams({ is_active: "true", limit: "200" });
    if (toolkitSlugs?.length) {
      // Filter by toolkit name(s) — API supports one at a time, so fetch each
      const allItems: any[] = [];
      for (const slug of toolkitSlugs) {
        const res = await fetch(
          `${AGENTDOJO_API_BASE}/triggers?${new URLSearchParams({ toolkit_name: slug, is_active: "true", limit: "200" })}`,
          { headers: headers(apiKey) },
        );
        if (res.ok) {
          const data = await res.json();
          const items = data.data || data.triggers || [];
          allItems.push(...items);
        }
      }
      return mapTriggerTypes(allItems);
    }

    const res = await fetch(`${AGENTDOJO_API_BASE}/triggers?${params}`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      console.error("AgentDojo listTriggerTypes error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.data || data.triggers || [];
    return mapTriggerTypes(items);
  },

  async getTriggerType(apiKey: string, slug: string): Promise<TriggerType | null> {
    const res = await fetch(
      `${AGENTDOJO_API_BASE}/triggers/${encodeURIComponent(slug)}`,
      { headers: headers(apiKey) },
    );

    if (!res.ok) {
      if (res.status === 404) return null;
      console.error("AgentDojo getTriggerType error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const item = data.data || data;
    return {
      slug: item.slug,
      name: item.display_name || item.event_name || item.slug,
      description: item.description || "",
      type: (item.mechanism as "webhook" | "poll") || "webhook",
      toolkit_slug: item.toolkit?.name || item.toolkit_name || "",
      toolkit_name: item.toolkit?.display_name || item.toolkit_display_name || "",
      logo: item.toolkit?.icon_url || null,
      config_schema: item.config_schema || {},
      payload_schema: item.payload_schema || {},
    };
  },

  async createTrigger(
    apiKey: string,
    slug: string,
    connectedAccountId: string,
    config?: Record<string, unknown>,
  ): Promise<{ triggerId: string }> {
    // AgentDojo uses subscriptions — we create a subscription for this trigger
    // The callback_url should be set in config or from stored webhook URL
    const callbackUrl = (config?.callback_url as string) || "";
    if (!callbackUrl) {
      throw new Error("callback_url is required in config for AgentDojo triggers");
    }

    // Separate known top-level fields from extra config (e.g. owner, repo for GitHub)
    const { callback_url, title, events, server, prompt, agent_id, ...extraConfig } = config || {} as Record<string, unknown>;

    const body: Record<string, unknown> = {
      trigger_type_slug: slug,
      credential_id: connectedAccountId,
      callback_url: callbackUrl,
      title: (title as string) || `Trigger: ${slug}`,
    };

    if (events) body.events = events;
    if (server) body.server = server;
    if (prompt) body.prompt = prompt;
    if (agent_id) body.agent_id = agent_id;

    // Pass extra config fields (owner, repo, etc.) as the config object
    // mcp-subscribe spreads this into the webhook register payload
    if (Object.keys(extraConfig).length > 0) {
      body.config = extraConfig;
      console.log("AgentDojo createTrigger: extra config:", JSON.stringify(extraConfig));
    }

    const res = await fetch(`${AGENTDOJO_API_BASE}/subscribe`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("AgentDojo createTrigger error:", res.status, errText);
      throw new Error(`Failed to create AgentDojo subscription: ${errText}`);
    }

    const data = await res.json();
    return { triggerId: String(data.subscription_id || data.id) };
  },

  async listTriggers(apiKey: string): Promise<TriggerInstance[]> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/subscriptions?status=active`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      console.error("AgentDojo listTriggers error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.subscriptions || data.data || [];

    return items.map((item: any) => ({
      id: String(item.id || item.subscription_id),
      trigger_slug: item.title || item.server || "",
      connected_account_id: item.credential_id || null,
      status: item.status === "active" ? "active" as const : "disabled" as const,
      config: {
        server: item.server,
        events: item.events,
        callback_url: item.callback_url,
        prompt: item.prompt,
        title: item.title,
      },
      created_at: item.created_at || "",
    }));
  },

  async enableTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/subscription/update`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ subscription_id: parseInt(triggerId), status: "active" }),
    });
    return res.ok;
  },

  async disableTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/subscription/update`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ subscription_id: parseInt(triggerId), status: "disabled" }),
    });
    return res.ok;
  },

  async deleteTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(`${AGENTDOJO_API_BASE}/unsubscribe`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ subscription_id: parseInt(triggerId) }),
    });
    return res.ok;
  },

  async setupWebhook(apiKey: string, webhookUrl: string): Promise<{ secret?: string }> {
    // AgentDojo uses per-subscription callback URLs, not a global webhook.
    // We just store the base URL locally — it will be passed when creating subscriptions.
    // No remote API call needed.
    return {};
  },

  async getWebhookConfig(apiKey: string): Promise<{ url: string | null; secret: string | null }> {
    // AgentDojo doesn't have a global webhook config — each subscription has its own callback_url.
    // Return null to indicate per-subscription mode.
    return { url: null, secret: null };
  },

  verifyWebhook(req: Request, body: string, secret: string): boolean {
    // AgentDojo forwards webhooks with an HMAC signature
    const signature = req.headers.get("x-webhook-signature") || "";
    if (!signature) {
      // If no signature header, check for a simple shared token
      const token = req.headers.get("x-webhook-token") || "";
      return token === secret;
    }

    // HMAC-SHA256 verification: signature is "sha256=<hex>"
    const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature;

    try {
      const expected = createHmac("sha256", secret).update(body).digest("hex");
      return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  },

  parseWebhookPayload(body: Record<string, unknown>): {
    triggerSlug: string;
    triggerInstanceId: string | null;
    payload: Record<string, unknown>;
  } {
    // AgentDojo forwarded payload format:
    // { type: "webhook", server: "stripe-payments", event: "payment_intent.succeeded",
    //   data: { ... }, prompt: "...", subscription_id: 123, timestamp: "..." }

    const server = (body.server as string) || "";
    const event = (body.event as string) || "";
    const triggerSlug = event ? `${server}:${event}` : server || (body.type as string) || "unknown";

    const triggerInstanceId = body.subscription_id
      ? String(body.subscription_id)
      : null;

    const payload = (body.data as Record<string, unknown>) || {};

    return { triggerSlug, triggerInstanceId, payload };
  },
};

function mapTriggerTypes(items: any[]): TriggerType[] {
  return items.map((item: any) => ({
    slug: item.slug,
    name: item.display_name || item.event_name || item.slug,
    description: item.description || "",
    type: (item.mechanism as "webhook" | "poll") || "webhook",
    toolkit_slug: item.toolkit?.name || item.toolkit_name || "",
    toolkit_name: item.toolkit?.display_name || item.toolkit_display_name || "",
    logo: item.toolkit?.icon_url || null,
    config_schema: item.config_schema || {},
    payload_schema: item.payload_schema || {},
  }));
}
