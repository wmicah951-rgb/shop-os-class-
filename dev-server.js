// Local preview without Vercel:  node dev-server.js   then open http://localhost:3000
// (PowerShell: $env:LLM_API_KEY="your-key"; node dev-server.js)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/chat.js";
import shopHandler from "./api/shop.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/chat") || req.url.startsWith("/api/shop")) {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", async () => {
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      res.status = code => { res.statusCode = code; return res; };
      res.json = obj => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
      await (req.url.startsWith("/api/shop") ? shopHandler : handler)(req, res);
    });
    return;
  }
  try {
    const html = await readFile(join(root, "index.html"));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  } catch { res.statusCode = 404; res.end("Not found"); }
}).listen(port, () => console.log(`Shop-OS agent running at http://localhost:${port}`));
