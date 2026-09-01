# Donny's Digital — Netlify site

Six pages that used to live as embedded HTML inside Google Sites, moved onto
Netlify so the data can be served from a real CDN.

## Why this move was worth making

Netlify's hosting is not meaningfully faster than Google Sites' hosting. The
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

**CSV mirrors** (the other pages). Reshaping every loader was not worth it, so
their sheets are mirrored byte-for-byte to `/mirror/*.csv` — same bytes, same
parser, but from a CDN with Brotli and a real revalidate.

## The data stays live

The snapshot does not replace the sheet, it front-runs it. The Movies page
treats a decoded snapshot exactly as it treats its own IndexedDB cache: paint
from it, then run the existing revalidation probe against the real sheet and
catch up if anything moved. A stale snapshot costs a slower first paint, never
wrong data.

If the snapshot is missing or broken, every page falls back to the live sheet
and behaves exactly as it did before this existed.

## Deploying

1. Push this folder to a GitHub repo.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Netlify reads `netlify.toml`, so build command and publish directory are
   already set. Deploy.

The build runs `node scripts/build-data.mjs`, which pulls the sheet and writes
`snapshots/`, `mirror/` and `data-manifest.json`. Those are gitignored on
purpose — they are rebuilt from the live sheet on every deploy, so committing
them would only ever ship stale data.

### Keeping the snapshot current

Every deploy rebuilds it. To refresh without pushing a commit, either:

- **Scheduled build** — Netlify UI → *Site configuration → Build & deploy →
  Build hooks*, then point a scheduler at the hook URL.
- **On demand** — create a build hook and have an Apps Script in the sheet
  `UrlFetchApp.fetch(hookUrl, {method:'post'})` when you finish editing.

Neither is required. The pages catch up against the live sheet on their own.

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

## Layout

```
index.html          Movies      (was Dailysales.optimized.html)
wishlist.html       Wishlist
data.html           Data        (reads the same sheet as Movies)
sales.html          Sales       (was donnys-sales.html)
ma-compare.html     MA Compare
d2d.html            D2D
netlify.toml        caching headers + clean urls
scripts/
  build-data.mjs    fetches the sheet, writes the snapshots and mirrors
assets/             brand mark + favicons (the avatar)
snapshots/          generated: content-hashed, cached forever
mirror/             generated: stable names, revalidated
```

The nav bar at the top of each page used to come from Google Sites and is now
part of the pages themselves — inlined rather than pulled from a stylesheet so
it paints in the first frame. The brand mark to its left and the
favicons are the avatar, in `assets/`.
