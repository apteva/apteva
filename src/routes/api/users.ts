import { json } from "./helpers";
import { UserDB } from "../../db";
import { createUser, hashPassword, validatePassword } from "../../auth";
import type { AuthContext } from "../../auth/middleware";

export async function handleUserRoutes(
  req: Request,
  path: string,
  method: string,
  authContext?: AuthContext,
): Promise<Response | null> {
  const user = authContext?.user;

  // GET /api/users - List all users
  if (path === "/api/users" && method === "GET") {
    const users = UserDB.findAll().map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    }));
    return json({ users });
  }

  // POST /api/users - Create a new user
  if (path === "/api/users" && method === "POST") {
    try {
      const body = await req.json();
      const { username, password, email, role } = body;

      if (!username || !password) {
        return json({ error: "Username and password are required" }, 400);
      }

      const result = await createUser({
        username,
        password,
        email: email || undefined,
        role: role || "user",
      });

      if (!result.success) {
        return json({ error: result.error }, 400);
      }

      return json({
        user: {
          id: result.user!.id,
          username: result.user!.username,
          email: result.user!.email,
          role: result.user!.role,
          createdAt: result.user!.created_at,
        },
      }, 201);
    } catch (e) {
      return json({ error: "Invalid request body" }, 400);
    }
  }

  // GET /api/users/:id - Get a specific user
  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }
    return json({
      user: {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role,
        createdAt: targetUser.created_at,
        lastLoginAt: targetUser.last_login_at,
      },
    });
  }

  // PUT /api/users/:id - Update a user
  if (userMatch && method === "PUT") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }

    try {
      const body = await req.json();
      const updates: Parameters<typeof UserDB.update>[1] = {};

      if (body.email !== undefined) updates.email = body.email;
      if (body.role !== undefined) {
        // Prevent removing last admin
        if (targetUser.role === "admin" && body.role !== "admin") {
          if (UserDB.countAdmins() <= 1) {
            return json({ error: "Cannot remove the last admin" }, 400);
          }
        }
        updates.role = body.role;
      }
      if (body.password !== undefined) {
        const validation = validatePassword(body.password);
        if (!validation.valid) {
          return json({ error: validation.errors.join(". ") }, 400);
        }
        updates.password_hash = await hashPassword(body.password);
      }

      const updated = UserDB.update(userMatch[1], updates);
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

  // DELETE /api/users/:id - Delete a user
  if (userMatch && method === "DELETE") {
    const targetUser = UserDB.findById(userMatch[1]);
    if (!targetUser) {
      return json({ error: "User not found" }, 404);
    }

    // Prevent deleting yourself
    if (user && targetUser.id === user.id) {
      return json({ error: "Cannot delete your own account" }, 400);
    }

    // Prevent deleting last admin
    if (targetUser.role === "admin" && UserDB.countAdmins() <= 1) {
      return json({ error: "Cannot delete the last admin" }, 400);
    }

    UserDB.delete(userMatch[1]);
    return json({ success: true });
  }

  return null;
}
