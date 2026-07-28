import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { publicCapabilities } from "../src/workflow-compiler.mjs";

const root = new URL("../integrations/litellm/", import.meta.url).pathname.slice(1);
const sharedStyle = "C:/Project/litellm/style.css";
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const port = Number(process.env.PORT ?? 4173);

createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const apiPayload = pathname === "/api/image/capabilities"
    ? publicCapabilities()
    : pathname === "/api/image/quota"
      ? { dailyUsed: 7.5, dailyLimit: 50, weeklyUsed: 31.5, weeklyLimit: 250, queued: 0, running: 0 }
      : pathname === "/api/image/presets"
        ? { items: [] }
        : null;
  if (apiPayload) {
    const body = JSON.stringify(apiPayload);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  const file = pathname === "/style.css"
    ? sharedStyle
    : join(root, pathname === "/" ? "image.html" : pathname.replace(/^\/+/, ""));
  try {
    const info = await stat(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Content-Length": info.size
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`preview http://127.0.0.1:${port}`);
});
