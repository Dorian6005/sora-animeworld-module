/**
 * Faithful AnymeX host harness, mirroring RyanYuuki/AnymeXExtensionRuntimeBridge
 * (lib/Services/Sora/JsEngine/*.dart and SoraSourceMethods.dart):
 *  - bare engine: no console, no setTimeout
 *  - fetchv2(url, headers, method, body) -> { status, headers, ok, json(), text() }
 *    and the global alias `const fetch = fetchv2`
 *  - fetchv2 rejects on network errors only (HTTP 4xx/5xx still resolve)
 *  - module source wrapped in `globalThis[name] = (() => { ... })()`
 *  - results post-processed like the Dart side (search, episodes, details,
 *    getVideoList), including its Map.toString() pitfall for `{stream: {...}}`.
 *
 * Usage: node test/anymex-bridge.mjs [modulePath] [query]
 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

const modDir = process.argv[2] || "modules/animeworld";
const query = process.argv[3] || "one piece";
const base = path.basename(modDir);
const code = fs.readFileSync(path.join(modDir, base + ".js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(modDir, base + ".json"), "utf8"));
const moduleName = manifest.sourceName;

const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9"
};

// Dart FetchV2.handle
async function bridgeFetch(payloadJson) {
    const data = JSON.parse(payloadJson);
    let method = String(data.method || "GET").toUpperCase();
    let body = data.body;
    const headers = { ...DEFAULT_HEADERS };
    let ext = data.headers;
    if (ext && typeof ext === "object") {
        if (Object.keys(ext).some((k) => /^(headers|method|body)$/i.test(k))) {
            const m = ext.method ?? ext.Method;
            if (m != null) method = String(m).toUpperCase();
            const b = ext.body ?? ext.Body;
            if (b != null) body = b;
            ext = ext.headers ?? ext.Headers;
        }
    }
    if (ext && typeof ext === "object") for (const [k, v] of Object.entries(ext)) headers[k] = String(v);
    try {
        const res = await fetch(data.url, {
            method,
            headers,
            body: method === "GET" || method === "HEAD" || body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
            redirect: "follow"
        });
        return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    } catch (e) {
        throw new Error("fetchv2 failed: " + e);
    }
}

const context = vm.createContext({
    sendMessage: (channel, payload) => {
        if (channel !== "bridge") throw new Error("Unknown bridge call");
        return bridgeFetch(payload);
    }
});
// FetchV2.inject()
vm.runInContext(`
async function fetchv2(url, headers = {}, method = "GET", body = null) {
  const payload = JSON.stringify({ type: "fetchv2", url, headers, method, body });
  const res = await sendMessage("bridge", payload);
  return {
    status: res.status,
    headers: res.headers,
    ok: res.status >= 200 && res.status < 300,
    json: () => Promise.resolve(JSON.parse(res.body)),
    text: () => Promise.resolve(res.body)
  };
}
const fetch = fetchv2;
`, context);

// JsExtensionEngine.loadModule
vm.runInContext(`
globalThis[${JSON.stringify(moduleName)}] = (() => {
${code}
  const __exports = {};
  if (typeof searchResults === 'function') __exports.searchResults = searchResults;
  if (typeof extractDetails === 'function') __exports.extractDetails = extractDetails;
  if (typeof extractEpisodes === 'function') __exports.extractEpisodes = extractEpisodes;
  if (typeof extractStreamUrl === 'function') __exports.extractStreamUrl = extractStreamUrl;
  return __exports;
})();
`, context, { filename: base + ".js" });

// JsExtensionEngine.call + SoraSourceMethods._call/_parseJs
async function call(method, params) {
    const encoded = JSON.stringify(params);
    try {
        const value = await vm.runInContext(`(async () => {
            const target = globalThis[${JSON.stringify(moduleName)}];
            const fn = target[${JSON.stringify(method)}];
            if (typeof fn !== "function") throw new Error("Method '${method}' not found");
            const args = JSON.parse('${encoded}');
            return await fn(...args);
        })()`, context);
        if (typeof value === "string") {
            try { return JSON.parse(value); } catch { return value; }
        }
        return value ?? null;
    } catch (e) {
        console.log(`  [Logger] Error calling JS method '${method}': ${e}`);
        return null;
    }
}

const ERR = ["Error", "error", "Not Found", "not found", "Failed"];
function isErrorPayload(d) {
    if (d == null) return true;
    const check = (m) => ERR.includes(m.title) || ERR.includes(m.id) || ERR.includes(m.href);
    if (Array.isArray(d)) return d.length === 1 && d[0] && typeof d[0] === "object" && check(d[0]);
    if (typeof d === "object") return check(d);
    return false;
}

// Dart's Map/List toString(), reproduces `urlData.toString()` on objects
function dartToString(v) {
    if (Array.isArray(v)) return "[" + v.map(dartToString).join(", ") + "]";
    if (v && typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => k + ": " + dartToString(x)).join(", ") + "}";
    return String(v);
}

// SoraSourceMethods.getVideoList (without m3u8 variant expansion)
function videoList(data) {
    const videos = [];
    const addVideo = (title, urlData, headers) => {
        let parsed = urlData;
        if (typeof urlData === "string" && /^\s*[[{]/.test(urlData)) { try { parsed = JSON.parse(urlData); } catch {} }
        if (parsed && typeof parsed === "object") {
            const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.streams) ? parsed.streams : [];
            if (list.length) {
                for (const s of list) {
                    if (!s || typeof s !== "object") continue;
                    const u = String(s.streamUrl ?? s.url ?? s.stream ?? "");
                    if (u) videos.push({ title: s.title ?? title, url: u, headers: { ...(headers || {}), ...(s.headers || {}) } });
                }
                return;
            }
        }
        videos.push({ title, url: dartToString(urlData), headers: headers || {} });
    };
    if (typeof data === "string") addVideo("Video", data);
    else if (Array.isArray(data)) data.forEach((d) => addVideo("Video", d));
    else if (data && typeof data === "object") {
        if ("stream" in data) addVideo("Video", data.stream);
        else if (Array.isArray(data.streams)) {
            for (const s of data.streams) {
                const u = s.streamUrl ?? s.url ?? s.stream;
                if (u) addVideo(s.title ?? "Server", u, s.headers);
            }
        } else if (data.streams && typeof data.streams === "object") {
            for (const [k, v] of Object.entries(data.streams)) if (v != null) addVideo(k, String(v));
        }
    }
    return videos;
}

let failed = false;
const fail = (msg) => { failed = true; console.log("FAIL:", msg); };

console.log(`== ${moduleName} under AnymeX bridge, query "${query}"`);
const search = await call("searchResults", [query, 1, []]);
const media = Array.isArray(search) ? search.map((m) => ({ title: m.title, url: m.href ?? m.id, cover: m.image ?? m.imageURL })) : [];
console.log("search:", media.length, "results; first:", media[0]);
if (!media.length || !media[0].url) fail("no search results");

if (media.length) {
    const rawEps = await call("extractEpisodes", [media[0].url]);
    if (isErrorPayload(rawEps)) fail("extractEpisodes returned error payload: " + JSON.stringify(rawEps));
    const eps = (Array.isArray(rawEps) ? rawEps : []).map((e) => ({ number: String(e.number ?? ""), url: e.href ?? e.id }));
    console.log("episodes:", eps.length, "first:", eps[0]);
    if (!eps.length) fail("no episodes");

    const details = await call("extractDetails", [media[0].url]);
    const d = Array.isArray(details) ? details[0] : details;
    console.log("details:", d && { description: String(d.description).slice(0, 160), aliases: d.aliases, airdate: d.airdate });

    if (eps.length) {
        const raw = await call("extractStreamUrl", [eps[0].url]);
        console.log("extractStreamUrl raw:", JSON.stringify(raw)?.slice(0, 220));
        if (isErrorPayload(raw)) fail("extractStreamUrl returned null/error");
        const vids = videoList(raw);
        console.log("videos:", vids.map((v) => ({ title: v.title, url: v.url.slice(0, 110), headers: v.headers })));
        if (!vids.length) fail("no playable videos");
        for (const v of vids) {
            if (!/^https?:\/\//.test(v.url)) { fail("video url is not a URL: " + v.url.slice(0, 80)); continue; }
            const r = await fetch(v.url, { headers: { ...v.headers, Range: "bytes=0-1023" } });
            console.log("  probe", r.status, r.headers.get("content-type"));
            if (r.status >= 400) fail("video url answered HTTP " + r.status);
        }
    }
}
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
