/**
 * Spotify "currently playing" proxy — Cloudflare Worker
 *
 * The browser cannot hit Spotify's API directly: it would require leaking your
 * refresh token in client JS. This Worker holds the secret and exposes a tiny
 * JSON endpoint that returns just what the homepage pill needs.
 *
 * GET / -> { is_playing, song, artist, album, album_art, song_url }
 *
 * Required Worker secrets (set via `npx wrangler secret put <NAME>` or the
 * Cloudflare dashboard → Workers & Pages → your Worker → Settings → Variables):
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *   SPOTIFY_REFRESH_TOKEN
 *
 * Optional:
 *   ALLOWED_ORIGIN (default: "https://therudyparra.com")
 */

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_NOW_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

async function getAccessToken(env) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.SPOTIFY_REFRESH_TOKEN,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchNowPlaying(env) {
  const access = await getAccessToken(env);
  const res = await fetch(SPOTIFY_NOW_URL, {
    headers: { Authorization: `Bearer ${access}` },
  });

  // 204 = nothing playing
  if (res.status === 204 || res.status === 202) {
    return { is_playing: false };
  }
  if (!res.ok) {
    throw new Error(`Spotify ${res.status}`);
  }

  const json = await res.json();
  if (!json || !json.item) {
    return { is_playing: !!(json && json.is_playing) };
  }

  const item = json.item;
  const artist = (item.artists || []).map(a => a.name).join(', ');
  const art = (item.album && item.album.images && item.album.images[0] && item.album.images[0].url) || null;

  return {
    is_playing: !!json.is_playing,
    song: item.name,
    artist,
    album: item.album ? item.album.name : null,
    album_art: art,
    song_url: item.external_urls ? item.external_urls.spotify : null,
  };
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=20',
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(env) });
    }

    try {
      const payload = await fetchNowPlaying(env);
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ is_playing: false, error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }
  },
};
