/**
 * Meeting scheduler — Cloudflare Worker
 *
 * Two endpoints:
 *   GET  /availability?days=14         -> { slots: [{ start, end }, ...] }
 *                                         All free 30-min slots over the
 *                                         next N days, computed from Google
 *                                         Calendar freebusy across all the
 *                                         calendars you list in CALENDAR_IDS.
 *
 *   POST /book                         -> { meetUrl, eventId, htmlLink }
 *                                         Body: { start, end, name, email,
 *                                                 note, website (honeypot) }
 *                                         Creates an event with a Google Meet
 *                                         link and sends invites.
 *
 * Required Worker secrets (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *   CALENDAR_IDS          comma-separated, e.g. "primary,xxxx@group.calendar.google.com"
 *   OWNER_EMAIL           your Google email (used as event organizer)
 *
 * Optional secrets:
 *   ALLOWED_ORIGIN        default "https://therudyparra.com"
 *   TIMEZONE              IANA zone, default "America/Denver"
 *   DAILY_START_HOUR      24h int, default 7
 *   DAILY_END_HOUR        24h int, default 22
 *   SLOT_MINUTES          int, default 30
 *   BUFFER_MINUTES        int, default 15
 *   MIN_NOTICE_HOURS      int, default 2
 *   OWNER_NAME            default "Rudy Parra"
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
const EVENTS_URL = (cal) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?conferenceDataVersion=1&sendUpdates=all`;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfg(env) {
  return {
    tz: env.TIMEZONE || 'America/Denver',
    dayStartH: parseInt(env.DAILY_START_HOUR || '7', 10),
    dayEndH:   parseInt(env.DAILY_END_HOUR   || '22', 10),
    slotMin:   parseInt(env.SLOT_MINUTES     || '30', 10),
    bufferMin: parseInt(env.BUFFER_MINUTES   || '15', 10),
    minNoticeMs: parseInt(env.MIN_NOTICE_HOURS || '2', 10) * 3600 * 1000,
    calendarIds: (env.CALENDAR_IDS || 'primary').split(',').map(s => s.trim()).filter(Boolean),
    ownerEmail: env.OWNER_EMAIL,
    ownerName:  env.OWNER_NAME || 'Rudy Parra',
  };
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

// ---------------------------------------------------------------------------
// Google OAuth — refresh-token grant
// ---------------------------------------------------------------------------

async function getAccessToken(env) {
  const body = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}

// ---------------------------------------------------------------------------
// Timezone arithmetic (no Date.now() usage that could leak UTC drift)
// ---------------------------------------------------------------------------

/** Format a Date as `yyyy-mm-dd` in the target timezone. */
function localDateKey(d, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d); // en-CA yields YYYY-MM-DD
}

/** Build a Date that represents `yyyy-mm-dd HH:MM` in the given IANA timezone. */
function dateInTZ(y, m, d, hh, mm, tz) {
  // We exploit Intl.DateTimeFormat to find the UTC instant whose local
  // representation in `tz` matches the requested components.
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  const actual = Date.UTC(get('year'), get('month') - 1, get('day'),
                          get('hour'), get('minute'), get('second'));
  const offset = guess - actual;       // UTC - local representation
  return new Date(guess + offset);
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

async function getBusyWindows(env, timeMin, timeMax) {
  const access = await getAccessToken(env);
  const conf = cfg(env);
  const r = await fetch(FREEBUSY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin, timeMax, timeZone: conf.tz,
      items: conf.calendarIds.map(id => ({ id })),
    }),
  });
  if (!r.ok) throw new Error(`freebusy failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const merged = [];
  for (const id of Object.keys(data.calendars || {})) {
    for (const b of data.calendars[id].busy || []) {
      merged.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
    }
  }
  // Merge overlapping windows
  merged.sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of merged) {
    if (out.length && w.start <= out[out.length - 1].end) {
      out[out.length - 1].end = Math.max(out[out.length - 1].end, w.end);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

function slotIsFree(start, end, busy, bufferMs) {
  for (const w of busy) {
    if (start < w.end + bufferMs && end + bufferMs > w.start) return false;
  }
  return true;
}

async function computeAvailability(env, days) {
  const conf = cfg(env);
  const now = new Date();
  const earliest = now.getTime() + conf.minNoticeMs;

  // Range covers `days` from "today" in TZ inclusive.
  const todayKey = localDateKey(now, conf.tz);
  const [ty, tm, td] = todayKey.split('-').map(n => parseInt(n, 10));
  const startBoundary = dateInTZ(ty, tm, td, 0, 0, conf.tz);
  const endBoundary = new Date(startBoundary.getTime() + days * 86400 * 1000);

  const busy = await getBusyWindows(env, startBoundary.toISOString(), endBoundary.toISOString());

  const slots = [];
  const bufferMs = conf.bufferMin * 60 * 1000;
  const slotMs = conf.slotMin * 60 * 1000;

  for (let i = 0; i < days; i++) {
    const dayStart = dateInTZ(ty, tm, td + i, conf.dayStartH, 0, conf.tz);
    const dayEnd =   dateInTZ(ty, tm, td + i, conf.dayEndH,   0, conf.tz);
    for (let t = dayStart.getTime(); t + slotMs <= dayEnd.getTime(); t += slotMs) {
      if (t < earliest) continue;
      const s = t, e = t + slotMs;
      if (slotIsFree(s, e, busy, bufferMs)) {
        slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
      }
    }
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

async function createBooking(env, payload) {
  const conf = cfg(env);
  const access = await getAccessToken(env);
  const { start, end, name, email, note } = payload;
  const requestId = 'tnp-' + start.replace(/[^0-9]/g, '');

  const body = {
    summary: `${conf.ownerName} ↔ ${name}`,
    description: [
      `Booked via therudyparra.com/book`,
      note ? `Note from ${name}: ${note}` : null,
    ].filter(Boolean).join('\n\n'),
    start: { dateTime: start, timeZone: conf.tz },
    end:   { dateTime: end,   timeZone: conf.tz },
    attendees: [
      { email: conf.ownerEmail, displayName: conf.ownerName, organizer: true, responseStatus: 'accepted' },
      { email, displayName: name, responseStatus: 'needsAction' },
    ],
    conferenceData: {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
    reminders: { useDefault: true },
  };

  const r = await fetch(EVENTS_URL(conf.calendarIds[0] || 'primary'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`events.insert failed: ${r.status} ${await r.text()}`);

  const evt = await r.json();
  const meet =
    (evt.conferenceData && evt.conferenceData.entryPoints || []).find(p => p.entryPointType === 'video');
  return {
    eventId:  evt.id,
    htmlLink: evt.htmlLink,
    meetUrl:  meet ? meet.uri : null,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBooking(payload, env) {
  const conf = cfg(env);
  const errs = [];
  for (const k of ['start', 'end', 'name', 'email']) {
    if (!payload[k] || typeof payload[k] !== 'string') errs.push(`missing ${k}`);
  }
  if (payload.website) errs.push('spam'); // honeypot
  if (errs.length) return errs;

  const s = new Date(payload.start).getTime();
  const e = new Date(payload.end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return ['bad timestamps'];
  if (e - s !== conf.slotMin * 60 * 1000) return ['unexpected slot length'];
  if (s < Date.now() + conf.minNoticeMs - 60 * 1000) return ['slot too soon'];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return ['bad email'];
  if (payload.name.length > 120 || payload.email.length > 200) return ['too long'];
  return null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname.endsWith('/availability')) {
        const days = Math.min(parseInt(url.searchParams.get('days') || '14', 10) || 14, 30);
        const slots = await computeAvailability(env, days);
        const conf = cfg(env);
        return new Response(JSON.stringify({
          slots,
          tz: conf.tz,
          slotMinutes: conf.slotMin,
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/book')) {
        const payload = await request.json().catch(() => ({}));
        const errs = validateBooking(payload, env);
        if (errs) {
          return new Response(JSON.stringify({ error: errs.join('; ') }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
          });
        }
        // Re-check the slot is still free before booking.
        const busy = await getBusyWindows(env, payload.start, payload.end);
        if (busy.length) {
          return new Response(JSON.stringify({ error: 'slot was just taken — please pick another' }), {
            status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
          });
        }
        const result = await createBooking(env, payload);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
        });
      }
      return new Response('Not found', { status: 404, headers: corsHeaders(env) });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err && err.message || err) }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }
  },
};
