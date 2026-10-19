#!/usr/bin/env node
/**
 * Validate and smoke-test a Sora module outside the app.
 *
 *   node test/run-module.mjs modules/internet-archive "dracula"
 *   node test/run-module.mjs modules/internet-archive "dracula" --no-head
 *
 * Works in all three Sora modes:
 *   - asyncJS:        keyword/URL in, Promise of JSON out
 *   - streamAsyncJS:  HTML in for search/details/episodes, URL in for stream
 *   - normal:         HTML in for everything
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRuntime } from "./sora-runtime.mjs";

const REQUIRED_MANIFEST_FIELDS = [
    "sourceName", "iconUrl", "author", "version", "language",
    "streamType", "quality", "baseUrl", "searchBaseUrl", "scriptUrl", "type"
];

function arg(flag) {
    return process.argv.includes(flag);
}

function positional() {
    return process.argv.slice(2).filter((a) => !a.startsWith("--"));
}

function parseJSONish(value, label) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") {
        throw new Error(`${label} returned ${typeof value}, expected a JSON string`);
    }
    try {
        return JSON.parse(value);
    } catch {
        // A bare URL is legal for extractStreamUrl.
        if (/^https?:\/\//i.test(value.trim())) return value.trim();
        throw new Error(`${label} returned invalid JSON: ${value.slice(0, 160)}`);
    }
}

function isHttp(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value);
}

function check(condition, message) {
    if (!condition) throw new Error(message);
}

function assertSearch(results) {
    check(Array.isArray(results), "searchResults must return a JSON array");
    for (const [i, item] of results.entries()) {
        check(item && typeof item === "object", `searchResults[${i}] is not an object`);
        check(typeof item.title === "string" && item.title.length > 0, `searchResults[${i}].title missing`);
        check(isHttp(item.href), `searchResults[${i}].href is not a URL`);
        check(typeof item.image === "string", `searchResults[${i}].image missing`);
    }
}

function assertDetails(items) {
    check(Array.isArray(items), "extractDetails must return a JSON array");
    if (!items.length) return;
    const item = items[0];
    for (const key of ["description", "aliases", "airdate"]) {
        check(typeof item[key] === "string", `extractDetails[0].${key} must be a string`);
    }
}

function assertEpisodes(items, asyncMode) {
    check(Array.isArray(items), "extractEpisodes must return a JSON array");
    for (const [i, item] of items.entries()) {
        check(isHttp(item.href), `extractEpisodes[${i}].href is not a URL`);
        if (asyncMode) {
            // App path: `$0["number"] as? Int`
            check(typeof item.number === "number", `extractEpisodes[${i}].number must be a JSON number in asyncJS mode`);
        } else {
            // App path: `ep["number"]` cast to String
            check(typeof item.number === "string", `extractEpisodes[${i}].number must be a string in normal mode`);
        }
    }
}

function extractStreamUrl(value) {
    const parsed = parseJSONish(value, "extractStreamUrl");

    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) return parsed.find(isHttp) || null;
    if (parsed && typeof parsed === "object") {
        if (isHttp(parsed.streamUrl)) return parsed.streamUrl;
        if (isHttp(parsed.url)) return parsed.url;
        if (isHttp(parsed.stream)) return parsed.stream;
        if (parsed.stream && typeof parsed.stream === "object") {
            if (isHttp(parsed.stream.streamUrl)) return parsed.stream.streamUrl;
            if (isHttp(parsed.stream.url)) return parsed.stream.url;
        }
        if (Array.isArray(parsed.streams)) {
            for (const s of parsed.streams) {
                if (isHttp(s)) return s;
                if (s && typeof s === "object") {
                    if (isHttp(s.streamUrl)) return s.streamUrl;
                    if (isHttp(s.url)) return s.url;
                }
            }
        }
    }
    return null;
}

async function timed(label, fn) {
    const start = Date.now();
    const value = await fn();
    console.log(`  ✓ ${label} (${Date.now() - start} ms)`);
    return value;
}

async function fetchHtml(url) {
    const res = await fetch(url, { headers: { "User-Agent": "SoraModuleHarness/1.0" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
}

async function head(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        const res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            headers: { "User-Agent": "SoraModuleHarness/1.0" },
            signal: controller.signal
        });
        return {
            status: res.status,
            type: res.headers.get("content-type") || "unknown",
            length: res.headers.get("content-length") || "unknown"
        };
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const [moduleDirArg, queryArg] = positional();
    if (!moduleDirArg) {
        console.error("Usage: node test/run-module.mjs <module-dir> [search-query] [--no-head]");
        process.exit(1);
    }

    const moduleDir = path.resolve(moduleDirArg);
    const manifestPath = path.join(moduleDir, "module.json");
    const fallbackManifest = path.join(moduleDir, `${path.basename(moduleDir)}.json`);

    let manifestFile = manifestPath;
    try {
        await fs.access(manifestFile);
    } catch {
        manifestFile = fallbackManifest;
    }

    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const script = await fs.readFile(path.join(moduleDir, path.basename(manifest.scriptUrl || "module.js")), "utf8")
        .catch(async () => {
            const jsFiles = (await fs.readdir(moduleDir)).filter((f) => f.endsWith(".js"));
            if (!jsFiles.length) throw new Error(`No .js file found in ${moduleDir}`);
            return fs.readFile(path.join(moduleDir, jsFiles[0]), "utf8");
        });

    console.log(`\nModule: ${manifest.sourceName} v${manifest.version}`);
    console.log(`Mode:   ${manifest.asyncJS ? "asyncJS" : manifest.streamAsyncJS ? "streamAsyncJS" : "normal"}`);

    const missing = REQUIRED_MANIFEST_FIELDS.filter((field) => {
        if (field === "author") return !manifest.author || !manifest.author.name || !manifest.author.icon;
        return manifest[field] === undefined || manifest[field] === "";
    });
    if (missing.length) throw new Error(`Manifest missing required fields: ${missing.join(", ")}`);
    console.log("  ✓ manifest shape");

    const query = queryArg || "dracula";
    const runtime = createRuntime();
    runtime.load(script, path.basename(manifest.scriptUrl || "module.js"));

    const asyncMode = manifest.asyncJS === true;
    const streamAsync = manifest.streamAsyncJS === true;

    // --- search -----------------------------------------------------
    const results = await timed("searchResults", async () => {
        let raw;
        if (asyncMode) {
            raw = await runtime.call("searchResults", query);
        } else {
            const searchUrl = manifest.searchBaseUrl.replace("%s", encodeURIComponent(query));
            raw = runtime.call("searchResults", await fetchHtml(searchUrl));
        }
        const parsed = parseJSONish(raw, "searchResults");
        assertSearch(parsed);
        return parsed;
    });

    console.log(`         ${results.length} result(s)`);
    if (results[0]) console.log(`         first: ${results[0].title} -> ${results[0].href}`);
    if (!results.length) {
        throw new Error(`Search for "${query}" returned nothing (site blocked, query too narrow, or parser broken)`);
    }

    const href = results[0].href;

    // --- details ----------------------------------------------------
    const details = await timed("extractDetails", async () => {
        const raw = asyncMode
            ? await runtime.call("extractDetails", href)
            : runtime.call("extractDetails", await fetchHtml(href));
        const parsed = parseJSONish(raw, "extractDetails");
        assertDetails(parsed);
        return parsed;
    });
    console.log(`         ${details[0] ? details[0].description.slice(0, 100) : "(none)"}`);

    // --- episodes ---------------------------------------------------
    const episodes = await timed("extractEpisodes", async () => {
        const raw = asyncMode
            ? await runtime.call("extractEpisodes", href)
            : runtime.call("extractEpisodes", await fetchHtml(href));
        const parsed = parseJSONish(raw, "extractEpisodes");
        assertEpisodes(parsed, asyncMode);
        return parsed;
    });
    console.log(`         ${episodes.length} episode(s)`);
    if (!episodes.length) throw new Error("extractEpisodes returned no playable entries");

    // --- stream -----------------------------------------------------
    const streamUrl = await timed("extractStreamUrl", async () => {
        const episodeUrl = episodes[0].href;
        let raw;
        if (asyncMode) {
            raw = await runtime.call("extractStreamUrl", episodeUrl);
        } else if (streamAsync) {
            raw = await runtime.call("extractStreamUrl", await fetchHtml(episodeUrl));
        } else {
            raw = runtime.call("extractStreamUrl", await fetchHtml(episodeUrl));
        }
        const url = extractStreamUrl(raw);
        check(isHttp(url), "extractStreamUrl did not produce an http(s) URL");
        return url;
    });
    console.log(`         ${streamUrl.slice(0, 140)}`);

    // --- reachability (best effort) ---------------------------------
    if (!arg("--no-head")) {
        try {
            const info = await head(streamUrl);
            console.log(`  ✓ stream reachable: HTTP ${info.status}, ${info.type}, ${info.length} bytes`);
            if (!/video|octet-stream|mpegurl/i.test(info.type)) {
                console.log(`  ! content-type "${info.type}" may not be directly playable`);
            }
        } catch (e) {
            console.log(`  ! could not verify stream with HEAD: ${e.message}`);
        }
    }

    if (runtime.logs.length) {
        console.log("\nModule console output:");
        for (const line of runtime.logs) console.log(`  | ${line}`);
    }

    console.log("\nAll contract checks passed.\n");
}

main().catch((error) => {
    console.error(`\n✗ ${error.message}\n`);
    process.exit(1);
});
