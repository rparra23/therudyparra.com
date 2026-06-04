# Google My Maps → /eats — Cloudflare Worker

The /eats page on therudyparra.com normally reads from `assets/restaurants.json`
in the repo. This Worker lets it pull from a **Google My Maps** map instead, so
adding a place in My Maps automatically updates the site within a few minutes.

```
Browser  ──GET──▶  Worker  ──KML feed──▶  Google My Maps
Browser  ◀─JSON──  Worker  ◀─────────────  KML XML
```

## How the site picks the source

`/eats` reads `assets/eats-config.json`. While `workerUrl` contains the
placeholder string `YOUR-WORKER`, the page reads the local
`assets/restaurants.json` instead. Once you set `workerUrl` to your deployed
Worker URL, the page switches to live My Maps data automatically.

This means you can deploy this Worker whenever you're ready — the site keeps
working in the meantime.

---

## One-time setup (~20 min)

### 1. Create a Google My Map

1. Go to <https://mymaps.google.com> and sign in.
2. Click **Create a new map**.
3. Title it (e.g. "Rudy's Favorite Restaurants").

### 2. (Optional) Import your existing Saved List

If you already have a Saved List in Google Maps and want to migrate it in
one shot:

1. Open the Saved List in Google Maps on a laptop.
2. Click the **⋮ menu** on the list → **Share list** → make it accessible
   if needed.
3. There's no first-party Saved-Lists → KML export, but you can copy each
   place into the new My Map by:
   - In the new My Map, search for each restaurant by name in the top search bar
   - Click the result → "Add to map"
   - Repeat per restaurant

   (Tedious but only once. If you have 20+ places, paste me the names in
   chat and I'll dictate the order so it's quick.)

### 3. Make the map public

1. In your My Map, click the **Share** button at the top left.
2. Under **General access**, change from "Restricted" to **"Anyone with the
   link"** with **Viewer** permission.
3. Save.

### 4. Grab the map ID

In your My Map's URL bar you'll see something like:

```
https://www.google.com/maps/d/edit?mid=1A2bCdEfGhIjKlMnOpQrStUvWxYz&ll=…
```

Copy the value of `mid=` — that's your **MAP_ID**.

### 5. Deploy the Worker

```bash
cd cloudflare-worker-mymap-eats
npm install -g wrangler           # one-time, skip if already installed
wrangler login                    # opens browser → log into Cloudflare
wrangler secret put MAP_ID
# paste your MAP_ID when prompted
wrangler deploy
```

`wrangler deploy` prints a URL like
`https://mymap-eats.<your-cf-username>.workers.dev`. Copy it.

### 6. Wire the site to the Worker

In the main repo, edit `assets/eats-config.json` and set:

```json
{
  "workerUrl": "https://mymap-eats.YOUR-USER.workers.dev"
}
```

Commit and push. Within ~30 seconds the /eats page starts pulling from
your Google My Map instead of the local JSON.

### 7. Add a place from your phone

1. Open the My Maps app (or mymaps.google.com on mobile)
2. Tap the search bar, find the place, tap **Add to map**
3. Within ~10 minutes the place shows up on /eats

(The 10-minute lag is the Worker's edge cache. To bust it for testing,
visit `https://mymap-eats.YOUR-USER.workers.dev?ts=<random>` in a
private window.)

---

## Optional tweaks

### Tighten the allowed origin

By default the Worker accepts requests from `https://therudyparra.com`.
To allow a localhost dev URL too, set:

```bash
wrangler secret put ALLOWED_ORIGIN
# enter: https://therudyparra.com,http://localhost:8000
```

(Note: the Worker code only supports one allowed origin at a time —
edit `worker.js` to support multiple if you need.)

### Change the cache window

Default cache is 10 minutes (`CACHE_SECONDS=600`). If you want updates
to land faster, lower it:

```bash
wrangler secret put CACHE_SECONDS
# enter: 60   (1 minute)
```

Don't go below 30 seconds — Google rate-limits the KML endpoint.

---

## How notes show up in the popup

In Google My Maps, when you click a place, there's a **description** field.
Whatever you type there becomes the note on /eats. If the first line of your
description looks like an address (e.g. `2400 Central Ave SE, ABQ NM`), the
Worker uses it as the address; everything else becomes the note text.

So a description like:

```
2400 Central Ave SE, Albuquerque, NM
The sweet rolls are the move. Sit at the counter.
```

Renders as:

> **Frontier Restaurant**
> 2400 Central Ave SE, Albuquerque, NM
> The sweet rolls are the move. Sit at the counter.

---

## Troubleshooting

- **`/eats` still shows starter spots after wiring up** — Reload with
  shift-click or open a private window; the browser may be caching.
- **`{ spots: [], error: "Google KML 404" }`** — The map isn't actually
  public yet. Re-check the Share settings; it must be "Anyone with the
  link → Viewer".
- **`MAP_ID not configured`** — `wrangler secret put MAP_ID` didn't take.
  Re-run it and re-deploy.
- **Spots show but addresses don't** — My Maps doesn't separate "address"
  from "note" in its KML. Either include the address as the first line of
  the description, or accept that the popup just shows your note.
