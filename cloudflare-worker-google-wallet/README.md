# Google Wallet "Save to Wallet" — Cloudflare Worker

This Worker signs a Google Wallet JWT and returns a `pay.google.com/gp/v/save/<JWT>`
URL that the homepage button navigates to. Google then shows the native
"Add to Google Wallet" dialog.

```
Browser  ──GET──▶  Worker  ──signed JWT in URL──▶  pay.google.com
Browser  ◀─JSON──  Worker  (saveUrl)
Browser  ──redirect──────────────────────────────▶  Google Wallet
```

## What you need (one-time, ~45 min + waiting for issuer approval)

1. A Google account (the one you want to issue passes under)
2. Google Cloud account (free)
3. Google Pay & Wallet Console access (free)
4. Cloudflare account (free; you already have it from the Pii Energy work)

## Setup walkthrough

### Step 1. Create a Google Cloud project (5 min)

1. Go to <https://console.cloud.google.com>
2. Click the project dropdown → **New Project**
3. Project name: `therudyparra-wallet` (or whatever)
4. Create. Select it.

### Step 2. Enable the Google Wallet API (1 min)

1. In Cloud Console → **APIs & Services → Library**
2. Search **Google Wallet API** → **Enable**

### Step 3. Create a service account (3 min)

1. **IAM & Admin → Service Accounts → + Create Service Account**
2. Service account name: `wallet-signer`
3. Skip the role/permissions step (we'll grant via Wallet Console)
4. **Create**, then click the new service account
5. **Keys** tab → **Add Key → Create new key → JSON → Create**
6. A `wallet-signer-xxxxx.json` file downloads. **Keep it safe.**

That JSON file contains two values you need:
- `client_email` — looks like `wallet-signer@therudyparra-wallet.iam.gserviceaccount.com`
- `private_key` — multi-line PEM string starting `-----BEGIN PRIVATE KEY-----`

### Step 4. Get an Issuer ID from the Google Pay & Wallet Console (5 min + approval wait)

1. Go to <https://pay.google.com/business/console>
2. Sign in with the SAME Google account as the Cloud project
3. **Get started → Generic** (for contact-card-style passes)
4. Fill in business info:
   - Business name: `Rudy Parra`
   - Business location: New Mexico, US
   - Class type: Generic
5. Submit. You'll see your **Issuer ID** (a long number) in the console header.

   **Test passes work immediately.** Public/production passes need approval —
   for a contact card, request publishing access via the **Publishing access**
   tab. Takes anywhere from a few hours to several days.

### Step 5. Link the service account to your Issuer (2 min)

1. In the Google Pay & Wallet Console, go to **Users**
2. **Invite a user** → paste the service account email from Step 3
3. Role: **Admin** (so it can create/update passes)
4. Send

### Step 6. Create a Pass Class (5 min)

A "class" is the template; "objects" are instances. We need one class for
contact passes. Easiest path: use Google's online class creator.

1. In Wallet Console → **Generic → Classes → Create**
2. Class ID suffix: `contact-v1` (so full ID = `<ISSUER>.contact-v1`)
3. Just leave most fields blank — we'll override per-object from the Worker
4. Save

(If you'd rather do this via API, see <https://developers.google.com/wallet/generic/web/create-a-class>.)

### Step 7. Deploy the Worker (5 min)

```bash
cd cloudflare-worker-google-wallet
npm install -g wrangler          # skip if already installed
wrangler login                   # opens browser

wrangler secret put GOOGLE_ISSUER_ID
# paste your Issuer ID (digits only)

wrangler secret put GOOGLE_CLASS_ID
# paste: <ISSUER>.contact-v1   (full class ID, period in the middle)

wrangler secret put GOOGLE_SA_EMAIL
# paste the service-account email

wrangler secret put GOOGLE_SA_PRIVATE_KEY
# paste the *entire* private_key value from the JSON,
# INCLUDING the BEGIN/END lines and the newlines.
# wrangler accepts multi-line input — paste then hit Ctrl+D (macOS) when done.

wrangler deploy
```

`wrangler deploy` prints a URL like
`https://google-wallet.<your-user>.workers.dev`. Copy it.

### Step 8. Wire the site to the Worker (1 min)

Edit `../assets/wallet-config.json`:

```json
{
  "applePkpassUrl": "...",
  "googleWalletJwtUrl": "https://google-wallet.YOUR-USER.workers.dev"
}
```

Commit and push:
```bash
git add assets/wallet-config.json
git commit -m "Wire up Google Wallet button"
git push
```

### Step 9. Test on Android

Open <https://therudyparra.com> on an Android phone → tap **Save to Google Wallet**.

If your issuer is in **test mode** (publishing access not yet approved), only
test users can save the pass. To add yourself as a test user:
1. Wallet Console → **Settings → Linked email addresses → Add**
2. Add your personal Google account email

Otherwise the save URL returns "This pass isn't yet available."

## When you update your contact info

Edit `worker.js` → `buildGenericObject()` to change phone/email/title/etc.,
then `wrangler deploy`. The next click on the button picks up the new data.

(You don't need to redeploy the class — the object claims override class
fields per-instance.)

## Security notes

- **Never commit the service-account JSON.** The `.gitignore` excludes it.
- The Worker holds the private key as a secret; secrets are encrypted at
  rest on Cloudflare and never exposed in responses.
- If the key leaks, regenerate a new one in Cloud Console → Service Accounts
  → Keys → delete old, add new, run `wrangler secret put GOOGLE_SA_PRIVATE_KEY`
  with the new value.

## Troubleshooting

- **`Missing secret: GOOGLE_SA_PRIVATE_KEY`**: re-run `wrangler secret put` for that
  secret. Confirm it pasted correctly (check there are no `\n` literals or
  truncation).
- **Worker responds but Google says "pass not found"**: your `GOOGLE_CLASS_ID`
  doesn't match the class you actually created in the Wallet Console. Re-check.
- **Save URL works on YOUR phone but not on others'**: the issuer is in test
  mode. See Step 9's "test users" note, or request publishing access.
- **Pass shows up but no logo/hero image**: the image URLs must be publicly
  reachable HTTPS URLs (which `https://therudyparra.com/assets/profile.jpg`
  already is — but double-check Pages is serving it).
