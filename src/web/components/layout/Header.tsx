import React from "react";
import { useTelemetryContext } from "../../context";

interface HeaderProps {
  onNewAgent: () => void;
  canCreateAgent: boolean;
}

export function Header({ onNewAgent, canCreateAgent }: HeaderProps) {
  const { connected } = useTelemetryContext();

  return (
    <header className="border-b border-[#1a1a1a] px-6 py-4 flex-shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[#f97316]">&gt;_</span>
          <span className="text-xl tracking-wider">apteva</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
            />
            <span className="text-xs text-[#666]">
              {connected ? "Live" : "Offline"}
            </span>
          </div>
          <button
            onClick={onNewAgent}
            disabled={!canCreateAgent}
            className="bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-2 rounded font-medium transition"
          >
            + New Agent
          </button>
        </div>
      </div>
    </header>
  );
}
