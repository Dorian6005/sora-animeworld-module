/**
 * Internet Archive — Sora module (async JS mode)
 *
 * Source: archive.org's "feature_films" collection (public-domain / openly
 * licensed movies). One archive.org item = one playable "episode".
 *
 * Required globals: searchResults(keyword), extractDetails(url),
 * extractEpisodes(url), extractStreamUrl(url).
 */

var API_BASE = "https://archive.org";
var COLLECTION = "feature_films";
var USER_AGENT = "SoraModule/1.0 (+https://archive.org)";

/* ------------------------------------------------------------------ */
/* Runtime helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sora exposes two HTTP helpers:
 *   fetchv2(url, headers, method, body, redirect, encoding)
 *     -> Promise<{ status, headers, text(), json() }>   (10 MB cap)
 *   fetch(url, headers)
 *     -> Promise<string>                                 (legacy, raw body)
 *
 * fetchv2 is preferred because it gives us a status code. If it fails we
 * fall back to the legacy helper.
 */
async function soraFetch(url, options) {
    options = options || {};
    var headers = options.headers || { "User-Agent": USER_AGENT };

    try {
        var res = await fetchv2(url, headers, options.method || "GET", options.body || null);

        // Sora resolves with { error: "..." } on network failures.
        if (res && res.error) throw new Error(res.error);

        if (res && typeof res.text === "function") {
            var body = await res.text();
            if (res.status && res.status >= 400) {
                throw new Error("HTTP " + res.status);
            }
            return body;
        }

        // Some builds resolve fetchv2 to a plain string.
        return String(res);
    } catch (e) {
        console.log("fetchv2 failed (" + e + "), trying fetch: " + url);
        return await fetch(url, headers);
    }
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        console.log("JSON parse error: " + e);
        return null;
    }
}

function stripHtml(input) {
    if (input === null || input === undefined) return "";
    var s = String(input);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    s = decodeEntities(s);
    s = s.replace(/[ \t\f\v]+/g, " ");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

function decodeEntities(s) {
    var named = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
        ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'",
        rdquo: '"', ldquo: '"'
    };
    return s
        .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
        })
        .replace(/&#(\d+);/g, function (_, dec) {
            return String.fromCharCode(parseInt(dec, 10));
        })
        .replace(/&([a-z]+);/gi, function (m, name) {
            return named[name.toLowerCase()] !== undefined ? named[name.toLowerCase()] : m;
        });
}

function firstString(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
            var s = firstString(value[i]);
            if (s) return s;
        }
        return "";
    }
    if (typeof value === "object") return "";
    return String(value).trim();
}

/** Accepts /details/<id>, /download/<id>, /embed/<id>, or a bare identifier. */
function itemIdFromUrl(url) {
    var value = String(url || "").trim();
    var match = value.match(/archive\.org\/(?:details|download|embed)\/([^\/?#]+)/i);
    if (match) return decodeURIComponent(match[1]);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return value;
    return "";
}

function itemPageUrl(id) {
    return API_BASE + "/details/" + encodeURIComponent(id);
}

/** Escape a keyword for the archive.org (Lucene-like) search syntax. */
function sanitizeKeyword(keyword) {
    return String(keyword || "")
        .replace(/[\\()"^~*?:\[\]{}!]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/* ------------------------------------------------------------------ */
/* 1. searchResults(keyword) -> JSON string                            */
/* ------------------------------------------------------------------ */

async function searchResults(keyword) {
    var query = sanitizeKeyword(keyword);
    if (!query) return JSON.stringify([]);

    var q = "title:(" + query + ") AND collection:(" + COLLECTION + ")";
    var url = API_BASE + "/advancedsearch.php"
        + "?q=" + encodeURIComponent(q)
        + "&fl%5B%5D=identifier"
        + "&fl%5B%5D=title"
        + "&fl%5B%5D=year"
        + "&fl%5B%5D=description"
        + "&rows=24&page=1&output=json"
        + "&sort%5B%5D=downloads%20desc";

    try {
        var data = parseJson(await soraFetch(url));
        var docs = data && data.response && data.response.docs ? data.response.docs : [];
        var results = [];

        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i] || {};
            var id = doc.identifier;
            if (!id) continue;

            var title = stripHtml(firstString(doc.title));
            if (!title) title = id;

            results.push({
                title: title,
                image: API_BASE + "/services/img/" + encodeURIComponent(id),
                href: itemPageUrl(id)
            });
        }

        console.log("Internet Archive: " + results.length + " results for \"" + query + "\"");
        return JSON.stringify(results);
    } catch (e) {
        console.log("searchResults error: " + e);
        return JSON.stringify([]);
    }
}

/* ------------------------------------------------------------------ */
/* 2. extractDetails(url) -> JSON string                               */
/* ------------------------------------------------------------------ */

async function extractDetails(url) {
    var id = itemIdFromUrl(url);
    if (!id) return JSON.stringify([]);

    try {
        var data = parseJson(await soraFetch(API_BASE + "/metadata/" + encodeURIComponent(id)));
        var m = data && data.metadata ? data.metadata : null;
        if (!m) return JSON.stringify([]);

        var description = stripHtml(firstString(m.description));
        if (description.length > 900) {
            description = description.slice(0, 900).replace(/\s+\S*$/, "") + "…";
        }
        if (!description) description = "No description available.";

        var aliases = [];
        var creator = stripHtml(firstString(m.creator));
        var collection = stripHtml(firstString(m.collection));
        if (creator) aliases.push(creator);
        if (collection) aliases.push(collection);

        var airdate = firstString(m.date) || firstString(m.year) || "Unknown";

        return JSON.stringify([{
            description: description,
            aliases: aliases.length ? aliases.join(" · ") : "N/A",
            airdate: airdate
        }]);
    } catch (e) {
        console.log("extractDetails error: " + e);
        return JSON.stringify([]);
    }
}

/* ------------------------------------------------------------------ */
/* 3. extractEpisodes(url) -> JSON string                              */
/* ------------------------------------------------------------------ */

async function extractEpisodes(url) {
    var id = itemIdFromUrl(url);
    if (!id) return JSON.stringify([]);

    // async mode: "number" must be a JSON number (Sora casts it to Int)
    return JSON.stringify([{
        href: itemPageUrl(id),
        number: 1
    }]);
}

/* ------------------------------------------------------------------ */
/* 4. extractStreamUrl(url) -> JSON string                             */
/* ------------------------------------------------------------------ */

function fileSize(file) {
    var size = parseInt(file && file.size, 10);
    return isNaN(size) ? 0 : size;
}

function encodePath(path) {
    return String(path)
        .split("/")
        .map(function (part) { return encodeURIComponent(part); })
        .join("/");
}

/**
 * Prefer the largest .mp4 (AVPlayer-friendly). Fall back to .m4v/.mov.
 * archive.org often exposes several derivatives; the biggest is normally
 * the best-quality one.
 */
function pickVideoFile(files) {
    var playable = [];
    for (var i = 0; i < files.length; i++) {
        var file = files[i] || {};
        if (!file.name) continue;
        if (/\.(mp4|m4v|mov)$/i.test(file.name)) playable.push(file);
    }

    if (!playable.length) return null;

    playable.sort(function (a, b) {
        var aMp4 = /\.mp4$/i.test(a.name) ? 1 : 0;
        var bMp4 = /\.mp4$/i.test(b.name) ? 1 : 0;
        if (aMp4 !== bMp4) return bMp4 - aMp4;
        return fileSize(b) - fileSize(a);
    });

    return playable[0];
}

async function extractStreamUrl(url) {
    var id = itemIdFromUrl(url);
    if (!id) return null;

    try {
        var data = parseJson(await soraFetch(API_BASE + "/metadata/" + encodeURIComponent(id)));
        var files = data && data.files ? data.files : [];
        var video = pickVideoFile(files);

        if (!video) {
            console.log("No playable video file for " + id);
            return null;
        }

        var streamUrl = API_BASE + "/download/" + encodeURIComponent(id) + "/" + encodePath(video.name);
        console.log("Stream: " + streamUrl);

        // Object form lets us show a readable title in Sora's source picker.
        return JSON.stringify({
            stream: {
                streamUrl: streamUrl,
                title: "Archive.org · " + (video.format || "video")
            }
        });
    } catch (e) {
        console.log("extractStreamUrl error: " + e);
        return null;
    }
}
