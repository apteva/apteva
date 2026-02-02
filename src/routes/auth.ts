import { UserDB } from "../db";
import {
  login,
  refreshSession,
  invalidateSession,
  getAuthStatus,
  verifyAccessToken,
  hashPassword,
  validatePassword,
  REFRESH_TOKEN_EXPIRY,
} from "../auth";
import {
  getTokenFromRequest,
  getRefreshTokenFromCookie,
  createRefreshTokenCookie,
  clearRefreshTokenCookie,
} from "../auth/middleware";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function handleAuthRequest(req: Request, path: string): Promise<Response> {
  const method = req.method;

  // GET /api/auth/check - Check authentication status
  if (path === "/api/auth/check" && method === "GET") {
    const token = getTokenFromRequest(req);
    const status = getAuthStatus(token || undefined);
    return json(status);
  }

  // POST /api/auth/login - Login with username and password
  if (path === "/api/auth/login" && method === "POST") {
    try {
      const body = await req.json();
      const { username, password } = body;

      if (!username || !password) {
        return json({ error: "Username and password are required" }, 400);
      }

      const result = await login(username, password);

      if (!result.success) {
        return json({ error: result.error }, 401);
      }

      // Set refresh token as httpOnly cookie
      const cookieHeader = createRefreshTokenCookie(result.tokens!.refreshToken, REFRESH_TOKEN_EXPIRY);

      return json(
        {
          user: result.user,
          accessToken: result.tokens!.accessToken,
          expiresIn: result.tokens!.expiresIn,
        },
        200,
        { "Set-Cookie": cookieHeader }
      );
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // POST /api/auth/logout - Logout (invalidate refresh token)
  if (path === "/api/auth/logout" && method === "POST") {
    const refreshToken = getRefreshTokenFromCookie(req);

    if (refreshToken) {
      invalidateSession(refreshToken);
    }

    // Clear the cookie
    return json(
      { success: true },
      200,
      { "Set-Cookie": clearRefreshTokenCookie() }
    );
  }

  // POST /api/auth/refresh - Refresh access token
  if (path === "/api/auth/refresh" && method === "POST") {
    // No users = no valid sessions possible
    if (!UserDB.hasUsers()) {
      return json({ error: "No users exist" }, 401, { "Set-Cookie": clearRefreshTokenCookie() });
    }

    const refreshToken = getRefreshTokenFromCookie(req);

    if (!refreshToken) {
      return json({ error: "No refresh token" }, 401);
    }

    const result = await refreshSession(refreshToken);

    if (!result) {
      return json(
        { error: "Invalid or expired refresh token" },
        401,
        { "Set-Cookie": clearRefreshTokenCookie() }
      );
    }

    // Set new refresh token cookie
    const cookieHeader = createRefreshTokenCookie(result.refreshToken, REFRESH_TOKEN_EXPIRY);

    return json(
      {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      },
      200,
      { "Set-Cookie": cookieHeader }
    );
  }

  // GET /api/auth/me - Get current user
  if (path === "/api/auth/me" && method === "GET") {
    const token = getTokenFromRequest(req);

    if (!token) {
      return json({ error: "Unauthorized" }, 401);
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const user = UserDB.findById(payload.userId);
    if (!user) {
      return json({ error: "User not found" }, 404);
    }

    return json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
    });
  }

  // PUT /api/auth/me - Update current user profile
  if (path === "/api/auth/me" && method === "PUT") {
    const token = getTokenFromRequest(req);

    if (!token) {
      return json({ error: "Unauthorized" }, 401);
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const user = UserDB.findById(payload.userId);
    if (!user) {
      return json({ error: "User not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Parameters<typeof UserDB.update>[1] = {};

      if (body.email !== undefined) updates.email = body.email;

      const updated = UserDB.update(user.id, updates);

      return json({
        user: updated ? {
          id: updated.id,
          username: updated.username,
          email: updated.email,
          role: updated.role,
          createdAt: updated.created_at,
          lastLoginAt: updated.last_login_at,
        } : null,
      });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // PUT /api/auth/password - Change password
  if (path === "/api/auth/password" && method === "PUT") {
    const token = getTokenFromRequest(req);

    if (!token) {
      return json({ error: "Unauthorized" }, 401);
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const user = UserDB.findById(payload.userId);
    if (!user) {
      return json({ error: "User not found" }, 404);
    }

    try {
      const body = await req.json();
      const { currentPassword, newPassword } = body;

      if (!currentPassword || !newPassword) {
        return json({ error: "Current and new password are required" }, 400);
      }

      // Verify current password
      const { verifyPassword } = await import("../auth");
      const isValid = await verifyPassword(currentPassword, user.password_hash);
      if (!isValid) {
        return json({ error: "Current password is incorrect" }, 401);
      }

      // Validate new password
      const validation = validatePassword(newPassword);
      if (!validation.valid) {
        return json({ error: validation.errors.join(". ") }, 400);
      }

      // Update password
      const newHash = await hashPassword(newPassword);
      UserDB.update(user.id, { password_hash: newHash });

      return json({ success: true, message: "Password updated successfully" });
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  return json({ error: "Not found" }, 404);
}
