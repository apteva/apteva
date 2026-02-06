export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const isDev = process.env.NODE_ENV !== "production";

export function debug(...args: unknown[]) {
  if (isDev) console.log("[api]", ...args);
}
