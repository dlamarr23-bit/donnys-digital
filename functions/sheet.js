// Cloudflare Pages Function — edge cache in front of the Google Sheets.
//
// Route: GET /sheet?u=<encoded Google Sheets URL>[&fresh=<seconds>]
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
// came from in `X-Sheet-Cache` (HIT / STALE / MISS / ERROR-STALE).
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

function fetchUpstream(target) {
  let p = inflight.get(target);
  if (p) return p;
  p = (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(target, { redirect: "follow", signal: ctl.signal });
      const type = res.headers.get("Content-Type") || "";
      const text = await res.text();
      return { ok: res.ok && !looksBad(text, type), status: res.status, text, type };
    } finally {
      clearTimeout(t);
    }
  })();
  inflight.set(target, p);
  p.finally(() => inflight.delete(target));
  return p;
}

function store(cache, key, text, type) {
  const h = new Headers();
  // text/plain on purpose: Cloudflare only compresses Content-Types on its
  // list and text/csv is not on it (see the note in _headers). Every page
  // reads these with fetch().text(), so nothing depends on the type.
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("X-Upstream-Type", type || "");
  h.set("X-Fetched-At", String(Date.now()));
  h.set("Cache-Control", `public, max-age=${MAX_KEEP}`);
  return cache.put(key, new Response(text, { headers: h }));
}

function reply(body, ageSec, how, status = 200) {
  const h = new Headers();
  h.set("Content-Type", "text/plain; charset=utf-8");
  // The browser must not keep its own copy: the page decides freshness from
  // X-Sheet-Age, and a browser-cached answer would hide that.
  h.set("Cache-Control", "no-store");
  h.set("X-Sheet-Age", String(Math.max(0, Math.round(ageSec))));
  h.set("X-Sheet-Cache", how);
  h.set("Access-Control-Expose-Headers", "X-Sheet-Age, X-Sheet-Cache");
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

  const cache = caches.default;
  const key = new Request(`${reqUrl.origin}/__sheet-cache/${encodeURIComponent(target.toString())}`);

  let cached = null, age = Infinity;
  try {
    cached = await cache.match(key);
    if (cached) age = (Date.now() - Number(cached.headers.get("X-Fetched-At") || 0)) / 1000;
  } catch { cached = null; }

  const refresh = async () => {
    const up = await fetchUpstream(target.toString());
    if (up.ok) await store(cache, key, up.text, up.type);
    return up;
  };

  // FAST: anything we have, now. Refresh behind it if it is getting old.
  if (cached && (fresh === null || age <= fresh)) {
    if (age > REFRESH_AFTER) waitUntil(refresh().catch(() => {}));
    return reply(cached.body, age, fresh === null && age > REFRESH_AFTER ? "STALE" : "HIT");
  }

  // MISS, or CONFIRM with a copy that is too old: wait for Google.
  try {
    const up = await fetchUpstream(target.toString());
    if (up.ok) {
      waitUntil(store(cache, key, up.text, up.type).catch(() => {}));
      return reply(up.text, 0, "MISS");
    }
    // Google answered, but with something unusable. Prefer an old good copy.
    if (cached) return reply(cached.body, age, "ERROR-STALE");
    return reply(up.text, 0, "ERROR", up.status >= 400 ? up.status : 502);
  } catch (e) {
    if (cached) return reply(cached.body, age, "ERROR-STALE");
    return reply(`Upstream fetch failed: ${(e && e.message) || e}`, 0, "ERROR", 502);
  }
}
