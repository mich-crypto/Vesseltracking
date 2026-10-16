// Data feed. For now there is only the demo simulator; a live AIS source can be added later
// by implementing the same interface: start(), stop(), calling onVessel(partialVessel) and onStatus(state, detail).

import { destinationPoint, distanceNm, bearingDeg } from './geo.js';

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
