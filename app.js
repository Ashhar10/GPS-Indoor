/**
 * GPS Indoor Map Editor & Proximity Wayfinder
 * Core Logic Module
 */

// --- Map Layers & State ---
let map;
let darkLayer;
let googleStreetsLayer;
let googleHybridLayer;
let osmLayer;
let activeTileStyle = 'google-hybrid';

// Drawing Editor State
let activeTool = 'select'; // 'select', 'room', 'wall', 'window', 'delete'
let isSimulatorEnabled = false;
let currentGpsCoords = { lat: 37.4220, lng: -122.0841 }; // Default Googleplex coords
let activeRoomId = null;

// Temporary coordinate arrays for drawing paths
let tempPoints = [];
let tempGraphic = null; // Temporary line/polygon drawn on click

// Saved features collections
let savedRooms = [];
let savedWalls = [];
let savedWindows = [];

// Leaflet Layer groups to host vectors on map
let roomsLayerGroup;
let wallsLayerGroup;
let windowsLayerGroup;
let userGpsMarker = null;
let gpsAccuracyCircle = null;
let lastGpsCoords = null; // For GPS smoothing
let lastGpsAccuracy = null; // Track accuracy changes
const smoothingFactor = 0.45; // Weight of new coordinate (0.0 - 1.0)

// Temporary polygon storage when waiting for modal save
let pendingRoomCoords = null;

// --- DOM Elements ---
const btnFindMe = document.getElementById('btn-find-me');
const btnStyleDark = document.getElementById('btn-style-dark');
const btnStyleGoogleStreet = document.getElementById('btn-style-google-street');
const btnStyleGoogleHybrid = document.getElementById('btn-style-google-hybrid');
const btnStyleOsm = document.getElementById('btn-style-osm');
const checkboxSimulator = document.getElementById('toggle-simulator');
const valLat = document.getElementById('val-lat');
const valLng = document.getElementById('val-lng');
const valCurrentRoom = document.getElementById('val-current-room');
const savedRoomsList = document.getElementById('saved-rooms-list');

// Modal Elements
const roomModal = document.getElementById('room-modal');
const roomNameInput = document.getElementById('room-name-input');
const roomCategorySelect = document.getElementById('room-category-select');
const roomDescInput = document.getElementById('room-desc-input');
const btnModalSave = document.getElementById('btn-modal-save');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalClose = document.getElementById('btn-modal-close');

// Success Overlay Elements
const successOverlay = document.getElementById('success-overlay');
const successRoomName = document.getElementById('success-room-name');
const btnSuccessClose = document.getElementById('btn-success-close');

const toolButtons = {
  select: document.getElementById('tool-select'),
  room: document.getElementById('tool-room'),
  wall: document.getElementById('tool-wall'),
  window: document.getElementById('tool-window'),
  delete: document.getElementById('tool-delete')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadFeaturesFromLocalStorage();
  setupUIEventListeners();
  locateUser(true); // Center on startup
});

// --- Map Setup ---
function initMap() {
  // Define tile layers with deep zoom scaling (up to zoom 23)
  darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 23,
    maxNativeZoom: 20,
    attribution: '© CartoDB'
  });

  googleStreetsLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    maxZoom: 23,
    maxNativeZoom: 20,
    attribution: '© Google'
  });

  googleHybridLayer = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 23,
    maxNativeZoom: 20,
    attribution: '© Google'
  });

  osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 23,
    maxNativeZoom: 19,
    attribution: '© OpenStreetMap'
  });

  // Start with Google Hybrid (high resolution satellite with labels) at zoom 19
  map = L.map('map', {
    layers: [googleHybridLayer],
    zoomControl: false,
    maxZoom: 23
  }).setView([currentGpsCoords.lat, currentGpsCoords.lng], 19);

  // Custom Zoom Control placement
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Create vector rendering groups
  roomsLayerGroup = L.layerGroup().addTo(map);
  wallsLayerGroup = L.layerGroup().addTo(map);
  windowsLayerGroup = L.layerGroup().addTo(map);

  // Marker representing the user/GPS location
  userGpsMarker = L.marker([currentGpsCoords.lat, currentGpsCoords.lng], {
    icon: L.divIcon({
      html: '<div class="pulsing-gps-marker"></div>',
      className: 'custom-poi-divicon',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    })
  }).addTo(map);

  // Monitor real GPS movement
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition((pos) => {
      if (!isSimulatorEnabled) {
        // Low Accuracy Filter: Ignore updates with inaccuracy > 150m 
        // ONLY if we already have a fine-accuracy lock (< 150m) established.
        if (pos.coords.accuracy > 150 && lastGpsCoords !== null && lastGpsAccuracy !== null && lastGpsAccuracy <= 150) {
          console.warn(`Low accuracy GPS ignored: ${pos.coords.accuracy}m`);
          return;
        }

        // Snapping Transition: If accuracy improves from coarse to fine,
        // bypass smoothing and snap immediately to the correct position.
        if (lastGpsCoords && (lastGpsAccuracy === null || lastGpsAccuracy > 150) && pos.coords.accuracy <= 150) {
          lastGpsCoords = null; 
        }

        let lat = pos.coords.latitude;
        let lng = pos.coords.longitude;

        // Exponential Moving Average smoothing to reduce GPS jitter
        if (lastGpsCoords) {
          lat = lastGpsCoords.lat + (lat - lastGpsCoords.lat) * smoothingFactor;
          lng = lastGpsCoords.lng + (lng - lastGpsCoords.lng) * smoothingFactor;
        }

        lastGpsCoords = { lat, lng };
        lastGpsAccuracy = pos.coords.accuracy;
        updateGpsLocation(lat, lng, pos.coords.accuracy);
      }
    }, (err) => console.log('GPS watch error:', err), {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  }
}

// --- GPS Updates & Proximity Core ---
function updateGpsLocation(lat, lng, accuracy = null) {
  currentGpsCoords.lat = lat;
  currentGpsCoords.lng = lng;

  valLat.textContent = lat.toFixed(6);
  valLng.textContent = lng.toFixed(6);

  if (userGpsMarker) {
    userGpsMarker.setLatLng([lat, lng]);
  }

  // Draw or update GPS accuracy uncertainty radius circle
  if (isSimulatorEnabled || accuracy === null) {
    if (gpsAccuracyCircle) {
      map.removeLayer(gpsAccuracyCircle);
      gpsAccuracyCircle = null;
    }
  } else {
    if (gpsAccuracyCircle) {
      gpsAccuracyCircle.setLatLng([lat, lng]);
      gpsAccuracyCircle.setRadius(accuracy);
    } else {
      gpsAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.1,
        weight: 1.5,
        interactive: false
      }).addTo(map);
    }
  }

  checkIndoorProximity(lat, lng);
}

function checkIndoorProximity(lat, lng) {
  let containingRoom = null;

  for (const room of savedRooms) {
    if (isPointInPolygon([lat, lng], room.latlngs)) {
      containingRoom = room;
      break;
    }
  }

  if (containingRoom) {
    // Entered a new room
    if (activeRoomId !== containingRoom.id) {
      activeRoomId = containingRoom.id;
      
      // Update coordinates panel UI
      valCurrentRoom.textContent = containingRoom.name;
      valCurrentRoom.className = 'current-room-pill inside';
      
      // Highlight polygon on map
      highlightActiveRoomOnMap(containingRoom.id);
      
      // Show "Maze Map Done" Celebration Notification overlay
      successRoomName.textContent = containingRoom.name;
      successOverlay.classList.add('show');
      
      showToast(`Welcome to ${containingRoom.name}! Proximity verified.`);
    }
  } else {
    // Exited previous room
    if (activeRoomId !== null) {
      activeRoomId = null;
      valCurrentRoom.textContent = 'Outside';
      valCurrentRoom.className = 'current-room-pill outside';
      
      // Remove polygon highlight
      highlightActiveRoomOnMap(null);
      
      // Hide celebration overlay
      successOverlay.classList.remove('show');
    }
  }
}

// Ray-Casting Point-in-Polygon Solver
function isPointInPolygon(point, vs) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Map polygon highlight updater
function highlightActiveRoomOnMap(roomId) {
  roomsLayerGroup.eachLayer(layer => {
    if (layer.dataset && layer.dataset.id) {
      const element = layer.getElement();
      if (layer.dataset.id === roomId) {
        layer.setStyle({ color: 'var(--success)', fillOpacity: 0.25 });
        if (element) element.classList.add('active-contain');
      } else {
        layer.setStyle({ color: 'var(--accent-color)', fillOpacity: 0.15 });
        if (element) element.classList.remove('active-contain');
      }
    }
  });
}

// --- Geolocation Finder ---
function locateUser(centerOnly = false) {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      
      // Reset smoothing filter on manual locate trigger
      lastGpsCoords = { lat, lng };

      updateGpsLocation(lat, lng, pos.coords.accuracy);
      map.setView([lat, lng], 20); // Zoom in close
      showToast('Centered on GPS coordinates.');
    }, (err) => {
      if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        showToast('GPS Blocked! Mobile HTTP requires Method A or B (HTTPS).');
      } else {
        showToast('Could not access geolocation. Using default.');
      }
      // Center default if starting
      if (centerOnly) {
        map.setView([currentGpsCoords.lat, currentGpsCoords.lng], 19);
      }
    }, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  }
}

// --- UI Interaction Bindings ---
function setupUIEventListeners() {
  btnFindMe.addEventListener('click', () => locateUser(false));
  
  // Style Toggles
  btnStyleDark.addEventListener('click', () => swapTileStyle('dark'));
  btnStyleGoogleStreet.addEventListener('click', () => swapTileStyle('google-street'));
  btnStyleGoogleHybrid.addEventListener('click', () => swapTileStyle('google-hybrid'));
  btnStyleOsm.addEventListener('click', () => swapTileStyle('osm'));

  // Mobile bottom sheet height toggling (Two-state: collapsed vs expanded)
  const btnToggleDrawer = document.getElementById('btn-toggle-drawer');
  const searchPanel = document.querySelector('.search-panel');
  let isDrawerExpanded = false;

  // Initialize collapsed state on mobile
  if (window.innerWidth <= 768) {
    btnToggleDrawer.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
  }

  btnToggleDrawer.addEventListener('click', () => {
    isDrawerExpanded = !isDrawerExpanded;
    if (isDrawerExpanded) {
      searchPanel.classList.add('expanded');
      btnToggleDrawer.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    } else {
      searchPanel.classList.remove('expanded');
      btnToggleDrawer.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
    }
  });

  // Tool buttons selection
  Object.keys(toolButtons).forEach(tool => {
    toolButtons[tool].addEventListener('click', () => {
      Object.values(toolButtons).forEach(btn => btn.classList.remove('active'));
      toolButtons[tool].classList.add('active');
      activeTool = tool;

      // Reset temporary drawings
      resetDraftState();
      
      updateFooterHint();
    });
  });

  // Simulator Toggle
  checkboxSimulator.addEventListener('change', (e) => {
    isSimulatorEnabled = e.target.checked;
    if (isSimulatorEnabled) {
      // Clear accuracy circle in simulator
      if (gpsAccuracyCircle) {
        map.removeLayer(gpsAccuracyCircle);
        gpsAccuracyCircle = null;
      }
      showToast('Simulator active. Click map to simulate walking.');
    } else {
      lastGpsCoords = null; // reset filter
      locateUser(false); // Snap back to real location
    }
  });

  // Success overlay close
  btnSuccessClose.addEventListener('click', () => {
    successOverlay.classList.remove('show');
  });

  // Modal actions
  btnModalSave.addEventListener('click', savePendingRoom);
  btnModalCancel.addEventListener('click', closeModal);
  btnModalClose.addEventListener('click', closeModal);

  // Map drawing clicks listeners
  map.on('click', handleMapClick);
  map.on('mousemove', handleMapMouseMove);
  map.on('dblclick', handleMapDoubleClick);
}

function swapTileStyle(style) {
  if (style === activeTileStyle) return;

  // Remove active styles from all buttons
  [btnStyleDark, btnStyleGoogleStreet, btnStyleGoogleHybrid, btnStyleOsm].forEach(btn => btn.classList.remove('active'));
  
  // Remove active layer
  if (map.hasLayer(darkLayer)) map.removeLayer(darkLayer);
  if (map.hasLayer(googleStreetsLayer)) map.removeLayer(googleStreetsLayer);
  if (map.hasLayer(googleHybridLayer)) map.removeLayer(googleHybridLayer);
  if (map.hasLayer(osmLayer)) map.removeLayer(osmLayer);

  let activeLayer;
  let targetButton;

  if (style === 'dark') {
    activeLayer = darkLayer;
    targetButton = btnStyleDark;
  } else if (style === 'google-street') {
    activeLayer = googleStreetsLayer;
    targetButton = btnStyleGoogleStreet;
  } else if (style === 'google-hybrid') {
    activeLayer = googleHybridLayer;
    targetButton = btnStyleGoogleHybrid;
  } else {
    activeLayer = osmLayer;
    targetButton = btnStyleOsm;
  }

  map.addLayer(activeLayer);
  targetButton.classList.add('active');
  activeTileStyle = style;
  showToast(`Switched map to ${style.replace('-', ' ')} view.`);
}

function updateFooterHint() {
  const directory = document.getElementById('rooms-list-container');
  // Just updates title tags or displays toast hints
  switch (activeTool) {
    case 'select':
      showToast('Mode: Inspect items and listings.');
      break;
    case 'room':
      showToast('Mode: Click points to draw corners. Double-click to close.');
      break;
    case 'wall':
      showToast('Mode: Click points. Double-click to finish drawing wall.');
      break;
    case 'window':
      showToast('Mode: Click points. Double-click to finish drawing window.');
      break;
    case 'delete':
      showToast('Mode: Click on any drawn vector to delete it.');
      break;
  }
}

// --- Map Drawing Core Engine ---
function handleMapClick(e) {
  // If Simulator is active and Select mode, move user position
  if (isSimulatorEnabled && activeTool === 'select') {
    updateGpsLocation(e.latlng.lat, e.latlng.lng);
    return;
  }

  // Draw modes
  if (activeTool === 'room' || activeTool === 'wall' || activeTool === 'window') {
    const pt = [e.latlng.lat, e.latlng.lng];
    tempPoints.push(pt);
    
    // Draw/Update temporary graphics
    if (tempPoints.length === 1) {
      // First point placed
      if (activeTool === 'room') {
        tempGraphic = L.polygon(tempPoints, { color: 'var(--accent-color)', weight: 2, fillOpacity: 0.1, dashArray: '5 5' }).addTo(map);
      } else {
        tempGraphic = L.polyline(tempPoints, { color: activeTool === 'window' ? '#67e8f9' : '#4b5563', weight: 3, dashArray: '5 5' }).addTo(map);
      }
    } else {
      // Add point to path
      tempGraphic.setLatLngs(tempPoints);
    }
  }
}

function handleMapMouseMove(e) {
  // Guide line drawing on cursor move
  if (tempGraphic && tempPoints.length > 0) {
    const pts = [...tempPoints, [e.latlng.lat, e.latlng.lng]];
    tempGraphic.setLatLngs(pts);
  }
}

function handleMapDoubleClick(e) {
  // Prevent zoom on double click when drawing
  if (activeTool === 'room' || activeTool === 'wall' || activeTool === 'window') {
    L.DomEvent.stopPropagation(e);

    if (tempPoints.length < 2) {
      resetDraftState();
      return;
    }

    const tool = activeTool; // Capture active tool
    const pts = [...tempPoints]; // copy points
    resetDraftState();

    if (tool === 'room') {
      pendingRoomCoords = pts;
      openModal();
    } else if (tool === 'wall') {
      saveWall(pts);
    } else if (tool === 'window') {
      saveWindow(pts);
    }
  }
}

function resetDraftState() {
  tempPoints = [];
  if (tempGraphic) {
    map.removeLayer(tempGraphic);
    tempGraphic = null;
  }
}

// --- Save & Render Vector Elements ---
function saveWall(latlngs) {
  const wall = {
    id: 'wall-' + Date.now(),
    latlngs: latlngs
  };
  savedWalls.push(wall);
  renderWall(wall);
  saveFeaturesToLocalStorage();
  showToast('Wall drawn successfully.');
}

function renderWall(wall) {
  const line = L.polyline(wall.latlngs, {
    className: 'drawn-wall-polyline',
    color: '#4b5563',
    weight: 5
  });
  
  line.dataset = { id: wall.id, type: 'wall' };
  line.on('click', (e) => handleFeatureClick(e, wall.id, 'wall'));
  line.addTo(wallsLayerGroup);
}

function saveWindow(latlngs) {
  const win = {
    id: 'window-' + Date.now(),
    latlngs: latlngs
  };
  savedWindows.push(win);
  renderWindow(win);
  saveFeaturesToLocalStorage();
  showToast('Window drawn successfully.');
}

function renderWindow(win) {
  const line = L.polyline(win.latlngs, {
    className: 'drawn-window-polyline',
    color: '#67e8f9',
    weight: 4
  });

  line.dataset = { id: win.id, type: 'window' };
  line.on('click', (e) => handleFeatureClick(e, win.id, 'window'));
  line.addTo(windowsLayerGroup);
}

function savePendingRoom() {
  const name = roomNameInput.value.trim();
  const cat = roomCategorySelect.value;
  const desc = roomDescInput.value.trim();

  if (!name) {
    alert('Please enter a room name.');
    return;
  }

  const room = {
    id: 'room-' + Date.now(),
    name: name,
    category: cat,
    desc: desc || 'No notes saved.',
    latlngs: pendingRoomCoords
  };

  savedRooms.push(room);
  renderRoom(room);
  saveFeaturesToLocalStorage();
  updateRoomDirectoryUI();
  
  // Re-check coordinates immediately in case user is currently inside it
  checkIndoorProximity(currentGpsCoords.lat, currentGpsCoords.lng);

  closeModal();
  showToast('Room mapped successfully.');
}

function renderRoom(room) {
  const poly = L.polygon(room.latlngs, {
    className: 'drawn-room-polygon',
    color: 'var(--accent-color)',
    fillColor: 'var(--accent-color)',
    fillOpacity: 0.15,
    weight: 2
  });

  poly.bindTooltip(room.name, {
    direction: 'center',
    className: 'room-tooltip-label',
    permanent: true,
    opacity: 0.85
  });

  poly.dataset = { id: room.id, type: 'room' };
  poly.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    handleFeatureClick(e, room.id, 'room');
  });

  poly.addTo(roomsLayerGroup);
}

// Click on feature helper
function handleFeatureClick(e, id, type) {
  if (activeTool === 'delete') {
    L.DomEvent.stopPropagation(e);
    deleteFeature(id, type);
  } else if (activeTool === 'select' && type === 'room') {
    L.DomEvent.stopPropagation(e);
    const room = savedRooms.find(r => r.id === id);
    if (room) {
      zoomToRoom(room);
    }
  }
}

// Remove elements
function deleteFeature(id, type) {
  if (type === 'room') {
    savedRooms = savedRooms.filter(r => r.id !== id);
    roomsLayerGroup.eachLayer(layer => {
      if (layer.dataset && layer.dataset.id === id) {
        roomsLayerGroup.removeLayer(layer);
      }
    });
    updateRoomDirectoryUI();
    
    // Clear active containment state
    if (activeRoomId === id) {
      activeRoomId = null;
      valCurrentRoom.textContent = 'Outside';
      valCurrentRoom.className = 'current-room-pill outside';
      successOverlay.classList.remove('show');
    }
  } else if (type === 'wall') {
    savedWalls = savedWalls.filter(w => w.id !== id);
    wallsLayerGroup.eachLayer(layer => {
      if (layer.dataset && layer.dataset.id === id) {
        wallsLayerGroup.removeLayer(layer);
      }
    });
  } else if (type === 'window') {
    savedWindows = savedWindows.filter(w => w.id !== id);
    windowsLayerGroup.eachLayer(layer => {
      if (layer.dataset && layer.dataset.id === id) {
        windowsLayerGroup.removeLayer(layer);
      }
    });
  }

  saveFeaturesToLocalStorage();
  showToast('Feature removed.');
}

// Zoom to room
function zoomToRoom(room) {
  const polyBounds = L.polygon(room.latlngs).getBounds();
  map.fitBounds(polyBounds);
  
  // Show detailed parameters via popup card
  L.popup()
    .setLatLng(polyBounds.getCenter())
    .setContent(`
      <div style="color: var(--text-primary);">
        <h3 style="margin-bottom: 4px; font-weight: 600;">${room.name}</h3>
        <p style="font-size: 0.75rem; text-transform: uppercase; color: var(--accent-color); font-weight: 700; margin-bottom: 6px;">${room.category}</p>
        <p style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">${room.desc}</p>
      </div>
    `)
    .openOn(map);
}

// --- Directory Update UI ---
function updateRoomDirectoryUI() {
  savedRoomsList.innerHTML = '';
  
  if (savedRooms.length === 0) {
    savedRoomsList.innerHTML = '<li class="empty-list-placeholder">No rooms drawn yet. Use the Drawing Tools above to map your building!</li>';
    return;
  }

  savedRooms.forEach(room => {
    const item = document.createElement('li');
    item.className = 'room-dir-item';
    item.innerHTML = `
      <div class="room-dir-info">
        <span class="room-dir-name">${room.name}</span>
        <span class="room-dir-cat">${room.category}</span>
      </div>
      <div class="room-dir-actions">
        <button class="room-dir-btn zoom" title="Zoom to room"><i class="fa-solid fa-expand"></i></button>
        <button class="room-dir-btn delete" title="Delete room"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    `;

    item.querySelector('.zoom').addEventListener('click', () => zoomToRoom(room));
    item.querySelector('.delete').addEventListener('click', () => deleteFeature(room.id, 'room'));

    savedRoomsList.appendChild(item);
  });
}

// --- Modal Handlers ---
function openModal() {
  roomNameInput.value = '';
  roomDescInput.value = '';
  roomCategorySelect.value = 'other';
  roomModal.style.display = 'flex';
  roomNameInput.focus();
}

function closeModal() {
  roomModal.style.display = 'none';
  pendingRoomCoords = null;
  resetDraftState();
}

// --- LocalStorage Integration ---
function saveFeaturesToLocalStorage() {
  localStorage.setItem('mazemap_gps_rooms', JSON.stringify(savedRooms));
  localStorage.setItem('mazemap_gps_walls', JSON.stringify(savedWalls));
  localStorage.setItem('mazemap_gps_windows', JSON.stringify(savedWindows));
}

function loadFeaturesFromLocalStorage() {
  const roomsStr = localStorage.getItem('mazemap_gps_rooms');
  const wallsStr = localStorage.getItem('mazemap_gps_walls');
  const windowsStr = localStorage.getItem('mazemap_gps_windows');

  if (roomsStr) {
    savedRooms = JSON.parse(roomsStr);
    savedRooms.forEach(renderRoom);
    updateRoomDirectoryUI();
  }
  if (wallsStr) {
    savedWalls = JSON.parse(wallsStr);
    savedWalls.forEach(renderWall);
  }
  if (windowsStr) {
    savedWindows = JSON.parse(windowsStr);
    savedWindows.forEach(renderWindow);
  }
}

// --- General Toast Notification system ---
function showToast(message) {
  const toastMsgElement = document.getElementById('toast-message');
  const toastElement = document.getElementById('toast-notification');
  toastMsgElement.textContent = message;
  toastElement.classList.add('show');
  setTimeout(() => {
    toastElement.classList.remove('show');
  }, 2500);
}
