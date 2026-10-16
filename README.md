# Vessel Tracker

A mobile-first PWA for keeping an eye on the traffic around you. It shows live AIS traffic, keeps a personal watchlist, and gives the range, bearing and CPA to every vessel from your GPS position. The look follows the **Portfolio** design system: glass cards over a soft colour field, a capsule tab bar, Space Grotesk titles, IBM Plex text and a teal accent. Dark mode is the default.

```
Phone (PWA)  ──WebSocket /ws──►  Cloudflare Worker  ──WebSocket──►  AisStream.io
             ◄─REST /api/snapshot (offshore polling)
```

## What it does

- **Nearby**: your position in degrees and decimal minutes, plus speed and course from GPS. A KPI row shows how many vessels are in range, the nearest one, how many are closing and how many watchlist vessels are in sight. Vessel cards are sorted nearest first and show range (NM), true bearing, relative bearing (Green/Red), speed, course, and CPA/TCPA.
- **Chart**: a Leaflet map on Esri grey basemaps with OpenSeaMap seamarks. You appear as a blue dot with an accuracy circle. Vessels are arrows rotated to their heading: teal for the watchlist, amber when closing, grey for everything else. Tap a vessel for its details.
- **Watchlist**: add a vessel by MMSI or by name. Each vessel has a *Show on chart* switch, an *Alerts* switch (mute) and *Remove*. Everything is stored in `localStorage`.
- **Alerts**: a banner and a vibration when a watched vessel comes within 1, 2 or 5 NM.
- **Connection badge**: Live (green), Reconnecting (amber), Polling (teal), Offline (red), Demo.
- **Updates**: data streams over a WebSocket. After 4 failed reconnects the app polls `/api/snapshot` every 10 or 15 minutes, and every poll also tries to get the stream back. Re-renders are throttled to at most one every 2 s. The server forwards at most one position per vessel every 2 s.
- **Offline**: a service worker caches the app shell and up to 600 chart tiles. The last known positions are kept for 2 h and marked "Last known".
- **Demo traffic**: with no server the app simulates 14 fictional vessels around you, so you can try it straight away.

## Run it

```bash
npm install
npx wrangler secret put AISSTREAM_API_KEY   # free key from https://aisstream.io
npm run dev                                 # app + proxy on http://localhost:8787
npm run deploy                              # to Cloudflare
```

When the app is served by the Worker and the key is set, it switches to live data by itself. To host the static files elsewhere (for example GitHub Pages from `public/`), enter the Worker URL under **Settings → Live data server** and set `ALLOWED_ORIGINS` in `wrangler.toml`.

To try only the UI: `npm run serve` and open http://localhost:8080 (demo traffic).

## Tests

```bash
npm test   # navigation maths (haversine, bearing, CPA), formatting, AIS parsing
```

## Files

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css` | Layout and Portfolio tokens |
| `public/app.js` | State, rendering, map, watchlist, alerts, settings |
| `public/feed.js` | Live feed (WebSocket + polling fallback) and demo simulator |
| `public/geo.js` | Distance, bearing, CPA, formatting |
| `public/sw.js`, `manifest.webmanifest` | PWA |
| `worker/worker.js` | AisStream proxy: `/ws`, `/api/snapshot`, `/api/health` |

AIS data can be delayed or incomplete. This app is for awareness only, never for navigation or collision avoidance.
