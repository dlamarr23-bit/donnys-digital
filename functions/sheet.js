// Cloudflare Pages Function — edge cache in front of the Google Sheets.
//
// Route: GET /sheet?u=<encoded Google Sheets URL>[&fresh=<seconds>][&check=1]
//
// WHY THIS EXISTS
// Every page paints from a local cache first and then asks the live sheet
// whether anything changed. That second step is what you see as "it shows my
// last visit, then updates a few seconds later": Google answers a gviz query
// or a published CSV in anywhere from 0.5s to 14s, and it sends
// `Cache-Control: private`, so no CDN is allowed to keep a copy.
//
// This function is that copy. It fetches the sheet once, keeps the answer in
// Cloudflare's edge cache, and hands it back in a few milliseconds:
//
//   no `fresh`     FAST. Return whatever copy the edge has, however old (up to
//                  MAX_KEEP), and if it is older than REFRESH_AFTER refresh it
//                  from Google in the background. The page gets an answer in
//                  ~50ms instead of seconds.
//   fresh=N        CONFIRM. Return the edge copy only if it is at most N
//                  seconds old, otherwise wait for Google. The pages use this
//                  as a silent second pass when the fast answer was old, so
//                  the data is still guaranteed live -- the fast answer just
//                  means nothing has to wait for it.
//
// Every response says how old it is in `X-Sheet-Age` (seconds) and where it
// came from in `X-Sheet-Cache` (HIT / STALE / MISS / ERROR-STALE), and what
// it holds in `X-Sheet-Hash` (SHA-1 of the exact bytes, hex).
//
//   check=1        FINGERPRINT ONLY. Same fast/confirm rules as above, but the
//                  body is empty: the answer is just the headers. A page that
//                  already holds a copy compares X-Sheet-Hash with the hash it
//                  saved and skips the download when they match. The hash is
//                  of the WHOLE sheet, so an edit to any cell in any column
//                  changes it -- unlike the old column probes, nothing can
//                  slip past it. It costs a few hundred bytes, not megabytes.
//
// The hash is worked out once, when a copy is stored, and kept on the cached
// entry, so a check never reads the cached body. Google's CSV export is
// byte-for-byte stable while the sheet is unchanged (checked 2026-11-20: two
// Google downloads, the edge copy and the deploy-time mirror all had the same
// SHA-1), which is what lets scripts/build-data.mjs publish the matching hash
// for the snapshot it built.
//
// The edge cache is per Cloudflare data centre, which in practice means per
// region: the first visitor through a given colo pays Google's latency, and
// everyone after them (including that same visitor tomorrow) does not.
//
// SECURITY: only the spreadsheets listed in SHEETS can be fetched, and only on
// docs.google.com. Do not loosen this -- without it the function is an open
// proxy anyone could point at anything using the site's bandwidth. To add a
// new sheet, add its id here.

const SHEETS = new Set([
  // Movies (Collection + Data)
  "1IHUqVvrGcjIESpHaClR9uvmjP3jutcz-ReijMqI7x38",
  "2PACX-1vTNcy_TXkl7kRJvIvf4U_q9pZUCdrJ9RsQ8Vgnr5NoX8K679jUhWC6iWZvbCYR2bOaRG2ypgFB13PEB",
  // Wishlist
  "1mMkaCPwn879BvxzVTzbu9ODJMaAW9QdBv6aDOjLixZw",
  "2PACX-1vRoppbitXf4M7TtjyYx2pnmqX0YV4MaWWclDBBYVBsymbdUrKCcJsKZLRYuUmLC7LiHmVp_fqqfq032",
  // MA Compare
  "1iCuGBc7f0J_Dddshqf2Ho86ypPh2b1QIMkQOsB3fSrI",
  "2PACX-1vRqFCFR3Ip1QuEdDACRkq4V-QyHQdqfywoen6DY_WOFdCjvm4YaoO77aQhY2yYIQRpjsgIXY2jvBRua",
  // D2D
  "1FGmx-wRGHXE80uyxbZWVeal4b6vOEr9JJ9Hr_VA668U",
  "2PACX-1vQWArgGSe6FACegY98sjeY088GmXve0e50ZWCrSj1c9ztDiEoCB0KRqg5kzYFYtMhxAAPH4BhyIN9N2",
  // Sales
  "1Sb1-8n4CL1of7YR7kUzP9uh3VQtUMr1du2Y_hQgqw7U",
]);

// A copy younger than this is served without even a background refresh.
const REFRESH_AFTER = 15;              // seconds
// How long the edge keeps a copy at all. Long on purpose: an old copy is only
// ever a first answer, never the last word (see `fresh` above).
const MAX_KEEP = 7 * 24 * 3600;        // seconds
// Google sometimes just hangs. Past this, give up and serve what we have.
const UPSTREAM_TIMEOUT_MS = 25000;

const PATH = /^\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]+)\/(?:gviz\/tq|pub|export)$/;

function allowed(u) {
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return false;
  const m = PATH.exec(u.pathname);
  return !!(m && SHEETS.has(m[1]));
}

// gviz answers HTTP 200 with {"status":"error"} for a rejected query, and a
// sheet that is not public answers with a Google sign-in page. Neither may be
// cached -- that would pin a failure in place for a week.
function looksBad(text, type) {
  if (/text\/html/i.test(type || "")) return true;
  if (text.length < 2000 && /"status"\s*:\s*"error"/.test(text)) return true;
  return false;
}

// One upstream request per URL per isolate at a time, so a burst of visitors
// (or a page's fast + confirm pair) cannot stampede Google.
const inflight = new Map();

async function sha1(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  let h = "";
  for (let i = 0; i < d.length; i++) h += d[i].toString(16).padStart(2, "0");
  return h;
}

function fetchUpstream(target) {
  let p = inflight.get(target);
  if (p) return p;
  p = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(target, { redirect: "follow", signal: ctl.signal });
      const type = res.headers.get("Content-Type") || "";
      // Bytes, not text: the body is stored and sent on as-is, so decoding
      // ~13MB into a string and encoding it again was pure CPU. Only a short
      // answer can be an error, so only a short answer is decoded to check.
      const buf = await res.arrayBuffer();
      const head = buf.byteLength < 2000 ? new TextDecoder().decode(buf) : "";
      const ok = res.ok && !looksBad(head, type);
      return { ok, status: res.status, buf, type, hash: ok ? await sha1(buf) : "" };
    } finally {
      clearTimeout(t);
    }
  })();
  inflight.set(target, p);
  p.finally(() => inflight.delete(target));
  return p;
}

function store(cache, key, buf, type, hash, fetchedAt) {
  const h = new Headers();
  // text/plain on purpose: Cloudflare only compresses Content-Types on its
  // list and text/csv is not on it (see the note in _headers). Every page
  // reads these with fetch().text(), so nothing depends on the type.
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("X-Upstream-Type", type || "");
  h.set("X-Fetched-At", String(fetchedAt || Date.now()));
  if (hash) h.set("X-Sheet-Hash", hash);
  h.set("Cache-Control", `public, max-age=${MAX_KEEP}`);
  return cache.put(key, new Response(buf, { headers: h }));
}

function reply(body, ageSec, how, status = 200, hash = "") {
  const h = new Headers();
  h.set("Content-Type", "text/plain; charset=utf-8");
  // The browser must not keep its own copy: the page decides freshness from
  // X-Sheet-Age, and a browser-cached answer would hide that.
  h.set("Cache-Control", "no-store");
  h.set("X-Sheet-Age", String(Math.max(0, Math.round(ageSec))));
  h.set("X-Sheet-Cache", how);
  if (hash) h.set("X-Sheet-Hash", hash);
  h.set("Access-Control-Expose-Headers", "X-Sheet-Age, X-Sheet-Cache, X-Sheet-Hash");
  return new Response(body, { status, headers: h });
}

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const reqUrl = new URL(request.url);
  const raw = reqUrl.searchParams.get("u");
  if (!raw) return new Response("Missing u param", { status: 400 });

  let target;
  try { target = new URL(raw); } catch { return new Response("Invalid u param", { status: 400 }); }
  if (!allowed(target)) return new Response("Sheet not allowed", { status: 403 });

  const freshParam = reqUrl.searchParams.get("fresh");
  const fresh = freshParam === null ? null : Math.max(0, Number(freshParam) || 0);
  const checkOnly = reqUrl.searchParams.get("check") === "1";

  const cache = caches.default;
  const key = new Request(`${reqUrl.origin}/__sheet-cache/${encodeURIComponent(target.toString())}`);

  let cached = null, age = Infinity;
  try {
    cached = await cache.match(key);
    if (cached) age = (Date.now() - Number(cached.headers.get("X-Fetched-At") || 0)) / 1000;
  } catch { cached = null; }

  const refresh = async () => {
    const up = await fetchUpstream(target.toString());
    if (up.ok) await store(cache, key, up.buf, up.type, up.hash);
    return up;
  };

  // The hash of the cached copy. A copy stored before hashes existed has
  // none: work it out once from its body and, when asked to, store it back
  // with its original fetch time so it does not suddenly look fresh.
  //
  // Two traps, both real:
  //  * Callers must await this BEFORE touching cached.body. clone() tees the
  //    body stream, so a cached.body taken earlier is locked by the time the
  //    Response is built, and the function throws (a bare 500).
  //  * Do not store back when a refresh is running beside it: if the refresh
  //    lands first, this would write the OLD copy on top of the new one.
  const cachedHash = async (storeBack) => {
    const have = cached.headers.get("X-Sheet-Hash");
    if (have) return have;
    const buf = await cached.clone().arrayBuffer();
    const hash = await sha1(buf);
    if (storeBack) {
      waitUntil(store(cache, key, buf, cached.headers.get("X-Upstream-Type"), hash,
        Number(cached.headers.get("X-Fetched-At") || 0)).catch(() => {}));
    }
    return hash;
  };
  // check=1 sends the same headers with no body.
  const body = (b) => (checkOnly ? null : b);

  // FAST: anything we have, now. Refresh behind it if it is getting old.
  if (cached && (fresh === null || age <= fresh)) {
    const refreshing = age > REFRESH_AFTER;
    if (refreshing) waitUntil(refresh().catch(() => {}));
    const how = fresh === null && refreshing ? "STALE" : "HIT";
    const hash = await cachedHash(!refreshing);
    return reply(body(cached.body), age, how, 200, hash);
  }

  // MISS, or CONFIRM with a copy that is too old: wait for Google.
  try {
    const up = await fetchUpstream(target.toString());
    if (up.ok) {
      waitUntil(store(cache, key, up.buf, up.type, up.hash).catch(() => {}));
      return reply(body(up.buf), 0, "MISS", 200, up.hash);
    }
    // Google answered, but with something unusable. Prefer an old good copy.
    if (cached) {
      const hash = await cachedHash(true);
      return reply(body(cached.body), age, "ERROR-STALE", 200, hash);
    }
    return reply(up.buf, 0, "ERROR", up.status >= 400 ? up.status : 502);
  } catch (e) {
    if (cached) {
      const hash = await cachedHash(true);
      return reply(body(cached.body), age, "ERROR-STALE", 200, hash);
    }
    return reply(`Upstream fetch failed: ${(e && e.message) || e}`, 0, "ERROR", 502);
  }
}
