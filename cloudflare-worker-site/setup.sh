#!/usr/bin/env bash
# One-shot setup for the rudy-site Worker (events sync + met capture + short links + analytics).
# Run from cloudflare-worker-site/:
#   npx wrangler login   # once, if not already logged in
#   bash setup.sh
#
# You'll be prompted for:
#   ADMIN_KEY — any strong random string; it unlocks /met/list and /stats
#               (one is generated for you to paste)
#   ICS_URLS  — comma-separated calendar feed URLs the events section syncs from:
#     * Luma calendar: your calendar page → ... menu → "Subscribe" → copy the
#       iCal/ICS URL (looks like https://api.lu.ma/ics/get?entity=calendar&id=...)
#     * Google Calendar: Settings → your calendar → "Integrate calendar" →
#       "Secret address in iCal format" (treat this URL like a password)
set -euo pipefail
cd "$(dirname "$0")"

# 1. KV namespace
if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "==> Creating KV namespace SITE…"
  OUT=$(npx wrangler kv namespace create SITE 2>&1) || { echo "$OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE 'id = "[a-f0-9]+"' | grep -oE '[a-f0-9]{16,}')
  [ -n "$ID" ] || { echo "Could not parse namespace id from:"; echo "$OUT"; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/" wrangler.toml
  echo "    namespace id: $ID"
else
  echo "==> KV namespace already configured."
fi

# 2. Secrets
echo "==> Set ADMIN_KEY. Here's a fresh random one you can paste:"
openssl rand -base64 24
npx wrangler secret put ADMIN_KEY
echo "==> Set ICS_URLS (comma-separated calendar feed URLs, see comments at top of this script):"
npx wrangler secret put ICS_URLS

# 3. Deploy + first refresh
echo "==> Deploying…"
npx wrangler deploy
echo
echo "==> Triggering the first events refresh…"
read -r -p "Paste the ADMIN_KEY you just set (for the refresh call): " KEY
curl -s -X POST -H "Authorization: Bearer $KEY" https://rudy-site.rparra.workers.dev/events/refresh; echo
echo
echo "Done. Endpoints:"
echo "  https://rudy-site.rparra.workers.dev/events   (public JSON the homepage reads)"
echo "  https://therudyparra.com/met/                 (lead capture form)"
echo "  https://therudyparra.com/met/admin.html       (your private dashboard — needs ADMIN_KEY)"
echo
echo "Short links: npx wrangler kv key put --remote --binding SITE \"link:techfest\" \"https://luma.com/mh1l9c39\""
echo "             then share https://rudy-site.rparra.workers.dev/go/techfest"
