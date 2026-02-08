import type { AuthContext } from "../../auth/middleware";
import { ApiKeyDB } from "../../db";
import { json } from "./helpers";

const MAX_KEYS_PER_USER = 10;

export async function handleApiKeyRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: AuthContext,
): Promise<Response | null> {
  // All API key routes require authentication
  if (!authContext?.isAuthenticated || !authContext.user) {
    return null; // Let other handlers deal with it
  }

  const userId = authContext.user.id;

  // POST /api/keys/personal - Create a new API key
  if (path === "/api/keys/personal" && method === "POST") {
    try {
      const body = await req.json();
      const { name, expires_in_days } = body;

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return json({ error: "Name is required" }, 400);
      }

      if (name.length > 100) {
        return json({ error: "Name must be 100 characters or less" }, 400);
      }

      // Limit keys per user
      const count = ApiKeyDB.countByUser(userId);
      if (count >= MAX_KEYS_PER_USER) {
        return json({ error: `Maximum ${MAX_KEYS_PER_USER} API keys allowed per user` }, 400);
      }

      // Calculate expiration
      let expires_at: string | null = null;
      if (expires_in_days && typeof expires_in_days === "number" && expires_in_days > 0) {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + expires_in_days);
        expires_at = expiry.toISOString();
      }

      const { apiKey, rawKey } = ApiKeyDB.create({
        name: name.trim(),
        user_id: userId,
        expires_at,
      });

      return json({
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey,
        prefix: apiKey.key_prefix,
        expires_at: apiKey.expires_at,
        created_at: apiKey.created_at,
      }, 201);
    } catch (e: any) {
      return json({ error: e.message || "Failed to create API key" }, 500);
    }
  }

  // GET /api/keys/personal - List user's API keys
  if (path === "/api/keys/personal" && method === "GET") {
    const keys = ApiKeyDB.findByUser(userId);
    return json({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        prefix: k.key_prefix,
        is_active: k.is_active,
        expires_at: k.expires_at,
        last_used_at: k.last_used_at,
        created_at: k.created_at,
      })),
    });
  }

  // DELETE /api/keys/personal/:id - Revoke/delete an API key
  const deleteMatch = path.match(/^\/api\/keys\/personal\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const keyId = deleteMatch[1];
    const deleted = ApiKeyDB.delete(keyId, userId);
    if (!deleted) {
      return json({ error: "API key not found" }, 404);
    }
    return json({ success: true });
  }

  return null;
}
