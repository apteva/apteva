import React, { useState, useEffect } from "react";
import { Select } from "../common/Select";
import { useTelemetryContext, type TelemetryEvent } from "../../context";

interface TelemetryStats {
  total_events: number;
  total_llm_calls: number;
  total_tool_calls: number;
  total_errors: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

interface UsageByAgent {
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  llm_calls: number;
  tool_calls: number;
  errors: number;
}

export function TelemetryPage() {
  const { connected, events: realtimeEvents } = useTelemetryContext();
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [historicalEvents, setHistoricalEvents] = useState<TelemetryEvent[]>([]);
  const [usage, setUsage] = useState<UsageByAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    category: "",
    level: "",
    agent_id: "",
  });
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  // Fetch agents for dropdown
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await fetch("/api/agents");
        const data = await res.json();
        setAgents(data.agents || []);
      } catch (e) {
        console.error("Failed to fetch agents:", e);
      }
    };
    fetchAgents();
  }, []);

  // Fetch stats and historical data (less frequently now since we have real-time)
  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch stats
      const statsRes = await fetch("/api/telemetry/stats");
      const statsData = await statsRes.json();
      setStats(statsData.stats);

      // Fetch historical events with filters
      const params = new URLSearchParams();
      if (filter.category) params.set("category", filter.category);
      if (filter.level) params.set("level", filter.level);
      if (filter.agent_id) params.set("agent_id", filter.agent_id);
      params.set("limit", "50");

      const eventsRes = await fetch(`/api/telemetry/events?${params}`);
      const eventsData = await eventsRes.json();
      setHistoricalEvents(eventsData.events || []);

      // Fetch usage by agent
      const usageRes = await fetch("/api/telemetry/usage?group_by=agent");
      const usageData = await usageRes.json();
      setUsage(usageData.usage || []);
    } catch (e) {
      console.error("Failed to fetch telemetry:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    // Refresh stats every 60 seconds (events come in real-time)
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [filter]);

  // Merge real-time events with historical, filtering and deduping
  const allEvents = React.useMemo(() => {
    // Apply filters to real-time events
    let filtered = realtimeEvents;
    if (filter.agent_id) {
      filtered = filtered.filter(e => e.agent_id === filter.agent_id);
    }
    if (filter.category) {
      filtered = filtered.filter(e => e.category === filter.category);
    }
    if (filter.level) {
      filtered = filtered.filter(e => e.level === filter.level);
    }

    // Merge with historical, dedupe by ID
    const seen = new Set(filtered.map(e => e.id));
    const merged = [...filtered];
    for (const evt of historicalEvents) {
      if (!seen.has(evt.id)) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }

    // Sort by timestamp descending
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return merged.slice(0, 100);
  }, [realtimeEvents, historicalEvents, filter]);

  const getAgentName = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    return agent?.name || agentId;
  };

  const formatNumber = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return n.toString();
  };

  const levelColors: Record<string, string> = {
    debug: "text-[#555]",
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
  };

  const categoryColors: Record<string, string> = {
    LLM: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    TOOL: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    CHAT: "bg-green-500/20 text-green-400 border-green-500/30",
    ERROR: "bg-red-500/20 text-red-400 border-red-500/30",
    SYSTEM: "bg-gray-500/20 text-gray-400 border-gray-500/30",
    TASK: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    MEMORY: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    MCP: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  };

  const agentOptions = [
    { value: "", label: "All Agents" },
    ...agents.map(a => ({ value: a.id, label: a.name })),
  ];

  const categoryOptions = [
    { value: "", label: "All Categories" },
    { value: "LLM", label: "LLM" },
    { value: "TOOL", label: "Tool" },
    { value: "CHAT", label: "Chat" },
    { value: "TASK", label: "Task" },
    { value: "MEMORY", label: "Memory" },
    { value: "MCP", label: "MCP" },
    { value: "SYSTEM", label: "System" },
    { value: "ERROR", label: "Error" },
  ];

  const levelOptions = [
    { value: "", label: "All Levels" },
    { value: "debug", label: "Debug" },
    { value: "info", label: "Info" },
    { value: "warn", label: "Warn" },
    { value: "error", label: "Error" },
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Telemetry</h1>
            <p className="text-[#666]">
              Monitor agent activity, token usage, and errors.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
            />
            <span className="text-xs text-[#666]">
              {connected ? "Live" : "Reconnecting..."}
            </span>
          </div>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <StatCard label="Events" value={formatNumber(stats.total_events)} />
            <StatCard label="LLM Calls" value={formatNumber(stats.total_llm_calls)} />
            <StatCard label="Tool Calls" value={formatNumber(stats.total_tool_calls)} />
            <StatCard label="Errors" value={formatNumber(stats.total_errors)} color="red" />
            <StatCard label="Input Tokens" value={formatNumber(stats.total_input_tokens)} />
            <StatCard label="Output Tokens" value={formatNumber(stats.total_output_tokens)} />
          </div>
        )}

        {/* Usage by Agent */}
        {usage.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-medium mb-3">Usage by Agent</h2>
            <div className="bg-[#111] border border-[#1a1a1a] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a1a] text-[#666]">
                    <th className="text-left p-3">Agent</th>
                    <th className="text-right p-3">LLM Calls</th>
                    <th className="text-right p-3">Tool Calls</th>
                    <th className="text-right p-3">Input Tokens</th>
                    <th className="text-right p-3">Output Tokens</th>
                    <th className="text-right p-3">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.agent_id} className="border-b border-[#1a1a1a] last:border-0">
                      <td className="p-3 font-medium">{getAgentName(u.agent_id)}</td>
                      <td className="p-3 text-right text-[#888]">{formatNumber(u.llm_calls)}</td>
                      <td className="p-3 text-right text-[#888]">{formatNumber(u.tool_calls)}</td>
                      <td className="p-3 text-right text-[#888]">{formatNumber(u.input_tokens)}</td>
                      <td className="p-3 text-right text-[#888]">{formatNumber(u.output_tokens)}</td>
                      <td className="p-3 text-right">
                        {u.errors > 0 ? (
                          <span className="text-red-400">{u.errors}</span>
                        ) : (
                          <span className="text-[#444]">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-56">
            <Select
              value={filter.agent_id}
              options={agentOptions}
              onChange={(value) => setFilter({ ...filter, agent_id: value })}
              placeholder="All Agents"
            />
          </div>
          <div className="w-48">
            <Select
              value={filter.category}
              options={categoryOptions}
              onChange={(value) => setFilter({ ...filter, category: value })}
              placeholder="All Categories"
            />
          </div>
          <div className="w-40">
            <Select
              value={filter.level}
              options={levelOptions}
              onChange={(value) => setFilter({ ...filter, level: value })}
              placeholder="All Levels"
            />
          </div>
          <button
            onClick={fetchData}
            className="px-3 py-2 bg-[#1a1a1a] hover:bg-[#222] border border-[#333] rounded text-sm transition"
          >
            Refresh
          </button>
        </div>

        {/* Events List */}
        <div className="bg-[#111] border border-[#1a1a1a] rounded-lg">
          <div className="p-3 border-b border-[#1a1a1a] flex items-center justify-between">
            <h2 className="font-medium">Recent Events</h2>
            {realtimeEvents.length > 0 && (
              <span className="text-xs text-[#666]">
                {realtimeEvents.length} new
              </span>
            )}
          </div>

          {loading && allEvents.length === 0 ? (
            <div className="p-8 text-center text-[#666]">Loading...</div>
          ) : allEvents.length === 0 ? (
            <div className="p-8 text-center text-[#666]">
              No telemetry events yet. Events will appear here in real-time once agents start sending data.
            </div>
          ) : (
            <div className="divide-y divide-[#1a1a1a]">
              {allEvents.map((event, index) => {
                // Check if this is a new real-time event (in first few positions and recent)
                const isNew = index < 3 && realtimeEvents.some(e => e.id === event.id);

                return (
                  <div
                    key={event.id}
                    className={`p-3 hover:bg-[#0a0a0a] transition cursor-pointer ${
                      isNew ? "bg-[#0f1a0f]" : ""
                    }`}
                    onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`px-2 py-0.5 rounded text-xs border ${categoryColors[event.category] || "bg-[#222] text-[#888] border-[#333]"}`}>
                        {event.category}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{event.type}</span>
                          <span className={`text-xs ${levelColors[event.level] || "text-[#666]"}`}>
                            {event.level}
                          </span>
                          {event.duration_ms && (
                            <span className="text-xs text-[#555]">{event.duration_ms}ms</span>
                          )}
                          {isNew && (
                            <span className="text-xs text-green-400">new</span>
                          )}
                        </div>
                        <div className="text-xs text-[#555] mt-1">
                          {getAgentName(event.agent_id)} · {new Date(event.timestamp).toLocaleString()}
                        </div>
                        {event.error && (
                          <div className="text-xs text-red-400 mt-1 font-mono">{event.error}</div>
                        )}
                        {expandedEvent === event.id && event.data && Object.keys(event.data).length > 0 && (
                          <pre className="text-xs text-[#666] mt-2 p-2 bg-[#0a0a0a] rounded overflow-x-auto">
                            {JSON.stringify(event.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4">
      <div className="text-[#666] text-xs mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${color === "red" ? "text-red-400" : ""}`}>
        {value}
      </div>
    </div>
  );
}
