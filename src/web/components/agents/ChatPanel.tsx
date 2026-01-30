import React from "react";
import { Chat } from "@apteva/apteva-kit";
import { CloseIcon } from "../common/Icons";
import type { Agent } from "../../types";

interface ChatPanelProps {
  agent: Agent;
  onClose: () => void;
  onStartAgent: (e?: React.MouseEvent) => void;
}

export function ChatPanel({ agent, onClose, onStartAgent }: ChatPanelProps) {
  if (agent.status === "running" && agent.port) {
    return (
      <div className="w-1/2 flex flex-col overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden relative">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 text-[#666] hover:text-[#e0e0e0] transition"
          >
            <CloseIcon />
          </button>
          <Chat
            agentId="default"
            apiUrl={`/api/agents/${agent.id}`}
            placeholder="Message this agent..."
            context={agent.systemPrompt}
            variant="terminal"
            headerTitle={agent.name}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="w-1/2 flex flex-col overflow-hidden">
      <div className="border-b border-[#1a1a1a] p-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{agent.name}</h2>
          <p className="text-sm text-[#666]">{agent.provider} / {agent.model}</p>
        </div>
        <button
          onClick={onClose}
          className="text-[#666] hover:text-[#e0e0e0] transition"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center text-[#666]">
        <div className="text-center">
          <p className="text-lg mb-2">Agent is not running</p>
          <button
            onClick={onStartAgent}
            className="bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6]/30 px-4 py-2 rounded font-medium transition"
          >
            Start Agent
          </button>
        </div>
      </div>
    </div>
  );
}
