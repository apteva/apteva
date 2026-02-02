import { verifyAccessToken, getAuthStatus } from "./index";
import { UserDB, type User } from "../db";

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
  "/api/telemetry", // Agents POST telemetry here
  "/api/telemetry/stream", // SSE doesn't support auth headers
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

  // Extract token from Authorization header
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      response: json({ error: "Unauthorized", code: "NO_TOKEN" }, 401),
      context,
    };
  }

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);

  if (!payload) {
    return {
      response: json({ error: "Invalid or expired token", code: "INVALID_TOKEN" }, 401),
      context,
    };
  }

  // Get user from database
  const user = UserDB.findById(payload.userId);
  if (!user) {
    return {
      response: json({ error: "User not found", code: "USER_NOT_FOUND" }, 401),
      context,
    };
  }

  // Update context
  context.user = user;
  context.isAuthenticated = true;
  context.isAdmin = user.role === "admin";

  // Check admin-only paths
  if (ADMIN_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
    if (user.role !== "admin") {
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
