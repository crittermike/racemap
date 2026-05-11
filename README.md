# RaceMap

A static, no-build proof-of-concept that shows nearby running races on a Leaflet map using the free RunSignup public REST API.

## What it is
- Plain HTML + CSS + vanilla JS. No frameworks, no build step.
- Leaflet + OpenStreetMap tiles (no API key).
- ZIP→lat/lon via a bundled static lookup (~42K US zips, ~1MB). No external geocoding calls needed.
- Geolocation via the browser; falls back to geocoding the zip in the input (default `29601`, Greenville SC).

## Run locally
```bash
cd projects/racemap
python3 -m http.server 8000
# then open http://localhost:8000/
```

That's it. Any static file server works (the file:// protocol won't because of CORS for the API requests).

## How it works
1. Tries `navigator.geolocation` for your position. If denied, looks up the zip from the bundled table.
2. Calls `https://runsignup.com/Rest/races` with `zipcode`, `radius`, today's date, and `events=T`.
3. The API doesn't return lat/lon, so each race zip is resolved instantly from `zipcodes.json` (a static ~42K entry lookup table).
4. Markers are dropped on the map; the sidebar shows a sortable-by-date list with city, distance (Haversine), and a Register link.
5. Click a sidebar card to fly the map to that pin and open the popup. Click a marker to highlight the card.

## Known limitations
- **Zip-based geocoding** = pins land at the centroid of the race's zip code, not the actual venue.
- Races whose zip fails to geocode are still shown in the sidebar with "(location unknown)" and plotted near the user with a small jitter so they're visible.
- No filtering UI yet (event type, distance, date range).
- The API's `start_date` filter is honored, but we don't enforce a client-side end-date window. Could add that easily.
- `description` is stripped to plain text but not currently shown in the UI; popup keeps things minimal.

## Future iteration ideas
- Filters: event type (5K, 10K, half, full, trail, tri), distance from you, date range.
- "Save favorite races" via localStorage.
- Cluster markers when zoomed out (Leaflet.markercluster).
- Use `near=lat,lon` based search if RunSignup adds it, or use a real geocoder for street-level pins.
- Show description and event details in a slide-out drawer when a card is clicked.
- PWA / offline cache of recent results.
- Light/dark theme toggle.
- Pre-warm geocode cache server-side and ship as JSON to skip the rate-limit dance for popular zips.
