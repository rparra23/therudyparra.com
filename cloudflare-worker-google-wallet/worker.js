/**
 * Google Wallet "Save to Wallet" link generator — Cloudflare Worker
 *
 * GET / -> { "saveUrl": "https://pay.google.com/gp/v/save/<JWT>" }
 *
 * The browser fetches this Worker, gets a save URL, and navigates the user
 * to Google's "Add to Wallet" page. The pass content is signed by the
 * Worker using a Google service-account RS256 private key, so credentials
 * never leave the server side.
 *
 * Required Worker secrets (set via `npx wrangler secret put <NAME>`):
 *   GOOGLE_ISSUER_ID         — your Google Wallet Issuer ID (digits)
 *   GOOGLE_CLASS_ID          — `<ISSUER>.<your_class_suffix>` (we create one below)
 *   GOOGLE_SA_EMAIL          — service-account email (xxx@yyy.iam.gserviceaccount.com)
 *   GOOGLE_SA_PRIVATE_KEY    — PEM private key string. Paste the *contents* of
 *                              the "private_key" field from the service-account
 *                              JSON, INCLUDING the BEGIN/END lines, with newlines.
 *                              wrangler secret put will accept multi-line input.
 *
 * Optional:
 *   ALLOWED_ORIGIN  default: "https://therudyparra.com"
 */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://therudyparra.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

/** base64url encode an ArrayBuffer or Uint8Array */
function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Convert a PEM private key string to a CryptoKey for RS256 signing */
async function importPrivateKey(pem) {
  const cleaned = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** Sign a JWT payload with an RS256 key. */
async function signJwt(payload, key) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(sig)}`;
}

/** Build the GenericObject JSON for the pass. */
function buildGenericObject(env) {
  return {
    id: `${env.GOOGLE_ISSUER_ID}.rudyparra-contact-v1`,
    classId: env.GOOGLE_CLASS_ID,
    genericType: 'GENERIC_TYPE_UNSPECIFIED',
    hexBackgroundColor: '#0b0b10',
    logo: {
      sourceUri: { uri: 'https://therudyparra.com/assets/profile.jpg' },
    },
    cardTitle: {
      defaultValue: { language: 'en-US', value: 'Rudy Parra' },
    },
    subheader: {
      defaultValue: { language: 'en-US', value: 'Albuquerque, NM' },
    },
    header: {
      defaultValue: { language: 'en-US', value: 'Electrical Lab Tech & Embedded Dev' },
    },
    textModulesData: [
      { id: 'phone',   header: 'Phone',   body: '+1 575-725-1290' },
      { id: 'email',   header: 'Email',   body: 'parrarudy3@icloud.com' },
      { id: 'website', header: 'Website', body: 'therudyparra.com' },
    ],
    linksModuleData: {
      uris: [
        { uri: 'https://therudyparra.com',                                description: 'Website' },
        { uri: 'tel:+15757251290',                                        description: 'Call'    },
        { uri: 'mailto:parrarudy3@icloud.com',                            description: 'Email'   },
        { uri: 'https://www.linkedin.com/in/rudy-parra-329a2318a/',       description: 'LinkedIn' },
        { uri: 'https://github.com/rparra23',                             description: 'GitHub'  },
      ],
    },
    heroImage: {
      sourceUri: { uri: 'https://therudyparra.com/assets/profile.jpg' },
    },
    barcode: {
      type: 'QR_CODE',
      value: 'https://therudyparra.com',
      alternateText: 'therudyparra.com',
    },
  };
}

async function buildSaveUrl(env) {
  for (const k of ['GOOGLE_ISSUER_ID', 'GOOGLE_CLASS_ID', 'GOOGLE_SA_EMAIL', 'GOOGLE_SA_PRIVATE_KEY']) {
    if (!env[k]) throw new Error(`Missing secret: ${k}`);
  }
  const key = await importPrivateKey(env.GOOGLE_SA_PRIVATE_KEY);
  const obj = buildGenericObject(env);
  const claims = {
    iss: env.GOOGLE_SA_EMAIL,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { genericObjects: [obj] },
    origins: ['https://therudyparra.com'],
  };
  const jwt = await signJwt(claims, key);
  return `https://pay.google.com/gp/v/save/${jwt}`;
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
      const saveUrl = await buildSaveUrl(env);
      return new Response(JSON.stringify({ saveUrl }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }
  },
};
