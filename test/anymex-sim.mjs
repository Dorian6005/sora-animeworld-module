/**
 * AnymeX host simulation:
 *  - no `console` global (QuickJS engine doesn't inject one)
 *  - legacy `fetch` is aliased to fetchv2 and returns a Response-shaped object
 *  - fetchv2 accepts only (url, headers, method, body)
 */
import vm from "node:vm";
import fs from "node:fs";

const code = fs.readFileSync("modules/animeworld/animeworld.js", "utf8");

async function realFetch(url, headers, method = "GET", body = null) {
    const res = await fetch(url, {
        method,
        headers: Object.assign(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            headers || {}
        ),
        body: method === "GET" ? undefined : body ?? undefined,
        redirect: "follow"
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fetchv2 failed: HTTP ${res.status} for ${url}`);
    return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        ok: res.status >= 200 && res.status < 300,
        json: async () => JSON.parse(text),
        text: async () => text
    };
}

const context = vm.createContext({
    // AnymeX: fetch IS fetchv2, object-shaped; no console at all
    fetch: (url, headers) => realFetch(url, headers),
    fetchv2: (url, headers = {}, method = "GET", body = null, _redirect, _enc) => realFetch(url, headers, method, body)
});

vm.runInContext(code, context, { filename: "animeworld.js" });

const search = JSON.parse(await context.searchResults("one piece"));
console.log("search results:", search.length, "→", search[0]?.title, "| href:", search[0]?.href);

const episodes = JSON.parse(await context.extractEpisodes(search[0].href));
console.log("episodes:", episodes.length, "first number:", episodes[0]?.number, "number type:", typeof episodes[0]?.number);

const stream = JSON.parse(await context.extractStreamUrl(episodes[0].href));
console.log("stream:", (stream?.stream?.streamUrl || "FAILED").slice(0, 90));
