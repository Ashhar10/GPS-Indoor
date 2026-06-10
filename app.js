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
let roomOccupancies = {};
let simulatedHour = 10;

// Live Camera (DensePose) WebSocket state
let activeTrafficSource = 'simulation'; // 'simulation' or 'live'
let liveWebSocket = null;
let liveWsUrl = 'ws://localhost:8080';

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

// Time of Day HUD Elements
const heatmapTimeControl = document.getElementById('heatmap-time-control');
const simTimeSlider = document.getElementById('sim-time-slider');
const simTimeDisplay = document.getElementById('sim-time-display');
const simTimeDesc = document.getElementById('sim-time-desc');

// Live DensePose HUD Elements
const heatmapConfigHud = document.getElementById('heatmap-config-hud');
const btnSourceSimulation = document.getElementById('source-btn-simulation');
const btnSourceLive = document.getElementById('source-btn-live');
const heatmapLiveControl = document.getElementById('heatmap-live-control');
const liveConnectionStatus = document.getElementById('live-connection-status');
const liveWsUrlInput = document.getElementById('live-ws-url-input');
const btnToggleLiveConn = document.getElementById('btn-toggle-live-conn');

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
        const count = roomOccupancies[containingRoom.id] || 0;
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
      if (activeTrafficSource === 'simulation') {
        startCrowdSimulation();
      }
      if (heatmapConfigHud) heatmapConfigHud.style.display = 'flex';
    } else {
      stopCrowdSimulation();
      disconnectLiveWS();
      removeHeatmap();
      if (heatmapConfigHud) heatmapConfigHud.style.display = 'none';
    }
  });

  // Heatmap Source Toggle Buttons
  if (btnSourceSimulation && btnSourceLive) {
    btnSourceSimulation.addEventListener('click', () => {
      if (activeTrafficSource === 'simulation') return;
      activeTrafficSource = 'simulation';
      
      btnSourceSimulation.classList.add('active');
      btnSourceLive.classList.remove('active');
      
      if (heatmapLiveControl) heatmapLiveControl.style.display = 'none';
      if (heatmapTimeControl) heatmapTimeControl.style.display = 'flex';
      
      disconnectLiveWS();
      
      if (isHeatmapEnabled) {
        initHeatmap();
        startCrowdSimulation();
      }
    });

    btnSourceLive.addEventListener('click', () => {
      if (activeTrafficSource === 'live') return;
      activeTrafficSource = 'live';
      
      btnSourceLive.classList.add('active');
      btnSourceSimulation.classList.remove('active');
      
      if (heatmapTimeControl) heatmapTimeControl.style.display = 'none';
      if (heatmapLiveControl) heatmapLiveControl.style.display = 'flex';
      
      stopCrowdSimulation();
      if (heatmapLayer) heatmapLayer.setLatLngs([]);
      
      // Clear room occupancy badges to 0 until WebSocket payload arrives
      savedRooms.forEach(room => {
        const badge = document.getElementById(`occupancy-badge-${room.id}`);
        if (badge) {
          badge.innerHTML = `<i class="fa-solid fa-users"></i> 0`;
          badge.className = 'room-dir-occupants';
        }
      });
    });
  }

  // Connect/Disconnect Button for Live DensePose
  if (btnToggleLiveConn) {
    btnToggleLiveConn.addEventListener('click', () => {
      if (liveWebSocket && (liveWebSocket.readyState === WebSocket.OPEN || liveWebSocket.readyState === WebSocket.CONNECTING)) {
        disconnectLiveWS();
      } else {
        connectToLiveWS();
      }
    });
  }

  // Time of Day Slider Listener
  if (simTimeSlider) {
    simTimeSlider.addEventListener('input', (e) => {
      simulatedHour = parseInt(e.target.value);
      if (simTimeDisplay) simTimeDisplay.textContent = formatHour(simulatedHour);
      if (simTimeDesc) simTimeDesc.textContent = getTimeOfDayDescription(simulatedHour);
      
      // Trigger quick evaluation for agents to adapt to schedule change
      if (simulatedAgents.length > 0) {
        simulatedAgents.forEach(agent => {
          if (agent.state === 'resting') {
            const currentRoom = savedRooms.find(r => r.id === agent.destRoomId);
            if (currentRoom) {
              const currentWeight = getCategoryWeight(currentRoom.category, simulatedHour);
              // If the room becomes unattractive at this hour, give them a high chance to migrate
              if (currentWeight < 0.25 && Math.random() < 0.65) {
                agent.restTicks = Math.floor(Math.random() * 5) + 1; // leave within 1-5 ticks (approx 0.3s)
              }
            }
          }
        });
      }
    });
  }

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
    // Retrieve occupant count from the synchronized cache
    const count = isHeatmapEnabled ? (roomOccupancies[room.id] || 0) : 0;
    const isCrowded = count > 10;
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

  // Restart crowd simulation or reset live data for the new floor if heatmap is enabled
  if (isHeatmapEnabled) {
    if (activeTrafficSource === 'simulation') {
      stopCrowdSimulation(false);
      startCrowdSimulation();
    } else {
      if (heatmapLayer) {
        heatmapLayer.setLatLngs([]);
      }
      roomOccupancies = {};
      updateRoomDirectoryUI();
    }
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
    // Expanded radius (35) and blur (20) to spread heat naturally over the floor area
    heatmapLayer = L.heatLayer([], {
      radius: 35,
      blur: 20,
      max: 5,
      gradient: {
        0.1: '#3b82f6', // Cool Blue (Low traffic)
        0.3: '#06b6d4', // Cyan
        0.5: '#10b981', // Green (Normal traffic)
        0.7: '#f59e0b', // Orange (Medium density: 6-10 people)
        1.0: '#ef4444'  // Red (High density: >10 people)
      }
    }).addTo(map);
  }
}

// Generates smooth coordinates between grid cells
function interpolatePath(path, stepsPerSegment = 5) {
  if (path.length < 2) return path;
  
  const result = [];
  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i + 1];
    
    for (let step = 0; step < stepsPerSegment; step++) {
      const t = step / stepsPerSegment;
      const lat = p1[0] + (p2[0] - p1[0]) * t;
      const lng = p1[1] + (p2[1] - p1[1]) * t;
      result.push([lat, lng]);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

// Generates smooth coordinates between two points
function interpolateTwoPoints(p1, p2, steps = 5) {
  if (!p1 || !p2) return [];
  const result = [];
  for (let step = 0; step < steps; step++) {
    const t = step / steps;
    const lat = p1[0] + (p2[0] - p1[0]) * t;
    const lng = p1[1] + (p2[1] - p1[1]) * t;
    result.push([lat, lng]);
  }
  return result;
}

// Selects a random point inside the room polygon using rejection sampling
function getRandomPointInRoom(room) {
  const vs = room.latlngs;
  if (!vs || vs.length === 0) return null;
  
  let minLat = vs[0][0], maxLat = vs[0][0];
  let minLng = vs[0][1], maxLng = vs[0][1];
  for (let i = 1; i < vs.length; i++) {
    const lat = vs[i][0];
    const lng = vs[i][1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  
  // Rejection sampling: try up to 30 times to find a point inside the polygon
  for (let iter = 0; iter < 30; iter++) {
    const lat = minLat + Math.random() * (maxLat - minLat);
    const lng = minLng + Math.random() * (maxLng - minLng);
    if (isPointInPolygon([lat, lng], vs)) {
      return [lat, lng];
    }
  }
  
  // Fallback: calculate centroid of the room
  let sumLat = 0, sumLng = 0;
  vs.forEach(pt => {
    sumLat += pt[0];
    sumLng += pt[1];
  });
  return [sumLat / vs.length, sumLng / vs.length];
}

// Moves a coordinate towards a target by a maximum step size
function moveTowards(current, target, maxStep) {
  const dLat = target[0] - current[0];
  const dLng = target[1] - current[1];
  const dist = Math.sqrt(dLat * dLat + dLng * dLng);
  if (dist <= maxStep) {
    return { pos: target, reached: true };
  }
  const ratio = maxStep / dist;
  return {
    pos: [
      current[0] + dLat * ratio,
      current[1] + dLng * ratio
    ],
    reached: false
  };
}

// Formats simulated hour integer into 12-hour AM/PM string
function formatHour(hour) {
  if (hour === 0) return "12:00 AM";
  if (hour === 12) return "12:00 PM";
  if (hour > 12) return `${hour - 12}:00 PM`;
  return `${hour}:00 AM`;
}

// Returns a human-friendly description of active locations based on the hour
function getTimeOfDayDescription(hour) {
  if (hour >= 22 || hour < 7) {
    return "Night Hours: Building mostly empty; light research lab activity.";
  } else if (hour >= 7 && hour < 11) {
    return "Morning Rush: Classrooms and faculty offices highly active.";
  } else if (hour >= 11 && hour < 14) {
    return "Lunch Break: High density in lounges, cafes, and common areas.";
  } else if (hour >= 14 && hour < 18) {
    return "Afternoon Study: Balanced activity across classrooms, labs, and offices.";
  } else {
    return "Evening Hours: Night classes and students studying late in labs.";
  }
}

// Maps room category and hour of day to relative probability weights
function getCategoryWeight(category, hour) {
  if (category === 'stairs' || category === 'hallway') return 0.02; // Transit areas
  
  if (hour >= 22 || hour < 7) { // Night
    if (category === 'lab') return 0.1;
    if (category === 'other') return 0.05;
    return 0.01;
  } else if (hour >= 7 && hour < 11) { // Morning
    if (category === 'classroom') return 0.8;
    if (category === 'office') return 0.7;
    if (category === 'other') return 0.4;
    if (category === 'lab') return 0.3;
    return 0.1;
  } else if (hour >= 11 && hour < 14) { // Lunch
    if (category === 'other') return 0.9; // lounges, cafeteria
    if (category === 'office') return 0.4;
    if (category === 'lab') return 0.4;
    if (category === 'classroom') return 0.2;
    return 0.15;
  } else if (hour >= 14 && hour < 18) { // Afternoon
    if (category === 'office') return 0.8;
    if (category === 'classroom') return 0.7;
    if (category === 'lab') return 0.7;
    if (category === 'conference') return 0.5;
    if (category === 'other') return 0.4;
    return 0.1;
  } else { // Evening (18 to 22)
    if (category === 'lab') return 0.5;
    if (category === 'classroom') return 0.3;
    if (category === 'other') return 0.4;
    if (category === 'office') return 0.2;
    return 0.05;
  }
}

// Selects a destination room based on relative category probability weights
function selectDestinationRoomBySchedule(roomsWithDoors, hour) {
  if (roomsWithDoors.length === 0) return null;
  if (roomsWithDoors.length === 1) return roomsWithDoors[0];
  
  const weights = roomsWithDoors.map(room => getCategoryWeight(room.category, hour));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  
  if (totalWeight <= 0) {
    return roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
  }
  
  let rand = Math.random() * totalWeight;
  for (let i = 0; i < roomsWithDoors.length; i++) {
    rand -= weights[i];
    if (rand <= 0) {
      return roomsWithDoors[i];
    }
  }
  return roomsWithDoors[roomsWithDoors.length - 1];
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
  
  const numAgents = 65;
  for (let i = 0; i < numAgents; i++) {
    setTimeout(() => {
      if (!isHeatmapEnabled || activeFloor !== boundary.floor) return;
      
      const startRoom = roomsWithDoors[Math.floor(Math.random() * roomsWithDoors.length)];
      let destRoom = selectDestinationRoomBySchedule(roomsWithDoors, simulatedHour);
      while (destRoom.id === startRoom.id && roomsWithDoors.length > 1) {
        destRoom = selectDestinationRoomBySchedule(roomsWithDoors, simulatedHour);
      }
      
      const startDoors = savedDoors.filter(d => d.roomId === startRoom.id && d.floor === activeFloor);
      const endDoors = savedDoors.filter(d => d.roomId === destRoom.id && d.floor === activeFloor);
      
      if (startDoors.length > 0 && endDoors.length > 0) {
        const rawPath = runPathfindingOnFloor(startRoom, destRoom, activeFloor);
        if (rawPath) {
          const startDoor = startDoors[0].latlng;
          const endDoor = endDoors[0].latlng;
          
          const spawnLatLng = getRandomPointInRoom(startRoom);
          const destLatLng = getRandomPointInRoom(destRoom);
          
          const roomEnterPath = interpolateTwoPoints(spawnLatLng, startDoor, 5);
          const hallwayPath = interpolatePath(rawPath, 5);
          const roomExitPath = interpolateTwoPoints(endDoor, destLatLng, 5);
          
          const fullPath = [...roomEnterPath, ...hallwayPath, ...roomExitPath];
          
          // Persistent random offset (+/- 2.5 meters in degrees) 
          // to spread agents across the entire width of hallways and rooms
          const offsetLat = (Math.random() - 0.5) * 0.000045;
          const offsetLng = (Math.random() - 0.5) * 0.000045;
          
          simulatedAgents.push({
            id: 'agent-' + i,
            path: fullPath,
            pathIndex: 0,
            latlng: fullPath[0],
            state: 'walking',
            restTicks: 0,
            startRoomId: startRoom.id,
            destRoomId: destRoom.id,
            floor: activeFloor,
            offsetLat: offsetLat,
            offsetLng: offsetLng,
            roomTargetLatLng: null,
            pauseTicks: 0
          });
        }
      }
    }, i * 30);
  }
  
  // Real-time ticking updates at 60ms (approx. 16 frames/second)
  agentUpdateIntervalId = setInterval(updateAgents, 60);
  heatmapUpdateIntervalId = setInterval(updateHeatmapData, 60);
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
        agent.restTicks = Math.floor(Math.random() * 250) + 150; // Rest for 9-24 seconds (60ms ticks)
        agent.roomTargetLatLng = null;
        agent.pauseTicks = 0;
      } else {
        agent.latlng = agent.path[agent.pathIndex];
      }
    } else if (agent.state === 'resting') {
      agent.restTicks--;
      if (agent.restTicks <= 0) {
        const currentRoom = savedRooms.find(r => r.id === agent.destRoomId);
        if (currentRoom && roomsWithDoors.length > 1) {
          let destRoom = selectDestinationRoomBySchedule(roomsWithDoors, simulatedHour);
          while (destRoom.id === currentRoom.id && roomsWithDoors.length > 1) {
            destRoom = selectDestinationRoomBySchedule(roomsWithDoors, simulatedHour);
          }
          
          const rawPath = runPathfindingOnFloor(currentRoom, destRoom, activeFloor);
          if (rawPath) {
            const currentDoors = savedDoors.filter(d => d.roomId === currentRoom.id && d.floor === activeFloor);
            const destDoors = savedDoors.filter(d => d.roomId === destRoom.id && d.floor === activeFloor);
            
            if (currentDoors.length > 0 && destDoors.length > 0) {
              const startDoor = currentDoors[0].latlng;
              const endDoor = destDoors[0].latlng;
              
              const spawnLatLng = agent.latlng;
              const destLatLng = getRandomPointInRoom(destRoom);
              
              const roomEnterPath = interpolateTwoPoints(spawnLatLng, startDoor, 5);
              const hallwayPath = interpolatePath(rawPath, 5);
              const roomExitPath = interpolateTwoPoints(endDoor, destLatLng, 5);
              
              agent.path = [...roomEnterPath, ...hallwayPath, ...roomExitPath];
              agent.pathIndex = 0;
              agent.latlng = agent.path[0];
              agent.state = 'walking';
              agent.startRoomId = currentRoom.id;
              agent.destRoomId = destRoom.id;
            }
          }
        }
      } else {
        // Mosey/mill around inside the room
        const currentRoom = savedRooms.find(r => r.id === agent.destRoomId);
        if (currentRoom) {
          // If room attractiveness is low at this hour, give agent a small chance to leave early
          const currentWeight = getCategoryWeight(currentRoom.category, simulatedHour);
          if (currentWeight < 0.25 && Math.random() < 0.015) {
            agent.restTicks = 0; 
          }
          
          if (agent.pauseTicks > 0) {
            agent.pauseTicks--;
          } else {
            if (!agent.roomTargetLatLng) {
              if (Math.random() < 0.15) {
                agent.pauseTicks = Math.floor(Math.random() * 40) + 15; // Pause for 1-3 seconds
              } else {
                agent.roomTargetLatLng = getRandomPointInRoom(currentRoom);
              }
            }
            
            if (agent.roomTargetLatLng) {
              // Walk towards room target coordinate
              const stepSize = 0.000003 + Math.random() * 0.000002;
              const result = moveTowards(agent.latlng, agent.roomTargetLatLng, stepSize);
              agent.latlng = result.pos;
              if (result.reached) {
                agent.roomTargetLatLng = null;
              }
            }
          }
        }
      }
    }
  });
  
  // Calculate occupancies based on active agent coordinates (with offsets)
  const occupancy = {};
  roomsOnFloor.forEach(r => occupancy[r.id] = 0);
  
  simulatedAgents.forEach(agent => {
    if (agent.floor !== activeFloor) return;
    const actualPt = [agent.latlng[0] + agent.offsetLat, agent.latlng[1] + agent.offsetLng];
    
    let foundRoom = false;
    for (const r of roomsOnFloor) {
      if (isPointInPolygon(actualPt, r.latlngs)) {
        occupancy[r.id] = (occupancy[r.id] || 0) + 1;
        foundRoom = true;
        break;
      }
    }
    if (!foundRoom && agent.state === 'resting') {
      occupancy[agent.destRoomId] = (occupancy[agent.destRoomId] || 0) + 1;
    }
  });
  
  // Cache globally for UI updates
  roomOccupancies = occupancy;
  
  // Update UI badges
  roomsOnFloor.forEach(room => {
    const count = occupancy[room.id] || 0;
    const badge = document.getElementById(`occupancy-badge-${room.id}`);
    if (badge) {
      badge.innerHTML = `<i class="fa-solid fa-users"></i> ${count}`;
      if (count > 10) {
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
  
  // 1. Add simulated agents with their persistent lateral offsets
  // to spread heat across the entire width of hallways and rooms
  simulatedAgents.forEach(agent => {
    if (agent.floor === activeFloor) {
      const displayLat = agent.latlng[0] + agent.offsetLat;
      const displayLng = agent.latlng[1] + agent.offsetLng;
      heatPoints.push([displayLat, displayLng, 1.2]);
    }
  });
  
  // 2. Add real user's location if simulation is active
  if (isSimulatorEnabled && currentGpsCoords) {
    heatPoints.push([currentGpsCoords.lat, currentGpsCoords.lng, 2.0]);
  }
  
  heatmapLayer.setLatLngs(heatPoints);
}

function stopCrowdSimulation(resetClock = true) {
  if (agentUpdateIntervalId) {
    clearInterval(agentUpdateIntervalId);
    agentUpdateIntervalId = null;
  }
  if (heatmapUpdateIntervalId) {
    clearInterval(heatmapUpdateIntervalId);
    heatmapUpdateIntervalId = null;
  }
  simulatedAgents = [];
  roomOccupancies = {};
  
  if (resetClock) {
    simulatedHour = 10;
    if (simTimeSlider) simTimeSlider.value = 10;
    if (simTimeDisplay) simTimeDisplay.textContent = formatHour(10);
    if (simTimeDesc) simTimeDesc.textContent = getTimeOfDayDescription(10);
  }
  
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

// --- WebSocket Real-Time Tracking Core ---
function updateWsStatus(status) {
  if (!liveConnectionStatus) return;
  
  // Remove existing status classes
  liveConnectionStatus.classList.remove('disconnected', 'connecting', 'connected');
  
  if (status === 'disconnected') {
    liveConnectionStatus.classList.add('disconnected');
    liveConnectionStatus.innerHTML = '<span class="status-dot"></span> Disconnected';
    if (btnToggleLiveConn) {
      btnToggleLiveConn.textContent = 'Connect';
      btnToggleLiveConn.classList.remove('danger');
      btnToggleLiveConn.classList.add('primary');
    }
  } else if (status === 'connecting') {
    liveConnectionStatus.classList.add('connecting');
    liveConnectionStatus.innerHTML = '<span class="status-dot"></span> Connecting';
    if (btnToggleLiveConn) {
      btnToggleLiveConn.textContent = 'Cancel';
      btnToggleLiveConn.classList.remove('primary');
      btnToggleLiveConn.classList.add('danger');
    }
  } else if (status === 'connected') {
    liveConnectionStatus.classList.add('connected');
    liveConnectionStatus.innerHTML = '<span class="status-dot"></span> Connected';
    if (btnToggleLiveConn) {
      btnToggleLiveConn.textContent = 'Disconnect';
      btnToggleLiveConn.classList.remove('primary');
      btnToggleLiveConn.classList.add('danger');
    }
  }
}

function connectToLiveWS() {
  if (liveWebSocket) {
    disconnectLiveWS();
  }
  
  const url = (liveWsUrlInput ? liveWsUrlInput.value.trim() : '') || 'ws://localhost:8080';
  liveWsUrl = url;
  
  showToast(`Connecting to ${url}...`);
  updateWsStatus('connecting');
  
  try {
    liveWebSocket = new WebSocket(url);
    
    liveWebSocket.onopen = () => {
      showToast('Connected to DensePose tracking server!');
      updateWsStatus('connected');
    };
    
    liveWebSocket.onmessage = (event) => {
      if (!isHeatmapEnabled || activeTrafficSource !== 'live') return;
      
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'heatmap') {
          // message.points = [[lat, lng], [lat, lng, weight], ...]
          const points = message.points.map(pt => {
            return [pt[0], pt[1], pt[2] || 1.2];
          });
          
          if (heatmapLayer) {
            heatmapLayer.setLatLngs(points);
          }
          
          // Re-calculate room occupancy client-side based on these coordinates
          calculateLiveOccupancies(points);
        } else if (message.type === 'occupancy') {
          // Direct room occupancy updates from server
          roomOccupancies = message.occupancy;
          updateRoomDirectoryUI();
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };
    
    liveWebSocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      showToast('Connection error. Check console / server.');
      updateWsStatus('disconnected');
    };
    
    liveWebSocket.onclose = () => {
      showToast('Disconnected from tracking server.');
      updateWsStatus('disconnected');
      liveWebSocket = null;
    };
    
  } catch (err) {
    console.error('WebSocket initialization error:', err);
    showToast('Failed to connect.');
    updateWsStatus('disconnected');
  }
}

function disconnectLiveWS() {
  if (liveWebSocket) {
    liveWebSocket.close();
    liveWebSocket = null;
  }
  updateWsStatus('disconnected');
}

// Calculates room occupancy client-side based on live coordinate list
function calculateLiveOccupancies(points) {
  const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
  const occupancy = {};
  roomsOnFloor.forEach(r => occupancy[r.id] = 0);
  
  points.forEach(pt => {
    for (const r of roomsOnFloor) {
      if (isPointInPolygon([pt[0], pt[1]], r.latlngs)) {
        occupancy[r.id] = (occupancy[r.id] || 0) + 1;
        break;
      }
    }
  });
  
  roomOccupancies = occupancy;
  
  // Update UI badges
  roomsOnFloor.forEach(room => {
    const count = occupancy[room.id] || 0;
    const badge = document.getElementById(`occupancy-badge-${room.id}`);
    if (badge) {
      badge.innerHTML = `<i class="fa-solid fa-users"></i> ${count}`;
      if (count > 10) {
        badge.className = 'room-dir-occupants crowded';
      } else {
        badge.className = 'room-dir-occupants';
      }
    }
  });
}

