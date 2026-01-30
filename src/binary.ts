import { join } from "path";
import { existsSync, mkdirSync, chmodSync } from "fs";

// Binary configuration
const BINARY_BASE_URL = "https://github.com/apteva/agent/releases/latest/download";
const CONNECT_TIMEOUT = 15000; // 15 seconds for initial connection
const DOWNLOAD_TIMEOUT = 120000; // 120 seconds for full download
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second between retries

// ANSI colors for console output
const c = {
  reset: "\x1b[0m",
  orange: "\x1b[38;5;208m",
  gray: "\x1b[38;5;245m",
  green: "\x1b[38;5;82m",
  red: "\x1b[38;5;196m",
};

// Map Node.js platform/arch to npm package names
function getNpmPackageName(): string {
  const platform = process.platform; // darwin, linux, win32
  const arch = process.arch; // x64, arm64

  // Map to our package naming convention
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };

  const mappedArch = archMap[arch] || arch;
  return `@apteva/agent-${platform}-${mappedArch}`;
}

// Try to find binary from installed npm package
function findNpmBinary(): string | null {
  const packageName = getNpmPackageName();

  try {
    // Try to require the package - it exports the binary path
    const binaryPath = require(packageName);
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // Package not installed, fall through
  }

  // Also try direct path resolution in node_modules
  const possiblePaths = [
    join(import.meta.dir, "../../node_modules", packageName, process.platform === "win32" ? "agent.exe" : "agent"),
    join(process.cwd(), "node_modules", packageName, process.platform === "win32" ? "agent.exe" : "agent"),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

// Determine platform and architecture for download fallback
function getPlatformInfo(): { platform: string; arch: string; ext: string } {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  let arch = process.arch;

  // Normalize architecture names for GitHub releases
  if (arch === "x64") arch = "amd64";
  if (arch === "arm64") arch = "arm64";

  const ext = platform === "windows" ? ".exe" : "";

  return { platform, arch, ext };
}

// Get binary filename for current platform (for download)
export function getBinaryFilename(): string {
  const { platform, arch, ext } = getPlatformInfo();
  return `agent-${platform}-${arch}${ext}`;
}

// Get full binary path in bin directory
export function getBinaryPath(binDir: string): string {
  return join(binDir, getBinaryFilename());
}

// Get download URL for current platform
function getDownloadUrl(): string {
  const filename = getBinaryFilename();
  return `${BINARY_BASE_URL}/${filename}`;
}

// Check if binary exists (either from npm or downloaded)
export function binaryExists(binDir: string): boolean {
  // First check npm package
  const npmBinary = findNpmBinary();
  if (npmBinary) return true;

  // Then check downloaded binary
  return existsSync(getBinaryPath(binDir));
}

// Get the actual binary path (npm or downloaded)
export function getActualBinaryPath(binDir: string): string | null {
  // First check npm package
  const npmBinary = findNpmBinary();
  if (npmBinary) return npmBinary;

  // Then check downloaded binary
  const downloadedPath = getBinaryPath(binDir);
  if (existsSync(downloadedPath)) return downloadedPath;

  return null;
}

// Helper to delay
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Download file with timeout for both connection and body
async function downloadWithTimeout(url: string): Promise<ArrayBuffer> {
  const controller = new AbortController();

  // Timeout for connection
  let timeoutId = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);

  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // Timeout for body download
  timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  try {
    const arrayBuffer = await response.arrayBuffer();
    clearTimeout(timeoutId);
    return arrayBuffer;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Ensure binary exists - check npm first, then download
export async function ensureBinary(binDir: string, silent = false): Promise<{
  success: boolean;
  path: string;
  error?: string;
  downloaded?: boolean;
  source?: "npm" | "download" | "cached";
}> {
  // First, check if binary is available from npm package
  const npmBinary = findNpmBinary();
  if (npmBinary) {
    return {
      success: true,
      path: npmBinary,
      downloaded: false,
      source: "npm"
    };
  }

  const binaryPath = getBinaryPath(binDir);

  // Ensure bin directory exists
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  // Check if already downloaded
  if (existsSync(binaryPath)) {
    return {
      success: true,
      path: binaryPath,
      downloaded: false,
      source: "cached"
    };
  }

  // No npm package and no cached binary - show error
  if (!silent) {
    console.log(`${c.red}not found${c.reset}`);
    console.log(`\n  Install the agent binary: npm install @apteva/agent-linux-x64`);
  }

  return {
    success: false,
    path: binaryPath,
    error: "Binary not found. Install via: npm install @apteva/agent-<platform>",
  };
}

// Get binary status info
export function getBinaryStatus(binDir: string): {
  exists: boolean;
  path: string;
  filename: string;
  downloadUrl: string;
  platform: string;
  arch: string;
  source?: "npm" | "download" | "none";
} {
  const { platform, arch } = getPlatformInfo();

  // Check npm first
  const npmBinary = findNpmBinary();
  if (npmBinary) {
    return {
      exists: true,
      path: npmBinary,
      filename: getBinaryFilename(),
      downloadUrl: getDownloadUrl(),
      platform,
      arch,
      source: "npm",
    };
  }

  // Check downloaded
  const downloadedPath = getBinaryPath(binDir);
  if (existsSync(downloadedPath)) {
    return {
      exists: true,
      path: downloadedPath,
      filename: getBinaryFilename(),
      downloadUrl: getDownloadUrl(),
      platform,
      arch,
      source: "download",
    };
  }

  return {
    exists: false,
    path: downloadedPath,
    filename: getBinaryFilename(),
    downloadUrl: getDownloadUrl(),
    platform,
    arch,
    source: "none",
  };
}
