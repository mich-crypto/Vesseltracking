// Data feeds: live AIS through your Cloudflare Worker (WebSocket with REST polling fallback)
// and a demo simulator. Both call onVessel(partialVessel) and onStatus(state, detail).
//   states: 'live' | 'reconnecting' | 'polling' | 'offline' | 'error' | 'demo'

import { destinationPoint, distanceNm, bearingDeg } from './geo.js';

const WS_RETRIES_BEFORE_POLLING = 4;

export class LiveFeed {
  constructor({ base, apiKey, pollMinutes, getSubscription, onVessel, onStatus }) {
    this.base = base;
    this.apiKey = apiKey || '';
    this.pollMinutes = pollMinutes;
    this.getSubscription = getSubscription;
    this.onVessel = onVessel;
    this.onStatus = onStatus;
    this.ws = null;
    this.failures = 0;
    this.timer = null;
    this.pollTimer = null;
    this.stopped = false;
    this.onOnline = () => { this.failures = 0; this.connect(); };
    this.onOffline = () => this.onStatus('offline', 'No network on this phone');
  }

  start() {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
  }

  /** Send a fresh subscription, e.g. after the watchlist changed or you moved. */
  resubscribe() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const sub = this.getSubscription();
      this.subCentre = sub.centre;
      this.ws.send(JSON.stringify({ type: 'subscribe', bbox: sub.bbox, mmsi: sub.mmsi, ...(this.apiKey ? { apiKey: this.apiKey } : {}) }));
    }
  }

  setRange() { this.resubscribe(); }
  setRetryMinutes(m) { this.setPollMinutes(m); }

  /** Ask for a new area once you have moved a quarter of the range. */
  moved(pos) {
    const sub = this.getSubscription();
    if (this.subCentre && distanceNm(this.subCentre, pos) > sub.range / 4) this.resubscribe();
  }

  setPollMinutes(m) {
    this.pollMinutes = m;
    if (this.pollTimer) this.startPolling();
  }

  wsUrl() {
    const u = new URL('ws', this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    if (!navigator.onLine) { this.onStatus('offline', 'No network on this phone'); return; }
    let ws;
    try { ws = new WebSocket(this.wsUrl()); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    let gotData = false, serverError = null;
    ws.onopen = () => {
      this.onStatus('connecting', 'Waiting for the first AIS reports');
      this.resubscribe();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'vessel' && msg.v) {
        if (!gotData) {
          // Only real data counts as live; an open socket to the Worker is not enough.
          gotData = true;
          this.failures = 0;
          this.rejections = 0;
          this.stopPolling();
          this.onStatus('live', 'Live stream');
        }
        this.onVessel(msg.v);
      } else if (msg.type === 'error') {
        serverError = msg.message || 'Server error';
        this.onStatus('error', serverError);
      }
    };
    ws.onclose = () => {
      if (serverError && !gotData) {
        // The key was refused (or missing). Stop after 3 in a row instead of retrying forever.
        this.rejections = (this.rejections || 0) + 1;
        if (this.rejections >= 3) { this.onStatus('error', `${serverError} Fix it in Settings and tap Connect.`); return; }
      }
      this.scheduleRetry();
    };
    ws.onerror = () => {}; // onclose follows
  }

  scheduleRetry() {
    if (this.stopped) return;
    this.failures += 1;
    if (this.failures >= WS_RETRIES_BEFORE_POLLING) {
      if (!this.pollTimer) this.startPolling();
      return;
    }
    const delay = Math.min(16000, 1000 * 2 ** (this.failures - 1));
    this.onStatus('reconnecting', `Reconnecting in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  startPolling() {
    clearInterval(this.pollTimer);
    const tick = async () => {
      const ok = await this.pollOnce();
      // Each poll is also a chance to get the live stream back.
      if (ok) { this.failures = WS_RETRIES_BEFORE_POLLING - 1; this.connect(); }
    };
    this.pollTimer = setInterval(tick, this.pollMinutes * 60000);
    tick();
  }

  stopPolling() { clearInterval(this.pollTimer); this.pollTimer = null; }

  async pollOnce() {
    const sub = this.getSubscription();
    const u = new URL('api/snapshot', this.base);
    if (sub.bbox) u.searchParams.set('bbox', sub.bbox.flat().map((n) => n.toFixed(4)).join(','));
    if (sub.mmsi?.length) u.searchParams.set('mmsi', sub.mmsi.join(','));
    try {
      const res = await fetch(u, { cache: 'no-store', headers: this.apiKey ? { 'X-AIS-Key': this.apiKey } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      (data.vessels || []).forEach((v) => this.onVessel(v));
      this.onStatus('polling', `Polling every ${this.pollMinutes} min`);
      return true;
    } catch {
      this.onStatus('offline', navigator.onLine ? 'Server unreachable' : 'No network on this phone');
      return false;
    }
  }
}

/** Ask the server whether it is up and has an AIS key. */
export async function testServer(base) {
  const res = await fetch(new URL('api/health', base), { cache: 'no-store' });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return res.json();
}

// ---------- Demo traffic ----------

// Fictional vessels with Dutch MIDs (244/245/246), placed around the position you give.
const DEMO_FLEET = [
  { mmsi: '244670583', name: 'NORDIC TERN', type: 70, sog: 11.8, dest: 'NLRTM', len: 189 },
  { mmsi: '245112090', name: 'MAAS PILOT 7', type: 50, sog: 14.2, dest: 'PILOT STN', len: 22 },
  { mmsi: '246338210', name: 'STELLA ORION', type: 80, sog: 9.4, dest: 'GBIMM', len: 228 },
  { mmsi: '244900017', name: 'ZEEHOND', type: 30, sog: 3.1, dest: 'SCHEVENINGEN', len: 34 },
  { mmsi: '244010562', name: 'HELDER BRISE', type: 36, sog: 5.6, dest: 'IJMUIDEN', len: 12 },
  { mmsi: '245780344', name: 'CAPE VLIELAND', type: 70, sog: 13.5, dest: 'DEHAM', len: 260 },
  { mmsi: '246120933', name: 'SMIT RIJNMOND', type: 52, sog: 0, dest: 'NLRTM', len: 32 },
  { mmsi: '244560211', name: 'STENA HOEK', type: 60, sog: 19.6, dest: 'GBHRW', len: 240 },
  { mmsi: '245019876', name: 'EEMS TRADER', type: 70, sog: 8.9, dest: 'NLDZL', len: 88 },
  { mmsi: '244223190', name: 'KNRM BEURS', type: 51, sog: 0, dest: '', len: 19 },
  { mmsi: '246445507', name: 'ATLANTIC MERIDIAN', type: 81, sog: 0.1, dest: 'NLRTM ANCH', len: 183 },
  { mmsi: '244807742', name: 'WILLEMIJN', type: 37, sog: 6.3, dest: 'STELLENDAM', len: 14 },
  { mmsi: '245661208', name: 'BREEZE ONE', type: 70, sog: 12.4, dest: 'BEANR', len: 147 },
  { mmsi: '246901435', name: 'LADY GRIETJE', type: 30, sog: 2.4, dest: 'IJMUIDEN', len: 41 },
];

export const DEMO_WATCH_SEED = [
  { mmsi: '244670583', name: 'NORDIC TERN' },
  { mmsi: '244560211', name: 'STENA HOEK' },
];

export class DemoFeed {
  constructor({ getCentre, onVessel, onStatus }) {
    this.getCentre = getCentre;
    this.onVessel = onVessel;
    this.onStatus = onStatus;
    this.ships = null;
    this.timer = null;
    this.tickN = 0;
  }

  seed(centre) {
    // Deterministic layout so the demo looks the same each time.
    let r = 7;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    this.ships = DEMO_FLEET.map((s, i) => {
      const dist = 0.8 + rnd() * 11;
      const brg = (i * 137.5 + rnd() * 30) % 360;
      const pos = destinationPoint(centre, brg, dist);
      // Steer most traffic across or towards you so CPA has something to say.
      const cog = s.sog > 0.5 ? (bearingDeg(pos, centre) + (rnd() - 0.5) * 120 + 360) % 360 : rnd() * 360;
      return { ...s, ...pos, cog, hdg: s.sog > 0.5 ? Math.round(cog) : Math.round(rnd() * 360) };
    });
  }

  start() {
    this.seed(this.getCentre());
    this.onStatus('demo', 'Demo traffic');
    this.ships.forEach((s) => this.emit(s));
    this.timer = setInterval(() => this.tick(), 3000);
  }

  stop() { clearInterval(this.timer); }

  tick() {
    const centre = this.getCentre();
    this.tickN += 1;
    for (const s of this.ships) {
      if (s.sog > 0.5) {
        Object.assign(s, destinationPoint(s, s.cog, (s.sog * 3) / 3600));
        s.cog = (s.cog + (Math.random() - 0.5) * 2 + 360) % 360;
        // Turn back once a vessel leaves the 14 NM demo area.
        if (distanceNm(s, centre) > 14) s.cog = (bearingDeg(s, centre) + (Math.random() - 0.5) * 60 + 360) % 360;
        s.hdg = Math.round(s.cog + (Math.random() - 0.5) * 4 + 360) % 360;
      }
      // AIS reporting rates: fast movers report often, moored ships rarely.
      const every = s.sog > 14 ? 1 : s.sog > 3 ? 2 : 6;
      if (this.tickN % every === 0) this.emit(s);
    }
  }

  emit(s) {
    this.onVessel({
      mmsi: s.mmsi, name: s.name, type: s.type, dest: s.dest, len: s.len,
      lat: s.lat, lon: s.lon, sog: Math.round(s.sog * 10) / 10, cog: Math.round(s.cog * 10) / 10,
      hdg: s.hdg, nav: s.sog > 0.5 ? 0 : s.type === 81 ? 1 : 5, ts: Date.now(), demo: true,
    });
  }
}
