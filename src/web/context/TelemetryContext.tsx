import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";

export interface TelemetryEvent {
  id: string;
  agent_id: string;
  timestamp: string;
  category: string;
  type: string;
  level: string;
  trace_id?: string;
  thread_id?: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}

interface TelemetryContextValue {
  connected: boolean;
  events: TelemetryEvent[];
  lastActivityByAgent: Record<string, { timestamp: string; category: string; type: string }>;
  clearEvents: () => void;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

const MAX_EVENTS = 200; // Keep last 200 events in memory

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [lastActivityByAgent, setLastActivityByAgent] = useState<Record<string, { timestamp: string; category: string; type: string }>>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource("/api/telemetry/stream");
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection message
        if (data.connected) {
          setConnected(true);
          return;
        }

        // Handle array of events
        if (Array.isArray(data)) {
          setEvents(prev => {
            const combined = [...data, ...prev];
            return combined.slice(0, MAX_EVENTS);
          });

          // Update last activity per agent
          setLastActivityByAgent(prev => {
            const updated = { ...prev };
            for (const evt of data) {
              const existing = updated[evt.agent_id];
              if (!existing || new Date(evt.timestamp) > new Date(existing.timestamp)) {
                updated[evt.agent_id] = {
                  timestamp: evt.timestamp,
                  category: evt.category,
                  type: evt.type,
                };
              }
            }
            return updated;
          });
        }
      } catch (e) {
        console.error("Failed to parse telemetry event:", e);
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;

      // Reconnect after 3 seconds
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return (
    <TelemetryContext.Provider value={{ connected, events, lastActivityByAgent, clearEvents }}>
      {children}
    </TelemetryContext.Provider>
  );
}

// Hook to access all telemetry
export function useTelemetryContext() {
  const context = useContext(TelemetryContext);
  if (!context) {
    throw new Error("useTelemetryContext must be used within TelemetryProvider");
  }
  return context;
}

// Hook to filter telemetry for a specific agent or category
export function useTelemetry(filter?: {
  agent_id?: string;
  category?: string;
  limit?: number;
}) {
  const { connected, events, lastActivityByAgent } = useTelemetryContext();

  const filteredEvents = React.useMemo(() => {
    let result = events;

    if (filter?.agent_id) {
      result = result.filter(e => e.agent_id === filter.agent_id);
    }
    if (filter?.category) {
      result = result.filter(e => e.category === filter.category);
    }
    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }, [events, filter?.agent_id, filter?.category, filter?.limit]);

  const lastActivity = filter?.agent_id ? lastActivityByAgent[filter.agent_id] : undefined;

  // Check if agent is "active" (had activity in last 10 seconds)
  const isActive = React.useMemo(() => {
    if (!lastActivity) return false;
    const activityTime = new Date(lastActivity.timestamp).getTime();
    const now = Date.now();
    return now - activityTime < 10000; // 10 seconds
  }, [lastActivity]);

  return {
    connected,
    events: filteredEvents,
    lastActivity,
    isActive,
  };
}

// Hook for agent activity indicator
export function useAgentActivity(agentId: string) {
  const { lastActivityByAgent } = useTelemetryContext();
  const [isActive, setIsActive] = useState(false);
  const lastActivity = lastActivityByAgent[agentId];

  useEffect(() => {
    if (!lastActivity) {
      setIsActive(false);
      return;
    }

    // Set active when we get new activity
    setIsActive(true);

    // Clear active state after 3 seconds of no activity
    const timeout = setTimeout(() => {
      setIsActive(false);
    }, 3000);

    return () => clearTimeout(timeout);
  }, [lastActivity?.timestamp]);

  return {
    isActive,
    lastActivity,
    category: lastActivity?.category,
    type: lastActivity?.type,
  };
}
