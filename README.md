# Donny's Digital — Cloudflare Pages site

**Live at <https://donnys-digital.pages.dev/>, hosted on Cloudflare Pages.**

Six pages that used to live as embedded HTML inside Google Sites, moved onto a
static host so the data can be served from a real CDN.

### Hosting history — read this before trusting any config file

The site was originally built for **Netlify** and later moved to **Cloudflare
Pages**. Both hosts read the same `_headers` and `_redirects` files, which is
why the move was cheap, but a few things did not carry over:

| | Netlify (old) | Cloudflare Pages (now) |
|---|---|---|
| Headers / redirects | `netlify.toml` | `_headers`, `_redirects` |
| Build settings | `netlify.toml` `[build]` | Pages dashboard → *Settings → Builds* |
| Image proxy | `/.netlify/images` (Image CDN) | `functions/img.js` → `/img?url=…` |
| Rebuild without a push | build hook | deploy hook |

**`netlify.toml` is dead weight.** Cloudflare does not read it. It is kept only
as a record of what the headers used to say; `_headers` and `_redirects` are
the live copies and are the ones to edit. If the two ever disagree, `_headers`
wins, because it is the only one being served.

The image proxy is the one real functional difference: Cloudflare Pages
Functions have no image-processing step, so `functions/img.js` proxies posters
at their original size and format instead of re-encoding them to webp. The
`&w=` and `&fm=` parameters are still on the URLs and are simply ignored. See
**Posters** below.

## Why this move was worth making

A static host is not meaningfully faster than Google Sites' hosting. The
speedup comes from something Google Sites could not do: serve the *data* from a
cache. Measured against the live sheet before any of this:

| | |
|---|---|
| Movies CSV | 11.7 MB raw / **3.45 MB gzipped** |
| Cold load | **~9.3 s** |
| Cache header Google sends | `private, max-age=300` |

`private` bars every CDN from holding a copy, and the endpoint is regenerated
per request, so there is no useful ETag either. Nothing about that is
configurable at the Google end. Every visit more than five minutes apart paid
for the whole file again, and on a first visit the page could not request a
single cover until it had all arrived.

Two things replace it:

**Tiered snapshots** (Movies page). The sheet is re-encoded at deploy time into
a compact form and split so the grid can paint from the smallest possible
piece:

| Tier | Gzipped | When |
|---|---|---|
| `core` — grid + the cheap facets | **589 KB** | first paint |
| `facets` — Director, Actors | ~630 KB | before the sidebar builds |
| `desc` — Descriptions | ~1.33 MB | only when search or a detail view asks |

589 KB against 3.45 MB is **5.9× less** to get a grid on screen, and because the
filenames carry a content hash they are served `immutable` — a repeat visit
re-downloads nothing at all.

Three things do the shrinking: tiering (Description alone was 30% of the CSV,
Actors another 15%); collapsing `Img`/`Link` to a bare id (18% of the CSV, and
94% of rows collapse to an id plus a one-digit flag); and dictionary-encoding
the columns that repeat across 19k rows.

**CSV mirrors** (the other pages). Their sheets are mirrored byte-for-byte to
`/mirror/*.csv` — same bytes, same parser, but from a CDN with Brotli.

Mirrors are written at DEPLOY TIME, so no page may treat one as its source of
truth. Every page reads the live sheet and uses its mirror only to put
something on screen first, or as a fallback when the live sheet is
unreachable. MA Compare, Wishlist and Data initially had this backwards and
showed deploy-time data until the next deploy.

## The data stays live

The snapshot does not replace the sheet, it front-runs it. The Movies page
treats a decoded snapshot exactly as it treats its own IndexedDB cache: paint
from it, then run the existing revalidation probe against the real sheet and
catch up if anything moved. A stale snapshot costs a slower first paint, never
wrong data.

If the snapshot is missing or broken, every page falls back to the live sheet
and behaves exactly as it did before this existed.

### The probe only sees the columns it asks for

"Catch up if anything moved" is only true for the columns the probe downloads.
It fetches six — **Title, Genre, Quality, Viewing Status, Studio, Date Added** —
hashes them, and compares that against the same hash taken from what is already
on screen. Equal means the 11.1MB export is never requested at all.

So a column that is *not* in that list can be edited in the sheet and stay
invisible on the site indefinitely: the probe reports "unchanged", the download
never starts, and the cached copy goes on painting. This is exactly what
happened to Genre and Studio, which are edited on their own and so move nothing
else on the row — they were added to the probe for that reason.

**If you start editing a column that is not on that list and expect the site to
notice, it has to be added to the probe.** Three places, all in `index.html`,
and all three have to agree:

- `PROBE_COLS` / `PROBE_HEAD` — the gviz query and the header labels it is
  checked against (a mismatch forces a full download rather than serving
  something stale)
- `signature()` — the fingerprint taken from a parsed collection
- `probeSigFromRows()` / `probeSigFromMovies()` — the two sides of the probe
  comparison, which must normalise identically or every visit reads as changed
  and re-downloads everything

Each added column costs bandwidth on every visit: the original four were ~955KB,
Genre and Studio roughly doubled that to ~2.3MB (~400KB gzipped). Still far
under the 11.1MB it avoids, but it is not free — do not add a column to the
probe unless edits to it actually need to show up.

## Deploying

A push to the GitHub repo is the whole deploy. Cloudflare Pages watches the
repo and rebuilds.

The build settings live in the **Pages dashboard**, not in a file in this repo
(that is the part `netlify.toml` used to do):

| Setting | Value |
|---|---|
| Build command | `node scripts/build-data.mjs` |
| Build output directory | `/` |

If that build command is ever cleared, the site still deploys and still works —
it just ships with no `snapshots/`, no `mirror/` and no `data-manifest.json`, so
every page falls all the way back to the live sheet and first paint gets slow.
An empty or 404 `/data-manifest.json` on the live site is the symptom.

The build runs `node scripts/build-data.mjs`, which pulls the sheet and writes
`snapshots/`, `mirror/` and `data-manifest.json`. Those are gitignored on
purpose — they are rebuilt from the live sheet on every deploy, so committing
them would only ever ship stale data.

### Keeping the snapshot current

Every deploy rebuilds it. To refresh without pushing a commit, either:

- **Scheduled build** — Cloudflare dashboard → *Workers & Pages → the project →
  Settings → Builds → Deploy hooks*, then point a scheduler at the hook URL.
- **On demand** — create a deploy hook and have an Apps Script in the sheet
  `UrlFetchApp.fetch(hookUrl, {method:'post'})` when you finish editing.
  `scripts/sheet-rebuild-trigger.gs` is that script; the hook URL inside it is
  the one thing that has to be swapped when the host changes.

Neither is required. The pages catch up against the live sheet on their own —
but only for the columns the revalidation probe actually looks at, so see
**The data stays live** above before assuming a sheet edit will appear.

## If you change the sheet's columns

`scripts/build-data.mjs` has a `COLS` list that must match the Movies tab's
header row, in order — the decoder rebuilds each row against it. The build
fails loudly on a mismatch rather than shipping a snapshot with Studio data in
the Language facet. Add the new column to `COLS` in the right position, then
pick its tier (`TIER_FACETS`, `TIER_DESC`, or leave it in core) and whether it
should be dictionary-encoded (`MULTI` for comma-separated, `SINGLE` for whole
values).

## Sales and D2D

Both now seed their first paint the same way, and both still refresh against
the live sheet immediately afterwards.

**Sales** reads 46 separate tabs, one request each. The tabs are tiny, but each
pays Google's TTFB -- measured between 0.5s and 11.3s *per tab*. The build makes
all 46 requests once and stores the responses verbatim in a single bundle, so a
first visit paints from one request instead of forty-six. Sales data changes
daily, so the bundle is only ever a first paint: the live load runs behind it
and replaces it.

**D2D** is one tab. Its published CSV is 1.27MB (278KB gzipped) against 305KB
for the slim gviz query the page uses live -- but Google answered the gviz query
in 14.1s when measured, where the mirror comes off the CDN in well under a
second. So the mirror seeds the paint and the live query still runs behind it.

Both seeds are parsed by the pages' own parsers (`parseTabRows` /
`parseBundleRows` for Sales, `parseCsvData` / `parseGviz` for D2D), so there is
no second copy of those schemas to drift out of sync.

## Posters

Every page routes `<img>` through a same-origin proxy, set up by a small script
at the top of each `<head>`. On Netlify that was the Image CDN
(`/.netlify/images`); on Cloudflare Pages it is `functions/img.js`, served at
`/img?url=…`.

The reason is not primarily speed. Networks that filter on hostname -- a work
network, some ISPs -- block `images2.vudu.com`, and the fallback proxies the
pages walk through (`cdn.statically.io`, `i0.wp.com`, `wsrv.nl`) are separate
hostnames that get blocked just as easily. That is why the Movies and D2D grids
came up blank at work while MA Compare, which uses `moviesanywhere.com`, was
fine. Routed through the proxy the browser only ever connects to this site,
so a host-based filter has nothing to match. Confirmed working on the network
that was blocking Vudu.

**Resizing was lost in the move.** Netlify's Image CDN re-encoded a poster to
~10KB of webp instead of ~40KB of source jpeg. A plain Cloudflare Pages Function
has no image-processing step, so posters now arrive at original size and format.
Getting it back means either Cloudflare Images (a separate paid product) or
Image Resizing via `/cdn-cgi/image/...` URLs (needs the domain on a Pro-plan
zone). The `&w=300&fm=webp` on every proxied URL is currently ignored.

Note that the proxied URL still carries the original address in its query
string, so this defeats a filter matching on *hostname*, not one matching the
URL text. A same-origin `/p/*` redirect was tried first for the stricter case
and removed once the proxy was confirmed working -- worth remembering if a
different network ever behaves differently.

The host allowlist now lives in `functions/img.js`, ported from the
`[images] remote_images` list in `netlify.toml`. A host that is not on it is
refused, so add it there before pointing anything new at it. **Do not remove
that check** — without it the function is an open proxy anyone can point at
arbitrary URLs using the site's bandwidth.

The per-page proxy chains are untouched and still act as the error fallback.

## Layout

```
index.html          Movies      (was Dailysales.optimized.html)
wishlist.html       Wishlist
data.html           Data        (reads the same sheet as Movies)
sales.html          Sales       (was donnys-sales.html)
ma-compare.html     MA Compare
d2d.html            D2D
_headers            caching headers            <- LIVE (Cloudflare reads this)
_redirects          /movies -> index.html      <- LIVE
netlify.toml        old Netlify config         <- DEAD, kept for reference only
functions/
  img.js            same-origin poster proxy, served at /img
scripts/
  build-data.mjs    fetches the sheet, writes the snapshots and mirrors
  sheet-rebuild-trigger.gs  Apps Script that pokes the deploy hook
assets/             brand mark + favicons (the avatar)
snapshots/          generated: content-hashed, cached forever
mirror/             generated: stable names, revalidated
```

The nav bar at the top of each page used to come from Google Sites and is now
part of the pages themselves — inlined rather than pulled from a stylesheet so
it paints in the first frame. The brand mark to its left and the
favicons are the avatar, in `assets/`.
