/**
 * Deck gate — Cloudflare Worker
 *
 * Server-side PIN protection for the /talks slide deck. The PIN lives only
 * as a Worker secret; the slide images live only in KV. Nothing about the
 * deck is fetchable without a valid signed token.
 *
 *   POST /unlock            Body: { pin }
 *                           → 200 { token, exp, total } on correct PIN
 *                           → 401 on wrong PIN (rate-limited per IP)
 *                           → 429 after too many attempts
 *
 *   GET  /slide/<NN>?t=…    → image/jpeg if the token verifies and hasn't
 *                             expired; 401 otherwise. NN = 01..TOTAL.
 *
 * Required secrets (set via `npx wrangler secret put <NAME>`):
 *   DECK_PIN         the PIN (digits, any length)
 *   TOKEN_SECRET     random 32+ chars; signs unlock tokens
 *
 * Optional:
 *   ALLOWED_ORIGIN   default "https://therudyparra.com"
 *   TOKEN_TTL_HOURS  default 12
 *   MAX_TRIES_HOUR   default 5 (per IP)
 *   TOTAL_SLIDES     default 35
 *
 * KV binding: DECK — holds `slide:01`…`slide:NN` (raw JPEG bytes, uploaded
 * by setup.sh) and transient `rate:<ip>` counters.
 */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compare via hashes so timing doesn't leak matching prefixes of the PIN.
async function pinMatches(supplied, actual) {
  const a = await sha256Hex('cmp.' + supplied);
  const b = await sha256Hex('cmp.' + actual);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeToken(env, now) {
  const ttlH = parseInt(env.TOKEN_TTL_HOURS || '12', 10);
  const exp = now + ttlH * 3600 * 1000;
  const sig = await hmacHex(env.TOKEN_SECRET, 'deck-v1.' + exp);
  return { token: exp + '.' + sig, exp };
}

async function tokenValid(env, token, now) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = parseInt(token.slice(0, dot), 10);
  if (!exp || exp < now) return false;
  const expected = await hmacHex(env.TOKEN_SECRET, 'deck-v1.' + exp);
  const sig = token.slice(dot + 1);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    const now = Date.now();
    const total = parseInt(env.TOTAL_SLIDES || '35', 10);

    try {
      // ---- POST /unlock ----
      if (request.method === 'POST' && url.pathname.endsWith('/unlock')) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = 'rate:' + ip;
        const tries = parseInt(await env.DECK.get(rateKey) || '0', 10);
        const maxTries = parseInt(env.MAX_TRIES_HOUR || '5', 10);
        if (tries >= maxTries) {
          return json({ error: 'Too many attempts — try again in an hour.' }, 429, env);
        }
        const body = await request.json().catch(() => ({}));
        const pin = String(body.pin || '').trim();
        if (!pin || !(await pinMatches(pin, env.DECK_PIN))) {
          await env.DECK.put(rateKey, String(tries + 1), { expirationTtl: 3600 });
          return json({ error: 'Wrong PIN.' }, 401, env);
        }
        const { token, exp } = await makeToken(env, now);
        return json({ token, exp, total }, 200, env);
      }

      // ---- GET /slide/<NN>?t=token ----
      const m = url.pathname.match(/\/slide\/(\d{2})$/);
      if (request.method === 'GET' && m) {
        const ok = await tokenValid(env, url.searchParams.get('t'), now);
        if (!ok) return json({ error: 'locked' }, 401, env);
        const nn = m[1];
        if (parseInt(nn, 10) < 1 || parseInt(nn, 10) > total) {
          return json({ error: 'no such slide' }, 404, env);
        }
        const bytes = await env.DECK.get('slide:' + nn, 'arrayBuffer');
        if (!bytes) return json({ error: 'slide not uploaded' }, 404, env);
        return new Response(bytes, {
          headers: {
            'Content-Type': 'image/jpeg',
            // Private: browser may cache for the session, shared caches must not.
            'Cache-Control': 'private, max-age=3600',
            ...corsHeaders(env),
          },
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders(env) });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, env);
    }
  },
};
