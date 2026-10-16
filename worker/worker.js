// Cloudflare Worker: serves the app and proxies AisStream.io so the API key never reaches the phone.
//
//   GET /api/health                  → { ok, live, version, deployedAt }  (live = the Worker has its own AIS key)
//   GET /api/check  (X-AIS-Key?)     → tries the key against AisStream: { ok, source, key, message }
//   GET /ws  (WebSocket)             → client sends {type:"subscribe", bbox, mmsi, apiKey?}; server streams {type:"vessel", v}
//   GET /api/snapshot?bbox=&mmsi=    → recent positions in the box, returns { vessels: [...] } (offshore polling)
//   everything else                  → static files from ./public
//
// AisStream allows ONE connection per API key and briefly blocks a key that reconnects quickly.
// So /ws, /api/check and /api/snapshot all go to one Durable Object, AisHub. It keeps a single
// upstream per key, subscribes it to the union of every device's area, and sends each device only
// the vessels inside its own area. Your iPhone and iPad can then stream at the same time.
//
// The AisStream key comes from the app's Settings (subscribe message / X-AIS-Key header) or, when the
// field is empty, from the secret AISSTREAM_API_KEY (wrangler secret put AISSTREAM_API_KEY).
// The Worker never stores or logs a key; it only passes it to AisStream.
// Vars: ALLOWED_ORIGINS (optional, comma-separated; empty allows any origin)

const AIS_URL = 'https://stream.aisstream.io/v0/stream';
const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const FORWARD_MIN_MS = 2000;   // per device and vessel, at most one position every 2 s
const MAX_MMSI = 50;           // AisStream's limit per subscription
const IDLE_MS = 60000;         // no heartbeat from a device for this long: drop it (frozen tab)
const GRACE_MS = 15000;        // keep the upstream this long after the last device leaves (quick reloads)
const CACHE_MS = 30 * 60000;   // positions kept for snapshots and for devices that join late
const MAX_BOXES = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/api/health') {
      const meta = env.CF_VERSION_METADATA || {};
      return json({ ok: true, live: Boolean(env.AISSTREAM_API_KEY), version: meta.id ? String(meta.id).slice(0, 8) : 'dev', deployedAt: meta.timestamp || null },
        200, { ...cors, 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/ws' || url.pathname === '/api/check' || url.pathname === '/api/snapshot') {
      if (url.pathname === '/ws') {
        if (!originAllowed(request, env)) return new Response('Origin not allowed', { status: 403 });
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const hub = env.HUB.get(env.HUB.idFromName('hub'));
      const res = await hub.fetch(request);
      if (url.pathname === '/ws') return res;
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

// ---------- The hub (Durable Object) ----------

export class AisHub {
  constructor(state, env) {
    this.env = env;
    this.groups = new Map(); // apiKey -> { upstream, opening, clients:Set, filterJson, cache:Map, graceTimer, lastData }
    this.idleTimer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.connect();
    if (url.pathname === '/api/check') return this.check(request);
    return this.snapshot(request, url);
  }

  group(key) {
    let g = this.groups.get(key);
    if (!g) { g = { upstream: null, opening: null, clients: new Set(), filterJson: '', cache: new Map(), seen: new Map(), graceTimer: null, lastData: 0 }; this.groups.set(key, g); }
    return g;
  }

  // ----- devices -----

  connect() {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const c = { ws: server, key: '', bbox: null, mmsi: [], lastSeen: Date.now(), lastSent: new Map() };
    server.addEventListener('message', (event) => {
      c.lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'subscribe') this.subscribe(c, msg).catch(() => {});
    });
    const leave = () => this.leave(c);
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);
    this.startIdleChecks();
    return new Response(null, { status: 101, webSocket: client });
  }

  async subscribe(c, msg) {
    const key = pickKey(this.env, msg.apiKey);
    if (!key) { send(c.ws, { type: 'error', message: 'No AisStream key. Add yours in Settings, or set AISSTREAM_API_KEY on the Worker.' }); return; }
    const sub = sanitizeSubscription(msg);
    if (c.key && c.key !== key) this.leaveGroup(c);
    c.key = key; c.bbox = sub.bbox; c.mmsi = sub.mmsi;
    const g = this.group(key);
    g.clients.add(c);
    clearTimeout(g.graceTimer); g.graceTimer = null;
    // A device that joins a running stream gets what is already known in its area at once.
    const since = Date.now() - CACHE_MS;
    for (const v of g.cache.values()) if ((g.seen.get(v.mmsi) || 0) > since && wants(c, v)) this.forward(c, v);
    await this.refresh(key);
  }

  leave(c) {
    try { c.ws.close(); } catch {}
    this.leaveGroup(c);
  }

  leaveGroup(c) {
    const g = this.groups.get(c.key);
    if (!g || !g.clients.delete(c)) return;
    if (g.clients.size) { this.refresh(c.key).catch(() => {}); return; }
    clearTimeout(g.graceTimer);
    g.graceTimer = setTimeout(() => { if (!g.clients.size) this.closeUpstream(c.key); }, GRACE_MS);
  }

  startIdleChecks() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      let any = false;
      for (const g of this.groups.values()) {
        for (const c of g.clients) {
          any = true;
          if (Date.now() - c.lastSeen > IDLE_MS) { try { c.ws.close(1000, 'Idle'); } catch {} this.leaveGroup(c); }
        }
      }
      if (!any) { clearInterval(this.idleTimer); this.idleTimer = null; }
    }, 15000);
  }

  forward(c, v) {
    if (v.lat != null) {
      const now = Date.now();
      if (now - (c.lastSent.get(v.mmsi) || 0) < FORWARD_MIN_MS) return;
      c.lastSent.set(v.mmsi, now);
    }
    send(c.ws, { type: 'vessel', v });
  }

  // ----- the one upstream per key -----

  /** Subscribe the key's upstream to every device's area; open it if needed. */
  async refresh(key) {
    const g = this.group(key);
    const filter = unionFilter([...g.clients]);
    if (!filter) return;
    const fj = JSON.stringify(filter);
    if (g.opening) { await g.opening; if (g.upstream?.isOpen()) { if (fj !== g.filterJson) { g.upstream.update(filter); g.filterJson = fj; } return; } }
    if (g.upstream?.isOpen()) {
      if (fj !== g.filterJson) { g.upstream.update(filter); g.filterJson = fj; }
      return;
    }
    g.opening = openUpstream(this.env, key, filter, (v) => this.onVessel(key, v), (why) => this.onUpstreamClosed(key, why))
      .then((u) => { g.upstream = u; g.filterJson = fj; })
      .catch((err) => { for (const c of g.clients) { send(c.ws, { type: 'error', message: `Could not reach the AIS provider: ${err.message}` }); try { c.ws.close(1011, 'Upstream unavailable'); } catch {} } })
      .finally(() => { g.opening = null; });
    await g.opening;
    // Areas may have changed while the connection was opening.
    const now = unionFilter([...g.clients]);
    if (g.upstream?.isOpen() && now && JSON.stringify(now) !== g.filterJson) { g.upstream.update(now); g.filterJson = JSON.stringify(now); }
  }

  onVessel(key, v) {
    const g = this.groups.get(key);
    if (!g) return;
    g.lastData = Date.now();
    const merged = { ...(g.cache.get(v.mmsi) || {}), ...v };
    g.cache.set(v.mmsi, merged);
    g.seen.set(v.mmsi, Date.now()); // when the Worker heard it; AIS timestamps can lag
    if (g.cache.size > 5000) for (const [k] of g.cache) { if (Date.now() - (g.seen.get(k) || 0) > CACHE_MS) { g.cache.delete(k); g.seen.delete(k); } }
    for (const c of g.clients) if (wants(c, merged)) this.forward(c, v.lat != null ? merged : v);
  }

  onUpstreamClosed(key, why) {
    const g = this.groups.get(key);
    if (!g) return;
    g.upstream = null; g.filterJson = '';
    for (const c of g.clients) {
      send(c.ws, { type: 'error', message: `AisStream closed the stream${why ? `: ${why}` : ''}. If this key is also used outside this app, AisStream allows only one connection per key.` });
      try { c.ws.close(1011, 'Upstream closed'); } catch {}
    }
    g.clients.clear();
  }

  closeUpstream(key) {
    const g = this.groups.get(key);
    if (!g) return;
    try { g.upstream?.close(); } catch {}
    g.upstream = null; g.filterJson = '';
  }

  // ----- polling and the key check, without a second connection -----

  async snapshot(request, url) {
    const key = pickKey(this.env, request.headers.get('X-AIS-Key'));
    if (!key) return json({ error: 'No AisStream key' }, 401);
    const sub = sanitizeSubscription({ bbox: parseBbox(url.searchParams.get('bbox')), mmsi: (url.searchParams.get('mmsi') || '').split(',') });
    if (!sub.bbox && !sub.mmsi.length) return json({ error: 'Give a bbox or a list of MMSIs' }, 400);
    const g = this.group(key);
    const seconds = Math.min(20, Math.max(3, Number(url.searchParams.get('seconds')) || 10));
    if (!g.upstream?.isOpen()) {
      // Nobody is streaming: listen as a temporary member of the group, then leave.
      const probe = { ws: null, key, bbox: sub.bbox, mmsi: sub.mmsi, lastSeen: Date.now(), lastSent: new Map() };
      g.clients.add(probe);
      clearTimeout(g.graceTimer);
      try { await this.refresh(key); await new Promise((r) => setTimeout(r, seconds * 1000)); } finally { this.leaveGroup(probe); }
    }
    const since = Date.now() - CACHE_MS;
    const vessels = [...g.cache.values()].filter((v) => v.lat != null && (g.seen.get(v.mmsi) || 0) > since && wants({ bbox: sub.bbox, mmsi: sub.mmsi }, v));
    return json({ at: new Date().toISOString(), vessels }, 200, { 'Cache-Control': 'no-store' });
  }

  async check(request) {
    const { key, source } = pickKeyWithSource(this.env, request.headers.get('X-AIS-Key'));
    if (!key) return json({ ok: false, source, message: 'No AisStream key. Add yours in Settings, or set AISSTREAM_API_KEY on the Worker.' });
    const g = this.group(key);
    const devices = [...g.clients].filter((c) => c.ws).length;
    if (g.upstream?.isOpen()) {
      // Never open a second connection next to a running one: AisStream would refuse it.
      const quiet = Date.now() - g.lastData > 30000 ? ' No reports in the last 30 s, so the area may be quiet.' : '';
      return json({ ok: true, source, key: maskKey(key), message: `AisStream accepted the key. It is streaming now to ${devices} device${devices === 1 ? '' : 's'}.${quiet}` });
    }
    // Not streaming: open the key's one connection briefly (worldwide, so reports arrive fast).
    const result = await new Promise((resolve) => {
      let u = null;
      const timer = setTimeout(() => finish({ ok: true, message: 'AisStream kept the connection open but sent no reports in 8 s.' }), 8000);
      const finish = (r) => { clearTimeout(timer); try { u?.close(); } catch {} resolve(r); };
      openUpstream(this.env, key, { BoundingBoxes: [[[-90, -180], [90, 180]]] },
        () => finish({ ok: true, message: 'AisStream accepted the key and is sending reports.' }),
        (why) => finish({ ok: false, message: `AisStream refused the connection${why ? ` (${why})` : ''}. Either the key is wrong, or it is in use outside this app: AisStream allows one connection per key.` }))
        .then((x) => { u = x; })
        .catch((err) => finish({ ok: false, message: `Could not reach AisStream: ${err.message}` }));
    });
    return json({ ...result, source, key: maskKey(key) }, 200, { 'Cache-Control': 'no-store' });
  }
}

const send = (ws, obj) => { if (ws) { try { ws.send(JSON.stringify(obj)); } catch {} } };

/** Does this device want this vessel? Inside its box, or on its MMSI list when it has no box. */
export function wants(c, v) {
  if (v.lat == null) return true; // static data (names, types) is small; every device gets it
  if (c.bbox) {
    const [[s, w], [n, e]] = c.bbox;
    return v.lat >= s && v.lat <= n && v.lon >= w && v.lon <= e;
  }
  return c.mmsi.includes(v.mmsi);
}

/**
 * One AisStream subscription covering every device of a key: all their boxes (AisStream takes
 * several). Devices without a box but with MMSIs (snapshots) fall back to a worldwide MMSI filter,
 * which only works when no device has a box, since the filter would apply to every box.
 */
export function unionFilter(clients) {
  const boxes = [...new Set(clients.filter((c) => c.bbox).map((c) => JSON.stringify(c.bbox)))].slice(0, MAX_BOXES).map((b) => JSON.parse(b));
  if (boxes.length) return { BoundingBoxes: boxes };
  const mmsi = [...new Set(clients.flatMap((c) => c.mmsi || []))].slice(0, MAX_MMSI);
  if (mmsi.length) return { BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: mmsi };
  return null;
}

async function openUpstream(env, apiKey, filter, onVessel, onClosed) {
  const resp = await fetch(env.AIS_UPSTREAM_URL || AIS_URL, { headers: { Upgrade: 'websocket' } }); // AIS_UPSTREAM_URL: local tests against a mock
  const ws = resp.webSocket;
  if (!ws) throw new Error(`upgrade refused (${resp.status})`);
  ws.accept();
  const subscribe = (f) => ws.send(JSON.stringify({ APIKey: apiKey, FilterMessageTypes: MESSAGE_TYPES, ...f }));
  subscribe(filter);
  const decoder = new TextDecoder();
  let closedByUs = false, upstreamError = '';
  ws.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : decoder.decode(event.data);
    let raw;
    try { raw = JSON.parse(text); } catch { return; }
    if (raw && typeof raw.error === 'string') { upstreamError = raw.error; return; } // AisStream explains before it closes
    const v = parseAis(raw);
    if (v) onVessel(v);
  });
  ws.addEventListener('close', (event) => {
    if (closedByUs || !onClosed) return;
    onClosed(upstreamError || event.reason || (event.code ? `close code ${event.code}` : ''));
  });
  return {
    close: () => { closedByUs = true; ws.close(); },
    // "Resending a subscription replaces the active configuration" (AisStream docs).
    update: (f) => subscribe(f),
    isOpen: () => ws.readyState === 1,
  };
}

// ---------- Keys ----------

/** The key typed in the app wins; otherwise the Worker's own secret. */
export function pickKeyWithSource(env, clientKey) {
  const k = typeof clientKey === 'string' ? clientKey.trim() : '';
  if (/^[A-Za-z0-9_-]{8,128}$/.test(k)) return { key: k, source: 'settings' };
  const secret = env.AISSTREAM_API_KEY ? String(env.AISSTREAM_API_KEY).trim() : ''; // a pasted secret often ends in a newline
  return secret ? { key: secret, source: 'worker' } : { key: '', source: null };
}
export const pickKey = (env, clientKey) => pickKeyWithSource(env, clientKey).key;

/** Show a key without revealing it: first and last 4 characters plus its length. */
export const maskKey = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} characters)` : '');

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
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'X-AIS-Key', Vary: 'Origin' };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
