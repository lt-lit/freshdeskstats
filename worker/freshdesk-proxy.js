// Freshdesk CORS proxy — Cloudflare Worker
// ------------------------------------------------------------------
// Purpose: a GitHub Pages site cannot call the Freshdesk API directly
// because Freshdesk does not send CORS headers. This Worker sits in the
// middle: the browser calls it, it forwards the request to Freshdesk
// carrying the Authorization header from the browser, and it adds the
// CORS headers the browser requires.
//
// IMPORTANT: This Worker does NOT store your API key. The key lives only
// in the site's Settings menu (browser localStorage) and rides along in
// the Authorization header on each request. This Worker just relays it.
//
// It is locked down so it can't be abused as a general open proxy:
//   - it only accepts requests from the origins in ALLOWED_ORIGINS
//   - it only ever forwards to <subdomain>.freshdesk.com
//   - it is read-only (GET requests only)
// ------------------------------------------------------------------

// The site(s) allowed to use this proxy. Add your GitHub Pages origin.
// (Origin = scheme + host only, no path.) Localhost entries are for
// testing the site locally before it's deployed to Pages.
const ALLOWED_ORIGINS = [
  "https://lt-lit.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

// Freshdesk subdomain must be a plain label (letters, digits, hyphens).
// This prevents the proxy from being pointed at arbitrary hosts.
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,60}$/i;

function corsHeaders(origin) {
  const h = new Headers();
  if (ALLOWED_ORIGINS.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Freshdesk-Domain");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check — visit the Worker URL in a browser to confirm it's live.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Freshdesk CORS proxy is running.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Only our own site may proxy through here.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Forbidden origin", { status: 403, headers: cors });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    const domain = request.headers.get("X-Freshdesk-Domain") || "";
    if (!DOMAIN_RE.test(domain)) {
      return new Response("Invalid or missing X-Freshdesk-Domain", { status: 400, headers: cors });
    }

    const auth = request.headers.get("Authorization");
    if (!auth) {
      return new Response("Missing Authorization", { status: 401, headers: cors });
    }

    const target = `https://${domain}.freshdesk.com${url.pathname}${url.search}`;

    let upstream;
    try {
      upstream = await fetch(target, {
        method: "GET",
        headers: {
          "Authorization": auth,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err}`, { status: 502, headers: cors });
    }

    // Rebuild the response with CORS headers, passing through Freshdesk's
    // pagination (Link) and rate-limit headers so the site can react to them.
    const respHeaders = new Headers(cors);
    respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    const passthrough = ["Link", "Retry-After", "X-RateLimit-Remaining", "X-RateLimit-Total", "X-RateLimit-Used-CurrentRequest"];
    for (const k of passthrough) {
      const v = upstream.headers.get(k);
      if (v) respHeaders.set(k, v);
    }
    respHeaders.set("Access-Control-Expose-Headers", passthrough.join(", "));

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
