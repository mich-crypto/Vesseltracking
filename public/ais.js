// Live AIS straight from AisStream.io in the browser, using the key you enter in Settings.
// The key stays in this browser's storage and is only sent to stream.aisstream.io.
//
// Two sockets: one for the area around you, and (when the watchlist has MMSIs) one worldwide
// stream filtered to those MMSIs, so watched vessels show wherever they are.

import { bboxAround } from './geo.js';

const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
const MAX_MMSI = 200;           // AisStream's limit per subscription
const FAST_RETRIES = 4;         // 1, 2, 4, 8 s; after that retry on the slow interval
const REJECT_WINDOW_MS = 6000;  // closed this soon after subscribing without data = refused

export class AisStreamFeed {
  constructor({ apiKey, range, retryMinutes, getCentre, getWatchMmsi, onVessel, onStatus }) {
    Object.assign(this, { apiKey, range, retryMinutes, getCentre, getWatchMmsi, onVessel, onStatus });
    this.sockets = { area: null, watch: null };
    this.failures = 0;
    this.refusals = 0;
    this.timer = null;
    this.stopped = false;
    this.subCentre = null;
    this.decoder = new TextDecoder();
    this.onOnline = () => { this.failures = 0; this.connect(); };
    this.onOffline = () => this.onStatus('offline', 'No network on this phone');
  }

  start() {
    addEventListener('online', this.onOnline);
    addEventListener('offline', this.onOffline);
    this.connect();
  }

  stop() {
    this.stopped = true;
    removeEventListener('online', this.onOnline);
    removeEventListener('offline', this.onOffline);
    clearTimeout(this.timer);
    this.closeAll();
  }

  closeAll() {
    for (const k of Object.keys(this.sockets)) {
      const ws = this.sockets[k];
      if (ws) { ws.onclose = null; ws.close(); }
      this.sockets[k] = null;
    }
  }

  setRange(nm) { this.range = nm; this.resubscribe(); }
  setRetryMinutes(m) { this.retryMinutes = m; }

  /** You moved, the range changed or the watchlist changed: replace the subscriptions. */
  resubscribe() {
    if (this.stopped) return;
    const want = this.getWatchMmsi().length > 0;
    if (want !== Boolean(this.sockets.watch)) { this.connect(); return; } // open or close the watchlist socket
    for (const [kind, ws] of Object.entries(this.sockets)) if (ws?.readyState === WebSocket.OPEN) ws.send(this.subscription(kind));
  }

  /** Re-subscribe once you have moved a quarter of the range. */
  moved(pos) {
    if (this.subCentre && distance(this.subCentre, pos) > this.range / 4) this.resubscribe();
  }

  subscription(kind) {
    const msg = { APIKey: this.apiKey, FilterMessageTypes: MESSAGE_TYPES };
    if (kind === 'area') {
      this.subCentre = this.getCentre();
      msg.BoundingBoxes = [bboxAround(this.subCentre, this.range)];
    } else {
      msg.BoundingBoxes = [[[-90, -180], [90, 180]]];
      msg.FiltersShipMMSI = this.getWatchMmsi().slice(0, MAX_MMSI);
    }
    return JSON.stringify(msg);
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.closeAll();
    if (!navigator.onLine) { this.onStatus('offline', 'No network on this phone'); return; }
    this.open('area');
    if (this.getWatchMmsi().length) this.open('watch');
  }

  open(kind) {
    let ws;
    try { ws = new WebSocket(AIS_URL); } catch { this.retry(false); return; }
    ws.binaryType = 'arraybuffer';
    this.sockets[kind] = ws;
    let openedAt = 0, gotData = false;
    ws.onopen = () => { openedAt = Date.now(); ws.send(this.subscription(kind)); };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : this.decoder.decode(ev.data);
      let raw;
      try { raw = JSON.parse(text); } catch { return; }
      if (raw.error) { this.onStatus('error', `AisStream says: ${raw.error}`); return; }
      if (!gotData) {
        gotData = true;
        this.failures = 0;
        this.refusals = 0;
        this.onStatus('live', 'Live from AisStream');
      }
      const v = parseAis(raw);
      if (v) this.onVessel(v);
    };
    ws.onclose = () => {
      if (this.sockets[kind] !== ws) return;
      this.sockets[kind] = null;
      const refused = openedAt && !gotData && Date.now() - openedAt < REJECT_WINDOW_MS;
      this.retry(refused);
    };
    ws.onerror = () => {}; // onclose follows
  }

  retry(refused) {
    if (this.stopped || this.timer) return;
    if (refused) this.refusals += 1;
    if (this.refusals >= 3) {
      this.onStatus('error', 'AisStream closed the connection right after the key was sent. Check the key. AisStream may also refuse connections made from a browser.');
      return; // stop hammering; Connect in Settings tries again
    }
    this.failures += 1;
    const slow = this.failures > FAST_RETRIES;
    const delay = slow ? this.retryMinutes * 60000 : 1000 * 2 ** (this.failures - 1);
    this.onStatus(slow ? 'offline' : 'reconnecting', slow ? `Retrying every ${this.retryMinutes} min` : `Reconnecting in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
  }
}

const distance = (a, b) => Math.hypot((a.lat - b.lat) * 60, (a.lon - b.lon) * 60 * Math.cos((a.lat * Math.PI) / 180));

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
