import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Select } from "../common/Select";
import { useTelemetryContext, useProjects, useAuth, type TelemetryEvent } from "../../context";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

interface TelemetryStats {
  total_events: number;
  total_llm_calls: number;
  total_tool_calls: number;
  total_errors: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
}

interface UsageByAgent {
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  llm_calls: number;
  tool_calls: number;
  errors: number;
  cost: number;
}

interface DailyUsage {
  date: string;
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
  const { events: realtimeEvents, statusChangeCounter } = useTelemetryContext();
  const { currentProjectId, currentProject, costTrackingEnabled } = useProjects();
  const { authFetch } = useAuth();
  const [fetchedStats, setFetchedStats] = useState<TelemetryStats | null>(null);
  const [historicalEvents, setHistoricalEvents] = useState<TelemetryEvent[]>([]);
  const [fetchedUsage, setFetchedUsage] = useState<UsageByAgent[]>([]);
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({
    level: "",
    agent_id: "",
  });
  // Categories to hide (DATABASE hidden by default)
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set(["DATABASE"]));
  const [agents, setAgents] = useState<Array<{ id: string; name: string; projectId: string | null }>>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  // Sort state for usage table
  type SortKey = "agent" | "llm_calls" | "tool_calls" | "input_tokens" | "output_tokens" | "errors" | "cost";
  const [sortKey, setSortKey] = useState<SortKey>("cost");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Track IDs that were in the fetched stats to avoid double-counting
  const countedEventIdsRef = useRef<Set<string>>(new Set());

  // Track which events are "new" (for animation) - stores event IDs with their arrival time
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  // Fetch agents for dropdown
  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const res = await authFetch("/api/agents");
        const data = await res.json();
        setAgents(data.agents || []);
      } catch (e) {
        console.error("Failed to fetch agents:", e);
      }
    };
    fetchAgents();
  }, [authFetch]);

  // Filter agents by project
  const filteredAgents = useMemo(() => {
    if (currentProjectId === null) return agents;
    if (currentProjectId === "unassigned") return agents.filter(a => !a.projectId);
    return agents.filter(a => a.projectId === currentProjectId);
  }, [agents, currentProjectId]);

  // Get agent IDs for the current project
  const projectAgentIds = useMemo(() => new Set(filteredAgents.map(a => a.id)), [filteredAgents]);

  // Fetch stats and historical data (less frequently now since we have real-time)
  const fetchData = async () => {
    setLoading(true);
    try {
      // Build project filter param
      const projectParam = currentProjectId === "unassigned" ? "null" : currentProjectId || "";

      // Fetch stats
      const statsParams = new URLSearchParams();
      if (projectParam) statsParams.set("project_id", projectParam);
      const statsRes = await authFetch(`/api/telemetry/stats${statsParams.toString() ? `?${statsParams}` : ""}`);
      const statsData = await statsRes.json();
      setFetchedStats(statsData.stats);

      // Fetch historical events with filters
      const params = new URLSearchParams();
      if (filter.level) params.set("level", filter.level);
      if (filter.agent_id) params.set("agent_id", filter.agent_id);
      if (projectParam) params.set("project_id", projectParam);
      params.set("limit", "100"); // Fetch more since we filter client-side

      const eventsRes = await authFetch(`/api/telemetry/events?${params}`);
      const eventsData = await eventsRes.json();
      const events = eventsData.events || [];
      setHistoricalEvents(events);

      // Mark all fetched event IDs as counted (stats already include them)
      countedEventIdsRef.current = new Set(events.map((e: TelemetryEvent) => e.id));

      // Fetch usage by agent
      const usageParams = new URLSearchParams();
      usageParams.set("group_by", "agent");
      if (projectParam) usageParams.set("project_id", projectParam);
      const usageRes = await authFetch(`/api/telemetry/usage?${usageParams}`);
      const usageData = await usageRes.json();
      setFetchedUsage(usageData.usage || []);

      // Fetch daily usage for charts
      const dailyParams = new URLSearchParams();
      dailyParams.set("group_by", "day");
      if (projectParam) dailyParams.set("project_id", projectParam);
      const dailyRes = await authFetch(`/api/telemetry/usage?${dailyParams}`);
      const dailyData = await dailyRes.json();
      // Sort by date ascending for charts
      const sorted = (dailyData.usage || []).sort((a: DailyUsage, b: DailyUsage) =>
        a.date.localeCompare(b.date)
      );
      setDailyUsage(sorted);
    } catch (e) {
      console.error("Failed to fetch telemetry:", e);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [filter, currentProjectId, authFetch, statusChangeCounter]);

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
      total_cost: fetchedStats.total_cost || 0,
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
            cost: 0,
          });
        }
      }
    }

    return Array.from(usageMap.values());
  }, [fetchedUsage, realtimeEvents]);

  // Sorted usage for the table
  const sortedUsage = useMemo(() => {
    const sorted = [...usage];
    sorted.sort((a, b) => {
      if (sortKey === "agent") {
        const aName = (agents.find(ag => ag.id === a.agent_id)?.name || a.agent_id).toLowerCase();
        const bName = (agents.find(ag => ag.id === b.agent_id)?.name || b.agent_id).toLowerCase();
        return sortDir === "asc" ? (aName < bName ? -1 : 1) : (aName > bName ? -1 : 1);
      }
      const aVal = a[sortKey] as number;
      const bVal = b[sortKey] as number;
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });
    return sorted;
  }, [usage, sortKey, sortDir, agents]);

  // Merge real-time events with historical, filtering and deduping
  const allEvents = React.useMemo(() => {
    // Apply filters to real-time events
    let filtered = realtimeEvents;

    // Filter by project (for real-time events)
    if (currentProjectId !== null) {
      filtered = filtered.filter(e => projectAgentIds.has(e.agent_id));
    }

    if (filter.agent_id) {
      filtered = filtered.filter(e => e.agent_id === filter.agent_id);
    }
    // Filter out hidden categories
    if (hiddenCategories.size > 0) {
      filtered = filtered.filter(e => !hiddenCategories.has(e.category));
    }
    if (filter.level) {
      filtered = filtered.filter(e => e.level === filter.level);
    }

    // Filter historical events too
    let filteredHistorical = historicalEvents;
    if (hiddenCategories.size > 0) {
      filteredHistorical = filteredHistorical.filter(e => !hiddenCategories.has(e.category));
    }

    // Merge with historical, dedupe by ID
    const seen = new Set(filtered.map(e => e.id));
    const merged = [...filtered];
    for (const evt of filteredHistorical) {
      if (!seen.has(evt.id)) {
        merged.push(evt);
        seen.add(evt.id);
      }
    }

    // Sort by timestamp descending
    merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return merged.slice(0, 100);
  }, [realtimeEvents, historicalEvents, filter, hiddenCategories, currentProjectId, projectAgentIds]);

  // Track new events for animation - mark events as "new" when they first appear
  useEffect(() => {
    const newIds: string[] = [];
    for (const event of realtimeEvents) {
      if (!seenEventIdsRef.current.has(event.id)) {
        seenEventIdsRef.current.add(event.id);
        newIds.push(event.id);
      }
    }

    if (newIds.length > 0) {
      setNewEventIds(prev => {
        const updated = new Set(prev);
        newIds.forEach(id => updated.add(id));
        return updated;
      });

      // Remove "new" status after 5 seconds
      setTimeout(() => {
        setNewEventIds(prev => {
          const updated = new Set(prev);
          newIds.forEach(id => updated.delete(id));
          return updated;
        });
      }, 5000);
    }
  }, [realtimeEvents]);

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
    debug: "text-[var(--color-text-faint)]",
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
    DATABASE: "bg-pink-500/20 text-pink-400 border-pink-500/30",
  };

  const allCategories = ["LLM", "TOOL", "CHAT", "TASK", "MEMORY", "MCP", "SYSTEM", "DATABASE", "ERROR"];

  const toggleCategory = (category: string) => {
    setHiddenCategories(prev => {
      const updated = new Set(prev);
      if (updated.has(category)) {
        updated.delete(category);
      } else {
        updated.add(category);
      }
      return updated;
    });
  };

  const agentOptions = [
    { value: "", label: "All Agents" },
    ...filteredAgents.map(a => ({ value: a.id, label: a.name })),
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
      <div>
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            {currentProject && (
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: currentProject.color }}
              />
            )}
            <h1 className="text-2xl font-semibold">
              {currentProjectId === null
                ? "Telemetry"
                : currentProjectId === "unassigned"
                ? "Telemetry - Unassigned"
                : `Telemetry - ${currentProject?.name || ""}`}
            </h1>
          </div>
          <p className="text-[var(--color-text-muted)]">
            Monitor agent activity, token usage, and errors.
          </p>
        </div>

        {/* Stats Cards */}
        {stats && (
          <div className={`grid grid-cols-2 md:grid-cols-3 ${costTrackingEnabled ? "lg:grid-cols-7" : "lg:grid-cols-6"} gap-4 mb-6`}>
            <StatCard label="Events" value={formatNumber(stats.total_events)} />
            <StatCard label="LLM Calls" value={formatNumber(stats.total_llm_calls)} />
            <StatCard label="Tool Calls" value={formatNumber(stats.total_tool_calls)} />
            <StatCard label="Errors" value={formatNumber(stats.total_errors)} color="red" />
            <StatCard label="Input Tokens" value={formatNumber(stats.total_input_tokens)} />
            <StatCard label="Output Tokens" value={formatNumber(stats.total_output_tokens)} />
            {costTrackingEnabled && (
              <StatCard label="Total Cost" value={`$${stats.total_cost.toFixed(4)}`} color="orange" />
            )}
          </div>
        )}

        {/* Charts */}
        {(() => {
          // Use daily data if we have multiple days, otherwise aggregate events by hour
          const useDaily = dailyUsage.length > 1;
          const chartData = useDaily ? dailyUsage : (() => {
            // Aggregate all visible events by hour
            const buckets = new Map<string, { date: string; llm_calls: number; tool_calls: number; errors: number; input_tokens: number; output_tokens: number }>();
            for (const event of allEvents) {
              const d = new Date(event.timestamp);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`;
              if (!buckets.has(key)) {
                buckets.set(key, { date: key, llm_calls: 0, tool_calls: 0, errors: 0, input_tokens: 0, output_tokens: 0 });
              }
              const b = buckets.get(key)!;
              const s = extractEventStats(event);
              b.llm_calls += s.llm_calls;
              b.tool_calls += s.tool_calls;
              b.errors += s.errors;
              b.input_tokens += s.input_tokens;
              b.output_tokens += s.output_tokens;
            }
            return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
          })();
          const chartLabel = useDaily ? "Daily" : "Hourly";

          if (chartData.length === 0) return null;

          return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            {/* Activity Chart */}
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4">
              <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-4">{chartLabel} Activity</h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="date"
                    stroke="var(--color-border-light)"
                    tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                    tickFormatter={(v) => {
                      if (!useDaily && v.includes(" ")) {
                        return v.split(" ")[1];
                      }
                      const d = new Date(v + "T00:00:00");
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis stroke="var(--color-border-light)" tick={{ fill: "var(--color-text-muted)", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border-light)",
                      borderRadius: "8px",
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--color-text-secondary)" }}
                    cursor={{ stroke: "rgba(255,255,255,0.1)" }}
                    labelFormatter={(v) => useDaily ? new Date(v + "T00:00:00").toLocaleDateString() : v}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <Area
                    type="monotone"
                    dataKey="llm_calls"
                    name="LLM Calls"
                    stroke="var(--color-accent)"
                    fill="var(--color-accent)"
                    fillOpacity={0.15}
                    strokeWidth={1.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="tool_calls"
                    name="Tool Calls"
                    stroke="var(--color-accent-hover)"
                    fill="var(--color-accent-hover)"
                    fillOpacity={0.08}
                    strokeWidth={1.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="errors"
                    name="Errors"
                    stroke="#ef4444"
                    fill="#ef4444"
                    fillOpacity={0.1}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Token Usage Chart */}
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4">
              <h3 className="text-sm font-medium text-[var(--color-text-secondary)] mb-4">{chartLabel} Token Usage</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="date"
                    stroke="var(--color-border-light)"
                    tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                    tickFormatter={(v) => {
                      if (!useDaily && v.includes(" ")) {
                        return v.split(" ")[1];
                      }
                      const d = new Date(v + "T00:00:00");
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis
                    stroke="var(--color-border-light)"
                    tick={{ fill: "var(--color-text-muted)", fontSize: 11 }}
                    tickFormatter={(v) => {
                      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
                      if (v >= 1000) return `${(v / 1000).toFixed(0)}K`;
                      return v;
                    }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border-light)",
                      borderRadius: "8px",
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "var(--color-text-secondary)" }}
                    cursor={{ fill: "rgba(255,255,255,0.03)" }}
                    labelFormatter={(v) => useDaily ? new Date(v + "T00:00:00").toLocaleDateString() : v}
                    formatter={(value: number) => [value.toLocaleString(), undefined]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <Bar
                    dataKey="input_tokens"
                    name="Input Tokens"
                    fill="var(--color-accent)"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="output_tokens"
                    name="Output Tokens"
                    fill="var(--color-accent-hover)"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          );
        })()}

        {/* Usage by Agent */}
        {usage.length > 0 && (() => {
          const maxCost = Math.max(...sortedUsage.map(u => u.cost), 0.0001);
          const SortHeader = ({ label, field, align = "right" }: { label: string; field: SortKey; align?: string }) => (
            <th
              className={`${align === "left" ? "text-left" : "text-right"} p-3 cursor-pointer hover:text-[var(--color-text-secondary)] select-none transition-colors`}
              onClick={() => handleSort(field)}
            >
              <span className="inline-flex items-center gap-1">
                {align === "right" && sortKey === field && (
                  <span className="text-orange-400">{sortDir === "asc" ? "\u25b2" : "\u25bc"}</span>
                )}
                {label}
                {align === "left" && sortKey === field && (
                  <span className="text-orange-400">{sortDir === "asc" ? "\u25b2" : "\u25bc"}</span>
                )}
              </span>
            </th>
          );

          return (
          <div className="mb-6">
            <h2 className="text-lg font-medium mb-3">Usage by Agent</h2>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-[var(--color-text-muted)]">
                    <SortHeader label="Agent" field="agent" align="left" />
                    <SortHeader label="LLM Calls" field="llm_calls" />
                    <SortHeader label="Tool Calls" field="tool_calls" />
                    <SortHeader label="Input Tokens" field="input_tokens" />
                    <SortHeader label="Output Tokens" field="output_tokens" />
                    <SortHeader label="Errors" field="errors" />
                    {costTrackingEnabled && <SortHeader label="Est. Cost" field="cost" />}
                  </tr>
                </thead>
                <tbody>
                  {sortedUsage.map((u) => (
                    <tr key={u.agent_id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg)]">
                      <td className="p-3 font-medium">{getAgentName(u.agent_id)}</td>
                      <td className="p-3 text-right text-[var(--color-text-secondary)]">{formatNumber(u.llm_calls)}</td>
                      <td className="p-3 text-right text-[var(--color-text-secondary)]">{formatNumber(u.tool_calls)}</td>
                      <td className="p-3 text-right text-[var(--color-text-secondary)]">{formatNumber(u.input_tokens)}</td>
                      <td className="p-3 text-right text-[var(--color-text-secondary)]">{formatNumber(u.output_tokens)}</td>
                      <td className="p-3 text-right">
                        {u.errors > 0 ? (
                          <span className="text-red-400">{u.errors}</span>
                        ) : (
                          <span className="text-[var(--color-text-faint)]">0</span>
                        )}
                      </td>
                      {costTrackingEnabled && (
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-[var(--color-surface-raised)] rounded-full overflow-hidden">
                              <div
                                className="h-full bg-orange-500 rounded-full"
                                style={{ width: `${(u.cost / maxCost) * 100}%` }}
                              />
                            </div>
                            <span className="text-[var(--color-text-secondary)] min-w-[60px] text-right">${u.cost.toFixed(4)}</span>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="w-44">
            <Select
              value={filter.agent_id}
              options={agentOptions}
              onChange={(value) => setFilter({ ...filter, agent_id: value })}
              placeholder="All Agents"
            />
          </div>
          {/* Category toggles */}
          <div className="flex flex-wrap items-center gap-1.5 flex-1">
            {allCategories.map((cat) => {
              const isHidden = hiddenCategories.has(cat);
              const colorClass = categoryColors[cat] || "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] border-[var(--color-border-light)]";
              return (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`px-2 py-0.5 rounded text-xs border transition-all ${
                    isHidden
                      ? "bg-[var(--color-surface-raised)] text-[var(--color-text-faint)] border-[var(--color-border-light)] opacity-50"
                      : colorClass
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="w-36">
              <Select
                value={filter.level}
                options={levelOptions}
                onChange={(value) => setFilter({ ...filter, level: value })}
                placeholder="All Levels"
              />
            </div>
            <button
              onClick={fetchData}
              className="px-3 py-2 bg-[var(--color-surface-raised)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border-light)] rounded text-sm transition"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Events List */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
          <div className="p-3 border-b border-[var(--color-border)] flex items-center justify-between">
            <h2 className="font-medium">Recent Events</h2>
            {realtimeEvents.length > 0 && (
              <span className="text-xs text-[var(--color-text-muted)]">
                {realtimeEvents.length} new
              </span>
            )}
          </div>

          {loading && allEvents.length === 0 ? (
            <div className="p-8 text-center text-[var(--color-text-muted)]">Loading...</div>
          ) : allEvents.length === 0 ? (
            <div className="p-8 text-center text-[var(--color-text-muted)]">
              No telemetry events yet. Events will appear here in real-time once agents start sending data.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {allEvents.map((event) => {
                const isNew = newEventIds.has(event.id);

                return (
                  <div
                    key={event.id}
                    className={`p-3 hover:bg-[var(--color-bg)] cursor-pointer transition-all duration-500 ${
                      isNew ? "bg-green-500/5" : ""
                    }`}
                    style={{
                      animation: isNew ? "slideIn 0.3s ease-out" : undefined,
                    }}
                    onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`px-2 py-0.5 rounded text-xs border transition-colors duration-300 ${categoryColors[event.category] || "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] border-[var(--color-border-light)]"}`}>
                        {event.category}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{event.type}</span>
                          <span className={`text-xs ${levelColors[event.level] || "text-[var(--color-text-muted)]"}`}>
                            {event.level}
                          </span>
                          {event.duration_ms && (
                            <span className="text-xs text-[var(--color-text-faint)]">{event.duration_ms}ms</span>
                          )}
                          <span
                            className={`w-1.5 h-1.5 rounded-full bg-green-400 transition-opacity duration-1000 ${
                              isNew ? "opacity-100" : "opacity-0"
                            }`}
                          />
                        </div>
                        <div className="text-xs text-[var(--color-text-faint)] mt-1">
                          {getAgentName(event.agent_id)} · {new Date(event.timestamp).toLocaleString()}
                        </div>
                        {event.error && (
                          <div className="text-xs text-red-400 mt-1 font-mono">{event.error}</div>
                        )}
                        {expandedEvent === event.id && event.data && Object.keys(event.data).length > 0 && (
                          <pre className="text-xs text-[var(--color-text-muted)] mt-2 p-2 bg-[var(--color-bg)] rounded overflow-x-auto">
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
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg p-4">
      <div className="text-[var(--color-text-muted)] text-xs mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${color === "red" ? "text-red-400" : color === "orange" ? "text-orange-400" : ""}`}>
        {value}
      </div>
    </div>
  );
}
