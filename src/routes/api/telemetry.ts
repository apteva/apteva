import { json } from "./helpers";
import { TelemetryDB } from "../../db";
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

      // Filter out debug events - too noisy
      const filteredEvents = body.events.filter(e => e.level !== "debug");
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
      group_by: (url.searchParams.get("group_by") as "agent" | "day") || undefined,
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
    });
    return json({ stats });
  }

  // POST /api/telemetry/clear - Clear all telemetry data
  if (path === "/api/telemetry/clear" && method === "POST") {
    const deleted = TelemetryDB.deleteOlderThan(0); // Delete all
    return json({ deleted });
  }

  return null;
}
