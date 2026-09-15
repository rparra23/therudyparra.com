#!/usr/bin/env bash
# Re-mint the Google refresh token for the scheduler Worker and update its secret.
# Run from cloudflare-worker-scheduler/:   bash fix-token.sh
#
# WHY: the OAuth app was left "In testing" in Google Cloud, and Google expires
# refresh tokens for testing-mode apps after 7 days. The Worker now gets
# "token refresh failed: 400" and /book is down.
#
# BEFORE RUNNING (once, ~1 min): https://console.cloud.google.com
#   -> select the scheduler project -> APIs & Services -> OAuth consent screen
#   -> click "PUBLISH APP" (status becomes "In production").
# Without this, the new token dies again in 7 days.
#
# You'll need the Client ID + Client Secret from APIs & Services -> Credentials
# (the "scheduler-cli" Desktop app entry).
set -euo pipefail
cd "$(dirname "$0")"

read -r -p "Google OAuth Client ID: " CLIENT_ID
read -r -s -p "Google OAuth Client Secret (typing is hidden): " CLIENT_SECRET; echo

REDIRECT="http://127.0.0.1:8888/callback"
SCOPE="https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar"
AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT}&response_type=code&access_type=offline&prompt=consent&scope=${SCOPE}"

echo "==> Opening the Google consent screen in your browser…"
echo "    Sign in with the SAME Google account your calendar lives on."
open "$AUTH_URL" 2>/dev/null || echo "Open this URL manually: $AUTH_URL"

echo "==> Waiting for Google to redirect back (listening on 127.0.0.1:8888)…"
CODE=$(python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
code = {}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        code['v'] = q.get('code', [''])[0]
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b"<h2>Done &mdash; close this tab and go back to the terminal.</h2>")
    def log_message(self, *a): pass
s = HTTPServer(('127.0.0.1', 8888), H)
while not code.get('v'):
    s.handle_request()
print(code['v'])
PY
)
[ -n "$CODE" ] || { echo "ERROR: no code received from Google. Aborting."; exit 1; }

echo "==> Exchanging the code for a refresh token…"
RESP=$(curl -s https://oauth2.googleapis.com/token \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET" \
  -d code="$CODE" \
  -d redirect_uri="$REDIRECT" \
  -d grant_type=authorization_code)
REFRESH=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("refresh_token",""))')
[ -n "$REFRESH" ] || { echo "ERROR: no refresh_token in Google's response:"; echo "$RESP"; exit 1; }

echo "==> Updating the Worker secret (if this fails, run 'npx wrangler login' and re-run this script)…"
printf '%s' "$REFRESH" | npx wrangler secret put GOOGLE_REFRESH_TOKEN

echo "==> Testing the live endpoint…"
sleep 3
curl -s "https://scheduler.rparra.workers.dev/availability?days=3&minutes=30" | head -c 400; echo
echo
echo "Done. If you see slot data above (not an error), https://therudyparra.com/book works again."
