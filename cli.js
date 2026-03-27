#!/usr/bin/env node

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const BIN_DIR = path.join(__dirname, "bin");
const ext = os.platform() === "win32" ? ".exe" : "";
const SERVER_BIN = path.join(BIN_DIR, `apteva-server${ext}`);
const CORE_BIN = path.join(BIN_DIR, `apteva-core${ext}`);

// Check binaries exist
if (!fs.existsSync(SERVER_BIN)) {
  console.error("apteva-server binary not found. Run: npm install apteva");
  process.exit(1);
}
if (!fs.existsSync(CORE_BIN)) {
  console.error("apteva-core binary not found. Run: npm install apteva");
  process.exit(1);
}

// Default data directory
const DATA_DIR = process.env.APTEVA_DATA || path.join(os.homedir(), ".apteva");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "apteva.db");
const PORT = process.env.PORT || "5280";

console.log(`
  ◆ Apteva

  Starting server on http://localhost:${PORT}
  Data directory: ${DATA_DIR}
`);

const server = spawn(SERVER_BIN, [], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: PORT,
    CORE_CMD: CORE_BIN,
    DB_PATH: DB_PATH,
    DATA_DIR: DATA_DIR,
  },
});

server.on("error", (err) => {
  console.error("Failed to start apteva-server:", err.message);
  process.exit(1);
});

server.on("exit", (code) => {
  process.exit(code || 0);
});

// Forward signals
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));

// Open browser after a short delay
setTimeout(() => {
  const url = `http://localhost:${PORT}`;
  try {
    if (os.platform() === "darwin") execSync(`open ${url}`);
    else if (os.platform() === "linux") execSync(`xdg-open ${url}`);
    else if (os.platform() === "win32") execSync(`start ${url}`);
  } catch {
    // Browser open is best-effort
  }
}, 1500);
