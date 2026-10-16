# Vessel Tracker

A mobile-first PWA for keeping an eye on the traffic around you. It keeps a personal watchlist and gives the range, bearing and CPA to every vessel from your GPS position. The look follows the **Portfolio** design system: glass cards over a soft colour field, a capsule tab bar, Space Grotesk titles, IBM Plex text and a teal accent. Dark mode is the default.

```
Phone (PWA)  ──WebSocket /ws──►  Cloudflare Worker  ──WebSocket──►  AisStream.io
             ◄─REST /api/snapshot (offshore polling)
```

The Cloudflare Worker serves the app and relays AisStream, which refuses direct connections from a browser. Pick the data source in **Settings → Data**:

- **Demo traffic** (the default): 14 fictional ships placed around your position, each reporting at AIS-like rates.
- **Live AIS**: the app streams through the Worker. The AisStream key comes from either place:
  - the Worker secret `AISSTREAM_API_KEY` (best: the key never leaves Cloudflare), or
  - the key field in Settings. It is stored in the browser and sent only to your Worker, which passes it to AisStream and never stores it. The Worker secret wins when both are set.

## What it does

- **Nearby**: your position in degrees and decimal minutes, plus speed and course from GPS. A KPI row shows how many vessels are in range, the nearest one, how many are closing and how many watchlist vessels are in sight. Vessel cards are sorted nearest first and show range (NM), true bearing, relative bearing (Green/Red), speed, course, and CPA/TCPA.
- **Chart**: a Leaflet map on Esri grey basemaps with OpenSeaMap seamarks. You appear as a blue dot with an accuracy circle. Vessels are arrows rotated to their heading: teal for the watchlist, amber when closing, grey for everything else. Tap a vessel for its details.
- **Watchlist**: add a vessel by MMSI or by name. Each vessel has a *Show on chart* switch, an *Alerts* switch (mute) and *Remove*. Everything is stored in `localStorage`.
- **Alerts**: a banner and a vibration when a watched vessel comes within 1, 2 or 5 NM.
- **Connection badge**: Live (green, only once real reports arrive), Connecting and Reconnecting (amber), Polling (teal), Offline and Not connected (red), Demo.
- **Offshore**: after 4 quick reconnects (1, 2, 4, 8 s) the app asks the Worker for a snapshot every 10 or 15 minutes, and each poll also tries to get the stream back. If AisStream refuses the key 3 times in a row, the app stops and shows the reason in Settings.
- **Throttling**: the Worker forwards at most one position per vessel every 2 s.
- **Performance**: re-renders are throttled to at most one every 2 s.
- **Offline**: a service worker caches the app shell and up to 600 chart tiles.

Without location permission, distances are measured from the harbour mouth at Hoek van Holland.

## Run it

```bash
npm install
npx wrangler secret put AISSTREAM_API_KEY   # optional: free key from https://aisstream.io
npm run dev                                 # app + Worker on http://localhost:8787
npm run deploy                              # to Cloudflare
```

When the Worker serves the app, leave **Settings → Cloudflare Worker** empty. To host `public/` somewhere else (for example GitHub Pages), enter the Worker URL there and list that site in `ALLOWED_ORIGINS` in `wrangler.toml`. Geolocation and the service worker need HTTPS or `localhost`.

To try only the UI with demo traffic: `npm run serve` and open http://localhost:8080.

## Tests

```bash
npm test   # navigation maths (haversine, bearing, CPA), formatting, AIS parsing, Worker input checks
```

## Files

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css` | Layout and Portfolio tokens |
| `public/app.js` | State, rendering, map, watchlist, alerts, settings |
| `public/feed.js` | Live feed through the Worker (WebSocket + polling) and demo simulator |
| `public/geo.js` | Distance, bearing, CPA, formatting |
| `public/sw.js`, `manifest.webmanifest` | PWA |
| `worker/worker.js`, `wrangler.toml` | Cloudflare Worker: `/ws`, `/api/snapshot`, `/api/health`, static files |

This app is for awareness only, never for navigation or collision avoidance.
