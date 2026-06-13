# Reviews — Cloudflare Worker for therudyparra.com/#testimonials

Live, no-approval review pipeline. Visitors submit on the homepage, the
review appears on the page within a second, and you (the owner) get a styled
email with a **one-click signed delete link** so you can nuke spam in ~5
seconds without any tooling.

Replaces the older `mailto:` + Gmail label + Claude routine flow.

```
Browser ──POST /review─▶ Worker ──put──▶ Cloudflare KV
                              │
                              └──Resend───▶ parrarudy3@icloud.com
                                          (signed Delete link)

Browser ──GET  /reviews─▶ Worker ──get──▶ Cloudflare KV ──array──▶ Browser
                                       (falls back to /assets/reviews.json
                                        if Worker is unreachable)
```

## One-time setup (~6 min)

### Step 1. Create the KV namespace (1 min)

```bash
cd cloudflare-worker-reviews
npx wrangler login                              # if not already
npx wrangler kv namespace create REVIEWS
```

`wrangler` prints something like:
```
[[kv_namespaces]]
binding = "REVIEWS"
id = "8a4f3c2e9b1d4f6a..."
```

**Paste that `id` value** into `wrangler.toml` (replace
`REPLACE_WITH_KV_NAMESPACE_ID`).

### Step 2. Set the secrets (2 min)

```bash
# Random 24+ char string used to sign delete links. Generate one fresh:
openssl rand -base64 32
# Then:
npx wrangler secret put DELETE_HMAC_SECRET     # paste the random string

# Optional but recommended — owner notification email:
npx wrangler secret put RESEND_API_KEY         # the re_... key (reuse the
                                               # scheduler's account)
npx wrangler secret put NOTIFY_EMAIL           # parrarudy3@icloud.com
```

If you skip `RESEND_API_KEY` / `NOTIFY_EMAIL`, reviews still publish live —
you just won't get pinged. The delete-link mechanism still works, you'd just
need to keep the signed URL yourself.

### Step 3. Deploy (30 sec)

```bash
npx wrangler deploy
```

Prints something like `https://reviews.rparra.workers.dev`. Copy it.

### Step 4. Wire the site to the Worker (1 min)

Edit `../assets/reviews-config.json` and replace `YOUR-WORKER` with the URL
from Step 3:

```json
{
  "workerUrl": "https://reviews.YOUR-USER.workers.dev"
}
```

Commit and push:
```bash
git add assets/reviews-config.json
git commit -m "Wire up reviews Worker"
git push
```

### Step 5. Test (1 min)

1. Open <https://therudyparra.com/#testimonials> in an incognito window
2. Click **Write a review**, fill it out, hit **Submit**
3. The new review should appear at the top of the Testimonials list within ~1 second
4. Check `parrarudy3@icloud.com` — within ~5 seconds you should see a "New review from …" email with a red **Delete this review** button
5. Click the button; the page-link opens, says "Review deleted." Refresh the homepage — the review is gone.

That's the full loop. Any review you don't actively delete stays up forever.

## Where the data lives

A single KV key — `reviews:list` — holds the full JSON array. Newest reviews
are prepended. KV has no schema so adding fields later is a non-event.

On a fresh deploy with an empty KV, the first GET seeds itself from the live
site's `/assets/reviews.json` so all your existing reviews carry over. After
that, the static file is **ignored** — the Worker's KV copy is the source of
truth. You can delete the static file later if you want.

## When you want to tune things

| Knob | Default | How to change |
|---|---|---|
| Rate limit per IP | 3 / hr | `wrangler secret put RATE_LIMIT_PER_HOUR` |
| Max review length | 2000 chars | `wrangler secret put MAX_REVIEW_CHARS` |
| CORS origin | `https://therudyparra.com` | `wrangler secret put ALLOWED_ORIGIN` |
| Email From | `onboarding@resend.dev` | `wrangler secret put RESEND_FROM` after verifying a Resend domain |
| Display owner name in email | "Rudy Parra" | `wrangler secret put OWNER_NAME` |

Then `wrangler deploy`.

## Manual maintenance (rare)

You can read/write the KV directly with wrangler if you ever need to:

```bash
# Dump everything as JSON
npx wrangler kv key get --namespace-id <kv-id> reviews:list

# Replace the whole list (e.g. bulk edit) — pipe in a JSON array
echo '[{"anonymous":false,"name":"...","review":"..."}]' | \
  npx wrangler kv key put --namespace-id <kv-id> reviews:list --file=-

# Wipe a rate-limit ban for an IP if you need to test repeatedly
npx wrangler kv key delete --namespace-id <kv-id> rate:1.2.3.4
```

## Security notes

- **The HMAC signing key (`DELETE_HMAC_SECRET`) is the only thing standing
  between a stranger and "delete any review." Treat it like a password.**
  Never check it into git; never put it in a screenshot; rotate it if you
  suspect leakage (`wrangler secret put DELETE_HMAC_SECRET` with a new value
  — old delete links stop working).
- Bot defense: honeypot field, rate limit, link/keyword filter, min-length
  check, max-length cap. Determined humans can still post anything — that's
  the trade-off you opted into.
- The Worker re-validates on POST regardless of what the frontend sent.
- KV write to a single key has weak consistency (eventually consistent
  globally). For the volume a personal site sees, two writes landing in the
  exact same second is essentially never going to happen. If it does, the
  later write wins; the earlier review is gone. If that ever matters, switch
  to a D1 table.

## Retiring the old Gmail / Claude routine

Once the live flow is verified, you can:

- Turn off the `publish-testimonials` Claude routine
- Stop expecting submission emails at `parrarudy1media@gmail.com`
- Remove the Gmail `publish` label if you want

The old `assets/reviews.json` file is no longer read by the site, but it
stays in the repo as the seed source for fresh Worker deploys. Safe to keep.
