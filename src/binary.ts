import { join } from "path";
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "fs";

// Binary configuration
const BINARY_BASE_URL = "https://github.com/apteva/agent/releases/latest/download";
const NPM_REGISTRY = "https://registry.npmjs.org";
const CONNECT_TIMEOUT = 15000; // 15 seconds for initial connection
const DOWNLOAD_TIMEOUT = 120000; // 120 seconds for full download
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second between retries

// Version info stored in data directory
let versionFilePath: string | null = null;

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

// ============ Version Management ============

// Get apteva app version from package.json
export function getAptevaVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// Check latest apteva version from npm
export async function getLatestAptevaVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY}/apteva/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

export interface VersionInfo {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  lastChecked: string | null;
}

export interface AllVersionInfo {
  apteva: VersionInfo;
  agent: VersionInfo;
}

// Initialize version file path
export function initVersionTracking(dataDir: string): void {
  versionFilePath = join(dataDir, "agent-version.json");
}

// Get stored version info
function getStoredVersion(): { version: string; lastChecked: string } | null {
  if (!versionFilePath || !existsSync(versionFilePath)) {
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(versionFilePath, "utf-8"));
    return data;
  } catch {
    return null;
  }
}

// Save version info
function saveVersion(version: string): void {
  if (!versionFilePath) return;
  const data = {
    version,
    lastChecked: new Date().toISOString(),
  };
  writeFileSync(versionFilePath, JSON.stringify(data, null, 2));
}

// Get latest version from npm registry
export async function getLatestNpmVersion(): Promise<string | null> {
  const packageName = getNpmPackageName();
  try {
    const response = await fetch(`${NPM_REGISTRY}/${packageName}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

// Get installed version (from npm package or stored)
export function getInstalledVersion(): string | null {
  const packageName = getNpmPackageName();

  // Try to get version from npm package
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || null;
  } catch {
    // Not installed via npm, check stored version
  }

  // Fall back to stored version
  const stored = getStoredVersion();
  return stored?.version || null;
}

// Check for agent binary updates
export async function checkForAgentUpdates(): Promise<VersionInfo> {
  const installed = getInstalledVersion();
  const latest = await getLatestNpmVersion();

  let updateAvailable = false;
  if (installed && latest) {
    updateAvailable = compareVersions(latest, installed) > 0;
  } else if (!installed && latest) {
    updateAvailable = true;
  }

  const stored = getStoredVersion();

  return {
    installed,
    latest,
    updateAvailable,
    lastChecked: stored?.lastChecked || null,
  };
}

// Check for apteva app updates
export async function checkForAptevaUpdates(): Promise<VersionInfo> {
  const installed = getAptevaVersion();
  const latest = await getLatestAptevaVersion();

  let updateAvailable = false;
  if (installed && latest && installed !== "unknown") {
    updateAvailable = compareVersions(latest, installed) > 0;
  }

  return {
    installed,
    latest,
    updateAvailable,
    lastChecked: new Date().toISOString(),
  };
}

// Check for all updates (apteva + agent)
export async function checkForUpdates(): Promise<AllVersionInfo> {
  const [apteva, agent] = await Promise.all([
    checkForAptevaUpdates(),
    checkForAgentUpdates(),
  ]);

  return { apteva, agent };
}

// Compare semver versions: returns positive if a > b, negative if a < b, 0 if equal
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(n => parseInt(n, 10) || 0);
  const partsB = b.split(".").map(n => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

// Download and install latest binary
export async function downloadLatestBinary(binDir: string): Promise<{
  success: boolean;
  version?: string;
  error?: string;
}> {
  // Ensure bin directory exists
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const binaryPath = getBinaryPath(binDir);
  const url = getDownloadUrl();

  console.log(`${c.gray}Downloading latest agent binary...${c.reset}`);

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const data = await downloadWithTimeout(url);

      // Write binary
      await Bun.write(binaryPath, data);

      // Make executable on Unix
      if (process.platform !== "win32") {
        chmodSync(binaryPath, 0o755);
      }

      // Get and save version
      const version = await getLatestNpmVersion();
      if (version) {
        saveVersion(version);
      }

      console.log(`${c.green}Downloaded agent v${version || "unknown"}${c.reset}`);

      return {
        success: true,
        version: version || undefined,
      };
    } catch (err) {
      lastErr = err as Error;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY * (attempt + 1));
      }
    }
  }

  return {
    success: false,
    error: lastErr?.message || "Download failed",
  };
}

// Install via npm (preferred method)
export async function installViaNpm(): Promise<{
  success: boolean;
  version?: string;
  error?: string;
}> {
  const packageName = getNpmPackageName();

  console.log(`${c.gray}Installing ${packageName}...${c.reset}`);

  try {
    const proc = Bun.spawn(["npm", "install", "-g", packageName], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        success: false,
        error: stderr || `npm install failed with code ${exitCode}`,
      };
    }

    const version = await getLatestNpmVersion();
    console.log(`${c.green}Installed agent v${version || "latest"}${c.reset}`);

    return {
      success: true,
      version: version || undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
