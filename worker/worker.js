// Cloudflare Worker: serves the app and proxies AisStream.io so the API key never reaches the phone.
//
//   GET /api/health                  → { ok, live }  (live = an AIS key is configured)
//   GET /ws  (WebSocket)             → client sends {type:"subscribe", bbox, mmsi}; server streams {type:"vessel", v}
//   GET /api/snapshot?bbox=&mmsi=    → listens upstream for a few seconds, returns { vessels: [...] } (offshore polling)
//   everything else                  → static files from ./public
//
// Secrets: AISSTREAM_API_KEY (wrangler secret put AISSTREAM_API_KEY)
// Vars:    ALLOWED_ORIGINS (optional, comma-separated; empty allows any origin)

const AIS_URL = 'https://stream.aisstream.io/v0/stream';
const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const FORWARD_MIN_MS = 2000; // per vessel, at most one position every 2 s to the phone
const MAX_MMSI = 50;         // AisStream's limit per subscription

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health') {
      return json({ ok: true, live: Boolean(env.AISSTREAM_API_KEY) }, 200, cors);
    }
    if (url.pathname === '/ws') {
      if (!originAllowed(request, env)) return new Response('Origin not allowed', { status: 403 });
      return handleSocket(request, env);
    }
    if (url.pathname === '/api/snapshot') {
      return handleSnapshot(url, env, cors);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

// ---------- WebSocket relay ----------

function handleSocket(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let upstreams = [];
  const lastSent = new Map();
  const send = (obj) => { try { server.send(JSON.stringify(obj)); } catch {} };
  const closeUpstreams = () => { upstreams.forEach((u) => { try { u.close(); } catch {} }); upstreams = []; };

  const forward = (v) => {
    // Static data (name, type) always goes through; positions are throttled per vessel.
    if (v.lat != null) {
      const now = Date.now();
      if (now - (lastSent.get(v.mmsi) || 0) < FORWARD_MIN_MS) return;
      lastSent.set(v.mmsi, now);
    }
    send({ type: 'vessel', v });
  };

  server.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type !== 'subscribe') return;
    if (!env.AISSTREAM_API_KEY) { send({ type: 'error', message: 'The server has no AIS key' }); return; }
    closeUpstreams();
    try {
      upstreams = await openUpstreams(env, sanitizeSubscription(msg), forward, () => {
        send({ type: 'error', message: 'AIS provider closed the stream' });
        try { server.close(1011, 'Upstream closed'); } catch {}
      });
    } catch (err) {
      send({ type: 'error', message: `Could not reach the AIS provider: ${err.message}` });
      try { server.close(1011, 'Upstream unavailable'); } catch {}
    }
  });
  server.addEventListener('close', closeUpstreams);
  server.addEventListener('error', closeUpstreams);

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * One upstream for the area around you and, when the watchlist has MMSIs, one worldwide
 * stream filtered to those MMSIs (so watched vessels show even when far away).
 */
async function openUpstreams(env, sub, onVessel, onClosed) {
  const plans = [];
  if (sub.bbox) plans.push({ BoundingBoxes: [sub.bbox] });
  if (sub.mmsi.length) plans.push({ BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: sub.mmsi });
  return Promise.all(plans.map((p) => openUpstream(env, p, onVessel, onClosed)));
}

async function openUpstream(env, filter, onVessel, onClosed) {
  const resp = await fetch(AIS_URL, { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`upgrade refused (${resp.status})`);
  ws.accept();
  ws.send(JSON.stringify({ APIKey: env.AISSTREAM_API_KEY, FilterMessageTypes: MESSAGE_TYPES, ...filter }));
  const decoder = new TextDecoder();
  let closedByUs = false;
  ws.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : decoder.decode(event.data);
    let raw;
    try { raw = JSON.parse(text); } catch { return; }
    const v = parseAis(raw);
    if (v) onVessel(v);
  });
  ws.addEventListener('close', () => { if (!closedByUs && onClosed) onClosed(); });
  return { close: () => { closedByUs = true; ws.close(); } };
}

// ---------- Snapshot (polling fallback) ----------

async function handleSnapshot(url, env, cors) {
  if (!env.AISSTREAM_API_KEY) return json({ error: 'The server has no AIS key' }, 503, cors);
  const sub = sanitizeSubscription({
    bbox: parseBbox(url.searchParams.get('bbox')),
    mmsi: (url.searchParams.get('mmsi') || '').split(','),
  });
  if (!sub.bbox && !sub.mmsi.length) return json({ error: 'Give a bbox or a list of MMSIs' }, 400, cors);
  const seconds = Math.min(20, Math.max(3, Number(url.searchParams.get('seconds')) || 10));

  const latest = new Map();
  const merge = (v) => latest.set(v.mmsi, { ...(latest.get(v.mmsi) || {}), ...v });
  let upstreams = [];
  try {
    upstreams = await openUpstreams(env, sub, merge);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  } catch (err) {
    return json({ error: `Could not reach the AIS provider: ${err.message}` }, 502, cors);
  } finally {
    upstreams.forEach((u) => { try { u.close(); } catch {} });
  }
  const vessels = [...latest.values()].filter((v) => v.lat != null);
  return json({ at: new Date().toISOString(), seconds, vessels }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

// ---------- Parsing ----------

export function parseBbox(s) {
  if (!s) return null;
  const n = s.split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  return [[n[0], n[1]], [n[2], n[3]]];
}

export function sanitizeSubscription(msg) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
  let bbox = null;
  if (Array.isArray(msg.bbox) && msg.bbox.length === 2 && msg.bbox.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => Number.isFinite(Number(x))))) {
    bbox = msg.bbox.map(([lat, lon]) => [clamp(lat, -90, 90), clamp(lon, -180, 180)]);
  }
  const mmsi = [...new Set((Array.isArray(msg.mmsi) ? msg.mmsi : []).map((m) => String(m).trim()).filter((m) => /^\d{9}$/.test(m)))].slice(0, MAX_MMSI);
  return { bbox, mmsi };
}

/** "2024-05-01 12:34:56.789 +0000 UTC" → epoch ms */
function parseAisTime(s) {
  if (!s) return Date.now();
  const t = Date.parse(`${String(s).slice(0, 19).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : Date.now();
}

const clean = (s) => (typeof s === 'string' ? s.replace(/@+$/g, '').trim() : '') || undefined;

/** One AisStream message → a compact vessel update, or null. */
export function parseAis(m) {
  if (!m || !m.MessageType) return null;
  const type = m.MessageType;
  const meta = m.MetaData || {};
  const body = (m.Message && m.Message[type]) || {};
  const mmsi = String(meta.MMSI ?? body.UserId ?? body.UserID ?? '');
  if (!/^\d{9}$/.test(mmsi)) return null;
  const v = { mmsi, ts: parseAisTime(meta.time_utc), name: clean(meta.ShipName) };

  if (type === 'PositionReport' || type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
    const lat = body.Latitude ?? meta.latitude;
    const lon = body.Longitude ?? meta.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    v.lat = lat;
    v.lon = lon;
    if (Number.isFinite(body.Sog) && body.Sog < 102.3) v.sog = body.Sog;
    if (Number.isFinite(body.Cog) && body.Cog < 360) v.cog = body.Cog;
    if (Number.isFinite(body.TrueHeading) && body.TrueHeading < 360) v.hdg = body.TrueHeading;
    if (Number.isFinite(body.NavigationalStatus)) v.nav = body.NavigationalStatus;
    if (type === 'ExtendedClassBPositionReport') {
      if (body.Name) v.name = clean(body.Name);
      if (body.Type) v.type = body.Type;
    }
    return v;
  }
  if (type === 'ShipStaticData') {
    if (body.Name) v.name = clean(body.Name);
    if (body.Type) v.type = body.Type;
    if (body.Destination) v.dest = clean(body.Destination);
    if (body.CallSign) v.call = clean(body.CallSign);
    const d = body.Dimension;
    if (d && Number.isFinite(d.A) && Number.isFinite(d.B) && d.A + d.B > 0) v.len = d.A + d.B;
    return v;
  }
  if (type === 'StaticDataReport') {
    if (body.ReportA?.Valid && body.ReportA.Name) v.name = clean(body.ReportA.Name);
    if (body.ReportB?.Valid) {
      if (body.ReportB.ShipType) v.type = body.ReportB.ShipType;
      if (body.ReportB.CallSign) v.call = clean(body.ReportB.CallSign);
      const d = body.ReportB.Dimension;
      if (d && Number.isFinite(d.A) && Number.isFinite(d.B) && d.A + d.B > 0) v.len = d.A + d.B;
    }
    return v;
  }
  return null;
}

// ---------- HTTP helpers ----------

function originAllowed(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const origin = request.headers.get('Origin');
  return !origin || allowed.includes(origin) || origin === new URL(request.url).origin;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = !allowed.length ? '*' : origin && allowed.includes(origin) ? origin : allowed[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
