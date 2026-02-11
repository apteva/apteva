import { ChannelDB } from "../db";
import {
  startTelegramChannel,
  stopTelegramChannel,
  isChannelActive,
} from "./telegram";

export async function startChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
  const channel = ChannelDB.findById(channelId);
  if (!channel) return { success: false, error: "Channel not found" };

  switch (channel.type) {
    case "telegram":
      return startTelegramChannel(channelId);
    default:
      return { success: false, error: `Unsupported channel type: ${channel.type}` };
  }
}

export async function stopChannel(channelId: string): Promise<void> {
  const channel = ChannelDB.findById(channelId);
  if (!channel) return;

  switch (channel.type) {
    case "telegram":
      await stopTelegramChannel(channelId);
      break;
  }
}

export async function stopAllChannels(): Promise<void> {
  const running = ChannelDB.findRunning();
  for (const channel of running) {
    await stopChannel(channel.id);
  }
}

export function isActive(channelId: string): boolean {
  return isChannelActive(channelId);
}
