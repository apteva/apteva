import { json } from "./helpers";
import { AgentDB, SubscriptionDB, SettingsDB } from "../../db";
import { getTriggerProvider } from "../../triggers";
import { agentFetch } from "./agent-utils";

/**
 * Central webhook receiver for trigger providers.
 * POST /api/webhooks/:provider — receives trigger events from any registered provider,
 * verifies HMAC, looks up local subscriptions, and dispatches to the appropriate agent(s).
 *
 * This endpoint is public (HMAC-verified, no JWT/API key auth).
 */
export async function handleWebhookRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {

  // POST /api/webhooks/composio
  if (path === "/api/webhooks/composio" && method === "POST") {
    return handleProviderWebhook(req, "composio");
  }

  // POST /api/webhooks/agentdojo
  if (path === "/api/webhooks/agentdojo" && method === "POST") {
    return handleProviderWebhook(req, "agentdojo");
  }

  return null;
}

async function handleProviderWebhook(req: Request, providerId: string): Promise<Response> {
  const provider = getTriggerProvider(providerId);
  if (!provider) {
    return json({ error: `${providerId} provider not registered` }, 500);
  }

  // Read raw body for HMAC verification
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return json({ error: "Failed to read request body" }, 400);
  }

  // Verify HMAC signature using stored webhook secret
  const webhookSecret = SettingsDB.get(`${providerId}_webhook_secret`);
  if (webhookSecret) {
    const valid = provider.verifyWebhook(req, rawBody, webhookSecret);
    if (!valid) {
      console.warn(`[webhook] Invalid HMAC signature for ${providerId} webhook`);
      return json({ error: "Invalid signature" }, 401);
    }
  } else {
    console.warn(`[webhook] No ${providerId} webhook secret configured — skipping HMAC verification`);
  }

  // Parse the payload
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Log raw webhook for debugging
  console.log(`[webhook:${providerId}] Raw payload:`, JSON.stringify(body, null, 2));

  const { triggerSlug, triggerInstanceId, payload } = provider.parseWebhookPayload(body);
  console.log(`[webhook:${providerId}] Parsed:`, { triggerSlug, triggerInstanceId });

  // Respond 200 immediately — dispatch async
  const dispatchPromise = dispatchToSubscribers(providerId, triggerSlug, triggerInstanceId, payload);

  // Fire and forget — but log errors
  dispatchPromise.catch(err => {
    console.error(`[webhook:${providerId}] Dispatch error:`, err);
  });

  return json({ received: true, provider: providerId, trigger: triggerSlug });
}

async function dispatchToSubscribers(
  providerId: string,
  triggerSlug: string,
  triggerInstanceId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  // Find matching subscriptions:
  // 1. Exact match by trigger_instance_id (most specific)
  // 2. Match by trigger_slug (broader)
  let subscriptions = triggerInstanceId
    ? SubscriptionDB.findByTriggerInstanceId(triggerInstanceId)
    : [];

  // If no instance-level matches, fall back to slug-level
  if (subscriptions.length === 0) {
    subscriptions = SubscriptionDB.findByTriggerSlug(triggerSlug);
  }

  // Filter to enabled only
  subscriptions = subscriptions.filter(s => s.enabled);

  if (subscriptions.length === 0) {
    console.log(`[webhook:${providerId}] No subscriptions for trigger ${triggerSlug} (instance: ${triggerInstanceId || "none"})`);
    return;
  }

  // Dispatch to each subscribed agent
  const results = await Promise.allSettled(
    subscriptions.map(sub => dispatchToAgent(sub.agent_id, triggerSlug, payload)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sub = subscriptions[i];
    if (result.status === "rejected") {
      console.error(`[webhook:${providerId}] Failed to dispatch to agent ${sub.agent_id}:`, result.reason);
    } else {
      console.log(`[webhook:${providerId}] Dispatched ${triggerSlug} to agent ${sub.agent_id}: ${result.value}`);
    }
  }
}

async function dispatchToAgent(
  agentId: string,
  triggerSlug: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const agent = AgentDB.findById(agentId);
  if (!agent) {
    return "agent_not_found";
  }

  if (agent.status !== "running" || !agent.port) {
    return "agent_not_running";
  }

  // Format the trigger event as a chat message
  const triggerName = triggerSlug.replace(/_/g, " ").replace(/:/g, " → ");
  const message = [
    `[Trigger: ${triggerName}]`,
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Process this event and take appropriate action.",
  ].join("\n");

  const response = await agentFetch(agent.id, agent.port, "/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  // Consume the streaming response
  if (response.body) {
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Ignore read errors
    }
  }

  return response.ok ? "sent" : "agent_error";
}
