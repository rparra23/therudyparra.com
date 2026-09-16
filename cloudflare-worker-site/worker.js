/**
 * rudy-site — one Worker behind therudyparra.com's dynamic features.
 *
 * Routes:
 *   GET  /events        → upcoming events JSON (refreshed from ICS feeds by cron)
 *   POST /met           → "we met at an event" lead capture (rate limited)
 *   GET  /met/list      → leads (Bearer ADMIN_KEY)
 *   POST /hit           → pageview beacon (first-party, no cookies)
 *   GET  /stats         → last 30 days of pageviews + link clicks (Bearer ADMIN_KEY)
 *   GET  /go/<slug>     → tracked redirect (slugs live in KV as link:<slug>)
 *
 * KV binding: SITE.  Secrets: ADMIN_KEY, ICS_URLS (comma-separated feed URLs).
 * Cron: refreshes events:json every 6 hours.
 *
 * Manage short links:
 *   npx wrangler kv key put --remote --binding SITE "link:techfest" "https://luma.com/mh1l9c39"
 */

const ALLOWED_ORIGINS = ['https://therudyparra.com', 'https://www.therudyparra.com'];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return env.ADMIN_KEY && auth === `Bearer ${env.ADMIN_KEY}`;
}

/* ---------- minimal ICS parsing ---------- */

function unfoldICS(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseICSDate(value, params) {
  // Forms: 20261026T180000Z | 20261026T180000 (with TZID) | 20261026 (VALUE=DATE)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  const allDay = !value.includes('T');
  let iso;
  if (z) iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  else if (allDay) iso = `${y}-${mo}-${d}T00:00:00-06:00`;
  else iso = `${y}-${mo}-${d}T${h}:${mi}:${s}-06:00`; // best effort: Mountain Time feeds
  return { iso, allDay, ts: Date.parse(iso) };
}

function parseICS(text) {
  const events = [];
  const blocks = unfoldICS(text).split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const get = (prop) => {
      const re = new RegExp(`^${prop}([^:\\n]*):(.*)$`, 'm');
      const m = body.match(re);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    if (!summary || !dtstart) continue;
    const start = parseICSDate(dtstart.value, dtstart.params);
    if (!start) continue;
    const dtend = get('DTEND');
    const end = dtend ? parseICSDate(dtend.value, dtend.params) : null;
    const loc = get('LOCATION');
    const url = get('URL');
    const desc = get('DESCRIPTION');
    // Pull the first http(s) link out of the description as a fallback URL
    let link = url ? url.value : null;
    if (!link && desc) {
      const lm = desc.value.replace(/\\n/g, '\n').match(/https?:\/\/[^\s"\\,]+/);
      if (lm) link = lm[0];
    }
    events.push({
      title: summary.value.replace(/\\,/g, ',').replace(/\\;/g, ';'),
      start: start.iso,
      startTs: start.ts,
      end: end ? end.iso : null,
      endTs: end ? end.ts : null,
      allDay: start.allDay,
      location: loc ? loc.value.replace(/\\,/g, ',').replace(/\\n/g, ', ').split(',')[0].trim() : null,
      url: link,
    });
  }
  return events;
}

function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Privacy gate: only events that link to a public events platform are ever
 *  published. Personal calendar items (appointments, flights, birthdays)
 *  carry no such link, so they can never appear on the site. To publish an
 *  event from a personal calendar, put its ticket/RSVP link in the event. */
const PUBLIC_EVENT_HOSTS = [
  'lu.ma', 'luma.com', 'eventbrite.com', 'partiful.com', 'meetup.com',
  'gdg.community.dev', 'newmexicotechweek.com', 'nmtechfest.com',
  'fcsuite.com', 'universe.com', 'startupworldcup.io', 'gmisconference.org',
  'nmtechcouncil.org', 'techqueria.org', 'nmtechtalks.com',
];
function isPublicEvent(e) {
  if (!e.url) return false;
  try {
    const host = new URL(e.url).hostname.toLowerCase();
    return PUBLIC_EVENT_HOSTS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

/** Pull the event's artwork from its page: the real Luma cover when there is
 *  one (re-requested as a 720px square), else the page's og:image. */
async function fetchEventImage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (rudy-site-worker)' }, redirect: 'follow' });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 400000);
    let m = html.match(/https:\/\/images\.lumacdn\.com\/cdn-cgi\/image\/[^"'\\ ]*(?:event-covers|uploads)\/[^"'\\ ]+\.(?:png|jpg|jpeg|webp)/);
    if (m) {
      const path = m[0].match(/(?:event-covers|uploads)\/.*/)[0];
      return `https://images.lumacdn.com/cdn-cgi/image/format=jpeg,fit=cover,dpr=1,anim=false,background=white,quality=80,width=720,height=720/${path}`;
    }
    m = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/);
    if (m) {
      const img = m[1].replace(/&amp;/g, '&');
      return /^https:\/\/[^"'\\ ]+$/.test(img) ? img : null;
    }
    return null;
  } catch { return null; }
}

async function refreshEvents(env) {
  const urls = (env.ICS_URLS || '').split(',')
    .map(u => u.trim().replace(/^webcal:\/\//i, 'https://'))
    .filter(Boolean);
  if (!urls.length) return { error: 'ICS_URLS not configured' };
  const all = [];
  const feedErrors = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'rudy-site-worker' } });
      if (r.ok) all.push(...parseICS(await r.text()));
      else feedErrors.push(`${u.slice(0, 60)}… → ${r.status}`);
    } catch (e) { feedErrors.push(`${u.slice(0, 60)}… → ${e.message}`); }
  }
  const now = Date.now();
  const horizon = now + 150 * 24 * 3600 * 1000;
  const inWindow = all.filter(e => (e.endTs || e.startTs) > now && e.startTs < horizon);
  const publicOnly = inWindow.filter(isPublicEvent);
  const upcoming = publicOnly
    .sort((a, b) => a.startTs - b.startTs)
    .slice(0, 24);
  const filteredOut = inWindow.length - publicOnly.length;

  // Fetch artwork before de-duping so we can keep the copy that has it.
  await Promise.all(upcoming.map(async e => {
    if (e.url) e.image = await fetchEventImage(e.url);
  }));

  // De-dupe across feeds: same day + same/contained/mostly-overlapping title.
  // When two copies collide, prefer the one with artwork.
  const kept = [];
  for (const e of upcoming) {
    const day = e.start.slice(0, 10);
    const nt = normTitle(e.title);
    const toks = new Set(nt.split(' ').filter(w => w.length > 3));
    let dup = null;
    for (const k of kept) {
      if (k.start.slice(0, 10) !== day) continue;
      const knt = normTitle(k.title);
      if (knt === nt || knt.includes(nt) || nt.includes(knt)) { dup = k; break; }
      const ktoks = knt.split(' ').filter(w => w.length > 3);
      const inter = ktoks.filter(w => toks.has(w)).length;
      const denom = Math.min(toks.size, ktoks.length) || 1;
      if (inter >= 2 && inter / denom >= 0.6) { dup = k; break; }
    }
    if (dup) {
      if (e.image && !dup.image) Object.assign(dup, e);
      continue;
    }
    kept.push(e);
  }

  await env.SITE.put('events:json', JSON.stringify({ updated: new Date().toISOString(), events: kept }));
  return { count: kept.length, keptPrivate: filteredOut, feedErrors };
}

/* ---------- handlers ---------- */

async function handleMet(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:met:${ip}`;
  const count = parseInt((await env.SITE.get(rlKey)) || '0', 10);
  if (count >= 10) return json({ error: 'Too many submissions — try again later.' }, request, 429);
  await env.SITE.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, request, 400); }
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const entry = {
    name: clean(body.name, 120),
    contact: clean(body.contact, 200),
    event: clean(body.event, 120),
    note: clean(body.note, 500),
    at: new Date().toISOString(),
  };
  if (!entry.name) return json({ error: 'Name is required.' }, request, 400);
  const id = `met:${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await env.SITE.put(id, JSON.stringify(entry));
  return json({ ok: true }, request);
}

async function listPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.SITE.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await env.SITE.get(k.name);
      out.push({ key: k.name, value: v ? JSON.parse(v) : null });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function handleHit(request, env, ctx) {
  let path = '/';
  try { path = new URL((await request.json()).p || '/', 'https://x').pathname.slice(0, 80); } catch {}
  const day = new Date().toISOString().slice(0, 10);
  const key = `hits:${day}:${path}`;
  ctx.waitUntil((async () => {
    const n = parseInt((await env.SITE.get(key)) || '0', 10);
    await env.SITE.put(key, String(n + 1), { expirationTtl: 90 * 24 * 3600 });
  })());
  return json({ ok: true }, request);
}

async function handleStats(request, env) {
  const hits = {};
  let cursor;
  do {
    const page = await env.SITE.list({ prefix: 'hits:', cursor });
    for (const k of page.keys) {
      const [, day, ...rest] = k.name.split(':');
      const path = rest.join(':');
      const n = parseInt((await env.SITE.get(k.name)) || '0', 10);
      hits[day] = hits[day] || {};
      hits[day][path] = (hits[day][path] || 0) + n;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const clicks = {};
  cursor = undefined;
  do {
    const page = await env.SITE.list({ prefix: 'clicks:', cursor });
    for (const k of page.keys) {
      clicks[k.name.slice(7)] = parseInt((await env.SITE.get(k.name)) || '0', 10);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return json({ hits, clicks }, request);
}

async function handleGo(request, env, ctx, slug) {
  const dest = await env.SITE.get(`link:${slug}`);
  if (!dest) return new Response('Not found', { status: 404 });
  ctx.waitUntil((async () => {
    const key = `clicks:${slug}`;
    const n = parseInt((await env.SITE.get(key)) || '0', 10);
    await env.SITE.put(key, String(n + 1));
  })());
  return Response.redirect(dest, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (path === '/events' && request.method === 'GET') {
      const cached = await env.SITE.get('events:json');
      if (cached) {
        return new Response(cached, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', ...corsHeaders(request) },
        });
      }
      return json({ updated: null, events: [] }, request);
    }
    if (path === '/events/refresh' && request.method === 'POST') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, request, 401);
      return json(await refreshEvents(env), request);
    }
    if (path === '/met' && request.method === 'POST') return handleMet(request, env);
    if (path === '/met/list' && request.method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, request, 401);
      const rows = await listPrefix(env, 'met:');
      rows.sort((a, b) => (a.key < b.key ? 1 : -1));
      return json({ leads: rows.map(r => ({ id: r.key, ...r.value })) }, request);
    }
    if (path === '/hit' && request.method === 'POST') return handleHit(request, env, ctx);
    if (path === '/stats' && request.method === 'GET') {
      if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, request, 401);
      return handleStats(request, env);
    }
    const go = path.match(/^\/go\/([A-Za-z0-9_-]{1,60})$/);
    if (go && request.method === 'GET') return handleGo(request, env, ctx, go[1]);

    return new Response('rudy-site worker', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEvents(env));
  },
};
