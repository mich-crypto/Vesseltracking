// Navigation maths. Pure functions, shared by the app and the tests.
// Positions are { lat, lon } in decimal degrees; distances in nautical miles; speeds in knots.

export const EARTH_RADIUS_NM = 3440.065;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

/** Great-circle distance (haversine) in nautical miles. */
export function distanceNm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing from a to b, 0–360°. */
export function bearingDeg(a, b) {
  const φ1 = rad(a.lat), φ2 = rad(b.lat), Δλ = rad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(deg(Math.atan2(y, x)));
}

/** Bearing relative to own heading (0 = dead ahead, 90 = starboard beam). Null without a heading. */
export function relativeBearing(trueBearing, ownHeading) {
  if (ownHeading == null || Number.isNaN(ownHeading)) return null;
  return norm360(trueBearing - ownHeading);
}

/** Point reached from `from` on a true bearing after `distNm`. */
export function destinationPoint(from, bearing, distNm) {
  const δ = distNm / EARTH_RADIUS_NM, θ = rad(bearing);
  const φ1 = rad(from.lat), λ1 = rad(from.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

/**
 * Closest point of approach between own ship and a target, on a local flat projection
 * (fine inside the ~50 NM ranges this app works with).
 * Returns { cpaNm, tcpaMin, closing }. tcpaMin is null when there is no relative motion.
 */
export function cpa(own, target) {
  const midLat = rad((own.lat + target.lat) / 2);
  const px = (target.lon - own.lon) * 60 * Math.cos(midLat);
  const py = (target.lat - own.lat) * 60;
  const vel = (s) => {
    const sog = s.sog || 0, cog = rad(s.cog || 0);
    return [sog * Math.sin(cog), sog * Math.cos(cog)];
  };
  const [ox, oy] = vel(own), [tx, ty] = vel(target);
  const vx = tx - ox, vy = ty - oy;
  const v2 = vx * vx + vy * vy;
  const range = Math.hypot(px, py);
  if (v2 < 1e-6) return { cpaNm: range, tcpaMin: null, closing: false };
  const tHours = -(px * vx + py * vy) / v2;
  if (tHours <= 0) return { cpaNm: range, tcpaMin: 0, closing: false };
  return {
    cpaNm: Math.hypot(px + vx * tHours, py + vy * tHours),
    tcpaMin: tHours * 60,
    closing: true,
  };
}

export const isValidMmsi = (s) => /^\d{9}$/.test(String(s).trim());

/** Normalise a vessel name the way AIS transmits it: upper case, single spaces. */
export const normName = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** AIS ship-type code (ITU-R M.1371) to a short label. */
export function shipTypeLabel(code) {
  const c = Number(code);
  if (!c) return 'Unknown type';
  if (c === 30) return 'Fishing';
  if (c === 31 || c === 32) return 'Towing';
  if (c === 33) return 'Dredger';
  if (c === 34) return 'Diving ops';
  if (c === 35) return 'Military';
  if (c === 36) return 'Sailing';
  if (c === 37) return 'Pleasure craft';
  if (c >= 40 && c <= 49) return 'High-speed craft';
  if (c === 50) return 'Pilot';
  if (c === 51) return 'Search and rescue';
  if (c === 52) return 'Tug';
  if (c === 53) return 'Port tender';
  if (c === 55) return 'Law enforcement';
  if (c === 58) return 'Medical';
  if (c >= 60 && c <= 69) return 'Passenger';
  if (c >= 70 && c <= 79) return 'Cargo';
  if (c >= 80 && c <= 89) return 'Tanker';
  return 'Other';
}

/** 51.98 → "51° 58.80′ N" (degrees and decimal minutes, as on a chart plotter). */
export function formatLatLon(value, isLat) {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  const abs = Math.abs(value);
  let d = Math.floor(abs);
  let m = (abs - d) * 60;
  if (m >= 59.995) { d += 1; m = 0; }
  return `${d}° ${m.toFixed(2).padStart(5, '0')}′ ${hemi}`;
}

/** 7.4 → "007°" */
export const formatBearing = (b) => `${String(Math.round(norm360(b)) % 360).padStart(3, '0')}°`;
