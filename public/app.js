import {
  distanceNm, bearingDeg, relativeBearing, cpa, isValidMmsi, normName,
  shipTypeLabel, formatLatLon, formatBearing,
} from './geo.js';
import { DemoFeed, DEMO_WATCH_SEED } from './feed.js';
import { AisStreamFeed } from './ais.js';

// ---------- Constants ----------
const RENDER_MIN_MS = 2000;            // throttle: at most one re-render every 2 s
const STALE_MS = 10 * 60 * 1000;       // older than this shows a "Stale" pill
const DROP_MS = 60 * 60 * 1000;        // non-watched vessels unseen for an hour drop out
const MAX_CARDS = 100;
const KN_PER_MS = 1.943844;
// Hoek van Holland harbour mouth, used when location is off.
const FALLBACK_POS = { lat: 51.985, lon: 4.06 };

// ---------- Storage (wrapped: private mode and blocked storage must not break the app) ----------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

const DEFAULT_SETTINGS = { source: 'demo', apiKey: '', retry: 15, range: 10, alert: 2, theme: 'dark', labels: false, tab: 'list', filter: 'all' };
const settings = { ...DEFAULT_SETTINGS, ...store.get('vt.settings', {}) };
const saveSettings = () => store.set('vt.settings', settings);

let watch = store.get('vt.watch', null);
const firstRun = watch === null;
if (!Array.isArray(watch)) watch = [];
const saveWatch = () => { store.set('vt.watch', watch); onWatchChanged(); };

// ---------- State ----------
const vessels = new Map(); // mmsi -> vessel
let me = null;             // { lat, lon, sog, cog, acc, ts, source: 'gps' | 'fallback' }
let geoError = null;
let feed = null;
const alerted = new Set();

// ---------- Helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNm = (d) => (d == null ? '–' : d < 10 ? d.toFixed(2) : d.toFixed(1));
const fmtKn = (s) => (s == null ? '–' : `${s.toFixed(1)} kn`);
const pad2 = (n) => String(n).padStart(2, '0');

function fmtAge(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(ts);
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Relative bearing the way it is called on deck: Green (starboard) or Red (port). */
function fmtRelative(rel) {
  if (rel == null) return '';
  const r = Math.round(rel);
  if (r <= 5 || r >= 355) return 'ahead';
  if (r >= 175 && r <= 185) return 'astern';
  return r < 180 ? `Green ${r}°` : `Red ${360 - r}°`;
}

const ownHeading = () => (me && me.sog != null && me.sog > 0.5 && me.cog != null ? me.cog : null);
const centre = () => me || FALLBACK_POS;

function watchEntryFor(v) {
  const n = normName(v.name);
  return watch.find((w) => (w.mmsi && w.mmsi === v.mmsi) || (!w.mmsi && w.name && n && w.name === n));
}

// ---------- Derived view model ----------
function derive() {
  const now = Date.now();
  const pos = centre();
  const own = { lat: pos.lat, lon: pos.lon, sog: me?.sog ?? 0, cog: me?.cog ?? 0 };
  const hdg = ownHeading();
  const out = [];
  for (const v of vessels.values()) {
    const w = watchEntryFor(v);
    const age = now - (v.ts || 0);
    if (!w && age > DROP_MS) { vessels.delete(v.mmsi); continue; }
    const dist = distanceNm(pos, v);
    if (!w && dist > settings.range) continue;
    const brg = bearingDeg(pos, v);
    const c = v.sog != null ? cpa(own, { lat: v.lat, lon: v.lon, sog: v.sog, cog: v.cog ?? 0 }) : null;
    const closing = !!(c && c.closing && c.tcpaMin <= 60);
    const risk = closing && c.cpaNm < 1 && c.tcpaMin <= 30;
    out.push({ v, w, dist, brg, rel: relativeBearing(brg, hdg), cpa: c, closing, risk, stale: age > STALE_MS });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

// ---------- Render scheduling (throttled) ----------
let lastRender = 0, renderTimer = null;
function scheduleRender(now = false) {
  if (now) { clearTimeout(renderTimer); renderTimer = null; render(); return; }
  if (renderTimer) return;
  const wait = Math.max(0, RENDER_MIN_MS - (Date.now() - lastRender));
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, wait);
}

function render() {
  lastRender = Date.now();
  const rows = derive();
  checkAlerts(rows);
  const tab = settings.tab;
  if (tab === 'list') renderList(rows);
  if (tab === 'map') renderMap(rows);
  if (tab === 'watch') renderWatch(rows);
  renderWatchCount(rows);
}

// ---------- Status badge ----------
const STATUS_LABEL = { live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline', error: 'Not connected', demo: 'Demo', starting: 'Starting' };
let feedState = { state: 'starting', detail: '' };
function setStatus(state, detail = '') {
  feedState = { state, detail };
  const el = $('#status');
  el.className = `badge ${state}`;
  el.title = detail;
  el.lastElementChild.textContent = STATUS_LABEL[state] || state;
  if (settings.tab === 'settings') renderSettings();
  if (state === 'error' || state === 'offline') scheduleRender();
}

// ---------- Nearby list ----------
function renderOwn() {
  const el = $('#own-card');
  const pos = centre();
  let label, notice = '';
  if (me?.source === 'gps') label = `Your position · GPS ± ${Math.round(me.acc)} m`;
  else label = 'Demo position · Hoek van Holland';
  if (geoError) {
    notice = `<div class="notice warn" style="margin-top:12px"><span class="ico">!</span><div class="grow">${esc(geoError)}</div>
      <button type="button" class="btn ghost small" id="btn-geo">Try again</button></div>`;
  }
  const hdg = ownHeading();
  el.innerHTML = `
    <div class="head"><div class="label"><i class="dot"></i>${esc(label)}</div>
      <span class="pill ${me?.source === 'gps' ? 'ok' : ''}">${me?.source === 'gps' ? 'Fix' : 'No fix'}</span></div>
    <div class="coords"><span>${formatLatLon(pos.lat, true)}</span><span>${formatLatLon(pos.lon, false)}</span></div>
    <div class="lstats">
      <div><span>Speed</span><b>${me?.sog != null ? fmtKn(me.sog) : '–'}</b></div>
      <div><span>Course</span><b>${hdg != null ? formatBearing(hdg) + ' T' : 'Not moving'}</b></div>
      <div><span>Last fix</span><b>${me?.source === 'gps' ? fmtAge(me.ts) : '–'}</b></div>
    </div>${notice}`;
}

function renderKpis(rows) {
  const inRange = rows.filter((r) => r.dist <= settings.range);
  const nearest = inRange[0];
  const closing = rows.filter((r) => r.closing).sort((a, b) => a.cpa.tcpaMin - b.cpa.tcpaMin);
  const watched = rows.filter((r) => r.w);
  const kpi = (label, value, delta, cls = '') => `<div class="card kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="delta">${delta}</div></div>`;
  $('#kpis').innerHTML =
    kpi('In range', inRange.length, `within ${settings.range} NM`) +
    kpi('Nearest', nearest ? `${fmtNm(nearest.dist)} <small>NM</small>` : '–', nearest ? esc(nearest.v.name || nearest.v.mmsi) : 'Nothing in range') +
    kpi('Closing', closing.length, closing[0] ? `next CPA in ${Math.round(closing[0].cpa.tcpaMin)} min` : 'No one heading your way', closing.some((r) => r.risk) ? 'neg' : '') +
    kpi('Watchlist', `${watched.length}<small> / ${watch.length}</small>`, watch.length ? 'seen right now' : 'Add one in Watchlist');
}

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'watch', label: 'Watchlist', test: (r) => !!r.w },
  { id: 'moving', label: 'Under way', test: (r) => (r.v.sog ?? 0) > 0.5 },
  { id: 'closing', label: 'Closing', test: (r) => r.closing },
];

function renderFilters(rows) {
  $('#filters').innerHTML = FILTERS.map((f) => {
    const n = rows.filter(f.test).length;
    return `<button type="button" class="chip ${settings.filter === f.id ? 'on' : ''}" data-filter="${f.id}" aria-pressed="${settings.filter === f.id}">${f.label} · ${n}</button>`;
  }).join('');
}

function shipGlyph(v) {
  const moving = (v.sog ?? 0) > 0.5;
  const rot = v.hdg != null && v.hdg !== 511 ? v.hdg : v.cog ?? 0;
  return moving
    ? `<svg viewBox="0 0 24 24" style="transform:rotate(${Math.round(rot)}deg)" aria-hidden="true"><use href="#i-ship"/></svg>`
    : `<svg viewBox="0 0 24 24" style="transform:scale(.7)" aria-hidden="true"><use href="#i-moored"/></svg>`;
}

function cpaCell(r) {
  if (!r.cpa || (r.v.sog ?? 0) <= 0.5 && (me?.sog ?? 0) <= 0.5) return `<div><span>CPA</span><b>–</b></div>`;
  if (!r.cpa.closing) return `<div><span>CPA</span><b>Opening</b></div>`;
  return `<div><span>CPA in ${Math.round(r.cpa.tcpaMin)} min</span><b class="${r.risk ? 'neg' : ''}">${fmtNm(r.cpa.cpaNm)} NM</b></div>`;
}

function vesselCard(r) {
  const { v, w } = r;
  const type = shipTypeLabel(v.type);
  const pills = [];
  if (w) pills.push(`<span class="pill accent">Watching</span>`);
  if (w && w.visible === false) pills.push(`<span class="pill">Hidden on chart</span>`);
  if (r.risk) pills.push(`<span class="pill alert">Close quarters</span>`);
  if (r.stale) pills.push(`<span class="pill warn">Stale</span>`);
  const rel = fmtRelative(r.rel);
  const course = v.cog != null && (v.sog ?? 0) > 0.5 ? formatBearing(v.cog) : v.nav === 1 ? 'At anchor' : v.nav === 5 ? 'Moored' : 'Stopped';
  return `
    <div class="glyph">${shipGlyph(v)}</div>
    <div style="min-width:0"><div class="name">${esc(v.name || 'Unnamed vessel')}</div>
      <div class="meta">${esc(type)} · <span class="mono">${esc(v.mmsi)}</span>${v.dest ? ` · to ${esc(v.dest)}` : ''}</div></div>
    <div class="range"><b>${fmtNm(r.dist)} <small>NM</small></b><span>${formatBearing(r.brg)} T${rel ? ` · ${rel}` : ''}</span></div>
    <div class="lstats">
      <div><span>Speed</span><b>${fmtKn(v.sog)}</b></div>
      <div><span>Course</span><b>${course}</b></div>
      ${cpaCell(r)}
    </div>
    <div class="vfoot">${pills.join('')}<span>Updated ${fmtAge(v.ts)}</span><span class="spacer"></span>
      <button type="button" class="round-btn ${w ? 'on' : ''}" data-watch="${esc(v.mmsi)}" aria-pressed="${!!w}"
        aria-label="${w ? 'Remove from watchlist' : 'Add to watchlist'}" title="${w ? 'Remove from watchlist' : 'Add to watchlist'}">
        <svg viewBox="0 0 24 24"><use href="#i-star"/></svg></button>
    </div>`;
}

const cardEls = new Map();
function renderList(rows) {
  renderOwn();
  renderKpis(rows);
  renderFilters(rows);
  const f = FILTERS.find((x) => x.id === settings.filter) || FILTERS[0];
  const shown = rows.filter(f.test);
  const list = $('#vessel-list');
  $('#list-meta').textContent = shown.length > MAX_CARDS ? `${MAX_CARDS} of ${shown.length}` : `${shown.length} vessel${shown.length === 1 ? '' : 's'}`;

  if (!shown.length) {
    cardEls.clear();
    const msg = settings.filter === 'watch'
      ? ['None of your watchlist is in sight', 'Add vessels with the star on any card, or by MMSI in Watchlist.']
      : settings.filter === 'closing'
        ? ['Nobody is closing on you', 'Vessels with a CPA inside the next hour show up here.']
        : feedState.state === 'error'
          ? ['Not connected to AisStream', feedState.detail]
          : feedState.state === 'offline' || feedState.state === 'reconnecting'
            ? ['Waiting for the connection', feedState.detail || 'The list fills as soon as positions come in.']
            : [`No vessels within ${settings.range} NM`, 'Widen the traffic range in Settings, or wait for the next reports.'];
    list.innerHTML = `<div class="card empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 17c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0"/><path d="M12 3v10M8 7h8"/></svg><div class="t">${msg[0]}</div><div>${msg[1]}</div></div>`;
    return;
  }
  if (!cardEls.size) list.innerHTML = '';

  // Keyed update: reuse each vessel's element so cards don't re-animate or lose focus.
  const keep = new Set();
  shown.slice(0, MAX_CARDS).forEach((r, i) => {
    keep.add(r.v.mmsi);
    let el = cardEls.get(r.v.mmsi);
    if (!el) {
      el = document.createElement('article');
      el.style.setProperty('--i', Math.min(i, 12));
      cardEls.set(r.v.mmsi, el);
    }
    el.className = `card vessel${r.w ? ' watched' : ''}${r.risk ? ' closing' : ''}`;
    const html = vesselCard(r);
    if (el._html !== html) {
      const focused = el.contains(document.activeElement);
      el.innerHTML = html;
      el._html = html;
      if (focused) el.querySelector('[data-watch]')?.focus();
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  for (const [k, el] of cardEls) if (!keep.has(k)) { el.remove(); cardEls.delete(k); }
}

// ---------- Chart (Leaflet) ----------
let map = null, baseLayer = null, ownMarker = null, ownCircle = null;
const markers = new Map();
let didFit = false;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

function setBaseLayer() {
  if (!map) return;
  if (baseLayer) map.removeLayer(baseLayer);
  const style = isDark() ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
  baseLayer = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 16,
    attribution: 'Tiles &copy; Esri · Seamarks <a href="https://openseamap.org">OpenSeaMap</a>',
  }).addTo(map);
  baseLayer.bringToBack();
  if (ownCircle) ownCircle.setStyle({ color: cssVar('--own'), fillColor: cssVar('--own') });
}

function initMap() {
  if (map || !window.L) return;
  const c = centre();
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([c.lat, c.lon], 11);
  setBaseLayer();
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, opacity: 0.9 }).addTo(map);
  ownCircle = L.circle([c.lat, c.lon], { radius: 0, color: cssVar('--own'), fillColor: cssVar('--own'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  ownMarker = L.marker([c.lat, c.lon], {
    icon: L.divIcon({ className: '', html: '<div class="own-marker" style="width:18px;height:18px"></div>', iconSize: [18, 18] }),
    zIndexOffset: 1000, keyboard: false, title: 'You',
  }).addTo(map);
  map.getContainer().addEventListener('click', onWatchButton);
}

function popupHtml(r) {
  const { v, w } = r;
  const c = r.cpa;
  const cpaText = !c || !c.closing ? 'Opening' : `${fmtNm(c.cpaNm)} NM in ${Math.round(c.tcpaMin)} min`;
  return `<div class="pop">
    <div class="pn">${esc(v.name || 'Unnamed vessel')}</div>
    <div class="pm">${esc(shipTypeLabel(v.type))} · <span class="mono">${esc(v.mmsi)}</span>${v.len ? ` · ${v.len} m` : ''}</div>
    <dl>
      <dt>Range</dt><dd>${fmtNm(r.dist)} NM</dd>
      <dt>Bearing</dt><dd>${formatBearing(r.brg)} T${r.rel != null ? ` · ${fmtRelative(r.rel)}` : ''}</dd>
      <dt>Speed</dt><dd>${fmtKn(v.sog)}</dd>
      <dt>Course / heading</dt><dd>${v.cog != null ? formatBearing(v.cog) : '–'} / ${v.hdg != null && v.hdg !== 511 ? formatBearing(v.hdg) : '–'}</dd>
      <dt>CPA</dt><dd class="${r.risk ? 'neg' : ''}">${cpaText}</dd>
      ${v.dest ? `<dt>Destination</dt><dd>${esc(v.dest)}</dd>` : ''}
      <dt>Updated</dt><dd>${fmtAge(v.ts)}</dd>
    </dl>
    <button type="button" class="btn small ${w ? 'ghost' : ''}" data-watch="${esc(v.mmsi)}">${w ? 'Remove from watchlist' : 'Add to watchlist'}</button>
  </div>`;
}

function markerClass(r) {
  return `ship-marker${r.w ? ' watched' : ''}${r.risk ? ' closing' : ''}`;
}

function markerInner(r) {
  const label = settings.labels || r.w ? `<span class="lbl">${esc(r.v.name || r.v.mmsi)}</span>` : '';
  return shipGlyph(r.v) + label;
}

function renderMap(rows) {
  initMap();
  if (!map) return;
  const c = centre();
  ownMarker.setLatLng([c.lat, c.lon]);
  ownCircle.setLatLng([c.lat, c.lon]).setRadius(me?.source === 'gps' ? me.acc : 0);

  const keep = new Set();
  for (const r of rows) {
    if (r.w && r.w.visible === false) continue;
    const { v } = r;
    keep.add(v.mmsi);
    let m = markers.get(v.mmsi);
    const size = (v.sog ?? 0) > 0.5 ? 22 : 16;
    if (!m) {
      m = L.marker([v.lat, v.lon], {
        icon: L.divIcon({ className: '', html: `<div class="${markerClass(r)}" style="width:${size}px;height:${size}px;position:relative">${markerInner(r)}</div>`, iconSize: [size, size] }),
        title: v.name || v.mmsi,
      }).addTo(map);
      m.bindPopup('', { maxWidth: 280, autoPanPadding: [20, 60] });
      markers.set(v.mmsi, m);
    } else {
      m.setLatLng([v.lat, v.lon]);
      const el = m.getElement()?.firstElementChild;
      if (el) {
        el.className = markerClass(r);
        el.style.width = el.style.height = `${size}px`;
        const inner = markerInner(r);
        if (el._inner !== inner) { el.innerHTML = inner; el._inner = inner; }
      }
    }
    m.setZIndexOffset(r.w ? 500 : r.risk ? 400 : 0);
    m._row = r;
    const p = m.getPopup();
    if (p.isOpen() || !p.getContent()) p.setContent(popupHtml(r));
  }
  for (const [k, m] of markers) if (!keep.has(k)) { map.removeLayer(m); markers.delete(k); }
  // Popups are filled when opened, so they always show the latest numbers.
  if (!map._popupHook) {
    map._popupHook = true;
    map.on('popupopen', (e) => { const m = e.popup._source; if (m?._row) e.popup.setContent(popupHtml(m._row)); });
  }
  if (!didFit && rows.length) { didFit = true; fitAll(rows); }
}

function fitAll(rows = derive()) {
  if (!map) return;
  const c = centre();
  const pts = [[c.lat, c.lon], ...rows.filter((r) => r.dist <= settings.range).map((r) => [r.v.lat, r.v.lon])];
  if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}

// ---------- Watchlist ----------
function renderWatchCount(rows) {
  const n = rows.filter((r) => r.w).length;
  const el = $('#watch-count');
  el.hidden = !watch.length;
  el.textContent = n;
  el.title = `${n} of ${watch.length} in sight`;
}

function renderWatch(rows) {
  const host = $('#watch-list');
  const byId = new Map();
  for (const r of rows) if (r.w) byId.set(r.w.id, r);
  // Watched vessels out of range are still tracked; find them in the full set.
  for (const v of vessels.values()) {
    const w = watchEntryFor(v);
    if (w && !byId.has(w.id)) byId.set(w.id, { v, w, dist: distanceNm(centre(), v) });
  }
  let html;
  if (!watch.length) {
    html = `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><use href="#i-star"/></svg>
      <div class="t">Your watchlist is empty</div><div>Add a vessel above, or tap the star on any card in Nearby.</div></div>`;
  } else {
    html = `<h3>Following ${watch.length} vessel${watch.length === 1 ? '' : 's'}</h3>` + watch.map((w) => {
      const r = byId.get(w.id);
      const title = r?.v.name || w.name || 'Waiting for a name';
      const sub = [w.mmsi ? `MMSI ${w.mmsi}` : 'Matched by name', r ? shipTypeLabel(r.v.type) : null].filter(Boolean).join(' · ');
      const where = r
        ? `${fmtNm(r.dist)} NM<small>${formatBearing(bearingDeg(centre(), r.v))} T · ${fmtAge(r.v.ts)}</small>`
        : `<span class="muted">Not seen</span><small>${w.mmsi ? 'not in the traffic' : `only within ${settings.range} NM`}</small>`;
      return `<div class="wrow">
        <div style="min-width:0"><div class="wn">${esc(title)}${w.demo ? ' <span class="pill warn">Demo</span>' : ''}</div><div class="wm">${esc(sub)}</div></div>
        <div class="wd">${where}</div>
        <div class="toggles">
          <label><input type="checkbox" class="sw" id="vis-${w.id}" data-vis="${w.id}" ${w.visible !== false ? 'checked' : ''}>Show on chart</label>
          <label><input type="checkbox" class="sw" id="alr-${w.id}" data-alert="${w.id}" ${!w.muted ? 'checked' : ''}>Alerts</label>
          <span class="spacer"></span>
          <button type="button" class="btn danger small" id="rm-${w.id}" data-remove="${w.id}">Remove</button>
        </div></div>`;
    }).join('');
  }
  if (host._html === html) return;
  const focusId = document.activeElement?.id;
  host.innerHTML = html;
  host._html = html;
  if (focusId && host.querySelector(`#${CSS.escape(focusId)}`)) host.querySelector(`#${CSS.escape(focusId)}`).focus();
}

function addWatch(input) {
  const q = String(input || '').trim();
  const hint = $('#add-hint');
  if (!q) { hint.className = 'hint err'; hint.textContent = 'Type a 9-digit MMSI or a vessel name first.'; return false; }
  let entry;
  if (/^\d+$/.test(q)) {
    if (!isValidMmsi(q)) { hint.className = 'hint err'; hint.textContent = `An MMSI has 9 digits; that one has ${q.length}.`; return false; }
    const known = vessels.get(q);
    entry = { mmsi: q, name: known ? normName(known.name) : '' };
  } else {
    const n = normName(q);
    if (n.length < 2) { hint.className = 'hint err'; hint.textContent = 'Use at least 2 letters of the name.'; return false; }
    const known = [...vessels.values()].find((v) => normName(v.name) === n);
    entry = { mmsi: known?.mmsi || '', name: n };
  }
  const dup = watch.find((w) => (entry.mmsi && w.mmsi === entry.mmsi) || (!entry.mmsi && w.name === entry.name));
  if (dup) { hint.className = 'hint err'; hint.textContent = 'That one is on your watchlist already.'; return false; }
  watch.unshift({ id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...entry, muted: false, visible: true, added: Date.now() });
  saveWatch();
  hint.className = 'hint good';
  hint.textContent = entry.mmsi ? `Added. Watching MMSI ${entry.mmsi} wherever it is.` : `Added. ${entry.name} shows up when it is within ${settings.range} NM.`;
  return true;
}

function toggleWatchMmsi(mmsi) {
  const v = vessels.get(mmsi);
  const w = v ? watchEntryFor(v) : watch.find((x) => x.mmsi === mmsi);
  if (w) watch = watch.filter((x) => x !== w);
  else watch.unshift({ id: `w${Date.now().toString(36)}`, mmsi, name: normName(v?.name), muted: false, visible: true, added: Date.now() });
  saveWatch();
  toast(w ? 'Removed from watchlist' : 'Added to watchlist', v?.name || mmsi, 'ok');
}

function onWatchButton(e) {
  const b = e.target.closest('[data-watch]');
  if (!b) return;
  toggleWatchMmsi(b.dataset.watch);
  if (map) map.closePopup();
}

function onWatchChanged() {
  feed?.resubscribe?.();
  scheduleRender(true);
}

// ---------- Alerts ----------
function checkAlerts(rows) {
  if (!settings.alert) return;
  for (const r of rows) {
    if (!r.w || r.w.muted) continue;
    const key = r.w.id;
    if (r.dist <= settings.alert && !alerted.has(key)) {
      alerted.add(key);
      toast(`${r.v.name || r.v.mmsi} is ${fmtNm(r.dist)} NM away`, `Bearing ${formatBearing(r.brg)} T · ${fmtKn(r.v.sog)}`);
      try { navigator.vibrate?.([120, 80, 120]); } catch {}
    } else if (r.dist > settings.alert * 1.2) {
      alerted.delete(key);
    }
  }
}

let toastTimer = null;
function toast(title, detail = '', kind = 'warn') {
  const host = $('#toast-host');
  host.innerHTML = `<div class="toast ${kind}" role="alert"><span class="ico">${kind === 'ok' ? '✓' : '!'}</span><div><b>${esc(title)}</b>${detail ? `<span class="muted">${esc(detail)}</span>` : ''}</div></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ''; }, 4500);
}

// ---------- Settings ----------
function setSeg(id, value) {
  $$(`#${id} button`).forEach((b) => {
    const on = b.dataset.v === String(value);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
}

function renderSettings() {
  setSeg('seg-source', settings.source);
  setSeg('seg-retry', settings.retry);
  setSeg('seg-range', settings.range);
  setSeg('seg-alert', settings.alert);
  setSeg('seg-theme', settings.theme);
  $('#live-settings').hidden = settings.source !== 'live';
  const key = $('#ais-key');
  if (document.activeElement !== key && !key.value) key.value = settings.apiKey;
  const out = $('#source-desc');
  out.className = 'd';
  if (settings.source === 'demo') out.textContent = 'Simulated traffic around your position. The vessels are fictional.';
  else if (!settings.apiKey) out.textContent = 'Enter your AisStream key below and tap Connect.';
  else {
    out.textContent = `${STATUS_LABEL[feedState.state] || feedState.state}${feedState.detail ? `: ${feedState.detail}` : ''}`;
    if (feedState.state === 'error') out.className = 'd err';
    if (feedState.state === 'live') out.className = 'd good';
  }
}

// ---------- Feed ----------
function onVessel(update) {
  if (!update || !update.mmsi) return;
  const mmsi = String(update.mmsi);
  const prev = vessels.get(mmsi) || { mmsi };
  const next = { ...prev };
  for (const [k, val] of Object.entries(update)) if (val !== undefined && val !== null && val !== '') next[k] = val;
  next.mmsi = mmsi;
  if (next.lat == null || next.lon == null) { vessels.set(mmsi, next); return; } // static data before the first position
  vessels.set(mmsi, next);
  // A name-only watch entry learns its MMSI the first time it is seen.
  const w = watch.find((x) => !x.mmsi && x.name && x.name === normName(next.name));
  if (w) { w.mmsi = mmsi; store.set('vt.watch', watch); }
  scheduleRender();
}

function startFeed() {
  feed?.stop();
  vessels.clear();
  cardEls.clear();
  for (const m of markers.values()) map?.removeLayer(m);
  markers.clear();
  didFit = false;
  if (settings.source === 'live') {
    if (!settings.apiKey) { feed = null; setStatus('error', 'Add your AisStream key in Settings.'); scheduleRender(true); return; }
    feed = new AisStreamFeed({
      apiKey: settings.apiKey, range: settings.range, retryMinutes: settings.retry, getCentre: centre,
      getWatchMmsi: () => watch.filter((w) => w.mmsi).map((w) => w.mmsi), onVessel, onStatus: setStatus,
    });
  } else {
    feed = new DemoFeed({ getCentre: centre, onVessel, onStatus: setStatus });
  }
  feed.start();
  scheduleRender(true);
}

// ---------- Location ----------
let geoWatchId = null;
function startGeo() {
  if (!('geolocation' in navigator)) { geoError = 'This browser has no location service. Distances are measured from Hoek van Holland.'; return; }
  if (geoWatchId != null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = navigator.geolocation.watchPosition((p) => {
    const first = !me || me.source !== 'gps';
    const { latitude, longitude, accuracy, speed, heading } = p.coords;
    const sog = speed != null && !Number.isNaN(speed) ? speed * KN_PER_MS : null;
    me = { lat: latitude, lon: longitude, acc: accuracy, sog, cog: heading != null && !Number.isNaN(heading) ? heading : me?.cog ?? null, ts: p.timestamp, source: 'gps' };
    geoError = null;
    feed?.moved?.(me);
    if (first) {
      if (settings.source === 'demo') startFeed(); // re-centre the demo fleet on you
      else feed?.resubscribe();
      if (map) map.setView([latitude, longitude], map.getZoom());
    }
    scheduleRender();
  }, (err) => {
    geoError = err.code === 1
      ? 'Location is off for this site. Distances are measured from Hoek van Holland until you allow it.'
      : 'No GPS fix yet. Distances are measured from the last known point.';
    scheduleRender();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}

// ---------- Tabs ----------
const TAB_TEXT = {
  list: ['Nearby', 'Vessels around you, closest first.'],
  map: ['Chart', 'Tap a vessel to see range, bearing and CPA.'],
  watch: ['Watchlist', 'Vessels you follow, wherever they are.'],
  settings: ['Settings', 'Data source, range, alerts and display.'],
};
function showTab(tab) {
  if (!TAB_TEXT[tab]) tab = 'list';
  settings.tab = tab;
  saveSettings();
  $$('nav.tabs button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== tab; });
  $('#title').textContent = TAB_TEXT[tab][0];
  $('#subtitle').textContent = TAB_TEXT[tab][1];
  if (tab === 'settings') renderSettings();
  scheduleRender(true);
  if (tab === 'map') requestAnimationFrame(() => map?.invalidateSize());
  window.scrollTo({ top: 0 });
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta.content = isDark() ? '#05060a' : '#f4f7f9';
  setBaseLayer();
}

// ---------- Wiring ----------
function wire() {
  $('nav.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    settings.filter = b.dataset.filter; saveSettings(); cardEls.clear(); $('#vessel-list').innerHTML = ''; scheduleRender(true);
  });
  $('#vessel-list').addEventListener('click', onWatchButton);
  $('#own-card').addEventListener('click', (e) => { if (e.target.closest('#btn-geo')) { geoError = null; startGeo(); scheduleRender(true); } });

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (addWatch($('#add-input').value)) $('#add-input').value = '';
  });
  $('#watch-list').addEventListener('change', (e) => {
    const t = e.target;
    const w = watch.find((x) => x.id === (t.dataset.vis || t.dataset.alert));
    if (!w) return;
    if (t.dataset.vis) w.visible = t.checked;
    if (t.dataset.alert) { w.muted = !t.checked; alerted.delete(w.id); }
    saveWatch();
  });
  $('#watch-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const w = watch.find((x) => x.id === b.dataset.remove);
    watch = watch.filter((x) => x.id !== b.dataset.remove);
    saveWatch();
    if (w) toast('Removed from watchlist', w.name || w.mmsi, 'ok');
  });

  const seg = (id, fn) => $(`#${id}`).addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { fn(b.dataset.v); saveSettings(); renderSettings(); } });
  seg('seg-range', (v) => { settings.range = Number(v); feed?.setRange?.(settings.range); didFit = false; scheduleRender(true); });
  seg('seg-source', (v) => {
    if (v === settings.source) return;
    settings.source = v;
    if (v === 'live') { const before = watch.length; watch = watch.filter((w) => !w.demo); if (watch.length !== before) store.set('vt.watch', watch); }
    startFeed();
  });
  seg('seg-retry', (v) => { settings.retry = Number(v); feed?.setRetryMinutes?.(settings.retry); });
  $('#key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#ais-key').value.trim();
    if (!key) { $('#source-desc').className = 'd err'; $('#source-desc').textContent = 'Paste your key first.'; return; }
    settings.apiKey = key; saveSettings();
    startFeed(); renderSettings();
  });
  $('#btn-key-show').addEventListener('click', (e) => {
    const k = $('#ais-key'); const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });
  $('#btn-key-forget').addEventListener('click', () => {
    settings.apiKey = ''; $('#ais-key').value = ''; saveSettings(); startFeed(); renderSettings();
  });
  seg('seg-alert', (v) => { settings.alert = Number(v); alerted.clear(); });
  seg('seg-theme', (v) => { settings.theme = v; applyTheme(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

  $('#btn-recenter').addEventListener('click', () => { const c = centre(); map?.setView([c.lat, c.lon], Math.max(map.getZoom(), 12)); });
  $('#btn-fit').addEventListener('click', () => fitAll());
  $('#btn-labels').addEventListener('click', (e) => {
    settings.labels = !settings.labels; saveSettings();
    e.currentTarget.classList.toggle('on', settings.labels);
    e.currentTarget.setAttribute('aria-pressed', settings.labels);
    scheduleRender(true);
  });
  $('#btn-labels').classList.toggle('on', settings.labels);

  const header = $('#top');
  addEventListener('scroll', () => header.classList.toggle('scrolled', scrollY > 8), { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(true); });

  setInterval(() => scheduleRender(), 5000); // keeps "Updated … ago" honest
}

function seedDemoWatch() {
  if (!firstRun) return;
  watch = DEMO_WATCH_SEED.map((s, i) => ({ id: `demo${i}`, ...s, muted: false, visible: true, demo: true, added: Date.now() }));
  store.set('vt.watch', watch);
}

function boot() {
  applyTheme();
  wire();
  showTab(settings.tab);
  seedDemoWatch();
  startGeo();
  startFeed();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
