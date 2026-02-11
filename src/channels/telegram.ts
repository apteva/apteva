import { Bot } from "grammy";
import { AgentDB, ChannelDB } from "../db";
import { decryptObject } from "../crypto";
import { agentFetch } from "../routes/api/agent-utils";

interface TelegramConfig {
  botToken: string;
  allowList?: string[]; // Telegram user IDs allowed to chat
}

// In-memory map of running bot instances
const activeBots = new Map<string, Bot>();

export function isChannelActive(channelId: string): boolean {
  return activeBots.has(channelId);
}

export async function startTelegramChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
  // Stop existing if running
  if (activeBots.has(channelId)) {
    await stopTelegramChannel(channelId);
  }

  const channel = ChannelDB.findById(channelId);
  if (!channel) return { success: false, error: "Channel not found" };

  let config: TelegramConfig;
  try {
    config = decryptObject(channel.config) as unknown as TelegramConfig;
  } catch {
    ChannelDB.setStatus(channelId, "error", "Failed to decrypt config");
    return { success: false, error: "Failed to decrypt config" };
  }

  if (!config.botToken) {
    ChannelDB.setStatus(channelId, "error", "Missing bot token");
    return { success: false, error: "Missing bot token" };
  }

  const agent = AgentDB.findById(channel.agent_id);
  if (!agent) {
    ChannelDB.setStatus(channelId, "error", "Agent not found");
    return { success: false, error: "Agent not found" };
  }

  try {
    const bot = new Bot(config.botToken);

    // /start command
    bot.command("start", async (ctx) => {
      await ctx.reply(`Connected to agent: ${agent.name}`);
    });

    // Handle text messages
    bot.on("message:text", async (ctx) => {
      // Access control
      if (config.allowList?.length) {
        const senderId = String(ctx.from.id);
        if (!config.allowList.includes(senderId)) return;
      }

      // Check agent is running
      const currentAgent = AgentDB.findById(channel.agent_id);
      if (!currentAgent || currentAgent.status !== "running" || !currentAgent.port) {
        await ctx.reply("Agent is not running.");
        return;
      }

      // Send typing indicator
      await ctx.replyWithChatAction("typing");

      try {
        // Map telegram chat → agent thread
        const threadId = `telegram-${ctx.chat.id}`;

        // Proxy to agent via agentFetch (same path as web UI chat)
        const res = await agentFetch(currentAgent.id, currentAgent.port, "/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: ctx.message.text,
            thread_id: threadId,
          }),
        });

        if (!res.ok) {
          await ctx.reply("Error: agent returned an error.");
          return;
        }

        // Stream response and send messages progressively as segments complete
        await streamAndSend(res, ctx);
      } catch (err) {
        console.error(`[telegram:${channelId}] Message handling error:`, err);
        await ctx.reply("Error processing your message.");
      }
    });

    // Error handler
    bot.catch((err) => {
      console.error(`[telegram:${channelId}] Bot error:`, err);
    });

    // Start long-polling (non-blocking)
    bot.start({
      onStart: () => {
        console.log(`[telegram:${channelId}] Bot started for agent ${agent.name}`);
      },
    });

    activeBots.set(channelId, bot);
    ChannelDB.setStatus(channelId, "running");
    return { success: true };
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    console.error(`[telegram:${channelId}] Failed to start:`, errorMsg);
    ChannelDB.setStatus(channelId, "error", errorMsg);
    return { success: false, error: errorMsg };
  }
}

export async function stopTelegramChannel(channelId: string): Promise<void> {
  const bot = activeBots.get(channelId);
  if (bot) {
    try {
      await bot.stop();
    } catch {
      // Ignore stop errors
    }
    activeBots.delete(channelId);
  }
  ChannelDB.setStatus(channelId, "stopped");
  console.log(`[telegram:${channelId}] Bot stopped`);
}

/**
 * Stream SSE response from agent and send Telegram messages progressively.
 * Mirrors the chunk types from apteva-kit's chat component:
 *   content/token → accumulate text, send when a boundary is hit
 *   tool_call → flush pending text, send tool indicator immediately
 *   tool_use, tool_input_delta, tool_result, tool_stream → skipped
 *
 * Messages are sent as soon as each segment completes (tool boundary or end of stream),
 * so the user sees them appear progressively in real-time.
 */
async function streamAndSend(
  res: Response,
  ctx: { reply: (text: string, opts?: any) => Promise<any>; replyWithChatAction: (action: string) => Promise<any> },
  onActivity?: () => void,
): Promise<void> {
  if (!res.body) {
    await ctx.reply("(No response from agent)");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let buffer = "";
  let messagesSent = 0;

  async function flushText() {
    const trimmed = textBuffer.trim();
    if (trimmed) {
      const chunks = splitMessage(trimmed, 4096);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          await ctx.reply(chunk);
        }
        messagesSent++;
      }
    }
    textBuffer = "";
  }

  // Periodically send typing indicator while streaming
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);

          switch (chunk.type) {
            // Text content — accumulate
            case "content":
            case "token":
              if (chunk.content) textBuffer += chunk.content;
              else if (chunk.text) textBuffer += chunk.text;
              break;

            // Tool starting — flush text immediately, then send tool indicator
            case "tool_call": {
              await flushText();
              const name = chunk.tool_display_name || chunk.tool_name || "tool";
              try {
                await ctx.reply(`🔧 _${escapeMarkdown(name)}_`, { parse_mode: "Markdown" });
              } catch {
                await ctx.reply(`🔧 ${name}`);
              }
              messagesSent++;
              break;
            }

            // Intermediate tool events — skip, but signal activity
            case "tool_input_delta":
            case "tool_use":
            case "tool_stream":
            case "tool_result":
              onActivity?.();
              break;

            // Fallback: older SSE formats
            case "message_delta":
              if (chunk.delta?.text) textBuffer += chunk.delta.text;
              break;
            case "content_block_delta":
              if (chunk.delta?.text) textBuffer += chunk.delta.text;
              break;

            default:
              if (chunk.content && typeof chunk.content === "string") {
                textBuffer += chunk.content;
              } else if (typeof chunk.text === "string") {
                textBuffer += chunk.text;
              }
              break;
          }
        } catch {
          if (data && data !== "[DONE]") {
            textBuffer += data;
          }
        }
      }
    }
  } catch {
    // Stream read error — flush what we have
  } finally {
    clearInterval(typingInterval);
  }

  // Flush remaining text
  await flushText();

  if (messagesSent === 0) {
    await ctx.reply("(No response from agent)");
  }
}

/**
 * Escape special Markdown characters for Telegram Markdown parse mode.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Split a message into chunks respecting the max length.
 * Tries to split at newlines when possible.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) {
      // No good newline found — split at space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // No good split point — hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
