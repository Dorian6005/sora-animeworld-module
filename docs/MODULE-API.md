# Sora module API

This is the contract a module must satisfy, derived from the current Swift
sources (`SoraCore` and the Sora app, `dev` branch). Sora evaluates your script
in a fresh `JavaScriptCore` context per load, then calls global functions by
name.

---

## 1. Manifest

The manifest is a JSON file fetched at install time and re-fetched on
**Refresh**. Required fields are non-optional in the Swift `Codable` model — a
missing one makes the whole module fail to decode.

| Field | Type | Notes |
|---|---|---|
| `sourceName` | string | Display name. |
| `iconUrl` | string | Module icon. |
| `author` | object | `{ "name": string, "icon": string }` (optional `url` is ignored). |
| `version` | string | Used to detect updates. Bump it. |
| `language` | string | Free text, e.g. `English (SUB)`. |
| `baseUrl` | string | Informational, shown in the UI. |
| `searchBaseUrl` | string | Must contain `%s`. Used only in HTML modes. Can be a dummy URL in `asyncJS` mode, but cannot be empty. |
| `scriptUrl` | string | Raw URL to the JS. Must be the raw file, not a GitHub HTML page. |
| `streamType` | string | `HLS` or `MP4`. |
| `quality` | string | Display only, e.g. `1080p`, `Various`. |
| `type` | string | `anime`, `movies`, `shows`, `novels`, … used by catalogs. |
| `downloadSupport` | bool | Optional; catalog metadata. |
| `asyncJS` | bool | Keyword/URL mode. |
| `streamAsyncJS` | bool | HTML mode, but only `extractStreamUrl` is async. |
| `softsub` | bool | Enables subtitle handling UI. |
| `multiStream` | bool | Site offers several sources per episode. |
| `multiSubs` | bool | Several subtitle tracks. |
| `novel` | bool | Treat entries as books and use `extractChapters`/`extractText`. |

The manifest can also contain extra keys (`description`, `combo`,
`supportsSora`, …); the app ignores unknown keys.

Before `scriptUrl` is downloaded, the app checks it exists. Sora then writes the
JS into its Documents directory and stores `localPath` + `metadataUrl` in
`modules.json`. On refresh, a changed `version` triggers a re-download.

---

## 2. Runtime globals

### `console.log(message)` / `console.error(message)`

Both go to Sora's in-app Logger. Logs are your only debugging channel on device
(**Settings → Logs**, filter `Debug` / `Error` / `HTMLStrings`).

### `fetch(url, headers)`

Legacy helper. Resolves the **raw response body as a string**; rejects on
network error. It does not give you a status code.

```js
const html = await fetch("https://site/page", { "User-Agent": "..." });
```

### `fetchv2(url, headers, method, body, redirect, encoding)`

Preferred helper. Resolves a response-like object:

```js
const res = await fetchv2(url, { "Accept": "application/json" }, "GET", null, true, "utf-8");
res.status;                 // number
res.headers;                // { [name]: value }
await res.text();           // string
await res.json();           // parsed JSON
```

- `method` defaults to `GET`; a `GET` with a body resolves `{ error }`.
- `body` is a string; objects are `JSON.stringify`-ed for non-GET methods.
- `redirect` is a bool (default `true`).
- `encoding`: `utf-8`, `windows-1251`, `windows-1252`, `iso-8859-1`, `ascii`,
  `utf-16`.
- On network failure the native bridge may resolve `{ error: "..." }` rather
  than reject — always check `res.error`.
- Hard cap: **10 MB** per response.

### `networkFetch(url, options)`

Headless `WKWebView` (iOS/macOS only; absent on tvOS). Use it for sites that
need JavaScript, Cloudflare cookies, or request sniffing. It returns:

```js
{
  url, requests: [string], html, cookies, success, error,
  totalRequests, cutoffTriggered, cutoffUrl,
  htmlCaptured, cookiesCaptured, elementsClicked, waitResults
}
```

Options: `timeoutSeconds` (10), `headers` (`{}`), `cutoff` (`null`, finish as
soon as a request URL contains this string), `returnHTML` (`false`),
`returnCookies` (`true`), `clickSelectors` (`[]`), `waitForSelectors` (`[]`),
`maxWaitTime` (5), `htmlContent` (`null`).

Convenience wrappers: `networkFetchWithHTML`, `networkFetchWithCutoff`,
`networkFetchWithClicks`, `networkFetchWithWaitAndClick`,
`networkFetchFromHTML`.

`networkFetchSimple` is the lighter variant: it only records request URLs
(`{ url, requests, success, error }`) and has no HTML/cookie return.

### Base64

`btoa(string)` and `atob(string)`. They operate on UTF-8 text, not bytes.

### HTML helpers

```js
getElementsByTag(html, tag)      // array of inner HTML
getAttribute(html, tag, attr)    // first matching attribute or null
getInnerText(html)
extractBetween(str, start, end)
stripHtml(html)
normalizeWhitespace(str)
urlEncode(str) / urlDecode(str)
htmlEntityDecode(str)
transformResponse(response, fn)
```

They are convenience only — most modules use their own regexes.

### Not available

No DOM (`document`, `window`, `querySelector`), no `localStorage`, no
`require`/`import`, no npm packages, no timers beyond what JSC provides, no
persistent state. Each `loadScript` creates a new `JSContext`, so module globals
do not survive between loads.

---

## 3. Function contracts

### Mode A — `asyncJS: true`

```js
async function searchResults(keyword)        // -> JSON string
async function extractDetails(url)           // -> JSON string
async function extractEpisodes(url)          // -> JSON string
async function extractStreamUrl(url)         // -> JSON string or bare URL
```

### Mode B — `streamAsyncJS: true`

Search/details/episodes receive **HTML**, `extractStreamUrl` receives **HTML**
and returns a Promise:

```js
function searchResults(html)
function extractDetails(html)
function extractEpisodes(html)
async function extractStreamUrl(html)
```

### Mode C — normal (no flags)

All four receive HTML; `extractStreamUrl` must be synchronous and return a
string (returning a Promise is treated as an error):

```js
function searchResults(html)
function extractDetails(html)
function extractEpisodes(html)
function extractStreamUrl(html)
```

The app decides with:

```swift
if asyncJS { fetchStreamUrlJS(...) }
else if streamAsyncJS { fetchStreamUrlJSSecond(...) }
else { fetchStreamUrl(...) }
```

---

## 4. Return shapes

### `searchResults`

A JSON **array** of objects:

```json
[{ "title": "Title", "image": "https://.../poster.jpg", "href": "https://.../watch/1" }]
```

`href` must be absolute — the app uses it as the details URL and later as the
episode base. `image` may be empty.

> In HTML mode Sora fetches `searchBaseUrl.replace("%s", encodeURIComponent(keyword))`
> itself, then passes the body to your function.

### `extractDetails`

A JSON array; the app reads the **first** object:

```json
[{ "description": "...", "aliases": "...", "airdate": "..." }]
```

All three values must be strings. HTML in `description` is displayed raw in some
views, so strip tags.

### `extractEpisodes`

```json
[{ "href": "https://.../episode/1", "number": 1 }]
```

**Important type difference:**

- `asyncJS` mode parses `number` as a Swift `Int` → emit a JSON **number**.
- HTML modes parse it as a `String` → emit a JSON **string**.

Getting this wrong silently yields episode `0` or a skipped episode.

Async `extractEpisodes` is wrapped in a **15-second timeout**; if it misses the
deadline the app proceeds with an empty list.

### `extractStreamUrl`

Accepted forms (all may be returned as a JSON string):

```js
// bare URL
"https://cdn/video.m3u8"

// single stream
{"stream": "https://cdn/video.m3u8"}

// multiple streams
{"streams": ["https://a.m3u8", "https://b.m3u8"]}

// streams with headers / titles (preferred)
{"stream": {"streamUrl": "https://cdn/video.m3u8",
            "headers": {"Referer": "https://site/"},
            "title": "1080p"}}

{"streams": [
  {"streamUrl": "https://a.m3u8", "headers": {}, "title": "SUB"},
  {"streamUrl": "https://b.m3u8", "headers": {}, "title": "DUB"}
]}

// subtitles can accompany any of the above
{"stream": "https://cdn/video.m3u8",
 "subtitles": ["https://cdn/en.vtt"]}
```

For source objects the app reads `streamUrl` **or** `url`, plus optional
`headers` (string map), `title`, and `subtitle`. When both `streams` (array of
objects) and `stream` objects are present, the object forms win over the plain
string forms.

The URL must be directly playable by `AVPlayer` (MP4/M4V/MOV or HLS), or
downloadable by the download manager. `headers` is how you pass `Referer`,
`Origin`, `Cookie`, etc.

---

## 5. Per-module settings (optional)

Sora can render a settings screen for a module and rewrite constants in the JS.
Wrap declarations in sentinel comments:

```js
// Settings start
const BASE_URL = "https://site.com";      // Site base URL
const USE_DUB = false;                    // Prefer dubs
const TIMEOUT = 10;                       // Request timeout (seconds)
// Settings end
```

- Only `const NAME = value;` lines are recognised.
- The trailing `// ...` becomes the setting's label.
- The type is inferred from the literal: string, bool, int, float.
- The app stores overrides in `UserDefaults` and rewrites the matching `const`
  line in the local JS file.

This is the cleanest way to expose knobs that vary per deployment — domains,
preferred quality, language. The AnimeWorld module uses it for its `DOMAIN`
setting: Sora renders it on the module's settings page, and editing it rewrites
the const without touching the script logic.

---

## 6. Debugging checklist

1. `node test/run-module.mjs <dir> "<query>"` — contract, shapes, reachability.
2. On device: **Settings → Logs**, filter `HTMLStrings` to see exactly what the
   app fetched and `Error` for JS exceptions.
3. If search works but playback fails, check `number` type (async vs HTML mode)
   and whether the stream needs headers.
4. If the app shows nothing, check the manifest decode first: every required
   field must exist, and `scriptUrl` must return JS, not an HTML error page.
5. Cloudflare-protected sites usually need `networkFetch` in HTML mode, or a
   JSON endpoint that is not challenged.

---

## 7. Practical notes

- **One item, one episode** is fine (films, one-shots). Return `number: 1`.
- **Search pagination** is not part of the contract; fetch a single page.
- **Rate limits / large metadata**: cache inside a single call, not across calls.
- **`scriptUrl` and the manifest can live anywhere**; the module is copied
  locally, so the site's CORS policy is irrelevant.
- **No secrets**: the JS is downloaded and stored in plain text on the device.
- **GPL**: Sora is GPLv3; distributing a module is usually independent, but
  copied app code would inherit the license.
