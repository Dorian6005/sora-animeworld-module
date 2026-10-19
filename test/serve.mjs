#!/usr/bin/env node
/**
 * Static server for local module testing.
 *
 *   node test/serve.mjs
 *
 * Then on an iPhone/iPad/Mac on the same network open:
 *   http://<your-LAN-IP>:8080/modules/internet-archive/internet-archive.json
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let filePath = path.join(ROOT, decodeURIComponent(url.pathname));

        // Prevent path traversal.
        if (!filePath.startsWith(ROOT)) {
            res.writeHead(403).end("Forbidden");
            return;
        }

        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && stat.isDirectory()) {
            filePath = path.join(filePath, "index.html");
        }

        const data = await fs.readFile(filePath);
        res.writeHead(200, {
            "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        });
        res.end(data);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Serving ${ROOT}\n`);
    console.log(`  http://localhost:${PORT}/modules/internet-archive/internet-archive.json`);

    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === "IPv4" && !address.internal) {
                console.log(`  http://${address.address}:${PORT}/modules/internet-archive/internet-archive.json`);
            }
        }
    }
    console.log("\nUse one of the LAN URLs on your device (same Wi-Fi). Ctrl+C to stop.");
});
