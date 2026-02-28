import { json } from "./helpers";
import { TelemetryDB, AgentDB } from "../../db";
import { getModelCost } from "../../providers";
import { telemetryBroadcaster, type TelemetryEvent } from "../../server";

export async function handleTelemetryRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // POST /api/telemetry - Receive telemetry events from agents
  if (path === "/api/telemetry" && method === "POST") {
    try {
      const body = await req.json() as {
        agent_id: string;
        sent_at: string;
        events: Array<{
          id: string;
          timestamp: string;
          category: string;
          type: string;
          level: string;
          trace_id?: string;
          span_id?: string;
          thread_id?: string;
          data?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          duration_ms?: number;
          error?: string;
        }>;
      };

      if (!body.agent_id || !body.events) {
        return json({ error: "agent_id and events are required" }, 400);
      }

      // Debug: log raw incoming events
      for (const event of body.events) {
        if (event.category === "LLM") {
          console.log(`[telemetry] RAW LLM event from ${body.agent_id}: ${JSON.stringify(event)}`);
        }
      }

      // Filter out debug events - too noisy
      const filteredEvents = body.events.filter(e => e.level !== "debug");

      // Compute cost per LLM event if cost tracking is enabled
      const costTrackingEnabled = process.env.COST_TRACKING_ENABLED !== "false";
      if (costTrackingEnabled) {
        const agent = AgentDB.findById(body.agent_id);
        if (agent) {
          const pricing = getModelCost(agent.provider, agent.model);
          for (const event of filteredEvents) {
            if (event.category === "LLM" && event.data) {
              const inputTokens = (event.data.input_tokens as number) || 0;
              const outputTokens = (event.data.output_tokens as number) || 0;
              const cacheCreationTokens = (event.data.cache_creation_tokens as number) || 0;
              const cacheReadTokens = (event.data.cache_read_tokens as number) || 0;
              const reasoningTokens = (event.data.reasoning_tokens as number) || 0;
              (event as any).cost = (
                inputTokens * pricing.input_cost +
                outputTokens * pricing.output_cost +
                cacheCreationTokens * pricing.cache_creation_cost +
                cacheReadTokens * pricing.cache_read_cost +
                reasoningTokens * pricing.output_cost
              ) / 1_000_000;
            }
          }
        }
      }

      const inserted = TelemetryDB.insertBatch(body.agent_id, filteredEvents);

      // Broadcast to SSE clients
      if (filteredEvents.length > 0) {
        const broadcastEvents: TelemetryEvent[] = filteredEvents.map(e => ({
          id: e.id,
          agent_id: body.agent_id,
          timestamp: e.timestamp,
          category: e.category,
          type: e.type,
          level: e.level,
          trace_id: e.trace_id,
          thread_id: e.thread_id,
          data: e.data,
          duration_ms: e.duration_ms,
          error: e.error,
        }));
        telemetryBroadcaster.broadcast(broadcastEvents);
      }

      return json({ received: body.events.length, inserted });
    } catch (e) {
      console.error("Telemetry error:", e);
      return json({ error: "Invalid telemetry payload" }, 400);
    }
  }

  // GET /api/telemetry/stream - SSE stream for real-time telemetry
  if (path === "/api/telemetry/stream" && method === "GET") {
    let controller: ReadableStreamDefaultController<string>;

    const stream = new ReadableStream<string>({
      start(c) {
        controller = c;
        telemetryBroadcaster.addClient(controller);
        // Send initial connection message
        controller.enqueue("data: {\"connected\":true}\n\n");
      },
      cancel() {
        telemetryBroadcaster.removeClient(controller);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // GET /api/telemetry/events - Query telemetry events
  if (path === "/api/telemetry/events" && method === "GET") {
    const url = new URL(req.url);
    const projectIdParam = url.searchParams.get("project_id");
    const events = TelemetryDB.query({
      agent_id: url.searchParams.get("agent_id") || undefined,
      project_id: projectIdParam === "null" ? null : projectIdParam || undefined,
      category: url.searchParams.get("category") || undefined,
      type: url.searchParams.get("type") || undefined,
      level: url.searchParams.get("level") || undefined,
      trace_id: url.searchParams.get("trace_id") || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
      limit: parseInt(url.searchParams.get("limit") || "100"),
      offset: parseInt(url.searchParams.get("offset") || "0"),
    });
    return json({ events });
  }

  // GET /api/telemetry/usage - Get usage statistics
  if (path === "/api/telemetry/usage" && method === "GET") {
    const url = new URL(req.url);
    const projectIdParam = url.searchParams.get("project_id");
    const usage = TelemetryDB.getUsage({
      agent_id: url.searchParams.get("agent_id") || undefined,
      project_id: projectIdParam === "null" ? null : projectIdParam || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
      group_by: (url.searchParams.get("group_by") as "agent" | "day" | "project") || undefined,
    });
    return json({ usage });
  }

  // GET /api/telemetry/stats - Get summary statistics
  if (path === "/api/telemetry/stats" && method === "GET") {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") || undefined;
    const projectIdParam = url.searchParams.get("project_id");
    const stats = TelemetryDB.getStats({
      agentId,
      projectId: projectIdParam === "null" ? null : projectIdParam || undefined,
      since: url.searchParams.get("since") || undefined,
      until: url.searchParams.get("until") || undefined,
    });
    return json({ stats });
  }

  // POST /api/telemetry/clear - Clear all telemetry data
  if (path === "/api/telemetry/clear" && method === "POST") {
    const deleted = TelemetryDB.deleteOlderThan(0); // Delete all
    return json({ deleted });
  }

  // --- Notification endpoints (piggyback on telemetry `seen` flag) ---

  // GET /api/notifications - Get notification-worthy events
  if (path === "/api/notifications" && method === "GET") {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const notifications = TelemetryDB.getNotifications(limit);
    return json({ notifications });
  }

  // GET /api/notifications/count - Get unseen notification count
  if (path === "/api/notifications/count" && method === "GET") {
    const count = TelemetryDB.getUnseenCount();
    return json({ count });
  }

  // POST /api/notifications/mark-seen - Mark specific notifications as seen
  if (path === "/api/notifications/mark-seen" && method === "POST") {
    const body = await req.json() as { ids?: string[]; all?: boolean };
    if (body.all) {
      const updated = TelemetryDB.markAllSeen();
      return json({ updated });
    }
    if (body.ids && body.ids.length > 0) {
      const updated = TelemetryDB.markSeen(body.ids);
      return json({ updated });
    }
    return json({ error: "Provide ids array or all: true" }, 400);
  }

  return null;
}
