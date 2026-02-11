import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { AptevaAPI, User } from "./api.js";

interface LoginProps {
  api: AptevaAPI;
  onSuccess: (user: User) => void;
}

export function Login({ api, onSuccess }: LoginProps) {
  const [field, setField] = useState<"username" | "password">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useInput((input, key) => {
    if (key.tab || (key.return && field === "username" && username)) {
      setField(field === "username" ? "password" : "username");
    }
  });

  const handleSubmit = async () => {
    if (!username || !password) return;
    setLoading(true);
    setError("");
    const result = await api.login(username, password);
    setLoading(false);
    if (result.success && result.user) {
      onSuccess(result.user);
    } else {
      setError(result.error || "Login failed");
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="hex('#f97316')" bold>
          {">"}_
        </Text>
        <Text bold> apteva</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>Sign in to continue</Text>
      </Box>

      <Box>
        <Text color={field === "username" ? "hex('#f97316')" : "white"}>
          Username:{" "}
        </Text>
        {field === "username" ? (
          <TextInput
            value={username}
            onChange={setUsername}
            onSubmit={() => {
              if (username) setField("password");
            }}
          />
        ) : (
          <Text>{username}</Text>
        )}
      </Box>

      <Box>
        <Text color={field === "password" ? "hex('#f97316')" : "white"}>
          Password:{" "}
        </Text>
        {field === "password" ? (
          <TextInput
            value={password}
            onChange={setPassword}
            onSubmit={handleSubmit}
            mask="*"
          />
        ) : (
          <Text dimColor>{"*".repeat(password.length) || "..."}</Text>
        )}
      </Box>

      {loading && (
        <Box marginTop={1}>
          <Text color="hex('#f97316')">
            <Spinner type="dots" />
          </Text>
          <Text> Signing in...</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>Tab to switch fields · Enter to submit</Text>
      </Box>
    </Box>
  );
}
