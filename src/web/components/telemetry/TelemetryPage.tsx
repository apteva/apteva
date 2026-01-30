import React, { useState, useEffect, useMemo, useRef } from "react";
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

// Helper to extract stats from a single event
function extractEventStats(event: TelemetryEvent): {
  llm_calls: number;
  tool_calls: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
} {
  const isLlm = event.category === "LLM";
  const isTool = event.category === "TOOL";
  const isError = event.level === "error";
  const inputTokens = (event.data?.input_tokens as number) || 0;
  const outputTokens = (event.data?.output_tokens as number) || 0;

  return {
    llm_calls: isLlm ? 1 : 0,
    tool_calls: isTool ? 1 : 0,
    errors: isError ? 1 : 0,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

export function TelemetryPage() {
  const { events: realtimeEvents } = useTelemetryContext();
  const [fetchedStats, setFetchedStats] = useState<TelemetryStats | null>(null);
  const [historicalEvents, setHistoricalEvents] = useState<TelemetryEvent[]>([]);
  const [fetchedUsage, setFetchedUsage] = useState<UsageByAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    category: "",
    level: "",
    agent_id: "",
  });
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  // Track IDs that were in the fetched stats to avoid double-counting
  const countedEventIdsRef = useRef<Set<string>>(new Set());

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
      setFetchedStats(statsData.stats);

      // Fetch historical events with filters
      const params = new URLSearchParams();
      if (filter.category) params.set("category", filter.category);
      if (filter.level) params.set("level", filter.level);
      if (filter.agent_id) params.set("agent_id", filter.agent_id);
      params.set("limit", "50");

      const eventsRes = await fetch(`/api/telemetry/events?${params}`);
      const eventsData = await eventsRes.json();
      const events = eventsData.events || [];
      setHistoricalEvents(events);

      // Mark all fetched event IDs as counted (stats already include them)
      countedEventIdsRef.current = new Set(events.map((e: TelemetryEvent) => e.id));

      // Fetch usage by agent
      const usageRes = await fetch("/api/telemetry/usage?group_by=agent");
      const usageData = await usageRes.json();
      setFetchedUsage(usageData.usage || []);
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

  // Compute real-time stats from new events (not already counted in fetched stats)
  const stats = useMemo(() => {
    if (!fetchedStats) return null;

    // Calculate deltas from real-time events not in fetched data
    let deltaEvents = 0;
    let deltaLlmCalls = 0;
    let deltaToolCalls = 0;
    let deltaErrors = 0;
    let deltaInputTokens = 0;
    let deltaOutputTokens = 0;

    for (const event of realtimeEvents) {
      if (!countedEventIdsRef.current.has(event.id)) {
        deltaEvents++;
        const eventStats = extractEventStats(event);
        deltaLlmCalls += eventStats.llm_calls;
        deltaToolCalls += eventStats.tool_calls;
        deltaErrors += eventStats.errors;
        deltaInputTokens += eventStats.input_tokens;
        deltaOutputTokens += eventStats.output_tokens;
      }
    }

    return {
      total_events: fetchedStats.total_events + deltaEvents,
      total_llm_calls: fetchedStats.total_llm_calls + deltaLlmCalls,
      total_tool_calls: fetchedStats.total_tool_calls + deltaToolCalls,
      total_errors: fetchedStats.total_errors + deltaErrors,
      total_input_tokens: fetchedStats.total_input_tokens + deltaInputTokens,
      total_output_tokens: fetchedStats.total_output_tokens + deltaOutputTokens,
    };
  }, [fetchedStats, realtimeEvents]);

  // Compute real-time usage by agent
  const usage = useMemo(() => {
    // Start with a copy of fetched usage as a map
    const usageMap = new Map<string, UsageByAgent>();
    for (const u of fetchedUsage) {
      usageMap.set(u.agent_id, { ...u });
    }

    // Add deltas from real-time events
    for (const event of realtimeEvents) {
      if (!countedEventIdsRef.current.has(event.id)) {
        const eventStats = extractEventStats(event);
        const existing = usageMap.get(event.agent_id);
        if (existing) {
          existing.llm_calls += eventStats.llm_calls;
          existing.tool_calls += eventStats.tool_calls;
          existing.errors += eventStats.errors;
          existing.input_tokens += eventStats.input_tokens;
          existing.output_tokens += eventStats.output_tokens;
        } else {
          usageMap.set(event.agent_id, {
            agent_id: event.agent_id,
            llm_calls: eventStats.llm_calls,
            tool_calls: eventStats.tool_calls,
            errors: eventStats.errors,
            input_tokens: eventStats.input_tokens,
            output_tokens: eventStats.output_tokens,
          });
        }
      }
    }

    return Array.from(usageMap.values());
  }, [fetchedUsage, realtimeEvents]);

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
        <div className="mb-6">
          <h1 className="text-2xl font-semibold mb-1">Telemetry</h1>
          <p className="text-[#666]">
            Monitor agent activity, token usage, and errors.
          </p>
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
              {allEvents.map((event) => {
                // Only mark as new if event arrived in last 10 seconds
                const eventTime = new Date(event.timestamp).getTime();
                const isNew = Date.now() - eventTime < 10000;

                return (
                  <div
                    key={event.id}
                    className="p-3 hover:bg-[#0a0a0a] transition cursor-pointer"
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
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
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
