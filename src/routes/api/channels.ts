import { json } from "./helpers";
import { ChannelDB, AgentDB } from "../../db";
import { encryptObject } from "../../crypto";
import { startChannel, stopChannel } from "../../channels";

export async function handleChannelRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // GET /api/channels - List all channels
  if (path === "/api/channels" && method === "GET") {
    const channels = ChannelDB.findAll();
    // Strip encrypted config from list response
    const safe = channels.map(ch => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      agent_id: ch.agent_id,
      status: ch.status,
      error: ch.error,
      project_id: ch.project_id,
      created_at: ch.created_at,
      updated_at: ch.updated_at,
    }));
    return json({ channels: safe });
  }

  // POST /api/channels - Create a new channel
  if (path === "/api/channels" && method === "POST") {
    const body = await req.json();
    const { type, name, agent_id, config, project_id } = body;

    if (!type || !name || !agent_id || !config) {
      return json({ error: "Missing required fields: type, name, agent_id, config" }, 400);
    }

    if (type !== "telegram") {
      return json({ error: `Unsupported channel type: ${type}. Supported: telegram` }, 400);
    }

    // Validate agent exists
    const agent = AgentDB.findById(agent_id);
    if (!agent) {
      return json({ error: "Agent not found" }, 404);
    }

    // Validate config has required fields
    if (!config.botToken) {
      return json({ error: "Missing botToken in config" }, 400);
    }

    // Encrypt config before storing
    const encryptedConfig = encryptObject(config);

    const channel = ChannelDB.create({
      type,
      name,
      agent_id,
      config: encryptedConfig,
      project_id: project_id || null,
    });

    return json({
      channel: {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        agent_id: channel.agent_id,
        status: channel.status,
        error: channel.error,
        project_id: channel.project_id,
        created_at: channel.created_at,
      },
    }, 201);
  }

  // Routes with channel ID
  const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  const channelActionMatch = path.match(/^\/api\/channels\/([^/]+)\/(start|stop)$/);

  // GET /api/channels/:id - Get channel detail
  if (channelMatch && method === "GET") {
    const channel = ChannelDB.findById(channelMatch[1]);
    if (!channel) return json({ error: "Channel not found" }, 404);

    return json({
      channel: {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        agent_id: channel.agent_id,
        status: channel.status,
        error: channel.error,
        project_id: channel.project_id,
        created_at: channel.created_at,
        updated_at: channel.updated_at,
      },
    });
  }

  // PUT /api/channels/:id - Update channel
  if (channelMatch && method === "PUT") {
    const channel = ChannelDB.findById(channelMatch[1]);
    if (!channel) return json({ error: "Channel not found" }, 404);

    if (channel.status === "running") {
      return json({ error: "Stop the channel before updating" }, 400);
    }

    const body = await req.json();
    const updates: Record<string, any> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.agent_id !== undefined) {
      const agent = AgentDB.findById(body.agent_id);
      if (!agent) return json({ error: "Agent not found" }, 404);
      updates.agent_id = body.agent_id;
    }
    if (body.config !== undefined) {
      if (!body.config.botToken) {
        return json({ error: "Missing botToken in config" }, 400);
      }
      updates.config = encryptObject(body.config);
    }
    if (body.project_id !== undefined) updates.project_id = body.project_id;

    const updated = ChannelDB.update(channelMatch[1], updates);
    return json({
      channel: updated ? {
        id: updated.id,
        type: updated.type,
        name: updated.name,
        agent_id: updated.agent_id,
        status: updated.status,
        project_id: updated.project_id,
      } : null,
    });
  }

  // DELETE /api/channels/:id - Delete channel
  if (channelMatch && method === "DELETE") {
    const channel = ChannelDB.findById(channelMatch[1]);
    if (!channel) return json({ error: "Channel not found" }, 404);

    // Stop if running
    if (channel.status === "running") {
      await stopChannel(channel.id);
    }

    ChannelDB.delete(channelMatch[1]);
    return json({ deleted: true });
  }

  // POST /api/channels/:id/start - Start channel
  if (channelActionMatch && channelActionMatch[2] === "start" && method === "POST") {
    const channel = ChannelDB.findById(channelActionMatch[1]);
    if (!channel) return json({ error: "Channel not found" }, 404);

    if (channel.status === "running") {
      return json({ error: "Channel is already running" }, 400);
    }

    const result = await startChannel(channel.id);
    if (!result.success) {
      return json({ error: result.error || "Failed to start channel" }, 500);
    }

    return json({ started: true });
  }

  // POST /api/channels/:id/stop - Stop channel
  if (channelActionMatch && channelActionMatch[2] === "stop" && method === "POST") {
    const channel = ChannelDB.findById(channelActionMatch[1]);
    if (!channel) return json({ error: "Channel not found" }, 404);

    await stopChannel(channel.id);
    return json({ stopped: true });
  }

  return null;
}
