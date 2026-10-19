/**
 * Sora module template — asyncJS mode.
 *
 * Copy this folder, then implement the four functions below.
 * Every function must return a JSON *string* (Sora parses it), except
 * extractStreamUrl, which may also return a bare URL.
 *
 * Mode cheat-sheet (see docs/MODULE-API.md):
 *
 *   asyncJS = true      searchResults(keyword)   extractDetails(url)
 *                       extractEpisodes(url)     extractStreamUrl(url)
 *
 *   streamAsyncJS true  searchResults(html)      extractDetails(html)
 *                       extractEpisodes(html)    extractStreamUrl(html)  [async]
 *
 *   normal (both false) searchResults(html)      extractDetails(html)
 *                       extractEpisodes(html)    extractStreamUrl(html)  [sync]
 */

var BASE_URL = "https://example.com";

/* ---------------------------------------------------------------- */
/* HTTP                                                              */
/* ---------------------------------------------------------------- */

/**
 * fetchv2 gives status codes and is the preferred helper.
 * Legacy fetch(url, headers) resolves the raw response body.
 */
async function soraFetch(url, options) {
    options = options || {};
    var headers = options.headers || {};

    try {
        var res = await fetchv2(url, headers, options.method || "GET", options.body || null);
        if (res && res.error) throw new Error(res.error);
        if (res && typeof res.text === "function") {
            var body = await res.text();
            if (res.status >= 400) throw new Error("HTTP " + res.status);
            return body;
        }
        return String(res);
    } catch (e) {
        return await fetch(url, headers);
    }
}

function absoluteUrl(href) {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    return BASE_URL + (href.charAt(0) === "/" ? "" : "/") + href;
}

/* ---------------------------------------------------------------- */
/* 1. Search                                                         */
/* ---------------------------------------------------------------- */

async function searchResults(keyword) {
    // asyncJS mode: keyword is the raw search term.
    // Other modes: keyword is the HTML of searchBaseUrl with %s replaced.

    var url = BASE_URL + "/search?q=" + encodeURIComponent(keyword);

    try {
        var html = await soraFetch(url);
        var results = [];

        // TODO: parse `html` and push { title, image, href } entries.
        // Regex scraping is the norm in Sora modules; there is no DOM.
        //
        // results.push({
        //     title: "Example",
        //     image: BASE_URL + "/cover.jpg",
        //     href: BASE_URL + "/watch/example"
        // });

        return JSON.stringify(results);
    } catch (e) {
        console.log("searchResults error: " + e);
        return JSON.stringify([]);
    }
}

/* ---------------------------------------------------------------- */
/* 2. Details                                                        */
/* ---------------------------------------------------------------- */

async function extractDetails(url) {
    try {
        var html = await soraFetch(url);

        return JSON.stringify([{
            description: "TODO: synopsis",
            aliases: "TODO: alternative titles",
            airdate: "TODO: year or air date"
        }]);
    } catch (e) {
        console.log("extractDetails error: " + e);
        return JSON.stringify([]);
    }
}

/* ---------------------------------------------------------------- */
/* 3. Episodes / chapters                                            */
/* ---------------------------------------------------------------- */

async function extractEpisodes(url) {
    try {
        var html = await soraFetch(url);
        var episodes = [];

        // asyncJS mode: number must be a JSON number.
        // normal mode:  number must be a string.
        //
        // episodes.push({
        //     href: absoluteUrl("/watch/example/episode-1"),
        //     number: 1
        // });

        return JSON.stringify(episodes);
    } catch (e) {
        console.log("extractEpisodes error: " + e);
        return JSON.stringify([]);
    }
}

/* ---------------------------------------------------------------- */
/* 4. Stream                                                         */
/* ---------------------------------------------------------------- */

async function extractStreamUrl(url) {
    try {
        var html = await soraFetch(url);

        // TODO: resolve the actual media URL.
        // Return a bare URL, or an object for a titled source:
        //
        // return JSON.stringify({
        //     stream: {
        //         streamUrl: "https://cdn.example.com/video.m3u8",
        //         headers: { "Referer": BASE_URL + "/" },
        //         title: "1080p"
        //     }
        // });

        return null;
    } catch (e) {
        console.log("extractStreamUrl error: " + e);
        return null;
    }
}
