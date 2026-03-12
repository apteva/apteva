import { json } from "./helpers";
import { SettingsDB } from "../../db";

export async function handleSettingsRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // GET /api/settings - Get all settings
  if (path === "/api/settings" && method === "GET") {
    return json({ settings: SettingsDB.getAll() });
  }

  // PUT /api/settings/:key - Set a single setting
  const singleMatch = path.match(/^\/api\/settings\/([a-z0-9_]+)$/);
  if (singleMatch && method === "PUT") {
    const key = singleMatch[1];
    const body = await req.json() as { value: string };
    if (body.value === undefined) {
      return json({ error: "value is required" }, 400);
    }
    SettingsDB.set(key, String(body.value));
    return json({ key, value: String(body.value) });
  }

  // DELETE /api/settings/:key - Delete a setting (revert to default)
  if (singleMatch && method === "DELETE") {
    const key = singleMatch[1];
    SettingsDB.delete(key);
    return json({ deleted: true, key });
  }

  // POST /api/settings/import - Bulk import settings
  if (path === "/api/settings/import" && method === "POST") {
    const body = await req.json() as { settings: Record<string, string> };
    if (!body.settings || typeof body.settings !== "object") {
      return json({ error: "settings object is required" }, 400);
    }
    const count = SettingsDB.import(body.settings);
    return json({ success: true, imported: count });
  }

  // GET /api/settings/export - Export all settings
  if (path === "/api/settings/export" && method === "GET") {
    return json(SettingsDB.export());
  }

  return null;
}
