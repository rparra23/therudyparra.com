# Spotify Now Playing — Cloudflare Worker

Tiny proxy between the homepage and Spotify's "currently playing" API.
The browser never sees your Spotify credentials.

```
Browser  ──GET──▶  Worker  ──refresh token──▶  Spotify
                              currently-playing
Browser  ◀─JSON──  Worker  ◀──────────────────  Spotify
```

## One-time setup (~15 minutes)

### 1. Create a Spotify Developer app

1. Sign in at <https://developer.spotify.com/dashboard> with your normal
   Spotify account.
2. Click **Create App**.
   - App name: `therudyparra.com` (or whatever)
   - App description: `Now-playing widget for my personal site`
   - Redirect URIs: `http://127.0.0.1:8888/callback`
     *(used only once during the token-grab step below — it does not need
     to be publicly reachable)*
   - APIs/SDKs: leave Web API ticked
   - Tick the Terms checkbox → **Save**
3. Open the new app → **Settings**. Copy the **Client ID** and reveal the
   **Client Secret**. Keep them handy.

### 2. Grab a refresh token (you do this once, by hand)

This is the only "you" step that touches OAuth. After this the Worker
refreshes tokens on its own forever.

1. Open this URL in a browser, replacing `YOUR_CLIENT_ID`:

   ```
   https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback&scope=user-read-currently-playing
   ```

2. Approve. Spotify redirects you to a `http://127.0.0.1:8888/callback?code=...`
   URL that will fail to load — that's fine. Copy the `code=` value from the
   address bar.

3. In a terminal, exchange the code for tokens:

   ```bash
   curl -X POST https://accounts.spotify.com/api/token \
     -u "YOUR_CLIENT_ID:YOUR_CLIENT_SECRET" \
     -d grant_type=authorization_code \
     -d code=THE_CODE_FROM_STEP_2 \
     -d redirect_uri=http://127.0.0.1:8888/callback
   ```

4. The response includes `"refresh_token": "..."`. **Save it.** That's the
   one that goes in the Worker. (The `access_token` field is short-lived
   and the Worker mints fresh ones itself.)

### 3. Deploy the Worker

```bash
# from inside this directory
npm install -g wrangler          # one-time
wrangler login                   # opens browser → log into Cloudflare
wrangler secret put SPOTIFY_CLIENT_ID
wrangler secret put SPOTIFY_CLIENT_SECRET
wrangler secret put SPOTIFY_REFRESH_TOKEN
wrangler deploy
```

When `deploy` finishes it prints a URL like
`https://now-playing.<your-username>.workers.dev` — copy that.

### 4. Wire the site to the Worker

In the main repo, open `assets/now-playing.json` and replace the placeholder:

```json
{
  "workerUrl": "https://now-playing.YOUR-USER.workers.dev"
}
```

Commit and push. Within ~60 seconds the homepage will start polling the
Worker every 30s. When you're playing something, the "Now playing" pill
appears at the top of the hero. When you're not, it stays hidden.

## Customizing the allowed origin

By default the Worker allows requests from `https://therudyparra.com`. To
restrict it further or allow a localhost dev URL, set the optional
`ALLOWED_ORIGIN` secret:

```bash
wrangler secret put ALLOWED_ORIGIN
# enter: https://therudyparra.com
```

## Why all this for one tiny pill?

- Spotify requires a refresh token to keep playing data fresh.
- Refresh tokens cannot live in the browser without leaking.
- Cloudflare Workers are free (100k requests/day), instant globally, and
  perfect for "tiny secret-holder" jobs like this.

If the Spotify dashboard or Cloudflare ever changes their UI and you get
stuck, ping Claude with the exact error message and the next step usually
takes 30 seconds.
