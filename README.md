# Sora / Sulfur module development kit

Sora does not have native plugins or a plugin SDK. What it calls **modules** are
plain JavaScript files plus a small JSON manifest — the same thing this repo
builds.

This kit gives you:

```
sora-modules/
├─ modules/internet-archive/     working example (public-domain movies)
├─ modules/animeworld/          AnimeWorld (.ac) with rotating-domain support
├─ template/                    copy-me skeleton for a new module
├─ test/
│  ├─ sora-runtime.mjs          Node emulation of Sora's JSContext helpers
│  ├─ run-module.mjs            contract + smoke test for any module
│  └─ serve.mjs                 LAN server so a device can install a local module
└─ docs/MODULE-API.md           full API reference (from the Swift source)
```

## Why a module at all?

Sora ships with **zero** content modules. A module tells the app how to:

1. **search** a site,
2. **read details** for a result,
3. **list episodes/chapters**,
4. **resolve a playable stream URL**.

The app does the playback, downloads, subtitles, PiP, tracking, and UI.

## Quick start

```bash
cd sora-modules

# Internet Archive example
npm test

# AnimeWorld example (live site, real episode + stream check)
npm run test:animeworld

# Or point the harness at any module directory
node test/run-module.mjs modules/internet-archive "nosferatu"

# Serve the repo over your LAN for on-device installation
npm run serve
```

`npm test` validates the manifest, runs all four functions, checks the exact
return shapes Sora expects, and verifies the resolved stream with a `HEAD`
request.

## Install a module in Sora

A module is installed by URL — the manifest does **not** need to live on the
same host as the site being scraped.

1. Host the folder (GitHub raw, any static host, or `npm run serve` on your LAN).
2. In Sora: **Settings → Modules → +**.
3. Paste the URL of the **manifest** (`.../internet-archive.json`), not the JS.
4. Sora downloads the manifest, then downloads `scriptUrl` into its Documents
   directory, and keeps a local copy in `modules.json`.

For the demo you must replace `YOUR_GITHUB_USER` in
`modules/internet-archive/internet-archive.json` with where you actually host
the script — or use the LAN server:

```
http://<your-computer-LAN-IP>:8080/modules/internet-archive/internet-archive.json
```

Community catalogs use `sora://module?url=<manifest-url>` links; Sora intercepts
that scheme and opens the add-module sheet.

## The demo module

`modules/internet-archive/` searches archive.org's `feature_films` collection —
public-domain and openly licensed films — and resolves the best MP4 derivative.
It is intentionally boring and legal: it exists to show the whole contract
working end to end.

```text
searchResults("dracula")
  -> 24 results, poster + href
extractDetails(item)
  -> synopsis, creator/collection, year
extractEpisodes(item)
  -> one episode (an archive.org item is a single film)
extractStreamUrl(item)
  -> https://archive.org/download/<id>/<file>.mp4
```

Archive.org content is not uniformly public domain — the collection contains
uploads with varying rights. Check an item before redistributing it.

## AnimeWorld and rotating domains

`modules/animeworld/` scrapes animeworld.ac. AnimeWorld moves domains regularly,
so the module has these protections:

1. **`DOMAIN` is a module setting.** The script pins the const inside a
   `// Settings start … // Settings end` block, so the field shows up in
   Sora's module settings screen (Settings → Modules → ⚙ on the module) and you
   can change the domain there without touching the code. When AnimeWorld moves,
   you only update that one value.
2. **Automatic failover.** The script keeps a list of official mirrors (from the
   site's own "domini ufficiali" page). If the configured domain stops serving
   AnimeWorld pages, search walks the list, and stream resolution tries the
   episode's own host first, then the pool.

To refresh the mirror list, fetch
`https://www.animeworlditalia.com` and copy whatever `animeworld.*` domains
appear into `FALLBACK_DOMAINS` in `animeworld.js`.

3. **`PREFERRED_LANGUAGE` is a module setting** (`both` default, `sub`, or `dub`).
   It filters the search list to subbed or dubbed entries (the site's own
   `language=it` filter is used server-side where it works; SUB is filtered
   client-side because the site's `language=sub` filter is unreliable). Sora
   renders it as a text field on the module's settings page.

## AnymeX compatibility

The module also runs inside AnymeX (AnyMEX Sora extension), whose runtime
differs from Sora's iOS JavaScriptCore in two ways that broke it at 1.1.0:

1. **No `console` global** — AnymeX's QuickJS engine does not inject a console,
   so plain `console.log()` threw `ReferenceError` mid-function. All logging now
   goes through a guarded `safeLog()`.
2. **`fetch` is aliased to `fetchv2`** and returns a Response-shaped object
   instead of raw text. The legacy-fetch fallback now accepts both shapes
   (`test/anymex-sim.mjs` proves the pipeline under an AnymeX-like host:
   4-argument `fetchv2`, object `fetch`, no console).

`npm run test:anymex` runs that simulation end-to-end.

AnimeWorld's stream API returns direct MP4 links (`/api/episode/info?id=<code>&alt=0`)
picked up by AVPlayer. Playback was verified through the harness (HTTP 200,
`video/mp4`), not inside the app itself — run it on-device before trusting it
for a binge session.

## Modes

| Manifest flags | `searchResults` gets | `extractDetails` / `extractEpisodes` get | `extractStreamUrl` gets |
|---|---|---|---|
| `asyncJS: true` | keyword | URL | URL |
| `streamAsyncJS: true` | HTML | HTML | HTML, async |
| neither | HTML | HTML | HTML, sync |

Pick `asyncJS` for JSON APIs; pick the HTML modes when the site only renders
server-side. See `docs/MODULE-API.md` for the exact shapes and the traps (the
`number` field changes type between modes, for example).

## What you cannot do

Modules run in a bare JavaScriptCore context, not a browser and not Node:

- no DOM, `document`, `window`, or `fetch` with a `Response` object;
- no `require`, imports, npm packages, or persistent storage;
- no background execution — each module load creates a fresh `JSContext`;
- `fetchv2` responses are capped at 10 MB;
- async `extractEpisodes` has a 15-second timeout in the app.

Use `fetchv2`, `networkFetch`, and regex parsing instead.

## Legal

Sora's own README says it is not intended for piracy, and modules are the
responsibility of their authors. This kit's example targets a public-domain
archive. If you build against a service, make sure you have the right to access
it and that your use complies with its terms and with copyright law.
