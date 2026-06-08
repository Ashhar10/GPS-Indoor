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
let activeTool = 'select'; // 'select', 'boundary', 'room', 'wall', 'window', 'door', 'delete'
let isSimulatorEnabled = false;
let currentGpsCoords = { lat: 37.4220, lng: -122.0841 }; // Default Googleplex coords
let activeRoomId = null;

// Temporary coordinate arrays for drawing paths
let tempPoints = [];
let tempGraphic = null; // Temporary line/polygon drawn on click

// Saved features collections
let savedBoundaries = [];
let savedRooms = [];
let savedWalls = [];
let savedWindows = [];
let savedDoors = [];
let activeFloor = '1';

// Heatmap and Crowd Simulation state
let isHeatmapEnabled = false;
let heatmapLayer = null;
let simulatedAgents = [];
let agentUpdateIntervalId = null;
let heatmapUpdateIntervalId = null;

// Leaflet Layer groups to host vectors on map
let boundariesLayerGroup;
let roomsLayerGroup;
let wallsLayerGroup;
let windowsLayerGroup;
let doorsLayerGroup;
let userGpsMarker = null;
let gpsAccuracyCircle = null;
let navigationPathPolyline = null;

let lastGpsCoords = null; // For GPS smoothing
let lastGpsAccuracy = null; // Track accuracy changes
const smoothingFactor = 0.45; // Weight of new coordinate (0.0 - 1.0)

// Temporary polygon storage when waiting for modal save
let pendingRoomCoords = null;
let isPlacingDoorForModal = false;
let tempDoorsForModal = [];

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
const roomFloorSelect = document.getElementById('room-floor-select');
const modalDoorStatus = document.getElementById('modal-door-status');
const btnModalAddDoor = document.getElementById('btn-modal-add-door');
const roomDescInput = document.getElementById('room-desc-input');
const btnModalSave = document.getElementById('btn-modal-save');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalClose = document.getElementById('btn-modal-close');

// Success Overlay Elements
const successOverlay = document.getElementById('success-overlay');
const successRoomName = document.getElementById('success-room-name');
const btnSuccessClose = document.getElementById('btn-success-close');

// Navigation Elements
const navStartSelect = document.getElementById('nav-start');
const navEndSelect = document.getElementById('nav-end');
const btnFindPath = document.getElementById('btn-find-path');
const btnClearPath = document.getElementById('btn-clear-path');

const toolButtons = {
  select: document.getElementById('tool-select'),
  boundary: document.getElementById('tool-boundary'),
  room: document.getElementById('tool-room'),
  wall: document.getElementById('tool-wall'),
  window: document.getElementById('tool-window'),
  door: document.getElementById('tool-door'),
  delete: document.getElementById('tool-delete')
};

// --- Panel Elements for responsive height shifts ---
const searchPanel = document.querySelector('.search-panel');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadFeaturesFromLocalStorage();
  setupUIEventListeners();
  switchActiveFloor('1');
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
  boundariesLayerGroup = L.layerGroup().addTo(map);
  roomsLayerGroup = L.layerGroup().addTo(map);
  wallsLayerGroup = L.layerGroup().addTo(map);
  windowsLayerGroup = L.layerGroup().addTo(map);
  doorsLayerGroup = L.layerGroup().addTo(map);

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

  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  for (const room of roomsOnFloor) {
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
      let countText = "";
      if (isHeatmapEnabled) {
        const count = simulatedAgents.filter(a => a.state === 'resting' && a.destRoomId === containingRoom.id).length +
                      simulatedAgents.filter(a => a.state === 'walking' && isPointInPolygon(a.latlng, containingRoom.latlngs)).length;
        countText = ` (Occupancy: ${count})`;
      }
      successRoomName.textContent = containingRoom.name + countText;
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

  // Floor selector buttons
  const floorButtons = document.querySelectorAll('.floor-btn');
  floorButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      floorButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchActiveFloor(btn.dataset.floor);
    });
  });

  // Modal Add Door button
  btnModalAddDoor.addEventListener('click', () => {
    isPlacingDoorForModal = true;
    roomModal.style.display = 'none'; // Temporarily hide modal
    showToast('Click on the map/room outline to place a door.');
  });

  // Navigation Pathfinding buttons
  btnFindPath.addEventListener('click', calculateAndDrawPath);
  btnClearPath.addEventListener('click', clearNavigationPath);

  // Traffic Heatmap Toggle Switch
  const checkboxHeatmap = document.getElementById('toggle-heatmap');
  checkboxHeatmap.addEventListener('change', (e) => {
    isHeatmapEnabled = e.target.checked;
    if (isHeatmapEnabled) {
      initHeatmap();
      startCrowdSimulation();
    } else {
      stopCrowdSimulation();
      removeHeatmap();
    }
  });

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
  switch (activeTool) {
    case 'select':
      showToast('Mode: Inspect items and listings.');
      break;
    case 'boundary':
      showToast('Mode: Click points to draw Floor Boundary. Double-click to close.');
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
    case 'door':
      showToast('Mode: Click near a room boundary to place a door.');
      break;
    case 'delete':
      showToast('Mode: Click on any drawn vector to delete it.');
      break;
  }
}

// --- Map Drawing Core Engine ---
function handleMapClick(e) {
  // If placing door for modal, handle it
  if (isPlacingDoorForModal) {
    const pt = [e.latlng.lat, e.latlng.lng];
    tempDoorsForModal.push(pt);
    
    // Draw temporary door marker
    const tempMarker = L.marker(pt, {
      icon: L.divIcon({
        html: '<div class="drawn-door-icon"><i class="fa-solid fa-door-open"></i></div>',
        className: 'custom-door-divicon',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      })
    }).addTo(doorsLayerGroup);
    
    isPlacingDoorForModal = false;
    
    // Update Modal UI
    modalDoorStatus.textContent = `${tempDoorsForModal.length} Door(s) Placed`;
    modalDoorStatus.className = 'door-status-pill filled';
    
    // Re-show modal
    roomModal.style.display = 'flex';
    showToast('Door placed.');
    return;
  }

  // If Simulator is active and Select mode, move user position
  if (isSimulatorEnabled && activeTool === 'select') {
    updateGpsLocation(e.latlng.lat, e.latlng.lng);
    return;
  }

  // If Door placing tool is active directly
  if (activeTool === 'door') {
    const pt = [e.latlng.lat, e.latlng.lng];
    const associatedRoom = findClosestRoom(pt);
    if (!associatedRoom) {
      showToast('Please draw a room on this floor first before placing a door!');
      return;
    }
    
    const door = {
      id: 'door-' + Date.now(),
      roomId: associatedRoom.id,
      floor: activeFloor,
      latlng: pt
    };
    
    savedDoors.push(door);
    renderDoor(door);
    saveFeaturesToLocalStorage();
    showToast(`Door associated with ${associatedRoom.name}.`);
    
    // Refresh Navigation options since a new door was placed
    updateNavigationRoomOptions();
    return;
  }

  // Draw modes (Room, Wall, Window, Boundary)
  if (activeTool === 'room' || activeTool === 'wall' || activeTool === 'window' || activeTool === 'boundary') {
    const pt = [e.latlng.lat, e.latlng.lng];
    tempPoints.push(pt);
    
    // Draw/Update temporary graphics
    if (tempPoints.length === 1) {
      if (activeTool === 'room' || activeTool === 'boundary') {
        const color = activeTool === 'boundary' ? 'var(--warning)' : 'var(--accent-color)';
        tempGraphic = L.polygon(tempPoints, { color: color, weight: 2, fillOpacity: 0.1, dashArray: '5 5' }).addTo(map);
      } else {
        tempGraphic = L.polyline(tempPoints, { color: activeTool === 'window' ? '#67e8f9' : '#4b5563', weight: 3, dashArray: '5 5' }).addTo(map);
      }
    } else {
      tempGraphic.setLatLngs(tempPoints);
    }
  }
}

function handleMapMouseMove(e) {
  if (tempGraphic && tempPoints.length > 0) {
    const pts = [...tempPoints, [e.latlng.lat, e.latlng.lng]];
    tempGraphic.setLatLngs(pts);
  }
}

function handleMapDoubleClick(e) {
  if (activeTool === 'room' || activeTool === 'wall' || activeTool === 'window' || activeTool === 'boundary') {
    L.DomEvent.stopPropagation(e);

    if (tempPoints.length < 2) {
      resetDraftState();
      return;
    }

    const tool = activeTool;
    const pts = [...tempPoints];
    resetDraftState();

    if (tool === 'room') {
      pendingRoomCoords = pts;
      openModal();
    } else if (tool === 'boundary') {
      saveBoundary(pts);
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
  const floor = roomFloorSelect.value;

  if (!name) {
    alert('Please enter a room name.');
    return;
  }

  if (tempDoorsForModal.length === 0) {
    alert('Every room must have at least one door to enable navigation. Please place a door.');
    return;
  }

  const roomId = 'room-' + Date.now();
  const room = {
    id: roomId,
    name: name,
    category: cat,
    floor: floor,
    desc: desc || 'No notes saved.',
    latlngs: pendingRoomCoords
  };

  // Move temporary doors into savedDoors
  tempDoorsForModal.forEach((pt, index) => {
    savedDoors.push({
      id: `door-${Date.now()}-${index}`,
      roomId: roomId,
      floor: floor,
      latlng: pt
    });
  });

  savedRooms.push(room);
  
  // Clear temp list
  tempDoorsForModal = [];
  modalDoorStatus.textContent = "0 Doors Placed";
  modalDoorStatus.className = "door-status-pill empty";

  saveFeaturesToLocalStorage();
  
  // Redraw everything to ensure consistency
  switchActiveFloor(floor);

  // Sync Floor Selector UI
  const floorButtons = document.querySelectorAll('.floor-btn');
  floorButtons.forEach(btn => {
    if (btn.dataset.floor === floor) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

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
    // Delete associated doors
    savedDoors = savedDoors.filter(d => d.roomId !== id);
    
    // Clear active containment state
    if (activeRoomId === id) {
      activeRoomId = null;
      valCurrentRoom.textContent = 'Outside';
      valCurrentRoom.className = 'current-room-pill outside';
      successOverlay.classList.remove('show');
    }
  } else if (type === 'boundary') {
    savedBoundaries = savedBoundaries.filter(b => b.id !== id);
  } else if (type === 'wall') {
    savedWalls = savedWalls.filter(w => w.id !== id);
  } else if (type === 'window') {
    savedWindows = savedWindows.filter(w => w.id !== id);
  } else if (type === 'door') {
    savedDoors = savedDoors.filter(d => d.id !== id);
  }

  saveFeaturesToLocalStorage();
  switchActiveFloor(activeFloor); // Re-render active floor
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
      <div style="color: var(--text-primary); font-family: 'Outfit', sans-serif;">
        <h3 style="margin-bottom: 4px; font-weight: 600;">${room.name}</h3>
        <p style="font-size: 0.7rem; text-transform: uppercase; color: var(--accent-color); font-weight: 700; margin-bottom: 6px;">${room.category} • Floor ${room.floor}</p>
        <p style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">${room.desc}</p>
      </div>
    `)
    .openOn(map);
}

// --- Directory Update UI ---
function updateRoomDirectoryUI() {
  savedRoomsList.innerHTML = '';
  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  
  if (roomsOnFloor.length === 0) {
    savedRoomsList.innerHTML = `<li class="empty-list-placeholder">No rooms mapped on Floor ${activeFloor} yet. Use the Drawing Tools above!</li>`;
    return;
  }

  roomsOnFloor.forEach(room => {
    // Calculate current simulated occupants (resting or walking inside)
    let count = 0;
    if (isHeatmapEnabled) {
      count = simulatedAgents.filter(a => a.state === 'resting' && a.destRoomId === room.id).length +
              simulatedAgents.filter(a => a.state === 'walking' && isPointInPolygon(a.latlng, room.latlngs)).length;
    }
    const isCrowded = count > 50;
    const badgeClass = isCrowded ? 'room-dir-occupants crowded' : 'room-dir-occupants';

    const item = document.createElement('li');
    item.className = 'room-dir-item';
    item.innerHTML = `
      <div class="room-dir-info">
        <span class="room-dir-name">${room.name}</span>
        <span class="room-dir-cat">${room.category} <span class="${badgeClass}" id="occupancy-badge-${room.id}"><i class="fa-solid fa-users"></i> ${count}</span></span>
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
  roomFloorSelect.value = activeFloor;
  tempDoorsForModal = [];
  modalDoorStatus.textContent = "0 Doors Placed";
  modalDoorStatus.className = "door-status-pill empty";
  roomModal.style.display = 'flex';
  roomNameInput.focus();
}

function closeModal() {
  roomModal.style.display = 'none';
  pendingRoomCoords = null;
  resetDraftState();

  // Clear any temporary door markers placed while modal was active
  doorsLayerGroup.eachLayer(layer => {
    if (layer.dataset && layer.dataset.id && layer.dataset.id.startsWith('temp-')) {
      doorsLayerGroup.removeLayer(layer);
    }
  });

  tempDoorsForModal = [];
  modalDoorStatus.textContent = "0 Doors Placed";
  modalDoorStatus.className = "door-status-pill empty";
}

// --- LocalStorage Integration ---
function saveFeaturesToLocalStorage() {
  localStorage.setItem('mazemap_gps_boundaries', JSON.stringify(savedBoundaries));
  localStorage.setItem('mazemap_gps_rooms', JSON.stringify(savedRooms));
  localStorage.setItem('mazemap_gps_walls', JSON.stringify(savedWalls));
  localStorage.setItem('mazemap_gps_windows', JSON.stringify(savedWindows));
  localStorage.setItem('mazemap_gps_doors', JSON.stringify(savedDoors));
}

function loadFeaturesFromLocalStorage() {
  const boundariesStr = localStorage.getItem('mazemap_gps_boundaries');
  const roomsStr = localStorage.getItem('mazemap_gps_rooms');
  const wallsStr = localStorage.getItem('mazemap_gps_walls');
  const windowsStr = localStorage.getItem('mazemap_gps_windows');
  const doorsStr = localStorage.getItem('mazemap_gps_doors');

  if (boundariesStr) savedBoundaries = JSON.parse(boundariesStr);
  if (roomsStr) savedRooms = JSON.parse(roomsStr);
  if (wallsStr) savedWalls = JSON.parse(wallsStr);
  if (windowsStr) savedWindows = JSON.parse(windowsStr);
  if (doorsStr) savedDoors = JSON.parse(doorsStr);
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

// --- FLOORS, DOORS & NAVIGATION APP ENGINE ---

function switchActiveFloor(floor) {
  activeFloor = floor;
  
  // Clear map layers
  boundariesLayerGroup.clearLayers();
  roomsLayerGroup.clearLayers();
  wallsLayerGroup.clearLayers();
  windowsLayerGroup.clearLayers();
  doorsLayerGroup.clearLayers();
  
  // Clear navigation path
  clearNavigationPath();
  
  // Render features matching floor
  savedBoundaries.filter(b => b.floor === activeFloor).forEach(renderBoundary);
  savedRooms.filter(r => r.floor === activeFloor).forEach(renderRoom);
  savedWalls.filter(w => w.floor === activeFloor).forEach(renderWall);
  savedWindows.filter(w => w.floor === activeFloor).forEach(renderWindow);
  savedDoors.filter(d => d.floor === activeFloor).forEach(renderDoor);
  
  // Update room directory UI
  updateRoomDirectoryUI();
  
  // Update dropdown select menus
  updateNavigationRoomOptions();

  // Restart crowd simulation for the new floor if heatmap is enabled
  if (isHeatmapEnabled) {
    stopCrowdSimulation();
    startCrowdSimulation();
  }

  // If a pending multi-floor route exists for this floor, draw it
  if (window.pendingDestinationPath && window.pendingDestinationPath.floor === floor) {
    drawNavigationPathOnMap(window.pendingDestinationPath.path);
    window.pendingDestinationPath = null;
    showToast(`Transit complete. Walkway to destination loaded.`);
  } else {
    showToast(`Switched to Floor ${activeFloor}`);
  }
}

function updateNavigationRoomOptions() {
  // Clear select elements
  navStartSelect.innerHTML = '<option value="">-- Choose Start Room --</option>';
  navEndSelect.innerHTML = '<option value="">-- Choose Destination --</option>';
  
  const floors = ['1', '2', '3', '4', '5'];
  
  floors.forEach(fl => {
    const roomsOnFloor = savedRooms.filter(r => r.floor === fl);
    if (roomsOnFloor.length > 0) {
      const startGroup = document.createElement('optgroup');
      startGroup.label = `Floor ${fl}`;
      const endGroup = document.createElement('optgroup');
      endGroup.label = `Floor ${fl}`;
      
      roomsOnFloor.forEach(room => {
        const hasDoors = savedDoors.some(d => d.roomId === room.id);
        const labelText = room.name + (hasDoors ? "" : " (No doors!)");
        
        const opt1 = document.createElement('option');
        opt1.value = room.id;
        opt1.textContent = labelText;
        opt1.disabled = !hasDoors;
        startGroup.appendChild(opt1);
        
        const opt2 = document.createElement('option');
        opt2.value = room.id;
        opt2.textContent = labelText;
        opt2.disabled = !hasDoors;
        endGroup.appendChild(opt2);
      });
      
      navStartSelect.appendChild(startGroup);
      navEndSelect.appendChild(endGroup);
    }
  });
}

function findClosestRoom(pt) {
  let closestRoom = null;
  let minDistance = Infinity;
  
  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  roomsOnFloor.forEach(room => {
    const poly = L.polygon(room.latlngs);
    const center = poly.getBounds().getCenter();
    const dist = map.distance(pt, [center.lat, center.lng]);
    if (dist < minDistance) {
      minDistance = dist;
      closestRoom = room;
    }
  });
  
  return minDistance < 100 ? closestRoom : null;
}

function saveBoundary(latlngs) {
  // Ensure only one boundary per floor
  const existingBoundary = savedBoundaries.find(b => b.floor === activeFloor);
  if (existingBoundary) {
    savedBoundaries = savedBoundaries.filter(b => b.id !== existingBoundary.id);
    boundariesLayerGroup.eachLayer(layer => {
      if (layer.dataset && layer.dataset.id === existingBoundary.id) {
        boundariesLayerGroup.removeLayer(layer);
      }
    });
  }

  const boundary = {
    id: 'boundary-' + Date.now(),
    floor: activeFloor,
    latlngs: latlngs
  };
  savedBoundaries.push(boundary);
  renderBoundary(boundary);
  saveFeaturesToLocalStorage();
  showToast('Floor Boundary saved.');
}

function renderBoundary(boundary) {
  const poly = L.polygon(boundary.latlngs, {
    className: 'drawn-boundary-polygon',
    color: 'var(--warning)',
    fillColor: 'var(--warning)',
    fillOpacity: 0.03,
    weight: 2.5,
    dashArray: '6 6'
  });
  
  poly.dataset = { id: boundary.id, type: 'boundary' };
  poly.on('click', (e) => handleFeatureClick(e, boundary.id, 'boundary'));
  poly.addTo(boundariesLayerGroup);
}

function renderDoor(door) {
  const marker = L.marker(door.latlng, {
    icon: L.divIcon({
      html: '<div class="drawn-door-icon"><i class="fa-solid fa-door-open"></i></div>',
      className: 'custom-door-divicon',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    })
  });
  
  const room = savedRooms.find(r => r.id === door.roomId);
  if (room) {
    marker.bindTooltip(`Door to: ${room.name}`, { direction: 'top', className: 'room-tooltip-label' });
  }
  
  marker.dataset = { id: door.id, type: 'door' };
  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    handleFeatureClick(e, door.id, 'door');
  });
  marker.addTo(doorsLayerGroup);
}

function calculateAndDrawPath() {
  const startRoomId = navStartSelect.value;
  const endRoomId = navEndSelect.value;
  
  if (!startRoomId || !endRoomId) {
    showToast('Please select both Start and Destination rooms.');
    return;
  }
  
  if (startRoomId === endRoomId) {
    showToast('Start and Destination are the same room!');
    return;
  }
  
  const startRoom = savedRooms.find(r => r.id === startRoomId);
  const endRoom = savedRooms.find(r => r.id === endRoomId);
  
  if (!startRoom || !endRoom) return;
  
  clearNavigationPath();
  
  if (startRoom.floor === endRoom.floor) {
    if (activeFloor !== startRoom.floor) {
      switchActiveFloor(startRoom.floor);
      const floorButtons = document.querySelectorAll('.floor-btn');
      floorButtons.forEach(btn => {
        if (btn.dataset.floor === activeFloor) btn.classList.add('active');
        else btn.classList.remove('active');
      });
    }
    
    const pathLatLngs = runPathfindingOnFloor(startRoom, endRoom, startRoom.floor);
    if (pathLatLngs) {
      drawNavigationPathOnMap(pathLatLngs);
      showToast('Directions loaded.');
    }
  } else {
    showToast('Routing across floors...');
    
    const startStairs = savedRooms.find(r => r.floor === startRoom.floor && r.category === 'stairs');
    const endStairs = savedRooms.find(r => r.floor === endRoom.floor && r.category === 'stairs');
    
    if (!startStairs || !endStairs) {
      alert('Stairs / Elevator portal rooms are required on both floors for multi-floor navigation. Please map a "Stairs / Elevator" room category on both floors.');
      return;
    }
    
    if (activeFloor !== startRoom.floor) {
      switchActiveFloor(startRoom.floor);
      const floorButtons = document.querySelectorAll('.floor-btn');
      floorButtons.forEach(btn => {
        if (btn.dataset.floor === activeFloor) btn.classList.add('active');
        else btn.classList.remove('active');
      });
    }
    
    const startPath = runPathfindingOnFloor(startRoom, startStairs, startRoom.floor);
    if (!startPath) {
      showToast('Could not route to stairs on start floor.');
      return;
    }
    
    const endPath = runPathfindingOnFloor(endStairs, endRoom, endRoom.floor);
    if (!endPath) {
      showToast('Could not route from stairs to destination room.');
      return;
    }
    
    drawNavigationPathOnMap(startPath);
    
    const stairsCenter = L.polygon(startStairs.latlngs).getBounds().getCenter();
    L.popup()
      .setLatLng(stairsCenter)
      .setContent(`
        <div style="font-family: 'Outfit', sans-serif; color: var(--text-primary); text-align: center;">
          <h4 style="color: var(--warning); margin-bottom: 4px;"><i class="fa-solid fa-stairs"></i> Floor Transit</h4>
          <p style="font-size: 0.8rem; line-height: 1.4; margin-bottom: 6px;">
            Go to the stairs/elevator on <strong>Floor ${startRoom.floor}</strong>, then switch to <strong>Floor ${endRoom.floor}</strong> in the selector.
          </p>
          <button onclick="switchActiveFloor('${endRoom.floor}'); document.querySelectorAll('.floor-btn').forEach(btn => { if (btn.dataset.floor === '${endRoom.floor}') btn.classList.add('active'); else btn.classList.remove('active'); }); map.closePopup();" style="background: var(--accent-color); border: none; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; font-weight: 600;">
            Go to Floor ${endRoom.floor}
          </button>
        </div>
      `)
      .openOn(map);
      
    window.pendingDestinationPath = {
      path: endPath,
      floor: endRoom.floor
    };
  }
}

function runPathfindingOnFloor(startRoom, endRoom, floor) {
  const boundary = savedBoundaries.find(b => b.floor === floor);
  if (!boundary) {
    alert(`Please draw the Floor Boundary for Floor ${floor} first!`);
    return null;
  }
  
  const startDoors = savedDoors.filter(d => d.roomId === startRoom.id && d.floor === floor);
  const endDoors = savedDoors.filter(d => d.roomId === endRoom.id && d.floor === floor);
  
  if (startDoors.length === 0 || endDoors.length === 0) {
    showToast('Start or destination room is missing doors.');
    return null;
  }
  
  const startDoorLatLng = startDoors[0].latlng;
  const endDoorLatLng = endDoors[0].latlng;
  
  const path = runAStar(startDoorLatLng, endDoorLatLng, boundary, floor);
  if (!path) {
    showToast('No walkable path found inside the boundary.');
    return null;
  }
  
  return path;
}

function drawNavigationPathOnMap(latlngs) {
  if (navigationPathPolyline) {
    map.removeLayer(navigationPathPolyline);
  }
  
  navigationPathPolyline = L.polyline(latlngs, {
    className: 'navigation-path',
    color: '#10b981',
    weight: 5
  }).addTo(map);
  
  map.fitBounds(navigationPathPolyline.getBounds(), { padding: [30, 30] });
}

function clearNavigationPath() {
  if (navigationPathPolyline) {
    map.removeLayer(navigationPathPolyline);
    navigationPathPolyline = null;
  }
  window.pendingDestinationPath = null;
}

function getDistanceToSegment(p, a, b) {
  let x = p[0], y = p[1];
  let x1 = a[0], y1 = a[1];
  let x2 = b[0], y2 = b[1];
  
  let A = x - x1;
  let B = y - y1;
  let C = x2 - x1;
  let D = y2 - y1;
  
  let dot = A * C + B * D;
  let len_sq = C * C + D * D;
  let param = -1;
  if (len_sq != 0) param = dot / len_sq;
  
  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }
  
  let dx = x - xx;
  let dy = y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

function runAStar(startLatLng, endLatLng, boundary, floor) {
  const boundaryPoly = L.polygon(boundary.latlngs);
  const bounds = boundaryPoly.getBounds();
  
  const minLat = bounds.getSouthWest().lat;
  const maxLat = bounds.getNorthEast().lat;
  const minLng = bounds.getSouthWest().lng;
  const maxLng = bounds.getNorthEast().lng;
  
  const rows = 80;
  const cols = 80;
  const dLat = (maxLat - minLat) / rows;
  const dLng = (maxLng - minLng) / cols;
  
  const rooms = savedRooms.filter(r => r.floor === floor);
  const walls = savedWalls.filter(w => w.floor === floor);
  const windows = savedWindows.filter(w => w.floor === floor);
  const doors = savedDoors.filter(d => d.floor === floor);
  
  function getCellCenter(r, c) {
    return [
      minLat + (r + 0.5) * dLat,
      minLng + (c + 0.5) * dLng
    ];
  }
  
  function latLngToCell(latlng) {
    let r = Math.floor((latlng[0] - minLat) / dLat);
    let c = Math.floor((latlng[1] - minLng) / dLng);
    r = Math.max(0, Math.min(rows - 1, r));
    c = Math.max(0, Math.min(cols - 1, c));
    return { r, c };
  }
  
  const startCell = latLngToCell(startLatLng);
  const endCell = latLngToCell(endLatLng);
  
  const cellDiag = Math.sqrt(dLat * dLat + dLng * dLng);
  const wallDistThreshold = Math.max(dLat, dLng) * 0.8;
  const doorRadiusThreshold = cellDiag * 2.0; 
  
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      const pt = getCellCenter(r, c);
      
      if (!isPointInPolygon(pt, boundary.latlngs)) {
        grid[r][c] = 0;
        continue;
      }
      
      let isNearDoor = false;
      for (const d of doors) {
        const dx = pt[0] - d.latlng[0];
        const dy = pt[1] - d.latlng[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < doorRadiusThreshold) {
          isNearDoor = true;
          break;
        }
      }
      
      let isInsideRoom = false;
      if (!isNearDoor) {
        for (const room of rooms) {
          if (isPointInPolygon(pt, room.latlngs)) {
            isInsideRoom = true;
            break;
          }
        }
      }
      
      if (isInsideRoom) {
        grid[r][c] = 0;
        continue;
      }
      
      let isNearWall = false;
      for (const wall of walls) {
        for (let i = 0; i < wall.latlngs.length - 1; i++) {
          if (getDistanceToSegment(pt, wall.latlngs[i], wall.latlngs[i+1]) < wallDistThreshold) {
            isNearWall = true;
            break;
          }
        }
        if (isNearWall) break;
      }
      
      if (!isNearWall) {
        for (const win of windows) {
          for (let i = 0; i < win.latlngs.length - 1; i++) {
            if (getDistanceToSegment(pt, win.latlngs[i], win.latlngs[i+1]) < wallDistThreshold) {
              isNearWall = true;
              break;
            }
          }
          if (isNearWall) break;
        }
      }
      
      if (isNearWall) {
        grid[r][c] = 0;
        continue;
      }
      
      grid[r][c] = 1; 
    }
  }
  
  grid[startCell.r][startCell.c] = 1;
  grid[endCell.r][endCell.c] = 1;
  
  const openSet = [];
  const closedSet = new Set();
  
  function getCellKey(r, c) {
    return `${r},${c}`;
  }
  
  const startNode = {
    r: startCell.r,
    c: startCell.c,
    g: 0,
    h: Math.sqrt(Math.pow(startCell.r - endCell.r, 2) + Math.pow(startCell.c - endCell.c, 2)),
    f: 0,
    parent: null
  };
  startNode.f = startNode.g + startNode.h;
  openSet.push(startNode);
  
  let endNode = null;
  
  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    const curr = openSet.shift();
    
    if (curr.r === endCell.r && curr.c === endCell.c) {
      endNode = curr;
      break;
    }
    
    closedSet.add(getCellKey(curr.r, curr.c));
    
    const dirs = [
      { dr: -1, dc: 0, cost: 1 },
      { dr: 1, dc: 0, cost: 1 },
      { dr: 0, dc: -1, cost: 1 },
      { dr: 0, dc: 1, cost: 1 },
      { dr: -1, dc: -1, cost: 1.414 },
      { dr: -1, dc: 1, cost: 1.414 },
      { dr: 1, dc: -1, cost: 1.414 },
      { dr: 1, dc: 1, cost: 1.414 }
    ];
    
    for (const dir of dirs) {
      const nr = curr.r + dir.dr;
      const nc = curr.c + dir.dc;
      
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] === 0) continue;
      if (closedSet.has(getCellKey(nr, nc))) continue;
      
      if (dir.dr !== 0 && dir.dc !== 0) {
        if (grid[curr.r + dir.dr][curr.c] === 0 && grid[curr.r][curr.c + dir.dc] === 0) {
          continue; 
        }
      }
      
      const gScore = curr.g + dir.cost;
      const hScore = Math.sqrt(Math.pow(nr - endCell.r, 2) + Math.pow(nc - endCell.c, 2));
      const fScore = gScore + hScore;
      
      let existing = openSet.find(n => n.r === nr && n.c === nc);
      if (existing) {
        if (gScore < existing.g) {
          existing.g = gScore;
          existing.f = fScore;
          existing.parent = curr;
        }
      } else {
        openSet.push({
          r: nr,
          c: nc,
          g: gScore,
          h: hScore,
          f: fScore,
          parent: curr
        });
      }
    }
  }
  
  if (!endNode) return null;
  
  const path = [];
  let current = endNode;
  while (current !== null) {
    path.push(getCellCenter(current.r, current.c));
    current = current.parent;
  }
  path.reverse();
  
  path[0] = startLatLng;
  path[path.length - 1] = endLatLng;
  
  return path;
}

// --- CROWD TRAFFIC SIMULATOR & HEATMAP OVERLAY ---

function initHeatmap() {
  if (!heatmapLayer) {
    // Custom gradient: blue -> cyan -> green -> yellow/orange -> red
    heatmapLayer = L.heatLayer([], {
      radius: 20,
      blur: 15,
      max: 5,
      gradient: {
        0.1: '#3b82f6', // Cool Blue
        0.3: '#06b6d4', // Cyan
        0.5: '#10b981', // Green (Normal traffic)
        0.7: '#f59e0b', // Orange (Medium density: 16-50 people)
        1.0: '#ef4444'  // Red (High density: >50 people)
      }
    }).addTo(map);
  }
}

function startCrowdSimulation() {
  stopCrowdSimulation();
  
  const boundary = savedBoundaries.find(b => b.floor === activeFloor);
  if (!boundary) {
    alert(`Please draw a Floor Boundary for Floor ${activeFloor} first to define the walkable simulation perimeter!`);
    const checkboxHeatmap = document.getElementById('toggle-heatmap');
    if (checkboxHeatmap) checkboxHeatmap.checked = false;
    isHeatmapEnabled = false;
    return;
  }
  
  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  if (roomsOnFloor.length < 2) {
    alert("Please draw at least 2 rooms (with doors) on this floor to simulate traffic routing.");
    const checkboxHeatmap = document.getElementById('toggle-heatmap');
    if (checkboxHeatmap) checkboxHeatmap.checked = false;
    isHeatmapEnabled = false;
    return;
  }
  
  const roomsWithDoors = roomsOnFloor.filter(room => savedDoors.some(d => d.roomId === room.id && d.floor === activeFloor));
  if (roomsWithDoors.length < 2) {
    alert("Please ensure at least 2 rooms on this floor have doors placed so agents can navigate between them.");
    const checkboxHeatmap = document.getElementById('toggle-heatmap');
    if (checkboxHeatmap) checkboxHeatmap.checked = false;
    isHeatmapEnabled = false;
    return;
  }

  showToast('Spawning crowd agents...');
  
  // Spawn 65 agents staggered by 30ms to prevent initial UI freeze
  const numAgents = 65;
  for (let i = 0; i < numAgents; i++) {
    setTimeout(() => {
      if (!isHeatmapEnabled || activeFloor !== boundary.floor) return;
      
      const startRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
      let destRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
      while (destRoom.id === startRoom.id && roomsWithDoors.length > 1) {
        destRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
      }
      
      const startDoors = savedDoors.filter(d => d.roomId === startRoom.id && d.floor === activeFloor);
      const endDoors = savedDoors.filter(d => d.roomId === destRoom.id && d.floor === activeFloor);
      
      if (startDoors.length > 0 && endDoors.length > 0) {
        const path = runPathfindingOnFloor(startRoom, destRoom, activeFloor);
        if (path) {
          simulatedAgents.push({
            id: 'agent-' + i,
            path: path,
            pathIndex: 0,
            latlng: path[0],
            state: 'walking',
            restTicks: 0,
            startRoomId: startRoom.id,
            destRoomId: destRoom.id,
            floor: activeFloor
          });
        }
      }
    }, i * 30);
  }
  
  agentUpdateIntervalId = setInterval(updateAgents, 200);
  heatmapUpdateIntervalId = setInterval(updateHeatmapData, 300);
}

function updateAgents() {
  if (simulatedAgents.length === 0) return;
  
  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  const roomsWithDoors = roomsOnFloor.filter(room => savedDoors.some(d => d.roomId === room.id && d.floor === activeFloor));
  
  simulatedAgents.forEach(agent => {
    if (agent.floor !== activeFloor) return;
    
    if (agent.state === 'walking') {
      agent.pathIndex++;
      if (agent.pathIndex >= agent.path.length) {
        agent.state = 'resting';
        agent.restTicks = Math.floor(Math.random() * 25) + 10; // Rest for 2 to 7 seconds
      } else {
        agent.latlng = agent.path[agent.pathIndex];
      }
    } else if (agent.state === 'resting') {
      agent.restTicks--;
      if (agent.restTicks <= 0) {
        const currentRoom = savedRooms.find(r => r.id === agent.destRoomId);
        if (currentRoom && roomsWithDoors.length > 1) {
          let destRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
          while (destRoom.id === currentRoom.id) {
            destRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
          }
          
          const path = runPathfindingOnFloor(currentRoom, destRoom, activeFloor);
          if (path) {
            agent.path = path;
            agent.pathIndex = 0;
            agent.latlng = path[0];
            agent.state = 'walking';
            agent.startRoomId = currentRoom.id;
            agent.destRoomId = destRoom.id;
          }
        }
      }
    }
  });
  
  // Calculate occupancies
  const occupancy = {};
  roomsOnFloor.forEach(r => occupancy[r.id] = 0);
  
  simulatedAgents.forEach(agent => {
    if (agent.state === 'resting') {
      occupancy[agent.destRoomId] = (occupancy[agent.destRoomId] || 0) + 1;
    } else {
      for (const r of roomsOnFloor) {
        if (isPointInPolygon(agent.latlng, r.latlngs)) {
          occupancy[r.id] = (occupancy[r.id] || 0) + 1;
          break;
        }
      }
    }
  });
  
  // Update room directory UI badges
  roomsOnFloor.forEach(room => {
    const count = occupancy[room.id] || 0;
    const badge = document.getElementById(`occupancy-badge-${room.id}`);
    if (badge) {
      badge.innerHTML = `<i class="fa-solid fa-users"></i> ${count}`;
      if (count > 50) {
        badge.className = 'room-dir-occupants crowded';
      } else {
        badge.className = 'room-dir-occupants';
      }
    }
  });
}

function updateHeatmapData() {
  if (!heatmapLayer || !isHeatmapEnabled) return;
  
  const heatPoints = [];
  
  // 1. Add all simulated agents
  simulatedAgents.forEach(agent => {
    if (agent.floor === activeFloor) {
      heatPoints.push([agent.latlng[0], agent.latlng[1], 1.2]);
    }
  });
  
  // 2. Add real user's location if simulation is active
  if (isSimulatorEnabled && currentGpsCoords) {
    heatPoints.push([currentGpsCoords.lat, currentGpsCoords.lng, 2.0]);
  }
  
  heatmapLayer.setLatLngs(heatPoints);
}

function stopCrowdSimulation() {
  if (agentUpdateIntervalId) {
    clearInterval(agentUpdateIntervalId);
    agentUpdateIntervalId = null;
  }
  if (heatmapUpdateIntervalId) {
    clearInterval(heatmapUpdateIntervalId);
    heatmapUpdateIntervalId = null;
  }
  simulatedAgents = [];
  
  // Reset directory badges
  savedRooms.forEach(room => {
    const badge = document.getElementById(`occupancy-badge-${room.id}`);
    if (badge) {
      badge.innerHTML = `<i class="fa-solid fa-users"></i> 0`;
      badge.className = 'room-dir-occupants';
    }
  });
}

function removeHeatmap() {
  if (heatmapLayer) {
    map.removeLayer(heatmapLayer);
    heatmapLayer = null;
  }
}

