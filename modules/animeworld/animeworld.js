/*
 * Sora module — AnimeWorld
 * asyncJS mode.
 *
 * Parsing strategy (no page-level regexes):
 *   1. Search    : full /search page parsed with a tokenizer-based HTML scanner
 *                  (quote-aware attributes, depth-counted tag blocks);
 *                  /api/search (JSON with embedded markup) is the fallback.
 *   2. Details   : structured first — JSON-LD blocks, then named blocks (.desc,
 *                  h1#anime-title, dd after "Data di Uscita").
 *   3. Episodes  : <li class="episode"> blocks walked with the same scanner;
 *                  attributes are read individually (order-independent),
 *                  deduped by episode id and sorted by number.
 *   4. Stream    : JSON API /api/episode/info?id=<code>&alt=0.
 *
 * Domain rotation: DOMAIN is a module setting (editable in-app); the script
 * carries the official mirror list and fails over automatically.
 *
 * NOTE ABOUT SETTINGS: Sora rewrites the consts between the sentinel comments
 * below when the user edits module settings in-app.
 */

// Settings start
const DOMAIN = "animeworld.ac";     // AnimeWorld domain (update here when it rotates)
const PREFERRED_LANGUAGE = "both";  // Search filter: both | sub | dub
// Settings end

var /* mirror pool; kept in sync with animeworlditalia.com */ FALLBACK_DOMAINS = [
    "www.animeworld.ac",
    "www.animeworld.so",
    "www.animeworld.tv"
];

var USER_AGENT =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

var NEEDLE = "AnimeWorld"; // marker used to recognise a working mirror
var lastGrabberError = null; // last /api/episode/info failure, for better error text
var lastSearchError = null; // last search failure across the domain pool

/* Diagnostics: last failure, shown in AnymeX as a placeholder episode
 * (see episodesOrDiagnostic) since modules have no console there. */
var DIAG = "";
function diagNote(stage, message) {
    DIAG = "AnimeWorld diag — " + stage + ": " + message;
    safeLog(DIAG);
}

var resolvedDomain = null; // cached for the lifetime of one script load

/* ================================================================== */
/* Mini HTML scanner (tokenizer based — no page-level regexes)         */
/* ================================================================== */

/**
 * Parse attributes from the inside of an open tag, e.g.
 * 'a href="/play/x" data-id="9" class="name"'. Quote-aware and
 * order-independent. Returns a lowercase-key map.
 */
function parseAttrs(tagContent) {
    var attrs = {};
    var s = String(tagContent);
    var i = 0;
    var n = s.length;

    while (i < n) {
        while (i < n && /\s/.test(s[i])) i++;
        var nameStart = i;
        while (i < n && s[i] !== "=" && s[i] !== ">" && !/\s/.test(s[i])) i++;
        var name = s.slice(nameStart, i).toLowerCase();
        if (!name) { i++; continue; }

        var value = "";
        if (s[i] === "=") {
            i++;
            while (i < n && /\s/.test(s[i])) i++;
            if (s[i] === '"' || s[i] === "'") {
                var quote = s[i];
                i++;
                var valueStart = i;
                while (i < n && s[i] !== quote) i++;
                value = s.slice(valueStart, i);
                i++;
            } else {
                var bareStart = i;
                while (i < n && !/\s/.test(s[i]) && s[i] !== ">") i++;
                value = s.slice(bareStart, i);
            }
        }
        if (attrs[name] === undefined) attrs[name] = value;
    }
    return attrs;
}

/** Find the true end ">" of a tag, skipping ">" inside quoted attribute values. */
function findTagEnd(lower, open) {
    var i = open;
    while (i < lower.length) {
        var ch = lower[i];
        if (ch === '"' || ch === "'") {
            var quote = ch;
            i++;
            while (i < lower.length && lower[i] !== quote) i++;
        } else if (ch === ">") {
            return i;
        }
        i++;
    }
    return -1;
}

/** Is the character right after '<'+tagName a boundary (not another tag name)? */
function isBoundary(lower, after) {
    if (after >= lower.length) return true;
    var ch = lower[after];
    return !/[a-z0-9]/.test(ch);
}

/**
 * Scan every open tag of `tagName` and return one record per tag:
 *   { attrs, inner, innerStart, end, selfClosing }
 * Containers get depth-counted matching; void/self-closing tags (img, br,
 * hr, meta, link, input, source) return inner as "".
 */
var VOID_TAGS = { img: 1, br: 1, hr: 1, meta: 1, link: 1, input: 1, source: 1, area: 1, base: 1, col: 1, embed: 1, track: 1 };

function findTags(html, tagName) {
    var tags = [];
    var lower = html.toLowerCase();
    var searchFrom = 0;

    while (searchFrom < html.length) {
        var open = lower.indexOf("<" + tagName, searchFrom);
        if (open === -1) break;

        var afterName = open + tagName.length + 1;
        if (!isBoundary(lower, afterName)) { searchFrom = open + 1; continue; }

        var tagEnd = findTagEnd(lower, open);
        if (tagEnd === -1) break;

        var attrsStr = html.slice(afterName, tagEnd).replace(/\/$/, "").trim();
        var attrs = parseAttrs(attrsStr);

        if (VOID_TAGS[tagName] || attrsStr.charAt(attrsStr.length - 1) === "/") {
            tags.push({ attrs: attrs, inner: "", innerStart: tagEnd + 1, innerEnd: tagEnd + 1, end: tagEnd + 1 });
            searchFrom = tagEnd + 1;
            continue;
        }

        // Depth-counted matching for container tags.
        var depth = 1;
        var p = tagEnd + 1;
        var closeIdx = -1;

        while (p < html.length) {
            var nextOpen = lower.indexOf("<" + tagName, p);
            var nextClose = lower.indexOf("</" + tagName, p);

            if (nextClose === -1) break; // unclosed tag — treat current tag as ended here

            if (nextOpen !== -1 && nextOpen < nextClose && isBoundary(lower, nextOpen + tagName.length + 1)) {
                depth++;
                p = nextOpen + tagName.length;
            } else if (nextOpen !== -1 && nextOpen < nextClose) {
                // "<"+tagName appeared but with a longer name (e.g. <a vs <abbr) — skip it
                p = nextOpen + tagName.length;
            } else {
                depth--;
                p = nextClose + tagName.length + 3;
                if (depth === 0) {
                    closeIdx = nextClose;
                    break;
                }
            }
        }

        if (closeIdx !== -1) {
            var innerStart = tagEnd + 1;
            var end = lower.indexOf(">", closeIdx);
            tags.push({
                attrs: attrs,
                inner: html.slice(innerStart, closeIdx),
                innerStart: innerStart,
                innerEnd: closeIdx,
                end: end === -1 ? html.length : end + 1
            });
            searchFrom = tags[tags.length - 1].end; // continue past this tag's closing tag
        } else {
            // Unclosed container: give it the rest of the document.
            tags.push({ attrs: attrs, inner: html.slice(tagEnd + 1), innerStart: tagEnd + 1, innerEnd: html.length, end: html.length });
            break;
        }
    }
    return tags;
}

// advance handled inline in findTags (searchFrom = tag.end)

/* === text helpers ================================================= */

function decodeEntities(s) {
    var named = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
        ndash: "-", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
        ldquo: "“", rdquo: "”",
        egrave: "è", eacute: "é", agrave: "à", igrave: "ì", ograve: "ò", ugrave: "ù"
    };
    return s
        .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
        .replace(/&#0*(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); })
        .replace(/&([a-zA-Z]+);/g, function (m, name) {
            var lower = name.toLowerCase();
            return named[lower] !== undefined ? named[lower] : m;
        });
}

function stripTags(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
        .replace(/<[^>]+>/g, " ");
}

function innerText(html) {
    return decodeEntities(stripTags(String(html))).replace(/\s+/g, " ").trim();
}

function classList(attrs) {
    var cls = attrs["class"] || "";
    return cls.toLowerCase().split(/\s+/);
}

function hasClass(tags, wanted) {
    for (var i = 0; i < tags.length; i++) {
        var list = classList(tags[i].attrs);
        if (list.indexOf(wanted.toLowerCase()) !== -1) return true;
    }
    return false;
}

function findByClass(tags, wanted) {
    for (var i = 0; i < tags.length; i++) {
        var list = classList(tags[i].attrs);
        if (list.indexOf(wanted.toLowerCase()) !== -1) return tags[i];
    }
    return null;
}

/* ================================================================== */
/* Domain resolution + HTTP                                            */
/* ================================================================== */

function cleanDomain(value) {
    return String(value || "")
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .trim()
        .toLowerCase();
}

function baseFor(domain) {
    return "https://" + domain;
}

function absoluteUrl(base, href) {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    var cleaned = String(base).replace(/\/+$/, "");
    return href.charAt(0) === "/" ? cleaned + href : cleaned + "/" + href;
}

/** Probe one domain: the home page must return AnimeWorld HTML. */
async function probeDomain(domain) {
    try {
        var res = await fetchv2(
            baseFor(domain) + "/search?keyword=test",
            { "User-Agent": USER_AGENT },
            "GET",
            null,
            true,
            "utf-8"
        );
        if (res && res.error) throw new Error(res.error);
        if (res && typeof res.status === "number" && res.status >= 400) {
            throw new Error("HTTP " + res.status);
        }
        var body = typeof res.text === "function" ? await res.text() : String(res);
        if (body.indexOf(NEEDLE) !== -1) return domain;
        throw new Error("unexpected page");
    } catch (e) {
        try {
            // Legacy helper — may be a raw string (Sora) or Response-shaped (AnymeX).
            var html = await soraFetch(baseFor(domain) + "/", { "User-Agent": USER_AGENT });
            if (html && String(html).indexOf(NEEDLE) !== -1) return domain;
        } catch (e2) {}
        return null;
    }
}

/**
 * Returns the base URL of a working AnimeWorld domain.
 * Only used as a last resort (stream fallback); search failover is inline.
 */
async function resolveBase() {
    if (resolvedDomain) return baseFor(resolvedDomain);

    var candidates = [cleanDomain(DOMAIN)];
    for (var i = 0; i < FALLBACK_DOMAINS.length; i++) {
        var d = cleanDomain(FALLBACK_DOMAINS[i]);
        if (candidates.indexOf(d) === -1) candidates.push(d);
    }

    for (var j = 0; j < candidates.length; j++) {
        var ok = await probeDomain(candidates[j]);
        if (ok) {
            resolvedDomain = ok;
        safeLog("AnimeWorld: using https://" + ok);
            return baseFor(ok);
        }
        safeLog("AnimeWorld: https://" + candidates[j] + " did not respond");
    }

    throw new Error(
        "no AnimeWorld domain answered, update the DOMAIN setting in module options"
    );
}

/* Last request outcome, reported by the AnymeX diagnostics below. */
var lastFetch = "";

async function soraFetch(url, options) {
    options = options || {};
    var headers = options.headers || { "User-Agent": USER_AGENT };
    var started = Date.now();

    try {
        var res = await fetchv2(
            url,
            headers,
            options.method || "GET",
            options.body || null,
            true,
            "utf-8"
        );
        if (res && res.error) throw new Error(res.error);
        if (res && typeof res.text === "function") {
            var body = await res.text();
            lastFetch = "HTTP " + res.status + ", " + String(body).length + " chars, " + (Date.now() - started) + " ms";
            if (res.status && res.status >= 400) throw new Error("HTTP " + res.status);
            return body;
        }
        lastFetch = "raw " + String(res).length + " chars";
        return String(res);
    } catch (e) {
        lastFetch = "fetchv2 error: " + e + " (" + (Date.now() - started) + " ms)";
        safeLog("fetchv2 failed (" + e + "), falling back for " + url);
        var legacy = await fetch(url, headers);
        // Some hosts (AnymeX) alias legacy fetch to a Response-shaped object.
        if (legacy && typeof legacy === "object" && typeof legacy.text === "function") {
            var legacyBody = await legacy.text();
            lastFetch += "; retry HTTP " + legacy.status + ", " + String(legacyBody).length + " chars";
            return legacyBody;
        }
        return legacy; // raw string on iOS JavaScriptCore
    }
}

/**
 * AnymeX defines a global `fjs` bridge object; Sora does not. Used to show
 * failure reasons on screen in AnymeX only, where there is no module console.
 */
function isAnymex() {
    return typeof fjs !== "undefined";
}

/** In AnymeX, an empty episode list is an endless spinner — show why instead. */
function episodesOrDiagnostic(episodes, url, message) {
    if (episodes.length || !isAnymex()) return JSON.stringify(episodes);
    var text = message || (DIAG || "no episodes") + " | last request: " + (lastFetch || "none");
    return JSON.stringify([{ href: url, number: 1, title: "⚠ " + text }]);
}

/**
 * When AnymeX can't match a title it falls back to a blank entry with id "0"
 * and still asks for its episodes/details.
 */
function isPageUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
}

var NO_MATCH_MESSAGE =
    "AnymeX found no AnimeWorld match for this title. Tap \"Wrong Title?\" and search it yourself (without apostrophes).";

/**
 * Safe logging: QuickJS engines (AnymeX) don't ship a console global,
 * which used to throw ReferenceErrors straight through the module body.
 */
function safeLog(message) {
    try {
        if (typeof console !== "undefined" && console.log) console.log(message);
    } catch (e) {
        // cannot even log — silently drop
    }
}

/** Episode code used with /api/episode/info, e.g. yRMlD */
function episodeCode(url) {
    var path = String(url || "").split("?")[0].split("#")[0];
    var segments = path.split("/").filter(function (s) { return s.length > 0; });
    return segments[segments.length - 1] || "";
}

/* ================================================================== */
/* 1. searchResults(keyword)                                           */
/* ================================================================== */

/** Public entry point — Sora calls this; never throws, returns [] on failure. */
async function searchResults(keyword) {
    try {
        var queries = searchQueries(keyword);
        var json = "[]";
        for (var i = 0; i < queries.length; i++) {
            json = await searchDomains(queries[i]);
            if (JSON.parse(json).length) return json;
        }
        return json;
    } catch (e) {
        diagNote("searchResults failed", String(e));
        return JSON.stringify([]);
    }
}

/**
 * The keyword, then looser variants tried only when it finds nothing.
 * AnymeX can't pass apostrophes to modules, so "L'attacco dei Giganti"
 * reaches us as "lattacco dei giganti", which AnimeWorld doesn't match:
 *   1. strip a merged Italian elision from the first word: "lattacco" -> "attacco"
 *   2. drop the first word (3+ words only): "dei giganti"
 */
function searchQueries(keyword) {
    var original = String(keyword || "").replace(/\s+/g, " ").trim();
    var words = original.split(" ");
    var elision = /^(?:dell|dall|nell|sull|quest|all|un|l|d)['’]?(?=[aeiouhàèéìòù])/i;

    var first = words[0].replace(elision, "");
    var unelided = [first.length >= 3 ? first : words[0]].concat(words.slice(1)).join(" ");

    var queries = [original];
    if (unelided !== original) queries.push(unelided);
    if (words.length >= 3) queries.push(words.slice(1).join(" "));
    return queries;
}

async function searchDomains(keyword) {
    var candidates = [cleanDomain(DOMAIN)];
    for (var i = 0; i < FALLBACK_DOMAINS.length; i++) {
        var mirror = cleanDomain(FALLBACK_DOMAINS[i]);
        if (candidates.indexOf(mirror) === -1) candidates.push(mirror);
    }

    for (var j = 0; j < candidates.length; j++) {
        try {
            var base = baseFor(candidates[j]);
            var html = await fetchSearchHtml(base, keyword);

            // Marker check: real AnimeWorld result pages have this section,
            // even when it is empty. Anything else (parked page, block page,
            // dead mirror) falls through to the next candidate domain.
            if (html.indexOf('class="film-list"') === -1) {
                safeLog("AnimeWorld: https://" + candidates[j] + " does not look like a search page");
                continue;
            }

            resolvedDomain = candidates[j];
            var parsed = parseSearchResults(html, base);
            var results = isAnymex()
                ? adaptResultsForAnymex(parsed, keyword)
                : parsed.map(function (r) { return { title: r.title, image: r.image, href: r.href }; });

            safeLog("AnimeWorld: " + results.length + ' results for "' + keyword + '" via https://' + candidates[j]);
            return JSON.stringify(results);
        } catch (e) {
            lastSearchError = e;
            safeLog("AnimeWorld: https://" + candidates[j] + " failed (" + e + ")");
        }
    }

    throw lastSearchError || new Error("no AnimeWorld domain answered; update the DOMAIN setting in module options");
}

/**
 * Search page source.
 * - dub : /filter?keyword=…&language=it  (site-side DUB filter works)
 * - sub : /search?keyword=… (server filter unreliable → filtered client-side)
 * - both: /search?keyword=…
 */
async function fetchSearchHtml(base, keyword) {
    var query = encodeURIComponent(keyword);
    var path = "/search?keyword=" + query;
    if (PREFERRED_LANGUAGE === "dub") {
        path = "/filter?keyword=" + query + "&language=it";
    }
    return await soraFetch(base + path);
}

/**
 * Parse either result markup shape with the scanner:
 *   shape A (page grid)   : a.poster > img, a.name, optional div.dub marker
 *   shape B (/api/search) : a > img.thumb, div.info > a.name
 * Returns [{ title, image, href }], deduped and language-filtered.
 */
function parseSearchResults(html, base) {
    // Slice out just the results grid so sidebar widgets never leak in.
    var start = html.indexOf('class="film-list"');
    if (start === -1) return [];
    var stop = html.indexOf('id="sidebar"', start);
    var section = html.slice(start, stop > -1 ? stop : html.length);

    var itemDivs = [];
    var allDivs = findTags(section, "div");
    for (var i = 0; i < allDivs.length; i++) {
        var list = classList(allDivs[i].attrs);
        if (list.indexOf("item") !== -1) itemDivs.push(allDivs[i]);
    }

    var results = [];
    var seen = {};

    for (var k = 0; k < itemDivs.length; k++) {
        var blockInner = itemDivs[k].inner;
        var anchors = findTags(blockInner, "a");

        var poster = findByClass(anchors, "poster");
        var name = findByClass(anchors, "name");

        var href = "";
        if (poster && poster.attrs.href) href = poster.attrs.href;
        if (!href && name && name.attrs.href) href = name.attrs.href;
        if (!href) {
            // shape B: the first anchor whose href points at a play page
            for (var a = 0; a < anchors.length; a++) {
                var candidateHref = anchors[a].attrs.href || "";
                if (candidateHref.indexOf("play/") !== -1) { href = candidateHref; break; }
            }
        }
        if (!href) continue;

        href = absoluteUrl(base, href);
        if (seen[href]) continue;

        // image — poster or thumb
        var images = findTags(poster ? poster.inner : blockInner, "img");
        var image = images.length ? images[0].attrs.src || "" : "";

        // title — name anchor text always; falls back to img alt
        var title = name ? innerText(name.inner) : "";
        if (!title && images.length) title = images[0].attrs.alt || "";

        if (!title) continue;

        // DUB entries: explicit marker in shape A, "(ITA)" title convention in shape B
        var markerDivs = findTags(blockInner, "div");
        var hasDubMarker = hasClass(markerDivs, "dub");
        var isDub = hasDubMarker || title.toLowerCase().indexOf("(ita)") !== -1 || title.toLowerCase().indexOf("(dub)") !== -1;

        if (!languageAllows(isDub, title)) continue;

        // Original/alternate name (romaji or English) — used for AnymeX matching.
        var altTitle = name ? decodeEntities(name.attrs["data-jtitle"] || "").trim() : "";

        seen[href] = true;
        results.push({ title: title, image: image, href: href, altTitle: altTitle });
    }

    return results;
}

/** Lowercase words without punctuation or "(TV)", for comparing names. */
function nameWords(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/\(tv\)/g, " ")
        .replace(/[^a-z0-9àèéìòù]+/g, " ")
        .trim();
}

/** Share of words two names have in common (0..1). */
function nameSimilarity(a, b) {
    var wa = nameWords(a).split(" ");
    var wb = nameWords(b).split(" ");
    var common = 0;
    for (var i = 0; i < wa.length; i++) if (wa[i] && wb.indexOf(wa[i]) !== -1) common++;
    var total = wa.length + wb.length - common;
    return total ? common / total : 0;
}

/**
 * AnymeX matches a source to an AniList entry by comparing its English and
 * romaji titles with ours, and takes the first result scoring 0.98 or more.
 * AnimeWorld titles are often Italian ("L'attacco dei Giganti"), so:
 *   - show whichever of the Italian title / alternate name is closer to the
 *     query (the query is the AniList title being matched);
 *   - move exact name matches to the top, so a sequel or movie with a
 *     near-identical name isn't picked before the right entry.
 */
function adaptResultsForAnymex(results, keyword) {
    var wanted = nameWords(keyword);
    var exact = [];
    var rest = [];
    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var alt = r.altTitle ? r.altTitle.replace(/\s*\(TV\)/i, "") : "";
        var title = alt && nameSimilarity(alt, keyword) > nameSimilarity(r.title, keyword) ? alt : r.title;
        var item = { title: title, image: r.image, href: r.href };
        var isExact = nameWords(r.title) === wanted || (alt && nameWords(alt) === wanted);
        (isExact ? exact : rest).push(item);
    }
    return exact.concat(rest);
}

/** Site-side filter is guarded by a client check with the same rules. */
function languageAllows(isDub, title) {
    if (PREFERRED_LANGUAGE === "dub") return isDub;
    if (PREFERRED_LANGUAGE === "sub") return !isDub;
    return true;
}

/* ================================================================== */
/* 2. extractDetails(url)                                              */
/* ================================================================== */

async function extractDetails(url) {
    if (!isPageUrl(url)) return JSON.stringify([]);
    try {
        var html = await soraFetch(url);
        safeLog("AnimeWorld: details page fetched, " + html.length + " chars");

        var ldJson = collectJsonLd(html);

        // description: .desc block first, JSON-LD partOfSeries.description second
        var description = "";
        var divs = findTags(html, "div");
        for (var i = 0; i < divs.length; i++) {
            var list = classList(divs[i].attrs);
            if (list.indexOf("desc") !== -1) {
                description = innerText(divs[i].inner);
                break;
            }
        }
        if (!description) {
            description = seriesFieldFromJsonLd(ldJson, "description") || "";
            description = description.replace(/^Trama di .*?:\s*/i, "");
            if (!description) description = plainFieldFromJsonLd(ldJson, "description") || "";
        }
        // The site double-encodes some entities ("&amp;#x27;"), so decode again.
        description = decodeEntities(description).replace(/[  ]+/g, " ").trim();
        if (description.length > 900) {
            description = description.slice(0, 900).replace(/\s+\S*$/, "") + "…";
        }

        // aliases: h1#anime-title (display title + data-jtitle), plus JSON-LD names
        var aliasesArr = [];
        var h1s = findTags(html, "h1");
        var displayTitle = "";
        for (var h = 0; h < h1s.length; h++) {
            if (h1s[h].attrs.id === "anime-title") {
                displayTitle = innerText(h1s[h].inner);
                var jtitle = h1s[h].attrs["data-jtitle"] || "";
                if (jtitle) aliasesArr.push(innerText(jtitle));
                if (displayTitle && displayTitle !== jtitle) aliasesArr.push(displayTitle);
                break;
            }
        }
        if (aliasesArr.length === 0) {
            var jldName = seriesFieldFromJsonLd(ldJson, "alternateName") || seriesFieldFromJsonLd(ldJson, "name");
            if (jldName) aliasesArr.push(jldName);
        }

        // airdate: <dt>Data di Uscita:</dt> followed by <dd>…</dd>
        var airdate = "";
        var dts = findTags(html, "dt");
        for (var d = 0; d < dts.length; d++) {
            if (innerText(dts[d].inner).indexOf("Data di Uscita") !== -1) {
                var dds = findTags(html.slice(dts[d].end), "dd");
                if (dds.length && dds[0].innerStart < 400) {
                    airdate = innerText(dds[0].inner);
                }
                break;
            }
        }

        if (!description && aliasesArr.length === 0 && !airdate) {
            safeLog("AnimeWorld: no details parsed from " + url);
        }

        var meta = readMetaList(html);
        description = description || "No description available.";

        // AnymeX ignores status/episodes/airdate from Sora modules and shows
        // "??" instead, so put them at the top of the synopsis there.
        if (isAnymex()) {
            var facts = [];
            var wanted = ["Stato", "Episodi", "Durata", "Data di Uscita", "Studio", "Voto"];
            for (var w = 0; w < wanted.length; w++) {
                if (meta.fields[wanted[w]]) facts.push(wanted[w] + ": " + meta.fields[wanted[w]]);
            }
            if (facts.length) description = facts.join(" · ") + "\n\n" + description;
        }

        return JSON.stringify([
            {
                description: description,
                aliases: aliasesArr.length ? aliasesArr.join(" · ") : "N/A",
                airdate: airdate || "Unknown",
                genre: meta.genres
            }
        ]);
    } catch (e) {
        diagNote("extractDetails failed", String(e));
        return JSON.stringify([]);
    }
}

/**
 * The info lists (<dl class="meta">): "Data di Uscita", "Studio", "Genere",
 * "Voto", "Durata", "Episodi", "Stato"... dt/dd pairs, matched in order.
 * Returns { fields: { label: text }, genres: [..] }.
 */
function readMetaList(html) {
    var fields = {};
    var genres = [];
    var dls = findTags(html, "dl");
    for (var i = 0; i < dls.length; i++) {
        if (classList(dls[i].attrs).indexOf("meta") === -1) continue;
        var dts = findTags(dls[i].inner, "dt");
        var dds = findTags(dls[i].inner, "dd");
        for (var j = 0; j < dts.length && j < dds.length; j++) {
            var label = innerText(dts[j].inner).replace(/:\s*$/, "");
            var value = innerText(dds[j].inner).replace(/\s+\/\s+/g, "/");
            if (label && value && fields[label] === undefined) fields[label] = value;
            if (label === "Genere") {
                var links = findTags(dds[j].inner, "a");
                for (var k = 0; k < links.length; k++) {
                    var g = innerText(links[k].inner);
                    if (g) genres.push(g);
                }
            }
        }
    }
    return { fields: fields, genres: genres };
}

/** Every <script type="application/ld+json"> that parses cleanly. */
function collectJsonLd(html) {
    var blocks = [];
    var scripts = findTags(html, "script");
    for (var i = 0; i < scripts.length; i++) {
        var type = (scripts[i].attrs.type || "").replace(/\s+/g, "").toLowerCase();
        if (type !== "application/ld+json") continue;
        try {
            var parsed = JSON.parse(scripts[i].inner.trim());
            var entries = Array.isArray(parsed) ? parsed : [parsed];
            for (var j = 0; j < entries.length; j++) blocks.push(entries[j]);
        } catch (e) {
            safeLog("ld+json block " + i + " skipped (invalid JSON)");
        }
    }
    return blocks;
}

function seriesFieldFromJsonLd(blocks, field) {
    for (var i = 0; i < blocks.length; i++) {
        var series = blocks[i].partOfSeries;
        if (series && series[field]) return String(series[field]);
    }
    return "";
}

function plainFieldFromJsonLd(blocks, field) {
    for (var i = 0; i < blocks.length; i++) {
        if (blocks[i][field] !== undefined) return String(blocks[i][field]);
    }
    return "";
}

/* ================================================================== */
/* 3. extractEpisodes(url)                                             */
/* ================================================================== */

async function extractEpisodes(url) {
    if (!isPageUrl(url)) return episodesOrDiagnostic([], String(url), NO_MATCH_MESSAGE);
    try {
        var html = await soraFetch(url);

        var lis = findTags(html, "li");
        var episodes = [];
        var seenIds = {};

        for (var i = 0; i < lis.length; i++) {
            var list = classList(lis[i].attrs);
            if (list.indexOf("episode") === -1) continue;

            var anchors = findTags(lis[i].inner, "a");
            if (!anchors.length) continue;
            var attrs = anchors[0].attrs;

            var id = attrs["data-id"] || "";
            var num = attrs["data-episode-num"] || attrs["data-num"] || "";
            var href = attrs.href || "";

            var number = parseInt(num, 10);
            if (isNaN(number)) {
                // legacy fallback: number written as the link text
                var text = innerText(anchors[0].inner);
                number = parseInt(text, 10);
            }
            if (isNaN(number)) continue;

            var dedupeKey = id || href || String(number);
            if (seenIds[dedupeKey]) continue;
            seenIds[dedupeKey] = true;

            if (href.charAt(0) === "/") {
                var origin = String(url).match(/^(https?:\/\/[^\/]+)/i);
                href = (origin ? origin[1] : "") + href;
            }

            episodes.push({ href: href, number: number });
        }

        // Episodes appear in range blocks; restore natural order.
        episodes.sort(function (a, b) { return a.number - b.number; });
        safeLog("AnimeWorld: " + episodes.length + " episodes from " + url);

        if (episodes.length === 0) {
            // Help on-device debugging: report what we actually received.
            diagNote(
                "episodes empty",
                "url=" + url +
                " html " + html.length + "B" +
                ", li=" + lis.length +
                ", hasEpisodeLi=" + (String(html).indexOf('class="episode"') !== -1) +
                ", hasFilmList=" + (String(html).indexOf("film-list") !== -1) +
                ", looksCloudflare=" + /Just a moment|Attention Required|cf-browser-verification/i.test(html) +
                ", page title=" + JSON.stringify(pageTitle(html))
            );
        }
        return episodesOrDiagnostic(episodes, url);
    } catch (e) {
        diagNote("extractEpisodes failed", String(e));
        return episodesOrDiagnostic([], url);
    }
}

function pageTitle(html) {
    var titles = findTags(String(html), "title");
    return titles.length ? innerText(titles[0].inner).slice(0, 80) : "";
}

/* ================================================================== */
/* 4. extractStreamUrl(url)                                            */
/* ================================================================== */

async function extractStreamUrl(url) {
    try {
        var code = episodeCode(url);
        if (!code) throw new Error("cannot derive episode id from " + url);

        var referer = String(url);
        var streamUrl = null;

        // 1) The host the episode page came from (most consistent with the ids).
        var originMatch = referer.match(/^(https?:\/\/[^\/]+)/i);
        if (originMatch) {
            streamUrl = await resolveGrabber(originMatch[1], code, referer);
            if (streamUrl) return buildStreamResult(streamUrl, referer);
        }

        // 2) Fallback: probe the domain pool (episode page may be stale after rotation).
        var base = await resolveBase();
        streamUrl = await resolveGrabber(base, code, referer);
        if (streamUrl) return buildStreamResult(streamUrl, referer);

        throw lastGrabberError || new Error("no grabber returned by AnimeWorld API");
    } catch (e) {
        safeLog("extractStreamUrl error: " + e);
        return null;
    }
}

async function resolveGrabber(base, code, referer) {
    var apiUrl = base + "/api/episode/info?id=" + encodeURIComponent(code) + "&alt=0";
    try {
        var json = JSON.parse(
            await soraFetch(apiUrl, { "User-Agent": USER_AGENT, "Referer": referer })
        );
        return toGrabberUrl(json && json.grabber) || null;
    } catch (e) {
        lastGrabberError = e;
        safeLog("resolveGrabber failed on " + base + ": " + e);
        return null;
    }
}

/**
 * Uses the `streams` array form on purpose: Sora accepts it, and it is the
 * only object form AnymeX reads correctly. AnymeX turns `{stream: {...}}`
 * into the literal text "{streamUrl: ..., headers: ...}" and then tries to
 * play that text as the URL.
 */
function buildStreamResult(streamUrl, referer) {
    safeLog("AnimeWorld: stream " + streamUrl.slice(0, 90));
    return JSON.stringify({
        streams: [
            {
                title: "AnimeWorld",
                streamUrl: streamUrl,
                headers: { "User-Agent": USER_AGENT, "Referer": referer }
            }
        ]
    });
}

function toGrabberUrl(grabber) {
    if (typeof grabber === "string" && /^https?:\/\//i.test(grabber)) return grabber;
    if (grabber && typeof grabber === "object") {
        return grabber.url || grabber.streamUrl || grabber.file || grabber.src || "";
    }
    return "";
}
