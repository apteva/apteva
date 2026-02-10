// Composio Trigger Provider
// https://docs.composio.dev/api-reference/triggers

import { createHmac, timingSafeEqual } from "crypto";
import type { TriggerProvider, TriggerType, TriggerInstance } from "./index";

const COMPOSIO_API_BASE = "https://backend.composio.dev";

function headers(apiKey: string) {
  return { "x-api-key": apiKey, "Content-Type": "application/json" };
}

export const ComposioTriggerProvider: TriggerProvider = {
  id: "composio",
  name: "Composio",

  async listTriggerTypes(apiKey: string, toolkitSlugs?: string[]): Promise<TriggerType[]> {
    const params = new URLSearchParams();
    if (toolkitSlugs?.length) {
      params.set("toolkit_slugs", toolkitSlugs.join(","));
    }

    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/triggers_types?${params}`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      console.error("Composio listTriggerTypes error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.items || data || [];

    return items.map((item: any) => ({
      slug: item.slug || item.enum,
      name: item.name || item.slug,
      description: item.description || "",
      type: item.type || "webhook",
      toolkit_slug: item.toolkit?.slug || item.app_slug || "",
      toolkit_name: item.toolkit?.name || item.app_name || "",
      logo: item.toolkit?.logo || item.logo || null,
      config_schema: item.config || {},
      payload_schema: item.payload || {},
    }));
  },

  async getTriggerType(apiKey: string, slug: string): Promise<TriggerType | null> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/triggers_types/${encodeURIComponent(slug)}`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      console.error("Composio getTriggerType error:", res.status, await res.text());
      return null;
    }

    const item = await res.json();
    return {
      slug: item.slug || item.enum,
      name: item.name || item.slug,
      description: item.description || "",
      type: item.type || "webhook",
      toolkit_slug: item.toolkit?.slug || item.app_slug || "",
      toolkit_name: item.toolkit?.name || item.app_name || "",
      logo: item.toolkit?.logo || item.logo || null,
      config_schema: item.config || {},
      payload_schema: item.payload || {},
    };
  },

  async createTrigger(
    apiKey: string,
    slug: string,
    connectedAccountId: string,
    config?: Record<string, unknown>,
  ): Promise<{ triggerId: string }> {
    const body: any = {
      connected_account_id: connectedAccountId,
    };
    if (config) {
      body.trigger_config = config;
    }

    const res = await fetch(
      `${COMPOSIO_API_BASE}/api/v3/trigger_instances/${encodeURIComponent(slug)}/upsert`,
      {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("Composio createTrigger error:", res.status, errText);
      throw new Error(`Failed to create trigger: ${errText}`);
    }

    const data = await res.json();
    return { triggerId: data.trigger_id || data.deprecated?.uuid || data.id };
  },

  async listTriggers(apiKey: string): Promise<TriggerInstance[]> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/trigger_instances/active`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      console.error("Composio listTriggers error:", res.status, await res.text());
      return [];
    }

    const data = await res.json();
    const items = data.items || data.triggers || data || [];

    return items.map((item: any) => ({
      id: item.id || item.trigger_id,
      trigger_slug: item.trigger_name || item.trigger_slug || item.slug || "",
      connected_account_id: item.connected_account_id || item.connectedAccountId || null,
      status: item.disabled ? "disabled" : "active",
      config: item.trigger_config || item.triggerConfig || {},
      created_at: item.created_at || item.createdAt || "",
    }));
  },

  async enableTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(
      `${COMPOSIO_API_BASE}/api/v3/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      {
        method: "PATCH",
        headers: headers(apiKey),
        body: JSON.stringify({ status: "enable" }),
      },
    );
    return res.ok;
  },

  async disableTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(
      `${COMPOSIO_API_BASE}/api/v3/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      {
        method: "PATCH",
        headers: headers(apiKey),
        body: JSON.stringify({ status: "disable" }),
      },
    );
    return res.ok;
  },

  async deleteTrigger(apiKey: string, triggerId: string): Promise<boolean> {
    const res = await fetch(
      `${COMPOSIO_API_BASE}/api/v3/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      {
        method: "DELETE",
        headers: headers(apiKey),
      },
    );
    return res.ok;
  },

  async setupWebhook(apiKey: string, webhookUrl: string): Promise<{ secret?: string }> {
    // Use webhook_subscriptions API (requires HTTPS)
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/webhook_subscriptions`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        webhook_url: webhookUrl,
        enabled_events: ["composio.trigger.message"],
        version: "V3",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Composio setupWebhook error:", res.status, errText);
      throw new Error(`Failed to set webhook URL: ${errText}`);
    }

    const data = await res.json();
    const secret = data.secret || data.webhook_secret || undefined;
    return { secret };
  },

  async getWebhookConfig(apiKey: string): Promise<{ url: string | null; secret: string | null }> {
    const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/webhook_subscriptions`, {
      headers: headers(apiKey),
    });

    if (!res.ok) {
      console.error("Composio getWebhookConfig error:", res.status, await res.text());
      return { url: null, secret: null };
    }

    const data = await res.json();
    const items = data.items || data.subscriptions || (Array.isArray(data) ? data : [data]);
    const sub = items[0];
    return {
      url: sub?.webhook_url || sub?.callback_url || sub?.url || null,
      secret: sub?.secret || sub?.webhook_secret || null,
    };
  },

  verifyWebhook(req: Request, body: string, secret: string): boolean {
    const signature = req.headers.get("webhook-signature") || "";
    const webhookId = req.headers.get("webhook-id") || "";
    const timestamp = req.headers.get("webhook-timestamp") || "";

    if (!signature || !webhookId || !timestamp) return false;

    // Check timestamp freshness (5-minute window to prevent replay)
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > 300) return false;

    // Composio signature: HMAC-SHA256("{webhook-id}.{timestamp}.{body}", secret)
    const signedContent = `${webhookId}.${timestamp}.${body}`;
    const expectedSignature = createHmac("sha256", secret)
      .update(signedContent)
      .digest("base64");

    // Signature header format: "v1,<base64>"
    const sig = signature.startsWith("v1,") ? signature.slice(3) : signature;

    try {
      return timingSafeEqual(
        Buffer.from(sig, "base64"),
        Buffer.from(expectedSignature, "base64"),
      );
    } catch {
      return false;
    }
  },

  parseWebhookPayload(body: Record<string, unknown>): {
    triggerSlug: string;
    triggerInstanceId: string | null;
    payload: Record<string, unknown>;
  } {
    // V3 format: { type: "composio.trigger.message", metadata: { trigger_slug, trigger_id, ... }, data: { ... } }
    // V2/V1 format: { trigger_name, trigger_id, payload: { ... } }
    const metadata = (body.metadata as Record<string, unknown>) || {};
    const data = (body.data as Record<string, unknown>) || {};

    const triggerSlug =
      (metadata.trigger_slug as string) ||
      (body.trigger_name as string) ||
      ((body.type as string) !== "composio.trigger.message" ? (body.type as string) : null) ||
      "unknown";

    const triggerInstanceId =
      (metadata.trigger_id as string) ||
      (body.trigger_id as string) ||
      (body.triggerId as string) ||
      null;

    const payload =
      (body.payload as Record<string, unknown>) ||
      data;

    return { triggerSlug, triggerInstanceId, payload };
  },
};
