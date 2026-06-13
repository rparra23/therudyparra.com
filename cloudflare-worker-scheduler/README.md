# Scheduler — Cloudflare Worker for therudyparra.com/book

Two endpoints behind your domain:

- `GET  /availability?days=14` → list of free 30-min slots over the next N days
- `POST /book`                 → creates a Google Calendar event with a Meet link, invites both parties

The Worker holds your Google refresh token; the browser never sees it.

```
Browser ──/availability──▶ Worker ──freebusy.query──▶ Google Calendar
Browser ◀──slots[]──────── Worker

Browser ──/book──────────▶ Worker ──events.insert──▶ Google Calendar
                                     (+ Meet link)
Browser ◀──{meetUrl}────── Worker
                                  Calendar emails both parties
```

## One-time setup (~25 min)

### Step 1. (Optional but recommended) Subscribe iCloud → Google

If you keep events on iCloud, sync them to Google so the scheduler sees them
as "busy":

1. **iCloud.com → Calendar → tiny radio icon next to a calendar → Public Calendar → Copy Link**
2. Replace `webcal://` with `https://` in the URL
3. In Google Calendar (web), **Other calendars → + → From URL**, paste, Add
4. Wait ~5 min for first sync. Google will keep this in sync going forward
   (read-only — events you add to Google still need to be on Google)

Repeat for each iCloud calendar you want included. Note their Google calendar
IDs (look in the calendar's Settings → Integrate calendar → Calendar ID).

### Step 2. Google Cloud project + OAuth client (5 min)

1. <https://console.cloud.google.com> → **New Project** → `scheduler-therudyparra`
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**
3. **APIs & Services → OAuth consent screen**
   - User Type: **External**
   - App name: `Rudy Parra scheduler`
   - User support email: your email
   - Developer contact: your email
   - **Save & continue** through Scopes (skip), Test users
   - **Add a test user**: your own Google account
   - Save
4. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `scheduler-cli`
   - Create
5. Copy the **Client ID** and **Client Secret** — keep them handy

### Step 3. Grab a refresh token (5 min)

Open this URL in a browser, replacing `YOUR_CLIENT_ID`:

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=http://127.0.0.1:8888/callback&response_type=code&access_type=offline&prompt=consent&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar
```

Approve. You'll be redirected to a `http://127.0.0.1:8888/callback?code=...`
URL that fails to load — that's expected. **Copy the `code=` value** from the
address bar.

Exchange the code for a refresh token in your terminal:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=THE_CODE_FROM_THE_URL \
  -d redirect_uri=http://127.0.0.1:8888/callback \
  -d grant_type=authorization_code | jq .
```

In the response, save the `refresh_token` value. (The `access_token` is
short-lived; the Worker mints fresh ones on demand.)

### Step 4. Find your calendar IDs (1 min)

Go to <https://calendar.google.com> → settings cog → **Settings**. In the
left rail under "Settings for my calendars," click each calendar you want
the scheduler to see. **Integrate calendar → Calendar ID**.

For your main one, the ID is usually your email address. For added/iCloud
calendars, it's a long string ending in `@group.calendar.google.com`.

Make a comma-separated string of all the IDs you want included, e.g.:
```
parrarudy3@gmail.com,abc123def@group.calendar.google.com
```

(Or just `primary` if you only have one and want the simplest config.)

### Step 5. Deploy the Worker (5 min)

```bash
cd cloudflare-worker-scheduler
npm install -g wrangler          # one-time
wrangler login                   # opens browser
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
wrangler secret put CALENDAR_IDS
wrangler secret put OWNER_EMAIL
# Optional overrides — only set if you want a non-default:
# wrangler secret put TIMEZONE         # default America/Denver
# wrangler secret put DAILY_START_HOUR # default 7
# wrangler secret put DAILY_END_HOUR   # default 22
# wrangler secret put SLOT_MINUTES     # default 30
# wrangler secret put BUFFER_MINUTES   # default 15
# wrangler secret put MIN_NOTICE_HOURS # default 2
# wrangler secret put OWNER_NAME       # default "Rudy Parra"
wrangler deploy
```

When `deploy` finishes it prints a URL like
`https://scheduler.<your-cf-username>.workers.dev`. Copy it.

### Step 6. Wire the site to the Worker (1 min)

Edit `../assets/scheduler-config.json` and replace the placeholder:

```json
{
  "workerUrl": "https://scheduler.YOUR-USER.workers.dev"
}
```

Commit and push:
```bash
git add assets/scheduler-config.json
git commit -m "Wire up the scheduler Worker"
git push
```

### Step 7. Test (2 min)

1. Open <https://therudyparra.com/book> in an incognito window
2. You should see available 30-min slots over the next 14 days
3. Pick one, fill in a test name + email (use a second email you own)
4. Submit → confirmation screen with a Google Meet link
5. Check your Google Calendar — the event should appear with the Meet link
6. Both you and the test email should get calendar invites

## Owner email notification (optional, ~3 min)

Whenever someone successfully books, the Worker can send a styled HTML
notification to a single inbox you control. Uses [Resend](https://resend.com)
because their free tier (3,000/mo) is plenty and they reach iCloud reliably.

1. **Sign up at <https://resend.com>** using the SAME address you want to be
   notified at (e.g. `parrarudy3@icloud.com`). Resend's free tier lets you
   send to your own address without any domain verification.
2. **Resend → API Keys → Create API Key** → permissions `Sending access` → copy
   the `re_...` key.
3. Wire it into the Worker:

   ```bash
   cd cloudflare-worker-scheduler
   wrangler secret put RESEND_API_KEY    # paste the re_... key
   wrangler secret put NOTIFY_EMAIL      # paste parrarudy3@icloud.com
   # Optional — only set if you've verified a sending domain in Resend later:
   # wrangler secret put RESEND_FROM     # e.g. "therudyparra.com bookings <hi@therudyparra.com>"
   wrangler deploy
   ```

4. Place a real test booking on <https://therudyparra.com/book>. Within a few
   seconds you should see a "*Name* booked you" email arrive at
   `parrarudy3@icloud.com`. The Google Calendar invite continues to fire
   independently — this is purely an extra heads-up.

If `RESEND_API_KEY` or `NOTIFY_EMAIL` isn't set, the email step is skipped
silently and the rest of the scheduler keeps working.

**Note on the From address.** Out of the box the email comes from
`therudyparra.com bookings <onboarding@resend.dev>`. Resend's free tier
allows that sender to deliver only to the address you signed up with —
perfect for owner notifications. To send to other addresses (e.g. cc'ing a
teammate), verify a domain in Resend (2 DNS records) and set `RESEND_FROM`.

## When you want to tune behavior

| Knob | How to change |
|---|---|
| Working hours | `wrangler secret put DAILY_START_HOUR` / `DAILY_END_HOUR` |
| Slot length | `wrangler secret put SLOT_MINUTES` |
| Buffer between meetings | `wrangler secret put BUFFER_MINUTES` |
| Minimum notice | `wrangler secret put MIN_NOTICE_HOURS` |
| Timezone | `wrangler secret put TIMEZONE` (IANA zone) |
| Calendars to read busy from | `wrangler secret put CALENDAR_IDS` (comma list) |

Then `wrangler deploy`. Changes are live within seconds.

## Security notes

- **Never commit the OAuth client JSON or the refresh token.** The `.gitignore`
  excludes anything `.json` except `wrangler.toml`-relevant files.
- The honeypot field (`website`) on the booking form rejects naïve bots.
- The Worker re-checks the slot is still free at booking time, so two
  visitors who pick the same slot won't double-book.
- If the refresh token ever leaks, revoke it at <https://myaccount.google.com/permissions>
  and run Steps 3+ again with a fresh code.

## Troubleshooting

- **`token refresh failed`** — usually the OAuth consent screen is still in
  "Testing" mode and you've hit the 7-day token expiry. Either move the app
  to Production in the consent screen, or re-run Step 3 weekly.
- **`freebusy failed: 403`** — the service-account approach isn't what this
  uses; this is OAuth-as-you. Confirm the Google account you authorized in
  Step 3 actually has access to the calendar IDs in your `CALENDAR_IDS`.
- **Empty `slots[]`** — verify your `DAILY_START_HOUR` / `DAILY_END_HOUR` make
  sense, and that the calendars you listed don't have all-day events covering
  every weekday.
