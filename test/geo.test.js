import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceNm, bearingDeg, relativeBearing, destinationPoint, cpa, bboxAround,
  isValidMmsi, normName, shipTypeLabel, formatLatLon, formatBearing,
} from '../public/geo.js';
import { parseAis, sanitizeSubscription, parseBbox, pickKey } from '../worker/worker.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('one minute of latitude is one nautical mile', () => {
  near(distanceNm({ lat: 50, lon: 4 }, { lat: 50 + 1 / 60, lon: 4 }), 1, 0.005);
});

test('Hoek van Holland to Harwich is about 103 NM on 268°', () => {
  const hvh = { lat: 51.985, lon: 4.06 }, harwich = { lat: 51.947, lon: 1.29 };
  near(distanceNm(hvh, harwich), 102.6, 1.5);
  near(bearingDeg(hvh, harwich), 268, 2);
});

test('bearings cover the cardinal points', () => {
  const o = { lat: 0, lon: 0 };
  near(bearingDeg(o, { lat: 1, lon: 0 }), 0, 0.01);
  near(bearingDeg(o, { lat: 0, lon: 1 }), 90, 0.01);
  near(bearingDeg(o, { lat: -1, lon: 0 }), 180, 0.01);
  near(bearingDeg(o, { lat: 0, lon: -1 }), 270, 0.01);
});

test('relative bearing wraps and needs a heading', () => {
  assert.equal(relativeBearing(10, 350), 20);
  assert.equal(relativeBearing(340, 20), 320);
  assert.equal(relativeBearing(90, null), null);
});

test('destinationPoint is the inverse of distance and bearing', () => {
  const a = { lat: 51.9, lon: 4.1 };
  const b = destinationPoint(a, 123, 7.5);
  near(distanceNm(a, b), 7.5, 0.01);
  near(bearingDeg(a, b), 123, 0.1);
});

test('CPA: a ship crossing ahead from starboard', () => {
  const own = { lat: 52, lon: 4, sog: 0, cog: 0 };
  // Target 2 NM north, 2 NM east, steaming west at 12 kn: passes 2 NM ahead in 10 min.
  const tgt = { ...destinationPoint(destinationPoint(own, 0, 2), 90, 2), sog: 12, cog: 270 };
  const r = cpa(own, tgt);
  assert.equal(r.closing, true);
  near(r.cpaNm, 2, 0.02);
  near(r.tcpaMin, 10, 0.2);
});

test('CPA: an opening ship reports its current range', () => {
  const own = { lat: 52, lon: 4, sog: 0, cog: 0 };
  const tgt = { ...destinationPoint(own, 0, 3), sog: 10, cog: 0 };
  const r = cpa(own, tgt);
  assert.equal(r.closing, false);
  near(r.cpaNm, 3, 0.01);
});

test('CPA: no relative motion', () => {
  const own = { lat: 52, lon: 4, sog: 8, cog: 45 };
  const tgt = { lat: 52.05, lon: 4, sog: 8, cog: 45 };
  assert.equal(cpa(own, tgt).tcpaMin, null);
});

test('formatting', () => {
  assert.equal(formatLatLon(51.98, true), '51° 58.80′ N');
  assert.equal(formatLatLon(-4.5, false), '4° 30.00′ W');
  assert.equal(formatLatLon(3.99999, true), '4° 00.00′ N');
  assert.equal(formatBearing(7.4), '007°');
  assert.equal(formatBearing(359.7), '000°');
  assert.equal(isValidMmsi('244670583'), true);
  assert.equal(isValidMmsi('24467058'), false);
  assert.equal(normName('  Nordic-tern '), 'NORDIC TERN');
  assert.equal(shipTypeLabel(72), 'Cargo');
  assert.equal(shipTypeLabel(84), 'Tanker');
  assert.equal(shipTypeLabel(0), 'Unknown type');
});

test('bbox spans the radius in both directions', () => {
  const [[s, w], [n, e]] = bboxAround({ lat: 52, lon: 4 }, 10);
  near(n - s, 20 / 60, 1e-9);
  assert.ok(e - w > n - s, 'longitude span is wider at 52° N');
});

test('parseAis: position report', () => {
  const v = parseAis({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 244670583, ShipName: 'NORDIC TERN         ', latitude: 51.98, longitude: 4.05, time_utc: '2026-10-16 09:12:30.123456 +0000 UTC' },
    Message: { PositionReport: { UserID: 244670583, Latitude: 51.98, Longitude: 4.05, Sog: 11.8, Cog: 231.4, TrueHeading: 511, NavigationalStatus: 0 } },
  });
  assert.equal(v.mmsi, '244670583');
  assert.equal(v.name, 'NORDIC TERN');
  assert.equal(v.sog, 11.8);
  assert.equal(v.cog, 231.4);
  assert.equal(v.hdg, undefined, '511 means no heading');
  assert.equal(v.ts, Date.UTC(2026, 9, 16, 9, 12, 30));
});

test('parseAis: static data and invalid input', () => {
  const v = parseAis({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: 246338210 },
    Message: { ShipStaticData: { Name: 'STELLA ORION@@@', Type: 80, Destination: 'GBIMM', Dimension: { A: 180, B: 48, C: 16, D: 16 } } },
  });
  assert.deepEqual([v.name, v.type, v.dest, v.len], ['STELLA ORION', 80, 'GBIMM', 228]);
  assert.equal(parseAis({ MessageType: 'PositionReport', MetaData: { MMSI: 12 }, Message: {} }), null);
  assert.equal(parseAis({ MessageType: 'PositionReport', MetaData: { MMSI: 244670583 }, Message: { PositionReport: { Latitude: 91, Longitude: 181 } } }), null);
});

test('subscriptions are sanitised', () => {
  const s = sanitizeSubscription({ bbox: [[-95, 4], [52, 200]], mmsi: ['244670583', 'abc', '244670583', 123456789] });
  assert.deepEqual(s.bbox, [[-90, 4], [52, 180]]);
  assert.deepEqual(s.mmsi, ['244670583', '123456789']);
  assert.deepEqual(parseBbox('51.8,3.9,52.1,4.3'), [[51.8, 3.9], [52.1, 4.3]]);
  assert.equal(parseBbox('1,2,3'), null);
});

test('the Worker secret wins over a key from the app', () => {
  assert.equal(pickKey({ AISSTREAM_API_KEY: 'server-key-123' }, 'client-key-456'), 'server-key-123');
  assert.equal(pickKey({}, ' client-key-456 '), 'client-key-456');
  assert.equal(pickKey({}, 'bad key with spaces'), '');
  assert.equal(pickKey({}, undefined), '');
});
