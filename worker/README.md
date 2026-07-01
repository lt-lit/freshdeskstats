# Freshdesk CORS proxy (Cloudflare Worker)

A minimal relay that lets the static site call the Freshdesk API from the
browser. Freshdesk's API does not send CORS headers, so a browser on
`github.io` can't read its responses directly. This Worker forwards the
request server-side and adds the missing CORS header.

## What it does / does not do

- **Does not** store your API key. The key lives only in the site's Settings
  menu (browser `localStorage`) and is sent in the `Authorization` header on
  each request. The Worker relays it to Freshdesk.
- **Read-only**: only `GET` is proxied.
- **Locked down**: only the origins in `ALLOWED_ORIGINS` may use it, and it
  only ever forwards to `<subdomain>.freshdesk.com`.

## How the site calls it

```
GET https://<worker-url>/api/v2/tickets?per_page=100
  Authorization: Basic base64(<api_key>:X)
  X-Freshdesk-Domain: <your-freshdesk-subdomain>   # e.g. "acme" for acme.freshdesk.com
```

The Worker rebuilds the target as
`https://<X-Freshdesk-Domain>.freshdesk.com/api/v2/tickets?per_page=100`.

## Deploy (dashboard)

1. dash.cloudflare.com → **Workers & Pages** → **Create application** →
   **Create Worker**.
2. Name it (e.g. `freshdesk-proxy`) → **Deploy**.
3. **Edit code** → paste the contents of `freshdesk-proxy.js` → **Deploy**.
4. Note the `https://<name>.<subdomain>.workers.dev` URL — the site's Settings
   menu points at it.

## Config

Edit `ALLOWED_ORIGINS` in `freshdesk-proxy.js` to match your GitHub Pages
origin (scheme + host only, no path), then redeploy.
