import { verifyAccessToken, getAuthStatus } from "./index";
import { UserDB, ApiKeyDB, type User } from "../db";

// Extend Request type to include user
declare global {
  interface Request {
    user?: User;
  }
}

// Helper to create JSON response
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  "/api/auth/check",
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/health",
  "/api/features", // Feature flags needed before auth
  "/api/telemetry", // Agents POST telemetry here
  "/api/telemetry/stream", // SSE doesn't support auth headers
  "/api/mcp/platform", // Built-in MCP server for agent communication
  "/api/webhooks/composio", // Composio trigger webhooks (HMAC-verified)
  "/api/webhooks/agentdojo", // AgentDojo trigger webhooks (HMAC-verified)
];

// Regex patterns for public paths (for dynamic segments)
const PUBLIC_PATTERNS = [
  /^\/api\/mcp\/servers\/[^/]+\/mcp$/, // Local MCP server JSON-RPC endpoints
];

// Path prefixes that don't require authentication (for agent communication)
const PUBLIC_PREFIXES = [
  "/api/agents/", // Agent chat API needs to work without frontend auth
];

// Paths that only work when no users exist
const SETUP_PATHS = [
  "/api/onboarding/user",
];

// Admin-only paths
const ADMIN_PATHS = [
  "/api/users",
];

export interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

/**
 * Auth middleware for protecting API routes
 * Returns null if request should proceed, or a Response to return immediately
 */
export async function authMiddleware(req: Request, path: string): Promise<{ response?: Response; context: AuthContext }> {
  const context: AuthContext = {
    user: null,
    isAuthenticated: false,
    isAdmin: false,
  };

  // Check if auth is disabled
  if (process.env.AUTH_ENABLED === "false") {
    return { context };
  }

  // Public paths - no auth needed
  if (PUBLIC_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    return { context };
  }

  // Public patterns - no auth needed (dynamic path segments)
  if (PUBLIC_PATTERNS.some(p => p.test(path))) {
    return { context };
  }

  // Public prefixes - no auth needed (for agent communication)
  if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) {
    return { context };
  }

  // Setup paths - only allowed when no users exist
  if (SETUP_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    const hasUsers = UserDB.hasUsers();
    if (!hasUsers) {
      return { context }; // Allow - no users yet
    }
    // Users exist - require auth for these paths
  }

  // Check for API key authentication (X-API-Key header or Bearer apt_... token)
  const apiKeyHeader = req.headers.get("X-API-Key");
  const authHeader = req.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const apiKeyValue = apiKeyHeader || (bearerToken?.startsWith("apt_") ? bearerToken : null);

  if (apiKeyValue) {
    // API key auth
    const result = ApiKeyDB.validate(apiKeyValue);
    if (!result) {
      return {
        response: json({ error: "Invalid or expired API key", code: "INVALID_API_KEY" }, 401),
        context,
      };
    }

    context.user = result.user;
    context.isAuthenticated = true;
    context.isAdmin = result.user.role === "admin";
  } else if (bearerToken) {
    // JWT auth
    const payload = verifyAccessToken(bearerToken);

    if (!payload) {
      return {
        response: json({ error: "Invalid or expired token", code: "INVALID_TOKEN" }, 401),
        context,
      };
    }

    const user = UserDB.findById(payload.userId);
    if (!user) {
      return {
        response: json({ error: "User not found", code: "USER_NOT_FOUND" }, 401),
        context,
      };
    }

    context.user = user;
    context.isAuthenticated = true;
    context.isAdmin = user.role === "admin";
  } else {
    return {
      response: json({ error: "Unauthorized", code: "NO_TOKEN" }, 401),
      context,
    };
  }

  // Check admin-only paths
  if (ADMIN_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    if (!context.isAdmin) {
      return {
        response: json({ error: "Admin access required", code: "FORBIDDEN" }, 403),
        context,
      };
    }
  }

  return { context };
}

/**
 * Helper to check if a path requires authentication
 */
export function requiresAuth(path: string): boolean {
  if (process.env.AUTH_ENABLED === "false") {
    return false;
  }

  if (PUBLIC_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    return false;
  }

  return true;
}

/**
 * Helper to extract token from request
 */
export function getTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Helper to extract refresh token from cookie
 */
export function getRefreshTokenFromCookie(req: Request): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;

  const match = cookie.match(/(?:^|;\s*)apteva_session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Create Set-Cookie header for refresh token
 * Note: Secure flag only added when HTTPS is explicitly enabled (not just production mode)
 * This allows Docker deployments to work on localhost without HTTPS
 */
export function createRefreshTokenCookie(token: string, maxAge: number): string {
  const secure = process.env.HTTPS_ENABLED === "true" ? "; Secure" : "";
  return `apteva_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

/**
 * Create Set-Cookie header to clear refresh token
 */
export function clearRefreshTokenCookie(): string {
  return "apteva_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}
