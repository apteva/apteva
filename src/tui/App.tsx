import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { AptevaAPI, type User } from "./api.js";
import { Login } from "./Login.js";
import { AgentList } from "./AgentList.js";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

interface AppProps {
  baseUrl: string;
}

export function App({ baseUrl }: AppProps) {
  const [api] = useState(() => new AptevaAPI(baseUrl));
  const [screen, setScreen] = useState<"connecting" | "login" | "agents">("connecting");
  const [user, setUser] = useState<User | null>(null);
  const [connectError, setConnectError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const tryConnect = async () => {
      // First check if server is already running
      const connected = await api.checkConnection();
      if (cancelled) return;

      if (connected) {
        setScreen("login");
        return;
      }

      // Server not running — try to start it
      setConnectError("Server not running. Starting...");

      try {
        // Find the server entry point relative to this file
        const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../server.ts");
        const child = spawn("bun", ["run", serverPath], {
          stdio: "ignore",
          detached: true,
          env: { ...process.env, PORT: new URL(baseUrl).port || "4280" },
        });
        child.unref();

        // Wait for server to come up (poll for up to 10 seconds)
        for (let i = 0; i < 20; i++) {
          if (cancelled) return;
          await new Promise(r => setTimeout(r, 500));
          const up = await api.checkConnection();
          if (up) {
            if (!cancelled) setScreen("login");
            return;
          }
        }
      } catch {
        // Spawn failed
      }

      if (!cancelled) {
        setConnectError(`Cannot connect to ${baseUrl}. Start the server with: bun run dev`);
      }
    };

    tryConnect();
    return () => { cancelled = true; };
  }, []);

  if (screen === "connecting") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text color="hex('#f97316')" bold>{">"}_</Text>
          <Text bold> apteva</Text>
        </Box>
        <Box>
          <Text color="hex('#f97316')"><Spinner type="dots" /></Text>
          <Text> {connectError || `Connecting to ${baseUrl}...`}</Text>
        </Box>
      </Box>
    );
  }

  if (screen === "login") {
    return (
      <Login
        api={api}
        onSuccess={(u) => {
          setUser(u);
          setScreen("agents");
        }}
      />
    );
  }

  if (screen === "agents" && user) {
    return <AgentList api={api} user={user} />;
  }

  return null;
}
