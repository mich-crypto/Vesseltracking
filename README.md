# Vessel Tracker

A mobile-first static PWA for keeping an eye on the traffic around you. It keeps a personal watchlist and gives the range, bearing and CPA to every vessel from your GPS position. The look follows the **Portfolio** design system: glass cards over a soft colour field, a capsule tab bar, Space Grotesk titles, IBM Plex text and a teal accent. Dark mode is the default.

There is no backend. For now the vessels come from a built-in simulator: 14 fictional ships placed around your position, each reporting at AIS-like rates. All the code that turns positions into the screens only reads `onVessel` updates, so a live AIS source can be added later behind the same interface in `public/feed.js`.

## What it does

- **Nearby**: your position in degrees and decimal minutes, plus speed and course from GPS. A KPI row shows how many vessels are in range, the nearest one, how many are closing and how many watchlist vessels are in sight. Vessel cards are sorted nearest first and show range (NM), true bearing, relative bearing (Green/Red), speed, course, and CPA/TCPA.
- **Chart**: a Leaflet map on Esri grey basemaps with OpenSeaMap seamarks. You appear as a blue dot with an accuracy circle. Vessels are arrows rotated to their heading: teal for the watchlist, amber when closing, grey for everything else. Tap a vessel for its details.
- **Watchlist**: add a vessel by MMSI or by name. Each vessel has a *Show on chart* switch, an *Alerts* switch (mute) and *Remove*. Everything is stored in `localStorage`.
- **Alerts**: a banner and a vibration when a watched vessel comes within 1, 2 or 5 NM.
- **Performance**: re-renders are throttled to at most one every 2 s.
- **Offline**: a service worker caches the app shell and up to 600 chart tiles.

Without location permission, distances are measured from the harbour mouth at Hoek van Holland.

## Run it

Any static file host works (GitHub Pages, Netlify, or a plain web server pointed at `public/`). Geolocation and the service worker need HTTPS or `localhost`.

```bash
npm run serve   # http://localhost:8080
```

## Tests

```bash
npm test   # navigation maths (haversine, bearing, CPA) and formatting
```

## Files

| Path | What |
| --- | --- |
| `public/index.html`, `styles.css` | Layout and Portfolio tokens |
| `public/app.js` | State, rendering, map, watchlist, alerts, settings |
| `public/feed.js` | Demo traffic simulator (the data-source interface) |
| `public/geo.js` | Distance, bearing, CPA, formatting |
| `public/sw.js`, `manifest.webmanifest` | PWA |

This app is for awareness only, never for navigation or collision avoidance.
