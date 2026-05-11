// RaceMap - vanilla JS POC
'use strict';

const DEFAULT_ZIP = '29601';
const DEFAULT_LATLON = [34.8526, -82.3940]; // Greenville SC fallback
const PREFS_KEY = 'racemap.prefs.v1';

let map;
let userMarker = null;
let raceMarkers = [];
let userLatLon = null;
let activeCardId = null;
let zipLookup = null; // loaded from zipcodes.json

// ---------- preferences ----------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

// ---------- utilities ----------
function $(sel) { return document.querySelector(sel); }
function setStatus(msg) { $('#status').textContent = msg || ''; }

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}

function haversineMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]); const lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function parseUSDate(s) {
  // "MM/DD/YYYY"
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2]));
}

function formatNiceDate(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatShortDate(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- zip code lookup (static JSON) ----------
async function loadZipLookup() {
  if (zipLookup) return;
  const r = await fetch('zipcodes.json');
  zipLookup = await r.json();
}

function lookupZip(zip) {
  if (!zip || !zipLookup) return null;
  return zipLookup[zip] || null;
}

function geocodeRaces(races) {
  races.forEach((race) => {
    const zip = race.address && race.address.zipcode;
    race._latlon = lookupZip(zip);
    race._latlonSource = 'zip'; // track precision level
  });
}

// ---------- Photon address geocoding (free, CORS-enabled) ----------
function buildAddressQuery(race) {
  const a = race.address;
  if (!a) return null;
  const parts = [a.street, a.city, a.state, a.zipcode].filter(Boolean);
  return parts.length >= 2 ? parts.join(', ') : null;
}

async function photonGeocode(query) {
  // Clean up address oddities that can confuse the geocoder
  const cleaned = query.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(cleaned)}&limit=1&lang=en`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const data = await r.json();
  const feats = data.features;
  if (!feats || !feats.length) return null;
  const [lon, lat] = feats[0].geometry.coordinates;
  return [lat, lon];
}

async function refineRaceLocations() {
  const btn = $('#refine-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Refining...';

  // Only refine currently filtered/displayed races that still use ZIP-level coords
  const toRefine = allRaces.filter((r) => r._latlonSource === 'zip' && buildAddressQuery(r));
  let refined = 0;
  const total = toRefine.length;
  const BATCH_SIZE = 3; // concurrent requests to be polite

  for (let i = 0; i < toRefine.length; i += BATCH_SIZE) {
    const batch = toRefine.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (race) => {
      const query = buildAddressQuery(race);
      try {
        const coords = await photonGeocode(query);
        if (coords) {
          race._latlon = coords;
          race._latlonSource = 'address';
          refined++;
        }
      } catch (e) {
        console.warn('Photon geocode failed for', race.name, e);
      }
    }));
    btn.textContent = `Refining... ${Math.min(i + BATCH_SIZE, total)}/${total}`;
    // Small delay between batches to be polite to the free API
    if (i + BATCH_SIZE < toRefine.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Recompute distances and re-render
  allRaces.forEach((r) => {
    r._distance = r._latlon && userLatLon ? haversineMiles(userLatLon, r._latlon) : null;
  });
  applyFilters();

  btn.textContent = `📍 Refine Locations${refined ? ` (${refined} updated)` : ''}`;
  btn.disabled = false;
  // If everything is refined, hide the button
  const remaining = allRaces.filter((r) => r._latlonSource === 'zip' && buildAddressQuery(r)).length;
  if (remaining === 0) {
    btn.textContent = '✓ All locations refined';
    btn.disabled = true;
  }
}

// ---------- geolocation ----------
function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) => { console.warn('geo denied', err && err.message); resolve(null); },
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

// ---------- distance-based pin colors ----------
const DIST_COLORS = [
  { max: 10, color: '#10b981', label: '< 10 mi' },   // green
  { max: 25, color: '#3b82f6', label: '10–25 mi' },   // blue
  { max: 50, color: '#f59e0b', label: '25–50 mi' },   // amber
  { max: Infinity, color: '#ef4444', label: '50+ mi' } // red
];

function distColor(miles) {
  if (miles == null) return '#94a3b8'; // gray for unknown
  for (const band of DIST_COLORS) {
    if (miles <= band.max) return band.color;
  }
  return '#94a3b8';
}

function makeRaceIcon(color, highlighted) {
  const size = highlighted ? 18 : 14;
  const border = highlighted ? '3px solid #0f172a' : '2px solid white';
  const shadow = highlighted
    ? `0 0 0 3px ${color}, 0 0 12px ${color}`
    : `0 1px 3px rgba(0,0,0,0.3)`;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:${border};
      box-shadow:${shadow};
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

// ---------- map ----------
function initMap() {
  map = L.map('map').setView(DEFAULT_LATLON, 10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
  }).addTo(map);
}

function setUserMarker(latlon) {
  if (userMarker) map.removeLayer(userMarker);
  if (!latlon) return;
  const icon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  userMarker = L.marker(latlon, { icon, zIndexOffset: 1000, title: 'You — drag to refine', draggable: true }).addTo(map);
  userMarker.bindTooltip('Drag to refine your location', { direction: 'top', offset: [0, -10] });
  userMarker.on('dragend', () => {
    const ll = userMarker.getLatLng();
    userLatLon = [ll.lat, ll.lng];
    // Recompute distances and re-render
    allRaces.forEach((r) => {
      r._distance = r._latlon && userLatLon ? haversineMiles(userLatLon, r._latlon) : null;
    });
    applyFilters();
    updateHash();
  });
}

let clusterGroup = null;

function clearRaceMarkers() {
  if (clusterGroup) {
    map.removeLayer(clusterGroup);
    clusterGroup = null;
  }
  raceMarkers = [];
}

function jitter(latlon, i) {
  if (i === 0) return latlon; // first pin stays at center
  const offset = 0.003 + (i * 0.001); // grow slightly per pin
  const angle = (i * 137.5) * Math.PI / 180; // golden angle spiral
  return [latlon[0] + Math.cos(angle) * offset, latlon[1] + Math.sin(angle) * offset];
}

// ---------- main flow ----------
async function fetchRaces(zip, radius) {
  const apiUrl = `https://runsignup.com/Rest/races?format=json&zipcode=${zip}&radius=${radius}&start_date=${todayISO()}&results_per_page=50&events=T&only_races_with_open_reg=T`;
  const url = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(apiUrl)}`;
  const r = await fetch(url);
  let txt;
  try { txt = await r.text(); } catch (e) { throw new Error(`proxy read failed: ${e.message}`); }
  let data;
  try { data = JSON.parse(txt); } catch (e) {
    throw new Error(`proxy returned non-JSON (status ${r.status}): ${txt.slice(0, 120)}`);
  }
  if (data.error) throw new Error(`api error: ${data.error}`);
  const wrapped = (data && data.races) || [];
  return wrapped.map((w) => w.race).filter(Boolean);
}


function enrichRace(race) {
  const events = race.events || [];
  race._eventTypes = [...new Set(events.map((e) => e.event_type).filter(Boolean))];
  race._giveaways = events.map((e) => e.giveaway || '').filter(Boolean);
  // Collect unique race distances (e.g. "5K", "10 Miles")
  race._distances = [...new Set(events.map((e) => e.distance).filter(Boolean))];
}

function renderList(races) {
  const list = $('#race-list');
  const countEl = $('#race-count');

  if (!races.length) {
    countEl.innerHTML = '';
    const hasFilters = ($('#filter-search').value || '').trim() ||
      parseInt($('#filter-dist-min').value) > 0 ||
      parseInt($('#filter-dist-max').value) < 100 ||
      $('#filter-date').value ||
      $('#filter-type').value;
    list.innerHTML = hasFilters
      ? '<div class="empty">No races match your filters.<br><button id="clear-filters-btn" type="button">Clear filters</button></div>'
      : '<p class="empty">No races found nearby. Try a larger radius or different zip.</p>';
    if (hasFilters) {
      const btn = $('#clear-filters-btn');
      if (btn) btn.addEventListener('click', clearFilters);
    }
    return;
  }

  countEl.innerHTML = `<span class="race-count-badge">${races.length} race${races.length === 1 ? '' : 's'}</span>`;

  // Legend
  const legendHtml = `<div class="legend">${DIST_COLORS.map((b) =>
    `<span class="legend-item"><span class="dist-dot" style="background:${b.color}"></span>${b.label}</span>`
  ).join('')}</div>`;

  const cardsHtml = races.map((race) => {
    const date = parseUSDate(race.next_date);
    const dateStr = formatNiceDate(date) || race.next_date || 'Date TBD';
    const city = race.address ? `${race.address.city || ''}${race.address.state ? ', ' + race.address.state : ''}` : '';
    const dist = race._distance;
    const fromYouStr = dist != null ? `${dist.toFixed(1)} mi away` : '';
    const raceDistStr = race._distances.length ? race._distances.join(', ') : '';
    const color = distColor(dist);
    const open = race.is_registration_open === 'T';
    return `
      <div class="race-card" data-race-id="${race.race_id}">
        <h3 class="race-name"><span class="dist-dot" style="background:${color}"></span>${escapeHtml(race.name || 'Unnamed race')}</h3>
        <div class="race-meta"><strong>${dateStr}</strong></div>
        <div class="race-meta">${escapeHtml(city)}${fromYouStr ? ' · ' + fromYouStr : ''}</div>
        ${raceDistStr ? `<div class="race-meta">${escapeHtml(raceDistStr)}</div>` : ''}
        <div class="race-actions">
          <a href="${race.url}" target="_blank" rel="noopener" class="${open ? '' : 'closed'}">
            ${open ? 'Register' : 'View'}
          </a>
        </div>
      </div>
    `;
  }).join('');
  list.innerHTML = legendHtml + cardsHtml;

  list.querySelectorAll('.race-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      const id = parseInt(card.dataset.raceId);
      focusRace(id);
    });
    card.addEventListener('mouseenter', () => {
      const race = racesById[parseInt(card.dataset.raceId)];
      if (race && race._marker) {
        race._marker.setIcon(makeRaceIcon(race._color || '#94a3b8', true));
        race._marker.setZIndexOffset(900);
      }
    });
    card.addEventListener('mouseleave', () => {
      const race = racesById[parseInt(card.dataset.raceId)];
      if (race && race._marker) {
        race._marker.setIcon(makeRaceIcon(race._color || '#94a3b8', false));
        race._marker.setZIndexOffset(0);
      }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let racesById = {};
let allRaces = []; // full unfiltered list for re-filtering

function focusRace(raceId) {
  const race = racesById[raceId];
  if (!race) return;
  document.querySelectorAll('.race-card').forEach((c) => c.classList.toggle('active', parseInt(c.dataset.raceId) === raceId));
  if (race._marker) {
    map.flyTo(race._marker.getLatLng(), 12, { duration: 0.6 });
    setTimeout(() => race._marker.openPopup(), 600);
  }
  // Close mobile sidebar after click
  if (window.innerWidth <= 768) $('#sidebar').classList.remove('open');
}

function plotRaces(races) {
  clearRaceMarkers();
  racesById = {};
  let jitterIdx = 0;

  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 40,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 13
  });

  // Count how many races share each lat/lon so we can spread them out
  const locCounts = {};
  races.forEach((race) => {
    if (race._latlon) {
      const key = race._latlon.join(',');
      locCounts[key] = (locCounts[key] || 0) + 1;
    }
  });
  const locIndexes = {};

  races.forEach((race) => {
    racesById[race.race_id] = race;
    let ll = race._latlon;
    if (!ll && userLatLon) {
      ll = jitter(userLatLon, jitterIdx++);
    }
    if (!ll) return;

    // Spread out pins sharing the same location
    const key = ll.join(',');
    if (locCounts[key] > 1) {
      locIndexes[key] = (locIndexes[key] || 0);
      ll = jitter(ll, locIndexes[key]++);
    }
    const date = parseUSDate(race.next_date);
    const dateStr = formatNiceDate(date) || race.next_date || '';
    const shortDateStr = formatShortDate(date) || '';
    const city = race.address ? `${race.address.city || ''}${race.address.state ? ', ' + race.address.state : ''}` : '';
    const dist = race._distance;
    const color = distColor(dist);

    const icon = makeRaceIcon(color, false);
    const marker = L.marker(ll, { icon });

    const raceDistLabel = race._distances.length ? race._distances[0] : '';

    // Permanent tooltip with date + race distance
    const tooltipParts = [shortDateStr, raceDistLabel].filter(Boolean).join(' · ');
    if (tooltipParts) {
      marker.bindTooltip(tooltipParts, {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'race-tooltip'
      });
    }

    // Click popup with full details
    const popupHtml = `
      <div>
        <p class="popup-name">${escapeHtml(race.name)}</p>
        <p class="popup-meta">${dateStr}</p>
        <p class="popup-meta">${escapeHtml(city)}</p>
        <p class="popup-meta"><a href="${race.url}" target="_blank" rel="noopener">Race page →</a></p>
      </div>
    `;
    marker.bindPopup(popupHtml);

    marker.on('click', () => {
      document.querySelectorAll('.race-card').forEach((c) => c.classList.toggle('active', parseInt(c.dataset.raceId) === race.race_id));
      const card = document.querySelector(`.race-card[data-race-id="${race.race_id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    race._marker = marker;
    race._color = color;
    clusterGroup.addLayer(marker);
    raceMarkers.push(marker);
  });

  map.addLayer(clusterGroup);

  // Fit bounds if we have markers
  const ptsWithLoc = races.filter((r) => r._latlon).map((r) => r._latlon);
  if (userLatLon) ptsWithLoc.push(userLatLon);
  if (ptsWithLoc.length > 1) {
    map.fitBounds(L.latLngBounds(ptsWithLoc), { padding: [40, 40], maxZoom: 11 });
  } else if (userLatLon) {
    map.setView(userLatLon, 10);
  }
}

async function loadAndRender() {
  const zip = $('#zip-input').value.trim() || DEFAULT_ZIP;
  const radius = $('#radius-select').value;

  // Save preferences
  savePrefs({ zip, radius });

  $('#refresh-btn').disabled = true;
  setStatus('Fetching races...');
  $('#race-list').innerHTML = '<p class="empty">Loading...</p>';
  try {
    // Ensure zip lookup is loaded
    await loadZipLookup();

    // Resolve user location: prefer geolocation, else look up the zip
    if (!userLatLon) {
      userLatLon = await getUserLocation();
    }
    if (!userLatLon) {
      userLatLon = lookupZip(zip) || DEFAULT_LATLON;
    }
    setUserMarker(userLatLon);
    map.setView(userLatLon, 10);

    const races = await fetchRaces(zip, radius);
    // Sort by date
    races.sort((a, b) => {
      const da = parseUSDate(a.next_date); const db = parseUSDate(b.next_date);
      if (!da) return 1; if (!db) return -1;
      return da - db;
    });

    setStatus(`Found ${races.length} races.`);
    // Strip descriptions and enrich with event types + medal detection
    races.forEach((r) => {
      r._desc = stripHtml(r.description);
      enrichRace(r);
    });

    // Look up coordinates instantly from static zip table
    geocodeRaces(races);

    // Compute distances
    races.forEach((r) => {
      r._distance = r._latlon && userLatLon ? haversineMiles(userLatLon, r._latlon) : null;
    });

    allRaces = races.filter((r) => r._distances.length > 0);
    applyFilters();
  } catch (e) {
    console.error(e);
    setStatus('Error loading races');
    $('#race-list').innerHTML = `<p class="empty">Error: ${escapeHtml(e.message)}</p>`;
  } finally {
    $('#refresh-btn').disabled = false;
  }
}

function updateDistLabel() {
  const min = parseInt($('#filter-dist-min').value);
  const max = parseInt($('#filter-dist-max').value);
  $('#dist-label').textContent = `${min} – ${max} mi`;
}

function clearFilters() {
  $('#filter-search').value = '';
  $('#filter-dist-min').value = 0;
  $('#filter-dist-max').value = 100;
  $('#filter-date').value = '';
  $('#filter-type').value = '';
  applyFilters();
}

// ---------- URL hash sharing ----------
function updateHash() {
  const params = new URLSearchParams();
  const zip = $('#zip-input').value.trim();
  const radius = $('#radius-select').value;
  if (zip) params.set('zip', zip);
  if (radius !== '50') params.set('radius', radius);
  const search = $('#filter-search').value.trim();
  if (search) params.set('q', search);
  const distMin = $('#filter-dist-min').value;
  const distMax = $('#filter-dist-max').value;
  if (distMin !== '0') params.set('dmin', distMin);
  if (distMax !== '100') params.set('dmax', distMax);
  const dateVal = $('#filter-date').value;
  if (dateVal) params.set('when', dateVal);
  const typeVal = $('#filter-type').value;
  if (typeVal) params.set('type', typeVal);
  if (userLatLon) {
    params.set('lat', userLatLon[0].toFixed(4));
    params.set('lon', userLatLon[1].toFixed(4));
  }
  const hash = params.toString();
  history.replaceState(null, '', hash ? '#' + hash : location.pathname);
}

function restoreFromHash() {
  if (!location.hash || location.hash.length < 2) return false;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('zip')) $('#zip-input').value = params.get('zip');
  if (params.get('radius')) $('#radius-select').value = params.get('radius');
  if (params.get('q')) $('#filter-search').value = params.get('q');
  if (params.get('dmin')) $('#filter-dist-min').value = params.get('dmin');
  if (params.get('dmax')) $('#filter-dist-max').value = params.get('dmax');
  if (params.get('when')) $('#filter-date').value = params.get('when');
  if (params.get('type')) $('#filter-type').value = params.get('type');
  if (params.get('lat') && params.get('lon')) {
    userLatLon = [parseFloat(params.get('lat')), parseFloat(params.get('lon'))];
  }
  return true;
}

function applyFilters() {
  const search = ($('#filter-search').value || '').toLowerCase().trim();
  const distMin = parseInt($('#filter-dist-min').value);
  const distMax = parseInt($('#filter-dist-max').value);
  const dateMonths = $('#filter-date').value ? parseInt($('#filter-date').value) : null;
  const eventType = $('#filter-type').value;


  let endDate = null;
  if (dateMonths) {
    endDate = new Date();
    endDate.setMonth(endDate.getMonth() + dateMonths);
  }

  updateDistLabel();

  const filtered = allRaces.filter((race) => {
    if (search && !(race.name || '').toLowerCase().includes(search)) return false;
    if (race._distance != null) {
      if (race._distance < distMin || race._distance > distMax) return false;
    } else if (distMax < 100) {
      return false; // hide unknown-distance races when filtering
    }
    if (endDate) {
      const d = parseUSDate(race.next_date);
      if (d && d > endDate) return false;
    }
    if (eventType) {
      if (!race._eventTypes || !race._eventTypes.includes(eventType)) return false;
    }

    return true;
  });

  renderList(filtered);
  plotRaces(filtered);
  setStatus(`${filtered.length} of ${allRaces.length} races`);
  updateHash();
}

// ---------- bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  initMap();

  // Restore from URL hash first, then localStorage prefs as fallback
  const hasHash = restoreFromHash();
  if (!hasHash) {
    const prefs = loadPrefs();
    if (prefs.zip) $('#zip-input').value = prefs.zip;
    if (prefs.radius) $('#radius-select').value = prefs.radius;
  }

  $('#refresh-btn').addEventListener('click', () => { userLatLon = null; loadAndRender(); });
  $('#zip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { userLatLon = null; loadAndRender(); }
  });
  $('#sidebar-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#show-map-btn').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#refine-btn').addEventListener('click', refineRaceLocations);

  // Filter listeners
  $('#filter-search').addEventListener('input', applyFilters);
  $('#filter-dist-min').addEventListener('input', () => {
    const min = parseInt($('#filter-dist-min').value);
    const max = parseInt($('#filter-dist-max').value);
    if (min > max) $('#filter-dist-max').value = min;
    applyFilters();
  });
  $('#filter-dist-max').addEventListener('input', () => {
    const min = parseInt($('#filter-dist-min').value);
    const max = parseInt($('#filter-dist-max').value);
    if (max < min) $('#filter-dist-min').value = max;
    applyFilters();
  });
  $('#filter-date').addEventListener('change', applyFilters);
  $('#filter-type').addEventListener('change', applyFilters);

  // Mobile: auto-open sidebar on load
  if (window.innerWidth <= 768) {
    $('#sidebar').classList.add('open');
  }

  updateDistLabel();
  loadAndRender();
});
