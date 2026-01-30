import { join } from "path";
import { existsSync, statSync } from "fs";

// Find dist directory - handle both development and npx contexts
function findDistDir(): string {
  const candidates = [
    join(import.meta.dir, "../../dist"),
    join(import.meta.dir, "../dist"),
    join(process.cwd(), "dist"),
  ];

  for (const dir of candidates) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        const indexPath = join(dir, "index.html");
        if (existsSync(indexPath)) {
          return dir;
        }
      }
    } catch {
      continue;
    }
  }

  return candidates[0]; // Default to first candidate
}

const DIST_DIR = findDistDir();

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export async function serveStatic(req: Request, path: string): Promise<Response> {
  try {
    // Default to index.html for root
    let filePath = path === "/" ? "/index.html" : path;

    // Prevent directory traversal attacks
    if (filePath.includes("..")) {
      return new Response("Forbidden", { status: 403 });
    }

    const fullPath = join(DIST_DIR, filePath);

    // Check if file exists using sync API (more reliable)
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          const file = Bun.file(fullPath);
          const mimeType = getMimeType(filePath);
          return new Response(file, {
            headers: { "Content-Type": mimeType },
          });
        }
      } catch {
        // Fall through to SPA handling
      }
    }

    // For SPA: if file doesn't exist and it's not a static asset, serve index.html
    if (!path.includes(".")) {
      const indexPath = join(DIST_DIR, "index.html");
      if (existsSync(indexPath)) {
        const indexFile = Bun.file(indexPath);
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // If dist doesn't exist, serve a development message
    return new Response(
      `<!DOCTYPE html>
<html>
<head>
  <title>apteva</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    .container { text-align: center; }
    code { background: #1e293b; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>apteva</h1>
    <p>Run <code>bun run build</code> to build the frontend</p>
    <p>API available at <a href="/api/health" style="color: #60a5fa">/api/health</a></p>
  </div>
</body>
</html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      }
    );
  } catch (error) {
    console.error("Static file error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
