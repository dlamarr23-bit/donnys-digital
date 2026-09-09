// Cloudflare Pages Function — same-origin image proxy.
//
// Replaces Netlify's /.netlify/images. Route: GET /img?url=<encoded-url>
//
// What this DOES keep from the Netlify version: every poster request stays
// same-origin, so a network that blocks by hostname (images2.vudu.com, etc.)
// has nothing to match. That was the main reason the proxy existed (see
// README.md "Posters").
//
// What this does NOT keep: resizing / webp re-encoding. A plain Cloudflare
// Pages Function has no image-processing step built in — that requires
// either Cloudflare Images (a separate paid product) or "Image Resizing"
// (needs the domain on a Cloudflare Pro-plan zone, using /cdn-cgi/image/...
// URLs). Until one of those is wired up, posters are proxied at original
// size/format. See MIGRATION-GUIDE.md for the upgrade path.
//
// SECURITY: this only fetches hosts on the allowlist below (ported from the
// [images] remote_images list in netlify.toml). Do not remove the check —
// without it this becomes an open proxy anyone on the internet can point at
// arbitrary URLs using your site's bandwidth.

const ALLOWLIST = [
  // wildcard subdomains ok, e.g. images2.vudu.com
  { host: "vudu.com", wildcard: true },
  { host: "fandango.com", wildcard: true },
  { host: "fandangonow.com", wildcard: true },
  { host: "moviesanywhere.com", wildcard: true },
  { host: "staticflickr.com", wildcard: true },
  { host: "ssl-images-amazon.com", wildcard: true },
  { host: "media-amazon.com", wildcard: true },
  { host: "barcodespider.com", wildcard: true },
  { host: "wikimedia.org", wildcard: true },
  { host: "mzstatic.com", wildcard: true },
  { host: "googleusercontent.com", wildcard: true },
  { host: "akamaized.net", wildcard: true },
  { host: "cloudfront.net", wildcard: true },
  // Cloudflare Pages -- your own in-house posters on *.pages.dev
  { host: "pages.dev", wildcard: true },
  // Photon fallback used on wishlist/data/d2d
  { host: "wp.com", wildcard: true },
  // Collection page's proxy-chain fallbacks (index.html VUDU_PROXIES) --
  // not in netlify.toml's list because Netlify's Image CDN never touched
  // these; they only appear once the generic /img rewrite re-wraps them.
  { host: "statically.io", wildcard: true },
  { host: "wsrv.nl", wildcard: true },
  // exact host only in netlify.toml (no subdomain wildcard before "image")
  { host: "image.tmdb.org", wildcard: false },
];

function isAllowed(hostname) {
  hostname = hostname.toLowerCase();
  return ALLOWLIST.some(({ host, wildcard }) => {
    if (hostname === host) return true;
    return wildcard && hostname.endsWith("." + host);
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  if (!target) {
    return new Response("Missing url param", { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid url param", { status: 400 });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return new Response("Unsupported protocol", { status: 400 });
  }

  if (!isAllowed(parsed.hostname)) {
    return new Response("Host not allowed", { status: 403 });
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      cf: { cacheEverything: true, cacheTtl: 604800 }, // 7 days at Cloudflare's edge
      headers: {
        // Some source CDNs (Akamai-fronted ones especially -- Vudu is one)
        // block requests that don't look like a real browser tab, which a
        // plain "Mozilla/5.0 (compatible; ...-proxy)" string doesn't. This
        // is a best-effort browser impression, not a guarantee -- some
        // providers block by source IP range regardless of headers.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        Referer: parsed.origin + "/",
      },
    });
  } catch {
    return new Response("Upstream fetch failed", { status: 502 });
  }

  if (!upstream.ok) {
    return new Response("Upstream error", { status: upstream.status });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
  headers.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");

  return new Response(upstream.body, { status: 200, headers });
}
