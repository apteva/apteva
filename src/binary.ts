import { join } from "path";
import { existsSync, mkdirSync, chmodSync } from "fs";

// Binary configuration
const BINARY_BASE_URL = "https://github.com/apteva/agent/releases/latest/download";

// Determine platform and architecture
function getPlatformInfo(): { platform: string; arch: string; ext: string } {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  let arch = process.arch;

  // Normalize architecture names
  if (arch === "x64") arch = "amd64";
  if (arch === "arm64") arch = "arm64";

  const ext = platform === "windows" ? ".exe" : "";

  return { platform, arch, ext };
}

// Get binary filename for current platform
export function getBinaryFilename(): string {
  const { platform, arch, ext } = getPlatformInfo();
  return `agent-${platform}-${arch}${ext}`;
}

// Get full binary path
export function getBinaryPath(binDir: string): string {
  return join(binDir, getBinaryFilename());
}

// Get download URL for current platform
function getDownloadUrl(): string {
  const filename = getBinaryFilename();
  return `${BINARY_BASE_URL}/${filename}`;
}

// Check if binary exists
export function binaryExists(binDir: string): boolean {
  return existsSync(getBinaryPath(binDir));
}

// Download binary if missing
export async function ensureBinary(binDir: string): Promise<{ success: boolean; path: string; error?: string }> {
  const binaryPath = getBinaryPath(binDir);

  // Ensure bin directory exists
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  // Check if already exists
  if (existsSync(binaryPath)) {
    return { success: true, path: binaryPath };
  }

  const url = getDownloadUrl();

  try {
    const response = await fetch(url);

    if (!response.ok) {
      // For now, since binaries don't exist yet, create a placeholder message
      if (response.status === 404) {
        return {
          success: false,
          path: binaryPath,
          error: `Agent binary not available yet. Binary URL: ${url}\n\nThe agent binary will be available in a future release. For now, you can:\n1. Build your own agent binary\n2. Set AGENT_BINARY_PATH environment variable to point to your binary`,
        };
      }
      return {
        success: false,
        path: binaryPath,
        error: `Failed to download binary: HTTP ${response.status}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    await Bun.write(binaryPath, arrayBuffer);

    // Make executable on Unix systems
    if (process.platform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }

    return { success: true, path: binaryPath };
  } catch (err) {
    return {
      success: false,
      path: binaryPath,
      error: `Failed to download binary: ${err}`,
    };
  }
}

// Get binary status info
export function getBinaryStatus(binDir: string): {
  exists: boolean;
  path: string;
  filename: string;
  downloadUrl: string;
  platform: string;
  arch: string;
} {
  const { platform, arch } = getPlatformInfo();
  const path = getBinaryPath(binDir);

  return {
    exists: existsSync(path),
    path,
    filename: getBinaryFilename(),
    downloadUrl: getDownloadUrl(),
    platform,
    arch,
  };
}
