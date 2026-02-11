import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { AptevaAPI, Agent, User } from "./api.js";

interface AgentListProps {
  api: AptevaAPI;
  user: User;
}

export function AgentList({ api, user }: AgentListProps) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const load = async () => {
      const result = await api.getAgents();
      setAgents(result);
      setLoading(false);
    };
    load();
  }, []);

  useInput((input, key) => {
    if (input === "q") exit();
    if (input === "r") {
      setLoading(true);
      api.getAgents().then(result => {
        setAgents(result);
        setLoading(false);
      });
    }
    if (key.upArrow) setSelected(s => Math.max(0, s - 1));
    if (key.downArrow) setSelected(s => Math.min(agents.length - 1, s + 1));
  });

  const statusColor = (status: string) => {
    if (status === "running") return "green";
    if (status === "error") return "red";
    return "gray";
  };

  const statusIcon = (status: string) => {
    if (status === "running") return "●";
    if (status === "error") return "✕";
    return "○";
  };

  // Column widths
  const nameW = 24;
  const statusW = 12;
  const modelW = 28;
  const providerW = 14;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text color="hex('#f97316')" bold>
            {">"}_
          </Text>
          <Text bold> apteva</Text>
          <Text dimColor> — agents</Text>
        </Box>
        <Text dimColor>
          {user.username} ({user.role})
        </Text>
      </Box>

      {loading ? (
        <Box>
          <Text color="hex('#f97316')">
            <Spinner type="dots" />
          </Text>
          <Text> Loading agents...</Text>
        </Box>
      ) : agents.length === 0 ? (
        <Text dimColor>No agents found.</Text>
      ) : (
        <Box flexDirection="column">
          {/* Table header */}
          <Box>
            <Text bold color="hex('#888')">
              {"  "}
              {pad("NAME", nameW)}
              {pad("STATUS", statusW)}
              {pad("MODEL", modelW)}
              {pad("PROVIDER", providerW)}
            </Text>
          </Box>
          <Box marginBottom={0}>
            <Text dimColor>
              {"  "}
              {"─".repeat(nameW + statusW + modelW + providerW)}
            </Text>
          </Box>

          {/* Rows */}
          {agents.map((agent, i) => (
            <Box key={agent.id}>
              <Text color={i === selected ? "hex('#f97316')" : undefined}>
                {i === selected ? "▸ " : "  "}
              </Text>
              <Text color={i === selected ? "white" : undefined}>
                {pad(agent.name, nameW)}
              </Text>
              <Text color={statusColor(agent.status)}>
                {statusIcon(agent.status)}{" "}
                {pad(agent.status, statusW - 2)}
              </Text>
              <Text dimColor>
                {pad(agent.model, modelW)}
              </Text>
              <Text dimColor>
                {pad(agent.provider, providerW)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · r refresh · q quit
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {agents.length} agent{agents.length !== 1 ? "s" : ""}
          {" · "}
          {agents.filter(a => a.status === "running").length} running
        </Text>
      </Box>
    </Box>
  );
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width - 1) + "…";
  return str + " ".repeat(width - str.length);
}
