/**
 * A small emulation of Sora's JavaScriptCore environment.
 * It exposes the same globals a Sora module expects, backed by Node's fetch.
 */

import vm from "node:vm";

const UA = "SoraModuleHarness/1.0";

function headerObject(headers) {
    if (!headers) return {};
    if (Array.isArray(headers)) {
        const out = {};
        for (const pair of headers) out[String(pair[0])] = String(pair[1]);
        return out;
    }
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
}

/** Legacy Sora helper: fetch(url, headers) -> raw text. */
async function legacyFetch(url, headers) {
    const res = await globalThis.fetch(url, {
        headers: Object.assign({ "User-Agent": UA }, headerObject(headers)),
        redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
}

/** Sora helper: fetchv2(url, headers, method, body, redirect, encoding). */
async function fetchV2(url, headers = {}, method = "GET", body = null, redirect = true) {
    const res = await globalThis.fetch(url, {
        method,
        headers: Object.assign({ "User-Agent": UA }, headerObject(headers)),
        body: method === "GET" ? undefined : (body ?? undefined),
        redirect: redirect ? "follow" : "manual"
    });

    const text = await res.text();
    return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        _data: text,
        text: async () => text,
        json: async () => JSON.parse(text)
    };
}

export function createRuntime() {
    const logs = [];

    const context = vm.createContext({
        fetch: legacyFetch,
        fetchv2: fetchV2,
        console: {
            log: (...args) => logs.push(args.map(String).join(" ")),
            error: (...args) => logs.push("[error] " + args.map(String).join(" "))
        },
        btoa: (s) => Buffer.from(String(s), "utf8").toString("base64"),
        atob: (s) => Buffer.from(String(s), "base64").toString("utf8"),
        setTimeout,
        clearTimeout
    });

    return {
        context,
        logs,
        load(code, filename = "module.js") {
            return vm.runInContext(code, context, { filename, timeout: 30_000 });
        },
        call(name, ...args) {
            const fn = context[name];
            if (typeof fn !== "function") {
                throw new Error(`Module does not define ${name}()`);
            }
            return fn(...args);
        }
    };
}
