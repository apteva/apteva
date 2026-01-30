import { join } from "path";

const DIST_DIR = join(import.meta.dir, "../../dist");

export async function serveStatic(req: Request, path: string): Promise<Response> {
  // Default to index.html for root and SPA routes
  let filePath = path === "/" ? "/index.html" : path;

  // Try to serve the file
  const fullPath = join(DIST_DIR, filePath);
  const file = Bun.file(fullPath);

  if (await file.exists()) {
    return new Response(file);
  }

  // For SPA: if file doesn't exist and it's not a static asset, serve index.html
  if (!path.includes(".")) {
    const indexFile = Bun.file(join(DIST_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }
  }

  // If dist doesn't exist, serve a development message
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <title>Apteva</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    .container { text-align: center; }
    code { background: #1e293b; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Apteva</h1>
    <p>Run <code>bun run build</code> to build the frontend</p>
    <p>API available at <a href="/api/health" style="color: #60a5fa">/api/health</a></p>
  </div>
</body>
</html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}
