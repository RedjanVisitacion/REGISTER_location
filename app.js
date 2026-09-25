// ============================================================
// Tile layers
// ============================================================
const streetLayer = L.tileLayer(
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }
);

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
  }
);

const labelsLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, opacity: 1, attribution: '' }
);

// ============================================================
// Map init — default: satellite
// ============================================================
const map = L.map("map", { zoomControl: true }).setView([8.485, 123.804], 13);
satelliteLayer.addTo(map);
labelsLayer.addTo(map);
let currentLayerMode = "satellite";

// ============================================================
// Layer toggle
// ============================================================
const btnStreet    = document.getElementById("btnStreet");
const btnSatellite = document.getElementById("btnSatellite");

btnSatellite.addEventListener("click", () => {
  if (currentLayerMode === "satellite") return;
  map.removeLayer(streetLayer);
  satelliteLayer.addTo(map);
  labelsLayer.addTo(map);
  currentLayerMode = "satellite";
  btnSatellite.classList.add("active");
  btnStreet.classList.remove("active");
});

btnStreet.addEventListener("click", () => {
  if (currentLayerMode === "street") return;
  map.removeLayer(satelliteLayer);
  map.removeLayer(labelsLayer);
  streetLayer.addTo(map);
  currentLayerMode = "street";
  btnStreet.classList.add("active");
  btnSatellite.classList.remove("active");
});

// ============================================================
// DOM refs
// ============================================================
const placeNameInput   = document.getElementById("placeName");
const addressInput     = document.getElementById("address");
const latitudeEl       = document.getElementById("latitude");
const longitudeEl      = document.getElementById("longitude");
const statusEl         = document.getElementById("status");
const locationList     = document.getElementById("locationList");
const suggestionsEl    = document.getElementById("suggestions");
const saveBtn          = document.getElementById("saveBtn");
const saveHint         = document.getElementById("saveHint");
const clearPlaceName   = document.getElementById("clearPlaceName");
const clearAddress     = document.getElementById("clearAddress");

// ============================================================
// State
// ============================================================
let currentMarker     = null;
let selectedLatitude  = null;
let selectedLongitude = null;
let suggestDebounce   = null;

let registeredLocations =
  JSON.parse(localStorage.getItem("registeredLocations")) || [];

// ============================================================
// Status helper
// ============================================================
function showStatus(message, type = "") {
  statusEl.innerHTML = "";
  statusEl.className = type;

  if (type === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    statusEl.appendChild(spinner);
  }

  const text = document.createTextNode(" " + message);
  statusEl.appendChild(text);
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "";
}

// ============================================================
// Save button state
// ============================================================
function setSaveReady(ready) {
  saveBtn.disabled = !ready;
  saveHint.style.display = ready ? "none" : "block";
}

// ============================================================
// Place marker
// ============================================================
function showMarker(lat, lon, title, zoom = 17) {
  if (currentMarker) map.removeLayer(currentMarker);

  currentMarker = L.marker([lat, lon])
    .addTo(map)
    .bindPopup(`<strong>${escapeHtml(title)}</strong>`)
    .openPopup();

  map.setView([lat, lon], zoom);

  selectedLatitude  = Number(lat);
  selectedLongitude = Number(lon);

  latitudeEl.textContent  = selectedLatitude.toFixed(6);
  longitudeEl.textContent = selectedLongitude.toFixed(6);

  setSaveReady(true);
}

// ============================================================
// Photon (Komoot) — free, no key, better fuzzy search than Nominatim
// ============================================================
async function photonSearch(query, limit = 6) {
  const url =
    "https://photon.komoot.io/api/?q=" +
    encodeURIComponent(query) +
    "&limit=" + limit +
    "&lang=en";
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Photon unavailable.");
  const data = await res.json();
  // Normalize to same shape as Nominatim results
  return (data.features || []).map((f) => ({
    place_id: f.properties.osm_id,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    display_name: buildPhotonLabel(f.properties),
    type: f.properties.type || f.properties.osm_value || ""
  }));
}

function buildPhotonLabel(p) {
  return [p.name, p.street, p.city || p.town || p.village, p.county, p.state, p.country]
    .filter(Boolean)
    .join(", ");
}

// ============================================================
// Nominatim — fallback
// ============================================================
async function nominatimSearch(query, limitPH = true, limit = 5) {
  const base = "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&";
  const cc   = limitPH ? "countrycodes=ph&" : "";
  const url  = base + cc + "limit=" + limit + "&q=" + encodeURIComponent(query);
  const res  = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Nominatim unavailable.");
  return res.json();
}

// Build smart query variants to maximise hit rate
function buildQueryVariants(raw) {
  const q = raw.trim();
  const variants = [
    q,
    q + ", Philippines",
    q + ", Misamis Occidental, Philippines",
    q + ", Oroquieta, Philippines"
  ];

  // Expand common PH acronyms
  const expanded = q
    .replace(/\bUSTP\b/gi, "University of Science and Technology of the Philippines")
    .replace(/\bUP\b/gi,   "University of the Philippines")
    .replace(/\bPNP\b/gi,  "Philippine National Police")
    .replace(/\bBFP\b/gi,  "Bureau of Fire Protection")
    .replace(/\bLGU\b/gi,  "Local Government Unit")
    .replace(/\bRHU\b/gi,  "Rural Health Unit")
    .replace(/\bBHS\b/gi,  "Barangay Health Station");

  if (expanded !== q) {
    variants.push(expanded, expanded + ", Philippines");
  }

  return [...new Set(variants)]; // deduplicate
}

// ============================================================
// Locate Place
// ============================================================
async function locatePlace(overrideAddress) {
  const address = (overrideAddress || addressInput.value).trim();

  if (!address) {
    showStatus("Please enter an address or location.", "error");
    return;
  }

  closeSuggestions();
  showStatus("Searching…", "loading");

  try {
    const variants = buildQueryVariants(address);
    let results = [];

    for (const variant of variants) {
      // 1. Photon — best fuzzy matching, no key needed
      results = await photonSearch(variant, 5);
      if (results.length > 0) break;

      // 2. Nominatim PH-scoped
      results = await nominatimSearch(variant, true);
      if (results.length > 0) break;

      // 3. Nominatim global
      results = await nominatimSearch(variant, false);
      if (results.length > 0) break;
    }

    if (results.length === 0) {
      showStatus(
        "Location not found. Try adding the city — e.g. \"USTP Panaon, Oroquieta\".",
        "error"
      );
      return;
    }

    const best  = results[0];
    const label = placeNameInput.value.trim() || best.display_name;

    showMarker(Number(best.lat), Number(best.lon), label);
    showStatus("Found: " + best.display_name, "success");

    if (!overrideAddress) {
      addressInput.value = best.display_name;
      clearAddress.style.display = "flex";
    }

  } catch (err) {
    console.error(err);
    showStatus("Search failed. Check your internet connection.", "error");
  }
}

// ============================================================
// Live autocomplete
// ============================================================
async function fetchSuggestions(query) {
  try {
    const seen   = new Set();
    const merged = [];

    // Photon first — faster and better fuzzy matching
    const photonResults = await photonSearch(query, 6);
    for (const r of photonResults) {
      if (!seen.has(r.place_id)) {
        seen.add(r.place_id);
        merged.push(r);
      }
    }

    // Top up with Nominatim PH results if Photon gave fewer than 4
    if (merged.length < 4) {
      const nomResults = await nominatimSearch(query, true, 5);
      for (const r of nomResults) {
        if (!seen.has(r.place_id)) {
          seen.add(r.place_id);
          merged.push(r);
        }
        if (merged.length >= 6) break;
      }
    }

    return merged;
  } catch {
    return [];
  }
}

function renderSuggestions(results) {
  suggestionsEl.innerHTML = "";

  if (results.length === 0) {
    closeSuggestions();
    return;
  }

  results.forEach((r) => {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.setAttribute("role", "option");

    // Icon based on type
    const iconMap = {
      amenity: "bi-building",
      university: "bi-mortarboard",
      school: "bi-mortarboard",
      hospital: "bi-hospital",
      road: "bi-sign-turn-right",
      residential: "bi-houses",
      city: "bi-building-fill",
      town: "bi-building-fill",
      village: "bi-house",
      suburb: "bi-geo"
    };
    const iconKey = Object.keys(iconMap).find(k =>
      (r.type || "").includes(k) || (r.class || "").includes(k)
    ) || "geo";
    const icon = iconMap[iconKey] || "bi-geo-alt";

    li.innerHTML = `
      <i class="bi ${icon} suggest-icon"></i>
      <div class="suggest-text">
        <span class="suggest-main">${escapeHtml(r.display_name.split(",")[0])}</span>
        <span class="suggest-sub">${escapeHtml(r.display_name)}</span>
      </div>
    `;

    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus from leaving input
      addressInput.value = r.display_name;
      closeSuggestions();
      locatePlace(r.display_name);
    });

    suggestionsEl.appendChild(li);
  });

  suggestionsEl.style.display = "block";
}

function closeSuggestions() {
  suggestionsEl.style.display = "none";
  suggestionsEl.innerHTML = "";
}

addressInput.addEventListener("input", () => {
  const val = addressInput.value.trim();
  clearTimeout(suggestDebounce);

  // Toggle clear button visibility
  clearAddress.style.display = val ? "flex" : "none";

  if (val.length < 3) {
    closeSuggestions();
    return;
  }

  suggestDebounce = setTimeout(async () => {
    const results = await fetchSuggestions(val);
    renderSuggestions(results);
  }, 350); // 350 ms debounce — responsive but not spammy
});

addressInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    locatePlace();
  }
  if (e.key === "Escape") closeSuggestions();
});

addressInput.addEventListener("blur", () => {
  // Small delay so mousedown on suggestion fires first
  setTimeout(closeSuggestions, 200);
});

// ============================================================
// Clear buttons
// ============================================================
clearPlaceName.addEventListener("click", () => {
  placeNameInput.value = "";
  placeNameInput.focus();
  clearPlaceName.style.display = "none";
});

clearAddress.addEventListener("click", () => {
  addressInput.value = "";
  addressInput.focus();
  clearAddress.style.display = "none";
  closeSuggestions();
  clearStatus();
});

placeNameInput.addEventListener("input", () => {
  clearPlaceName.style.display = placeNameInput.value ? "flex" : "none";
});

// ============================================================
// Current location
// ============================================================
function useCurrentLocation() {
  if (!navigator.geolocation) {
    showStatus("Geolocation is not supported by this browser.", "error");
    return;
  }

  showStatus("Getting your current location…", "loading");

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const label = placeNameInput.value.trim() || "My Current Location";

      showMarker(lat, lon, label);
      showStatus("Current location detected.", "success");

      try {
        const url =
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
        const res  = await fetch(url, { headers: { "Accept": "application/json" } });
        const data = await res.json();
        if (data?.display_name && !addressInput.value.trim()) {
          addressInput.value = data.display_name;
          clearAddress.style.display = "flex";
        }
      } catch {
        // reverse geocode is optional, silently ignore
      }
    },
    (err) => {
      const messages = {
        [err.PERMISSION_DENIED]:
          "Location access was denied. Please allow it in your browser settings.",
        [err.POSITION_UNAVAILABLE]: "Your location is currently unavailable.",
        [err.TIMEOUT]: "Location request timed out. Please try again."
      };
      showStatus(messages[err.code] || "Unable to get your location.", "error");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// ============================================================
// Save location
// ============================================================
document.getElementById("locationForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const placeName = placeNameInput.value.trim();
  const address   = addressInput.value.trim();

  if (!placeName) { showStatus("Please enter a place name.", "error"); return; }
  if (!address)   { showStatus("Please enter an address.", "error");    return; }
  if (selectedLatitude === null) {
    showStatus("Please locate the place on the map first.", "error");
    return;
  }

  const newLocation = {
    id: Date.now(),
    name: placeName,
    address,
    latitude: selectedLatitude,
    longitude: selectedLongitude
  };

  registeredLocations.push(newLocation);
  localStorage.setItem("registeredLocations", JSON.stringify(registeredLocations));

  renderLocations();
  showStatus(`"${placeName}" has been saved successfully.`, "success");

  // Reset form
  placeNameInput.value = "";
  addressInput.value   = "";
  clearPlaceName.style.display = "none";
  clearAddress.style.display   = "none";
  selectedLatitude  = null;
  selectedLongitude = null;
  latitudeEl.textContent  = "—";
  longitudeEl.textContent = "—";
  setSaveReady(false);
});

// ============================================================
// Render saved locations
// ============================================================
function renderLocations() {
  if (registeredLocations.length === 0) {
    locationList.innerHTML = '<div class="empty">No locations registered yet.</div>';
    return;
  }

  locationList.innerHTML = "";

  registeredLocations.forEach((loc) => {
    const item = document.createElement("div");
    item.className = "location-item";
    item.innerHTML = `
      <strong>${escapeHtml(loc.name)}</strong>
      <small>
        <i class="bi bi-geo-alt" style="color:#2563eb"></i> ${escapeHtml(loc.address)}<br>
        <i class="bi bi-crosshair" style="color:#6b7280"></i>
        ${Number(loc.latitude).toFixed(6)}, ${Number(loc.longitude).toFixed(6)}
      </small>
      <div class="location-actions">
        <button class="view-btn" onclick="viewLocation(${loc.id})">
          <i class="bi bi-eye"></i> View
        </button>
        <button class="delete-btn" onclick="deleteLocation(${loc.id})">
          <i class="bi bi-trash3"></i> Delete
        </button>
      </div>
    `;
    locationList.appendChild(item);
  });
}

// ============================================================
// View / Delete
// ============================================================
function viewLocation(id) {
  const loc = registeredLocations.find(l => l.id === id);
  if (!loc) return;
  showMarker(loc.latitude, loc.longitude, loc.name);
  showStatus(`Viewing: ${loc.name}`, "success");
}

function deleteLocation(id) {
  const loc = registeredLocations.find(l => l.id === id);
  if (!loc) return;
  if (!confirm(`Delete "${loc.name}"?`)) return;

  registeredLocations = registeredLocations.filter(l => l.id !== id);
  localStorage.setItem("registeredLocations", JSON.stringify(registeredLocations));
  renderLocations();
  showStatus(`"${loc.name}" deleted.`, "success");
}

// ============================================================
// Sanitize
// ============================================================
function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// Wire up buttons
// ============================================================
document.getElementById("locateBtn").addEventListener("click", () => locatePlace());
document.getElementById("currentLocationBtn").addEventListener("click", useCurrentLocation);

// Init
setSaveReady(false);
renderLocations();
