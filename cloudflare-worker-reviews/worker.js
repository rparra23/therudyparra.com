/**
 * Reviews Worker — therudyparra.com/#testimonials
 *
 * Endpoints:
 *   GET  /reviews                 -> { reviews: [...] }    public
 *   POST /review                  -> { ok: true, id, review } public, validated
 *   GET  /review/delete?id&sig    -> tiny HTML confirmation, HMAC-signed
 *
 * Storage: a single KV key `reviews:list` holds the full JSON array.
 * (Plenty fast for the volume a personal site sees — read-once, write-once.)
 *
 * On the very first read after deploy, if the KV is empty the Worker seeds
 * itself by fetching /assets/reviews.json from the live site, so the existing
 * static reviews carry over without a manual migration.
 *
 * Required Worker secrets (set via `npx wrangler secret put <NAME>`):
 *   DELETE_HMAC_SECRET    random string used to sign delete links (24+ chars)
 *
 * Optional secrets — if both are set, an email goes to NOTIFY_EMAIL on each
 * new submission with a one-click signed delete link:
 *   RESEND_API_KEY        Resend API key for sending notifications
 *   NOTIFY_EMAIL          inbox to notify (e.g. parrarudy3@icloud.com)
 *   RESEND_FROM           override From, default "therudyparra.com reviews <onboarding@resend.dev>"
 *
 * Optional behavior knobs:
 *   ALLOWED_ORIGIN        default "https://therudyparra.com"
 *   SEED_URL              default "https://therudyparra.com/assets/reviews.json"
 *   MAX_REVIEW_CHARS      int, default 2000
 *   RATE_LIMIT_PER_HOUR   int, default 3 (per IP)
 *   OWNER_NAME            default "Rudy Parra"
 */

const KV_KEY = 'reviews:list';
const RATE_PREFIX = 'rate:';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

function json(body, init = {}, env) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env), ...(init.headers || {}) },
  });
}

// ---------------------------------------------------------------------------
// HMAC for delete links — Web Crypto only, no deps.
// ---------------------------------------------------------------------------

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function loadReviews(env) {
  const raw = await env.REVIEWS.get(KV_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through to seed */ }
  }
  // Seed from the static reviews.json on the live site (first deploy only)
  const seedUrl = env.SEED_URL || 'https://therudyparra.com/assets/reviews.json';
  try {
    const r = await fetch(seedUrl, { cf: { cacheTtl: 0 } });
    if (r.ok) {
      const data = await r.json();
      const seeded = Array.isArray(data.reviews) ? data.reviews.map(withDefaults) : [];
      await env.REVIEWS.put(KV_KEY, JSON.stringify(seeded));
      return seeded;
    }
  } catch { /* ignore */ }
  return [];
}

async function saveReviews(env, list) {
  await env.REVIEWS.put(KV_KEY, JSON.stringify(list));
}

function withDefaults(r) {
  if (!r.id) r.id = newId();
  if (!r.createdAt) r.createdAt = new Date().toISOString();
  return r;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function trimField(v, max) {
  if (v == null) return '';
  return String(v).trim().slice(0, max);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reject obvious throwaway garbage / link spam.
function looksLikeSpam(s) {
  if (!s) return false;
  const urls = (s.match(/https?:\/\//gi) || []).length;
  if (urls >= 3) return true;
  if (/\b(viagra|casino|crypto\s*airdrop|onlyfans|seo\s*service)\b/i.test(s)) return true;
  return false;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function rateLimit(env, ip, limitPerHour) {
  const key = RATE_PREFIX + ip;
  const cur = parseInt(await env.REVIEWS.get(key) || '0', 10);
  if (cur >= limitPerHour) return false;
  await env.REVIEWS.put(key, String(cur + 1), { expirationTtl: 3600 });
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSubmission(body, env) {
  const errs = [];
  if (body.website) errs.push('spam');   // honeypot
  const isAnon = body.anonymous === true || body.anonymous === 'true';
  const name = isAnon ? '' : trimField(body.name, 120);
  const title = isAnon ? '' : trimField(body.title, 120);
  const company = isAnon ? '' : trimField(body.company, 120);
  const connection = trimField(body.connection, 200);
  const review = trimField(body.review, parseInt(env.MAX_REVIEW_CHARS || '2000', 10));

  if (!isAnon && !name) errs.push('name required when not anonymous');
  if (!connection) errs.push('connection required');
  if (!review) errs.push('review required');
  if (review.length < 12) errs.push('review too short');
  if (looksLikeSpam(review) || looksLikeSpam(connection)) errs.push('spam');

  if (errs.length) return { errs };
  return {
    record: {
      anonymous: isAnon,
      name: isAnon ? undefined : name,
      title: isAnon ? undefined : (title || undefined),
      company: isAnon ? undefined : (company || undefined),
      connection,
      review,
    },
  };
}

// ---------------------------------------------------------------------------
// Notification email
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderReviewEmail({ ownerName, record, deleteUrl }) {
  const author = record.anonymous ? 'Anonymous' : (record.name || 'Unnamed');
  const metaParts = [];
  if (!record.anonymous) {
    if (record.title) metaParts.push(record.title);
    if (record.company) metaParts.push(record.company);
  }
  const meta = metaParts.join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <title>New review on therudyparra.com</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b0b10">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #e4e4ea;overflow:hidden">
          <tr>
            <td style="background:linear-gradient(90deg,#a78bfa,#ec4899);height:4px;font-size:0;line-height:0">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px 32px 6px">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#7c3aed">therudyparra.com · testimonials</p>
              <h1 style="margin:8px 0 0;font-size:22px;line-height:1.25;color:#0b0b10;letter-spacing:-0.01em">${escapeHtml(author)} just posted a review</h1>
              <p style="margin:6px 0 0;font-size:14px;color:#6b6b76">It is live on the site now. Use the delete link below if it is spam or you want to take it down.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 4px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${meta ? `<tr><td style="padding:10px 0;border-top:1px solid #f0f0f4">
                    <p style="margin:0;font-size:11px;font-weight:700;color:#6b6b76;text-transform:uppercase;letter-spacing:0.08em">Who</p>
                    <p style="margin:6px 0 0;font-size:15px;color:#0b0b10">${escapeHtml(meta)}</p>
                  </td></tr>` : ''}
                <tr>
                  <td style="padding:10px 0;border-top:1px solid #f0f0f4">
                    <p style="margin:0;font-size:11px;font-weight:700;color:#6b6b76;text-transform:uppercase;letter-spacing:0.08em">Knows ${escapeHtml(ownerName)} via</p>
                    <p style="margin:6px 0 0;font-size:15px;color:#0b0b10">${escapeHtml(record.connection)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 0 16px;border-top:1px solid #f0f0f4">
                    <p style="margin:0;font-size:11px;font-weight:700;color:#6b6b76;text-transform:uppercase;letter-spacing:0.08em">Review</p>
                    <p style="margin:8px 0 0;font-size:15px;line-height:1.55;color:#0b0b10;white-space:pre-wrap">${escapeHtml(record.review)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 26px">
              <a href="${escapeHtml(deleteUrl)}" style="display:inline-block;padding:11px 18px;background:#ef4444;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px">Delete this review</a>
              <p style="margin:10px 0 0;font-size:11px;color:#9b9ba2">One click — the link is signed and only works for this review.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function notifyOwner(env, record, deleteUrl) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;
  const ownerName = env.OWNER_NAME || 'Rudy Parra';
  const html = renderReviewEmail({ ownerName, record, deleteUrl });
  const author = record.anonymous ? 'Anonymous' : (record.name || 'Unnamed');
  const text = [
    `New review on therudyparra.com from ${author}`,
    '',
    `Connection: ${record.connection}`,
    '',
    'Review:',
    record.review,
    '',
    `Delete this review: ${deleteUrl}`,
  ].join('\n');
  const from = env.RESEND_FROM || 'therudyparra.com reviews <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [env.NOTIFY_EMAIL],
        subject: `New review from ${author} — therudyparra.com`,
        html,
        text,
      }),
    });
    if (!r.ok) console.warn('resend failed', r.status, await r.text());
  } catch (err) {
    console.warn('resend threw', err);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    try {
      // GET /reviews — list
      if (request.method === 'GET' && /\/reviews$/.test(path)) {
        const list = await loadReviews(env);
        return json({ reviews: list.map(stripInternal) }, {}, env);
      }

      // POST /review — submit
      if (request.method === 'POST' && /\/review$/.test(path)) {
        const ip = clientIp(request);
        const limit = parseInt(env.RATE_LIMIT_PER_HOUR || '3', 10);
        if (!(await rateLimit(env, ip, limit))) {
          return json({ error: 'too many reviews from your IP this hour — try again later' }, { status: 429 }, env);
        }
        const body = await request.json().catch(() => ({}));
        const { errs, record } = validateSubmission(body, env);
        if (errs) return json({ error: errs.join('; ') }, { status: 400 }, env);

        const list = await loadReviews(env);
        const stored = {
          ...record,
          id: newId(),
          createdAt: new Date().toISOString(),
        };
        list.unshift(stored);                 // newest first
        await saveReviews(env, list);

        // Owner notification with signed delete link
        if (env.DELETE_HMAC_SECRET) {
          const sig = await hmacHex(env.DELETE_HMAC_SECRET, stored.id);
          const deleteUrl = `${url.origin}/review/delete?id=${stored.id}&sig=${sig}`;
          ctx.waitUntil(notifyOwner(env, stored, deleteUrl));
        }

        return json({ ok: true, id: stored.id, review: stripInternal(stored) }, { status: 201 }, env);
      }

      // GET /review/delete — HMAC-protected one-click delete
      if (request.method === 'GET' && /\/review\/delete$/.test(path)) {
        const id = url.searchParams.get('id') || '';
        const sig = url.searchParams.get('sig') || '';
        if (!env.DELETE_HMAC_SECRET || !id || !sig) {
          return htmlPage('Bad request', 'Missing id or signature.', 400);
        }
        const expected = await hmacHex(env.DELETE_HMAC_SECRET, id);
        if (!timingSafeEqualHex(sig, expected)) {
          return htmlPage('Invalid link', 'The delete signature did not match. This link may have been tampered with.', 403);
        }
        const list = await loadReviews(env);
        const before = list.length;
        const next = list.filter(r => r.id !== id);
        if (next.length === before) {
          return htmlPage('Already gone', 'That review has already been deleted (or was never saved).', 404);
        }
        await saveReviews(env, next);
        return htmlPage('Review deleted', `The review is gone. The page will reflect this on the next load.`, 200);
      }

      return new Response('Not found', { status: 404, headers: corsHeaders(env) });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, { status: 500 }, env);
    }
  },
};

// Hide internal fields (createdAt, id) from public list response — keep id
// so the frontend can use it for client-side dedupe after submit.
function stripInternal(r) {
  const { createdAt, ...rest } = r;
  return rest;
}

function htmlPage(title, body, status) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · therudyparra.com</title></head>
<body style="margin:0;padding:0;background:#0b0b10;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div style="max-width:480px;padding:32px;background:#15151c;border:1px solid #2a2a35;border-radius:14px">
    <h1 style="margin:0 0 8px;font-size:22px">${escapeHtml(title)}</h1>
    <p style="margin:0;color:#9b9ba2;line-height:1.5">${escapeHtml(body)}</p>
    <p style="margin:18px 0 0"><a href="https://therudyparra.com/#testimonials" style="color:#22d3ee;text-decoration:none">Back to therudyparra.com</a></p>
  </div>
</body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
