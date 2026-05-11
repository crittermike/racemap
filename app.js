// RaceMap - vanilla JS POC
'use strict';

const DEFAULT_ZIP = '29601';
const DEFAULT_LATLON = [34.8526, -82.3940]; // Greenville SC fallback

let map;
let userMarker = null;
let raceMarkers = [];
let userLatLon = null;
let activeCardId = null;
let zipLookup = null; // loaded from zipcodes.json

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
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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
  });
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

// ---------- map ----------
function initMap() {
  map = L.map('map').setView(DEFAULT_LATLON, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}

function setUserMarker(latlon) {
  if (userMarker) map.removeLayer(userMarker);
  if (!latlon) return;
  const icon = L.divIcon({ className: '', html: '<div class="user-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  userMarker = L.marker(latlon, { icon, zIndexOffset: 1000, title: 'You' }).addTo(map);
}

function clearRaceMarkers() {
  raceMarkers.forEach((m) => map.removeLayer(m));
  raceMarkers = [];
}

function jitter(latlon, i) {
  const offset = 0.005;
  const angle = (i * 137.5) * Math.PI / 180;
  return [latlon[0] + Math.cos(angle) * offset, latlon[1] + Math.sin(angle) * offset];
}

// ---------- main flow ----------
async function fetchRaces(zip, radius) {
  const apiUrl = `https://runsignup.com/Rest/races?format=json&zipcode=${zip}&radius=${radius}&start_date=${todayISO()}&results_per_page=50&events=T`;
  // RunSignup blocks browser CORS, so route through a public proxy.
  // codetabs has trailing-slash quirk and sometimes returns 400 with valid body, so don't trust status.
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

function renderList(races) {
  const list = $('#race-list');
  if (!races.length) {
    list.innerHTML = '<p class="empty">No races found nearby. Try a larger radius or different zip.</p>';
    return;
  }
  const html = races.map((race) => {
    const date = parseUSDate(race.next_date);
    const dateStr = formatNiceDate(date) || race.next_date || 'Date TBD';
    const city = race.address ? `${race.address.city || ''}${race.address.state ? ', ' + race.address.state : ''}` : '';
    const dist = race._latlon && userLatLon ? haversineMiles(userLatLon, race._latlon) : null;
    const distStr = dist != null ? `${dist.toFixed(1)} mi away` : '(location unknown)';
    const open = race.is_registration_open === 'T';
    return `
      <div class="race-card" data-race-id="${race.race_id}">
        <h3 class="race-name">${escapeHtml(race.name || 'Unnamed race')}</h3>
        <div class="race-meta"><strong>${dateStr}</strong></div>
        <div class="race-meta">${escapeHtml(city)}</div>
        <div class="race-meta">${distStr}</div>
        <div class="race-actions">
          <a href="${race.url}" target="_blank" rel="noopener" class="${open ? '' : 'closed'}">
            ${open ? 'Register' : 'View'}
          </a>
        </div>
      </div>
    `;
  }).join('');
  list.innerHTML = html;

  list.querySelectorAll('.race-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      const id = parseInt(card.dataset.raceId);
      focusRace(id);
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
  races.forEach((race) => {
    racesById[race.race_id] = race;
    let ll = race._latlon;
    if (!ll && userLatLon) {
      ll = jitter(userLatLon, jitterIdx++);
    }
    if (!ll) return;
    const date = parseUSDate(race.next_date);
    const dateStr = formatNiceDate(date) || race.next_date || '';
    const city = race.address ? `${race.address.city || ''}${race.address.state ? ', ' + race.address.state : ''}` : '';
    const popupHtml = `
      <div>
        <p class="popup-name">${escapeHtml(race.name)}</p>
        <p class="popup-meta">${dateStr}</p>
        <p class="popup-meta">${escapeHtml(city)}</p>
        <p class="popup-meta"><a href="${race.url}" target="_blank" rel="noopener">Race page →</a></p>
      </div>
    `;
    const marker = L.marker(ll).addTo(map).bindPopup(popupHtml);
    marker.on('click', () => {
      document.querySelectorAll('.race-card').forEach((c) => c.classList.toggle('active', parseInt(c.dataset.raceId) === race.race_id));
      const card = document.querySelector(`.race-card[data-race-id="${race.race_id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    race._marker = marker;
    raceMarkers.push(marker);
  });

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
    // Strip descriptions up front
    races.forEach((r) => { r._desc = stripHtml(r.description); });

    // Look up coordinates instantly from static zip table
    geocodeRaces(races);

    // Compute distances
    races.forEach((r) => {
      r._distance = r._latlon && userLatLon ? haversineMiles(userLatLon, r._latlon) : null;
    });

    renderList(races);
    plotRaces(races);
    setStatus(`${races.length} races`);
  } catch (e) {
    console.error(e);
    setStatus('Error loading races');
    $('#race-list').innerHTML = `<p class="empty">Error: ${escapeHtml(e.message)}</p>`;
  } finally {
    $('#refresh-btn').disabled = false;
  }
}

// ---------- bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  $('#refresh-btn').addEventListener('click', () => { userLatLon = null; loadAndRender(); });
  $('#zip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { userLatLon = null; loadAndRender(); }
  });
  $('#sidebar-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  loadAndRender();
});
