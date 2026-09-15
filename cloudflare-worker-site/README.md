# rudy-site — the Worker behind therudyparra.com's dynamic features

One Worker, one KV namespace, four features:

| Feature | How it works |
|---|---|
| **Self-updating events** | A cron (every 6h) fetches the ICS feeds in `ICS_URLS`, caches upcoming events in KV; the homepage fetches `/events` and appends cards for anything not already curated. |
| **"We met" capture** | `therudyparra.com/met/` posts to `/met`; review at `therudyparra.com/met/admin.html` with your `ADMIN_KEY`. |
| **Short links** | `wrangler kv key put --remote --binding SITE "link:techfest" "https://…"` → share `https://rudy-site.rparra.workers.dev/go/techfest`. Click counts show on the dashboard. |
| **Analytics** | Every page sends a beacon to `/hit` (first-party, no cookies, counts only, 90-day retention). Totals on the dashboard. |

## Deploy (one time, ~5 min)

```bash
cd cloudflare-worker-site
npx wrangler login     # if needed
bash setup.sh
```

You'll be prompted for `ADMIN_KEY` (random string — the script generates one
to paste) and `ICS_URLS`:

- **Luma**: your calendar page → ⋯ → Subscribe → copy the iCal URL
- **Google Calendar**: Settings → the calendar → Integrate calendar →
  **Secret address in iCal format** (treat that URL like a password)

Until this is deployed, the site works exactly as before — the frontend
fails silent on every endpoint.
