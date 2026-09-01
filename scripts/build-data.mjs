/* Build the static data snapshots that the site paints from.
   ---------------------------------------------------------------------------
   WHY THIS EXISTS

   The pages used to fetch the published Google Sheets CSV on every visit.
   That endpoint has two properties we cannot change and cannot live with:

     * it answers with  Cache-Control: private, max-age=300
       "private" bars every CDN from holding a copy, and 300s means even the
       browser re-downloads within the same sitting. Measured cold: 11.7MB
       raw / 3.45MB gzipped / ~9.3s.
     * it is generated per request, so there is no ETag worth revalidating.

   So we pull the sheet ONCE at build time, re-encode it far smaller, and let
   Netlify serve it as an immutable, content-hashed, Brotli-compressed file.
   The browser then caches it for a year and a repeat visit costs 0 bytes.

   ENCODING

   Three things do the work, in order of how much they save:

     1. TIERING. The grid paints from title + poster id + the small columns.
        Actors (29k unique) and Director (7.5k unique) are only needed once a
        facet panel opens, and Description only for search and the detail
        view. Those ride in separate files fetched after first paint.
     2. ID COLLAPSE. `Img` and `Link` are a constant prefix plus the same
        numeric id, and together were 18% of the CSV. We store the bare id and
        rebuild both in the browser -- but only when the derivation provably
        round-trips; anything unusual is stored literally (see encodeImg /
        encodeLink).
     3. DICTIONARIES. Genre/Studio/Quality/Language/... repeat endlessly across
        19k rows. Each becomes an int index into a dictionary emitted once.
        Multi-value columns are split on "," and tokenised the same way, so
        "Action, Adventure" costs two ints rather than 18 bytes.

   The decoder in index.html rebuilds rows in the EXACT original CSV column
   order, so nothing downstream of the loader knows any of this happened.

   USAGE
     node scripts/build-data.mjs            # fetch live sheet, write data/
     node scripts/build-data.mjs local.csv  # build from a local CSV instead
*/

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'snapshots');   // content-hashed, cached forever
const MIRROR = join(ROOT, 'mirror');     // stable names, revalidated

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTNcy_TXkl7kRJvIvf4U_q9pZUCdrJ9RsQ8Vgnr5NoX8K679jUhWC6iWZvbCYR2bOaRG2ypgFB13PEB/pub?gid=0&single=true&output=csv';

/* Column layout of the Movies tab. The ORDER here is load-bearing: the decoder
   reassembles each row against this exact list. If you add a column to the
   sheet, add it here in the same position and pick a tier for it below. */
const COLS = [
  'Poster', 'Title', 'Sort Title', 'Director', 'Actors', 'Description',
  'Genre', 'Img', 'Link', 'MPAA Rating', 'Quality', 'Media Type',
  'Viewing Status', 'Studio', 'Where to Watch', 'Highest Quality', 'Awards',
  'Acquired by', 'Language', 'Year', 'Tomato Meter', 'IMDB Rating',
  'Runtime', 'Date Added',
];

/* Which tier each column rides in.
     core   -> needed to paint the grid and drive the cheap facets
     facets -> big dictionaries, wanted only when those panels open
     desc   -> search enrichment and the detail view */
const TIER_FACETS = ['Director', 'Actors'];
const TIER_DESC = ['Description'];

/* Split on "," and dictionary-encode each token. */
const MULTI = ['Genre', 'Where to Watch', 'Director', 'Actors'];
/* Whole value dictionary-encoded. */
const SINGLE = [
  'Studio', 'Language', 'Viewing Status', 'Quality', 'Highest Quality',
  'MPAA Rating', 'Media Type', 'Acquired by', 'Awards',
];

const IMG_PREFIX = 'https://images2.vudu.com/poster2/';
const IMG_SUFFIX = '-l';
const LINK_BROWSE = 'https://athome.fandango.com/content/browse/details/title/';
const LINK_MOVIES = 'https://athome.fandango.com/content/movies/details/title/';

/* ---------- CSV ---------------------------------------------------------- */
/* Google's export is RFC4180: "" escapes a quote inside a quoted field, and
   fields may contain newlines (descriptions do). A regex split would corrupt
   roughly 1 row in 12, so this walks the string once. */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------- url collapse -------------------------------------------------- */
/* `Img` and `Link` were 18% of the CSV and are overwhelmingly a constant
   prefix plus a numeric id. Measured over the real 18,977-row sheet:

     Img   18,481 standard Vudu poster urls  /  496 something else
     Link  14,876 /browse/  3,413 /movies/  /  688 something else
           17,765 of those (93.6%) reuse the Img id exactly

   So the common row stores an id and a one-digit flag, and the ~3% that do
   anything unusual store the literal string. Encoding, decided by JSON type
   so the two can never be confused:

     img   "123"        -> IMG_PREFIX + id + IMG_SUFFIX
           ["<url>"]    -> use verbatim

     link  0            -> BROWSE + the img's id      (the common case)
           1            -> MOVIES + the img's id
           "456"        -> BROWSE + this id
           [1,"456"]    -> MOVIES + this id
           ["<url>"]    -> use verbatim

   Nothing is collapsed on a guess: a url only loses its prefix when it
   provably rebuilds byte-for-byte, because a wrong guess here would quietly
   point a cover or a buy link at the wrong film. */
function encodeImg(img) {
  if (img.startsWith(IMG_PREFIX) && img.endsWith(IMG_SUFFIX)) {
    const id = img.slice(IMG_PREFIX.length, img.length - IMG_SUFFIX.length);
    if (id && !id.includes('/')) return id;
  }
  return [img];
}
function encodeLink(link, imgId) {
  for (const [flag, prefix] of [[0, LINK_BROWSE], [1, LINK_MOVIES]]) {
    if (!link.startsWith(prefix)) continue;
    const id = link.slice(prefix.length);
    if (!id || id.includes('/')) break;
    if (id === imgId) return flag;                 // reuse the poster's id
    return flag === 0 ? id : [1, id];
  }
  return [link];
}

/* ---------- dictionary builder ------------------------------------------- */
function makeDict() {
  const map = new Map();
  return {
    id(v) {
      let k = map.get(v);
      if (k === undefined) { k = map.size; map.set(v, k); }
      return k;
    },
    list() { return [...map.keys()]; },
    get size() { return map.size; },
  };
}

/* ---------- build -------------------------------------------------------- */
async function loadCsv() {
  const local = process.argv[2];
  if (local) {
    console.log(`[build] reading local CSV: ${local}`);
    return readFile(local, 'utf8');
  }
  console.log('[build] fetching published sheet…');
  const t0 = Date.now();
  const res = await fetch(CSV_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  console.log(`[build] fetched ${(text.length / 1048576).toFixed(1)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return text;
}

function hash(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 10);
}


/* ---------- sales bundle -------------------------------------------------- */
/* The Sales page reads 46 separate tabs, one gviz request each. The tabs are
   tiny -- most are a couple of KB -- but each request pays Google's TTFB, and
   measured that ranged from 0.5s to 11.3s per tab. Forty-six of those is the
   whole cost of that page.

   So the build makes all 46 requests once and stores the responses verbatim,
   keyed by gid, in a single file. The page seeds its first paint from that one
   request and then runs its normal live load exactly as before.

   Stored VERBATIM, as the parsed gviz envelope, deliberately: the page feeds
   them straight back through its own parseTabRows/parseBundleRows, so there is
   no second implementation of the per-tab schemas to drift out of sync.

   This is a first paint, never the source of truth. Sales change daily and the
   page always refreshes against the live sheet behind the seeded grid -- a
   stale bundle costs nothing but shows something useful while the real data
   arrives. */
const SALES_SHEET = '1Sb1-8n4CL1of7YR7kUzP9uh3VQtUMr1du2Y_hQgqw7U';

/* Must stay in step with TABS in sales.html: [gid, headerRows, titleCol].
   A gid the page does not know about is ignored, and a tab missing from the
   bundle simply is not seeded -- neither case breaks anything. */
const SALES_TABS = [
  // Daily -- movies (headers on row 1, Title in F)
  ...['1086343653','1876860810','967611835','1842298070',
      '615215644','180674901','1457107899','864620682'].map((g) => [g, 1, 'F']),
  // Daily -- TV (Title in G)
  ...['1848983867','1477357018','1511704700','1889687096',
      '647897415','792440283','195984870','1543744872'].map((g) => [g, 1, 'G']),
  // Mix & Match -- row 1 is a sale banner, so headers are on row 2
  ...['332837353','472649581','1166853727','1267092600','416316003',
      '1055247309','1542145001','1396038894','662596291','1142530535'].map((g) => [g, 2, 'G']),
  // Fanflix -- same banner row, Title in F
  ...['1203289215','69297060','1849827414','1542252526','218590821',
      '807293732','1507436042','1257201074','2004923465','221173491',
      '922691955','1260795062','1079899146','636654364','286303006',
      '1443208328','1045428658','1538467875','275982898','1265886931'].map((g) => [g, 2, 'F']),
];

/* gviz answers with `/*O_o*\/\ngoogle.visualization.Query.setResponse({...});`
   -- the JSON is what sits between the first ( and the last ). */
function unwrapGviz(text) {
  const a = text.indexOf('('), b = text.lastIndexOf(')');
  if (a < 0 || b < a) throw new Error('not a gviz response');
  return JSON.parse(text.slice(a + 1, b));
}

async function buildSalesBundle() {
  const bundle = {};
  let ok = 0, failed = 0, rows = 0;
  /* A little concurrency: 46 sequential requests at Google's TTFB would
     dominate the build, and 6 at a time is polite enough not to get throttled. */
  const queue = SALES_TABS.slice();
  const worker = async () => {
    while (queue.length) {
      const [gid, headerRows, titleCol] = queue.shift();
      /* Same query the page builds, so the bundle holds the same rows the live
         load would have produced -- including the "title is not empty" filter. */
      const q = encodeURIComponent(`select * where ${titleCol} is not null and ${titleCol} <> ''`);
      const url = `https://docs.google.com/spreadsheets/d/${SALES_SHEET}/gviz/tq`
        + `?headers=${headerRows}&gid=${gid}&tq=${q}&tqx=out:json`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = unwrapGviz(await res.text());
        if (json.status === 'error') {
          throw new Error(json.errors?.[0]?.detailed_message || 'sheet error');
        }
        bundle[gid] = json;
        rows += json.table?.rows?.length || 0;
        ok++;
      } catch (e) {
        /* One unreachable tab is not a failed build -- the page still loads
           that tab live, it just is not part of the instant first paint. */
        failed++;
        console.warn(`[build] sales tab ${gid} skipped: ${e.message}`);
      }
    }
  };
  await Promise.all([...Array(6)].map(worker));
  console.log(`[build] sales bundle: ${ok}/${SALES_TABS.length} tabs, ${rows} rows` +
              (failed ? `, ${failed} skipped` : ''));
  return ok ? bundle : null;
}
/* ---------- csv mirrors --------------------------------------------------- */
/* The other pages each parse a published CSV of their own, and they hit the
   same wall the Movies page did. Measured:

     Data        the SAME 11.7MB Movies export      ~9.3s
     MA Compare  1.32MB                             ~9.5s
     Wishlist    48KB                               ~1.8s   (all latency, no size)

   Reshaping every one of those loaders into the tiered format would be a lot
   of surface area for the benefit. Mirroring the CSV byte-for-byte onto
   Netlify gets most of the win for a one-line change per page: same bytes,
   same parser, but now from a CDN with Brotli and a real revalidate instead of
   `private, max-age=300` from an endpoint that regenerates on every request.

   Stable filenames rather than content hashes, because these are served
   must-revalidate -- a repeat visit costs one 304 and no body. */
const MIRRORS = [
  { name: 'movies.csv', url: CSV_URL },
  {
    name: 'wishlist.csv',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRoppbitXf4M7TtjyYx2pnmqX0YV4MaWWclDBBYVBsymbdUrKCcJsKZLRYuUmLC7LiHmVp_fqqfq032/pub?gid=424360819&single=true&output=csv',
  },
  {
    name: 'ma-compare.csv',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqFCFR3Ip1QuEdDACRkq4V-QyHQdqfywoen6DY_WOFdCjvm4YaoO77aQhY2yYIQRpjsgIXY2jvBRua/pub?gid=1970076351&single=true&output=csv',
  },
  {
    name: 'd2d.csv',
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQWArgGSe6FACegY98sjeY088GmXve0e50ZWCrSj1c9ztDiEoCB0KRqg5kzYFYtMhxAAPH4BhyIN9N2/pub?gid=87799027&single=true&output=csv',
  },
];

async function buildMirrors(moviesCsv) {
  await mkdir(MIRROR, { recursive: true });
  const done = [];
  for (const m of MIRRORS) {
    try {
      /* The Movies export is already in memory; do not pull 11.7MB twice. */
      const text = m.url === CSV_URL && moviesCsv ? moviesCsv : await (async () => {
        const res = await fetch(m.url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })();
      /* A truncated or error-page response would replace a working mirror with
         junk, and the pages would parse it as an empty collection rather than
         failing over. Cheap sanity check: it must look like a CSV with rows. */
      if (!text || text.length < 200 || !text.includes(',') || text.split('\n').length < 3) {
        throw new Error(`response does not look like a CSV (${text.length} bytes)`);
      }
      await writeFile(join(MIRROR, m.name), text);
      done.push(m.name);
      console.log(`[build] mirror ${m.name.padEnd(16)} ${(text.length / 1048576).toFixed(2)}MB`);
    } catch (e) {
      /* A mirror that cannot be built is not a failed deploy: every page keeps
         its original Google URL as a fallback and works exactly as before. */
      console.warn(`[build] mirror ${m.name} SKIPPED: ${e.message}`);
    }
  }
  return done;
}

async function main() {
  const csvText = await loadCsv();
  const rows = parseCsv(csvText);
  const head = rows.shift().map((h) => h.trim());

  /* Fail loudly rather than shipping a snapshot whose columns have shifted --
     a silent mismatch would put Studio data in the Language facet. */
  const missing = COLS.filter((c) => !head.includes(c));
  if (missing.length) {
    throw new Error(
      `sheet columns changed. Missing: ${missing.join(', ')}\n` +
      `Sheet has: ${head.join(', ')}\n` +
      `Update COLS in scripts/build-data.mjs to match.`
    );
  }
  const at = Object.fromEntries(head.map((h, i) => [h, i]));
  const cell = (r, name) => (r[at[name]] ?? '').trim();

  const dicts = {};
  for (const c of [...MULTI, ...SINGLE]) dicts[c] = makeDict();

  const coreCols = COLS.filter(
    (c) => !TIER_FACETS.includes(c) && !TIER_DESC.includes(c) &&
           c !== 'Poster' && c !== 'Img' && c !== 'Link' && c !== 'Title' && c !== 'Sort Title'
  );

  const core = [], facets = [], descs = [];
  let literalImgs = 0, literalLinks = 0, sortTitleKept = 0, blankRows = 0;

  /* Every CSV data row gets exactly one entry, blanks included. parseRows() in
     the page derives `sheetRow: ri + 2` from the array position, so dropping a
     blank row here would shift every row after it and silently point the
     "edit in sheet" links at the wrong film. The page already skips blank
     titles on its own; our job is only to preserve position. */
  for (const r of rows) {
    const title = cell(r, 'Title');

    /* A blank row costs one byte instead of a full skeleton record. The
       decoder turns a 0 back into an empty row, keeping the position. */
    if (!title) {
      core.push(0);
      facets.push(0);
      descs.push('');
      blankRows++;
      continue;
    }

    const sortTitle = cell(r, 'Sort Title');
    const encImg = encodeImg(cell(r, 'Img'));
    const imgId = typeof encImg === 'string' ? encImg : null;
    const encLink = encodeLink(cell(r, 'Link'), imgId);
    if (imgId === null) literalImgs++;
    if (Array.isArray(encLink) && encLink.length === 1) literalLinks++;

    /* Sort Title matches Title on the overwhelming majority of rows; store it
       only where it actually differs and let the decoder fall back to Title. */
    const st = sortTitle === title ? 0 : (sortTitleKept++, sortTitle);

    const rec = [title, st, encImg, encLink];
    for (const c of coreCols) {
      if (MULTI.includes(c)) {
        rec.push(cell(r, c).split(',').map((s) => s.trim()).filter(Boolean).map((t) => dicts[c].id(t)));
      } else if (SINGLE.includes(c)) {
        rec.push(dicts[c].id(cell(r, c)));
      } else {
        rec.push(cell(r, c));
      }
    }
    core.push(rec);

    facets.push(TIER_FACETS.map((c) =>
      cell(r, c).split(',').map((s) => s.trim()).filter(Boolean).map((t) => dicts[c].id(t))
    ));
    descs.push(cell(r, 'Description'));
  }

  const pick = (names) => Object.fromEntries(names.map((c) => [c, dicts[c].list()]));

  const corePayload = {
    v: 1,
    n: core.length,
    cols: COLS,
    coreCols,
    multi: MULTI.filter((c) => coreCols.includes(c)),
    single: SINGLE.filter((c) => coreCols.includes(c)),
    imgPrefix: IMG_PREFIX, imgSuffix: IMG_SUFFIX,
    linkBrowse: LINK_BROWSE, linkMovies: LINK_MOVIES,
    dicts: pick([...MULTI, ...SINGLE].filter((c) => coreCols.includes(c))),
    rows: core,
  };
  const facetPayload = {
    v: 1, n: facets.length, cols: TIER_FACETS,
    dicts: pick(TIER_FACETS), rows: facets,
  };
  const descPayload = { v: 1, n: descs.length, rows: descs };

  /* An empty directory does not survive git, and Netlify checks out a clean
     tree on every build, so create it rather than assuming it is there. */
  await mkdir(DATA, { recursive: true });

  /* Clear out snapshots from previous builds so the deploy folder does not
     accumulate every hash we have ever published. */
  for (const f of await readdir(DATA).catch(() => [])) {
    if (/^(core|facets|desc|sales)\.[0-9a-f]{10}\.json$/.test(f)) await unlink(join(DATA, f));
  }

  const out = {};
  for (const [name, payload] of [['core', corePayload], ['facets', facetPayload], ['desc', descPayload]]) {
    const json = JSON.stringify(payload);
    const h = hash(json);
    const file = `${name}.${h}.json`;
    await writeFile(join(DATA, file), json);
    out[name] = file;
    console.log(`[build] ${file.padEnd(26)} ${(json.length / 1048576).toFixed(2)}MB raw`);
  }

  /* Sales rides in the hashed, immutable set rather than /mirror/, because it
     is a generated bundle of 46 responses rather than a byte-for-byte copy of
     one sheet. */
  const salesBundle = await buildSalesBundle();
  if (salesBundle) {
    const sj = JSON.stringify(salesBundle);
    const sfile = `sales.${hash(sj)}.json`;
    await writeFile(join(DATA, sfile), sj);
    out.sales = sfile;
    console.log(`[build] ${sfile.padEnd(26)} ${(sj.length / 1048576).toFixed(2)}MB raw`);
  }

  const mirrors = await buildMirrors(csvText);

  /* The manifest is what index.html reads to find the current snapshots. It is
     tiny and served must-revalidate, so a rebuild is picked up immediately
     while the big hashed files stay immutable in cache. It lives OUTSIDE
     data/ so that "everything under /data/ is immutable" stays true as a
     single header rule with no exception carved out of it. */
  await writeFile(
    join(ROOT, 'data-manifest.json'),
    JSON.stringify({ built: new Date().toISOString(), rows: core.length, files: out, mirrors })
  );

  console.log(`[build] ${core.length} rows (${blankRows} blank, kept for position)`);
  console.log(`[build] ${sortTitleKept} rows needed a distinct Sort Title`);
  console.log(`[build] ${literalImgs} literal Img urls, ${literalLinks} literal Link urls`);
  for (const c of [...MULTI, ...SINGLE]) {
    console.log(`[build]   dict ${c.padEnd(18)} ${String(dicts[c].size).padStart(6)} unique`);
  }
}

main().catch((e) => { console.error('[build] FAILED:', e.message); process.exit(1); });
