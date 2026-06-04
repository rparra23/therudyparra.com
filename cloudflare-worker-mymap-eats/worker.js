/**
 * Google My Maps → JSON proxy — Cloudflare Worker
 *
 * Fetches a public Google My Map's KML feed, parses Placemarks, returns
 * a small JSON shaped for the /eats page on therudyparra.com.
 *
 * GET / -> {
 *   spots: [
 *     { name, address, note, lat, lng, link }
 *   ]
 * }
 *
 * Required Worker variable (set via `wrangler secret put MAP_ID` or the
 * Cloudflare dashboard → Workers → Variables):
 *   MAP_ID  — the `mid=` value from your Google My Maps URL
 *
 * Optional:
 *   ALLOWED_ORIGIN   default: "https://therudyparra.com"
 *   CACHE_SECONDS    default: 600 (10 minutes)
 */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': `public, max-age=${env.CACHE_SECONDS || 600}`,
  };
}

/** Unescape XML entities inside text nodes/CDATA. */
function unxml(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Strip simple HTML tags from My Maps descriptions while keeping the text. */
function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Very small KML parser tuned for Google My Maps output.
 * Returns an array of { name, description, lat, lng } objects.
 * Avoids pulling in a full XML parser — bundle size matters on Workers.
 */
function parseKml(kml) {
  const out = [];
  const placemarkRe = /<Placemark[\s\S]*?<\/Placemark>/g;
  const nameRe = /<name>([\s\S]*?)<\/name>/;
  const descRe = /<description>([\s\S]*?)<\/description>/;
  const coordRe = /<coordinates>([\s\S]*?)<\/coordinates>/;

  const matches = kml.match(placemarkRe) || [];
  for (const pm of matches) {
    const name = unxml((pm.match(nameRe) || [, ''])[1]);
    const desc = stripHtml(unxml((pm.match(descRe) || [, ''])[1]));
    const coordsRaw = unxml((pm.match(coordRe) || [, ''])[1]);
    if (!coordsRaw) continue;
    // KML coords are "lng,lat[,alt]" — take only the first tuple
    const [first] = coordsRaw.split(/\s+/).filter(Boolean);
    const [lngStr, latStr] = first.split(',');
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    if (!isFinite(lng) || !isFinite(lat)) continue;
    out.push({ name, description: desc, lat, lng });
  }
  return out;
}

/**
 * Try to split a My Maps description into an address (first non-empty line)
 * and the user's own note (everything after). My Maps doesn't separate them
 * structurally, so this is heuristic but works well in practice.
 */
function splitDescription(desc) {
  if (!desc) return { address: null, note: null };
  const lines = desc.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { address: null, note: null };
  // Looks like an address if it contains a digit and either "St", "Ave",
  // "Blvd", "Rd", "Dr", "Way" or a state/ZIP. Fall through to "no address" if not.
  const addrLike = /\d/.test(lines[0]) && /(St|Ave|Blvd|Rd|Dr|Way|Ln|Pl|Hwy|Ct|Pkwy|Suite|Ste|#)\b|\b[A-Z]{2}\s+\d{5}/i.test(lines[0]);
  if (addrLike) {
    return { address: lines[0], note: lines.slice(1).join('\n') || null };
  }
  return { address: null, note: lines.join('\n') };
}

async function fetchSpots(env) {
  if (!env.MAP_ID) throw new Error('MAP_ID not configured');
  const url = `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(env.MAP_ID)}&forcekml=1`;
  const res = await fetch(url, {
    // A real-looking UA prevents Google from sometimes serving an empty doc.
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; therudyparra.com/1.0)' },
  });
  if (!res.ok) throw new Error(`Google KML ${res.status}`);
  const kml = await res.text();
  const placemarks = parseKml(kml);
  const spots = placemarks.map(p => {
    const { address, note } = splitDescription(p.description);
    return {
      name: p.name,
      tag: null,
      address: address,
      note: note,
      lat: p.lat,
      lng: p.lng,
      link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + (address ? ' ' + address : ''))}`,
    };
  });
  return { spots };
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
      const payload = await fetchSpots(env);
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ spots: [], error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }
  },
};
