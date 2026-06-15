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
let activeTileStyle = 'osm';

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

// WiFi Network Scanner State
let isWifiScannerEnabled = false;
let wifiWebSocket = null;
let wifiHeatmapPoints = [];
let lastWifiScannerMessage = null;
let activeSubnetFilter = 'all';
let detectedClientSubnetPrefix = null;
let activeAgents = []; // Track active scanning agents reported by server



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

// 3D Viewer State
let threeScene = null;
let threeCamera = null;
let threeRenderer = null;
let threeControls = null;
let threeAnimationFrame = null;
let threeSceneRoot = null;

// Google Maps 3D state
let googleMap3D = null;
let googleMap3DMode = 'three'; // 'three' (fallback) or 'google'
let google3DOverlays = []; // { polygons, polylines, markers, fitBounds }

// --- DOM Elements ---
const btnFindMe = document.getElementById('btn-find-me');
const btnStyleDark = document.getElementById('btn-style-dark');
const btnStyleGoogleStreet = document.getElementById('btn-style-google-street');
const btnStyleGoogleHybrid = document.getElementById('btn-style-google-hybrid');
const btnStyleOsm = document.getElementById('btn-style-osm');
const btnOpen3D = document.getElementById('btn-open-3d');
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
const viewer3DOverlay = document.getElementById('viewer3d-overlay');
const viewer3DStage = document.getElementById('viewer3d-stage');
const viewer3DSubtitle = document.getElementById('viewer3d-subtitle');
const viewer3DFloorPill = document.getElementById('viewer3d-floor-pill');
const btnClose3D = document.getElementById('btn-close-3d');
const googleMapsApiKeyInput = document.getElementById('google-maps-api-key');
const btnApplyGoogleKey = document.getElementById('btn-apply-google-key');

// Navigation Elements
const navStartSelect = document.getElementById('nav-start');
const navEndSelect = document.getElementById('nav-end');
const btnFindPath = document.getElementById('btn-find-path');
const btnClearPath = document.getElementById('btn-clear-path');

// WiFi Scanner DOM Elements
const checkboxWifiScanner = document.getElementById('toggle-wifi-scanner');
const wifiScanHud = document.getElementById('wifi-scan-hud');
const wifiConnectionStatus = document.getElementById('wifi-connection-status');
const wifiScannerIpInput = document.getElementById('wifi-scanner-ip');
const wifiNetworkFilter = document.getElementById('wifi-network-filter');
// Removed wifiFilterRespective elements as filtering is now automatic
const wifiDeviceCount = document.getElementById('wifi-device-count');
const wifiDevicesList = document.getElementById('wifi-devices-list');



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

  // Start with OpenStreetMap at zoom 19
  map = L.map('map', {
    layers: [osmLayer],
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
  if (btnOpen3D) btnOpen3D.addEventListener('click', open3DView);
  if (btnClose3D) btnClose3D.addEventListener('click', close3DView);
  if (btnApplyGoogleKey) btnApplyGoogleKey.addEventListener('click', applyGoogleMapsKey);
  if (googleMapsApiKeyInput) {
    googleMapsApiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyGoogleMapsKey();
    });
  }
  if (viewer3DOverlay) {
    viewer3DOverlay.addEventListener('click', (e) => {
      if (e.target === viewer3DOverlay) close3DView();
    });
  }
  window.addEventListener('resize', handle3DResize);
  
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

  // WiFi Scanner Toggle Switch
  if (checkboxWifiScanner) {
    const savedEnabled = localStorage.getItem('mazemap_wifi_scanner_enabled');
    const shouldEnable = savedEnabled === null ? true : savedEnabled === 'true';
    checkboxWifiScanner.checked = shouldEnable;

    checkboxWifiScanner.addEventListener('change', (e) => {
      isWifiScannerEnabled = e.target.checked;
      localStorage.setItem('mazemap_wifi_scanner_enabled', isWifiScannerEnabled);
      if (isWifiScannerEnabled) {
        if (wifiScanHud) wifiScanHud.style.display = 'flex';
        initHeatmap();
        connectToWifiWS();
      } else {
        if (wifiScanHud) wifiScanHud.style.display = 'none';
        disconnectWifiWS();
        if (heatmapLayer) {
          map.removeLayer(heatmapLayer);
          heatmapLayer = null;
        }
      }
    });
  }

  // WiFi Scanner IP Configuration Input
  if (wifiScannerIpInput) {
    let savedIp = localStorage.getItem('mazemap_wifi_scanner_ip');
    if (!savedIp) {
      const hostname = window.location.hostname;
      const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.');
      const isVercel = hostname.endsWith('.vercel.app') || hostname.includes('vercel');
      
      if (isLocal) {
        savedIp = hostname + ':8080';
      } else if (isVercel) {
        savedIp = 'gps-indoor.onrender.com';
      } else {
        savedIp = window.location.host;
      }
      localStorage.setItem('mazemap_wifi_scanner_ip', savedIp);
    }
    wifiScannerIpInput.value = savedIp;

    wifiScannerIpInput.addEventListener('change', () => {
      const value = wifiScannerIpInput.value.trim();
      localStorage.setItem('mazemap_wifi_scanner_ip', value);
      showToast('Scanner address updated. Reconnecting...');
      if (isWifiScannerEnabled) {
        connectToWifiWS();
      }
    });
  }

  // WiFi Scanner Subnet Dropdown Filter
  if (wifiNetworkFilter) {
    const savedFilter = localStorage.getItem('mazemap_wifi_subnet_filter');
    if (savedFilter) {
      activeSubnetFilter = savedFilter;
      wifiNetworkFilter.value = savedFilter;
    }
    wifiNetworkFilter.addEventListener('change', (e) => {
      activeSubnetFilter = e.target.value;
      localStorage.setItem('mazemap_wifi_subnet_filter', activeSubnetFilter);
      showToast(`Filtering to: ${e.target.options[e.target.selectedIndex].text}`);
      
      // (Respective filter is now automatic and immutable)
      
      // Clear current display to avoid showing old data from a different network
      if (heatmapLayer) heatmapLayer.setLatLngs([]);
      updateWifiDevicesUI([], 'loading', 'Waiting for data from selected network...');
      
      if (lastWifiScannerMessage) {
        processWifiScannerMessage(lastWifiScannerMessage);
      }
    });
  }

  // WiFi Scanner Respective Network Filter logic is now fully automatic

  // Auto-connect on page load if scanner is enabled
  if (checkboxWifiScanner && checkboxWifiScanner.checked) {
    setTimeout(() => {
      isWifiScannerEnabled = true;
      if (wifiScanHud) wifiScanHud.style.display = 'flex';
      initHeatmap();
      connectToWifiWS();
    }, 500);
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
    floor: activeFloor,
    latlngs: latlngs
  };
  savedWalls.push(wall);
  renderWall(wall);
  saveFeaturesToLocalStorage();
  request3DRefresh();
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
    floor: activeFloor,
    latlngs: latlngs
  };
  savedWindows.push(win);
  renderWindow(win);
  saveFeaturesToLocalStorage();
  request3DRefresh();
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
  request3DRefresh();

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
  request3DRefresh();
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



  // If a pending multi-floor route exists for this floor, draw it
  if (window.pendingDestinationPath && window.pendingDestinationPath.floor === floor) {
    drawNavigationPathOnMap(window.pendingDestinationPath.path);
    window.pendingDestinationPath = null;
    showToast(`Transit complete. Walkway to destination loaded.`);
  } else {
    showToast(`Switched to Floor ${activeFloor}`);
  }

  request3DRefresh();
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
  request3DRefresh();
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

// --- Leaflet Heatmap Layer Initialization ---
let heatmapLayer = null;
function initHeatmap() {
  if (heatmapLayer) return;
  if (typeof L === 'undefined' || typeof L.heatLayer !== 'function') {
    console.warn('[Heatmap] Leaflet.heat plugin is not loaded; WiFi heatmap disabled.');
    return;
  }
  heatmapLayer = L.heatLayer([], {
    radius: 35,
    blur: 20,
    max: 5,
    gradient: {
      0.1: '#3b82f6', // Cool Blue (Low traffic)
      0.3: '#06b6d4', // Cyan
      0.5: '#10b981', // Green (Normal traffic)
      0.7: '#f59e0b', // Orange (Medium density)
      1.0: '#ef4444'  // Red (High density)
    }
  }).addTo(map);
}

// --- WIFI SUBNET SCANNER CLIENT & REAL-TIME HEATMAP ---

function updateWifiWsStatus(status) {
  if (!wifiConnectionStatus) return;
  wifiConnectionStatus.className = 'ws-status-badge ' + status;
  
  if (status === 'disconnected') {
    wifiConnectionStatus.innerHTML = '<span class="status-dot"></span> Disconnected';
  } else if (status === 'connecting') {
    wifiConnectionStatus.innerHTML = '<span class="status-dot"></span> Connecting';
  } else if (status === 'connected') {
    wifiConnectionStatus.innerHTML = '<span class="status-dot"></span> Connected';
  }
}

function connectToWifiWS() {
  if (wifiWebSocket) {
    disconnectWifiWS();
  }
  
  updateWifiWsStatus('connecting');
  
  try {
    let serverAddr = wifiScannerIpInput ? wifiScannerIpInput.value.trim() : '';
    
    // Check if we are hosted on Vercel and the input is empty or points to Vercel
    const hostname = window.location.hostname;
    const isVercel = hostname.endsWith('.vercel.app') || hostname.includes('vercel');
    
    if (isVercel && (!serverAddr || serverAddr.includes('vercel.app'))) {
      showToast('Vercel does not support WebSockets. Please enter your Render Backend URL!');
      updateWifiWsStatus('disconnected');
      return;
    }
    
    if (!serverAddr) {
      serverAddr = window.location.host || '127.0.0.1:8080';
    }
    
    let wsUrl = serverAddr;
    const isHttps = window.location.protocol === 'https:';
    
    // Normalize http:// and https:// prefixes to WebSocket protocols
    if (wsUrl.startsWith('https://')) {
      wsUrl = wsUrl.replace('https://', 'wss://');
    } else if (wsUrl.startsWith('http://')) {
      wsUrl = wsUrl.replace('http://', 'ws://');
    }
    
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = (isHttps ? 'wss://' : 'ws://') + wsUrl;
    } else if (isHttps && wsUrl.startsWith('ws://')) {
      wsUrl = wsUrl.replace('ws://', 'wss://');
    }
    
    console.log('[WS] Connecting to:', wsUrl);
    wifiWebSocket = new WebSocket(wsUrl);
    
    wifiWebSocket.onopen = () => {
      showToast('Connected to WiFi Network Scanner!');
      updateWifiWsStatus('connected');
    };
    
    wifiWebSocket.onmessage = (event) => {
      if (!isWifiScannerEnabled) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'agent-list') {
          activeAgents = message.agents || [];
          console.log('[WS] Received agent list:', activeAgents);
          updateSubnetFilterDropdown();
          verifyLocalAgentsConnectivity();
          if (lastWifiScannerMessage) {
            processWifiScannerMessage(lastWifiScannerMessage);
          }
          return;
        }
        if (message.type === 'client-info') {
          console.log('[WS] Received client info:', message);
          window.clientIpAddress = message.ip;
          if (message.subnetPrefix && isPrivateIp(message.ip)) {
            detectedClientSubnetPrefix = message.subnetPrefix;
            showToast(`Connected via local network: ${message.interfaceName || message.subnetPrefix + 'x'}`);
          }
          // Automatically re-evaluate matching agent and update dropdown
          updateSubnetFilterDropdown();
          if (lastWifiScannerMessage) {
            processWifiScannerMessage(lastWifiScannerMessage);
          }
          return;
        }
        processWifiScannerMessage(message);
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };
    
    wifiWebSocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      if (wsUrl.includes('vercel.app')) {
        showToast('WebSocket error: Vercel does not support WebSockets. Set Server Address to Render URL.');
      } else {
        showToast('WiFi scanner server connection error.');
      }
      updateWifiWsStatus('disconnected');
    };
    
    wifiWebSocket.onclose = () => {
      showToast('Disconnected from WiFi scanner server.');
      updateWifiWsStatus('disconnected');
      wifiWebSocket = null;
    };
  } catch (err) {
    console.error('WebSocket initialization error:', err);
    updateWifiWsStatus('disconnected');
  }
}

function isPrivateIp(ip) {
  if (!ip) return false;
  return ip.startsWith('192.168.') || 
         ip.startsWith('10.') || 
         ip.startsWith('127.') || 
         ip.startsWith('::1') ||
         (ip.startsWith('172.') && (parseInt(ip.split('.')[1], 10) >= 16 && parseInt(ip.split('.')[1], 10) <= 31));
}

// Global variables for verified local agent connection
let verifiedLocalAgentIp = null;
let verifiedLocalSubnetPrefix = null;

function verifyLocalAgentsConnectivity() {
  activeAgents.forEach(agent => {
    (agent.networks || []).forEach(net => {
      // Skip loopback and demo subnets
      if (net.ip === '127.0.0.1' || net.subnetPrefix === '192.168.1.') return;
      
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 1200);
      
      fetch(`http://${net.ip}:8080/health`, { signal: controller.signal })
        .then(res => res.json())
        .then(data => {
          clearTimeout(id);
          if (data && data.status === 'ok') {
            console.log(`[Connectivity] Connected locally to agent at ${net.ip}`);
            verifiedLocalAgentIp = agent.agentIp;
            verifiedLocalSubnetPrefix = net.subnetPrefix;
            
            // Re-process message with the verified local network
            if (lastWifiScannerMessage) {
              processWifiScannerMessage(lastWifiScannerMessage);
            }
          }
        })
        .catch(err => {
          clearTimeout(id);
        });
    });
  });
}

function getMatchingAgentIpForClient() {
  if (!window.clientIpAddress) return null;
  let matchingAgentIp = null;

  if (isPrivateIp(window.clientIpAddress) && detectedClientSubnetPrefix) {
    const a = activeAgents.find(ag => (ag.networks || []).some(n => n.subnetPrefix === detectedClientSubnetPrefix));
    if (a) matchingAgentIp = a.agentIp;
  }
  
  if (!matchingAgentIp) {
    if (verifiedLocalSubnetPrefix && verifiedLocalAgentIp) {
      matchingAgentIp = verifiedLocalAgentIp;
    }
    if (!matchingAgentIp) {
      const a = activeAgents.find(ag => ag.agentIp === window.clientIpAddress);
      if (a) matchingAgentIp = a.agentIp;
    }
  }
  
  return matchingAgentIp;
}

function getActiveNetworkEntries() {
  const entries = [];
  const matchingAgentIp = getMatchingAgentIpForClient();

  // Return empty if client does not match any agent network
  if (!matchingAgentIp) return entries;

  activeAgents.forEach(agent => {
    // Only show networks for the matching agent
    if (agent.agentIp !== matchingAgentIp) return;

    (agent.networks || []).forEach(net => {
      const uniqueValue = `${agent.agentIp}|${net.subnetPrefix}`;
      let displayName = net.interfaceName || '';

      // Map raw OS interface names to user-friendly terms (WiFi/Ethernet/Hotspot)
      const lower = displayName.toLowerCase();
      if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wireless') || lower.includes('wlan')) {
        displayName = 'WiFi Network';
      } else if (lower.includes('ethernet')) {
        displayName = 'WiFi / Ethernet Network';
      } else if (lower.includes('tether') || lower.includes('ndis') || lower.includes('hotspot')) {
        displayName = 'USB Tether / Hotspot';
      } else if (lower.includes('loopback') || lower.includes('localhost')) {
        displayName = 'Local Loopback';
      } else if (!displayName) {
        displayName = 'WiFi / Local Network';
      }

      displayName = `${displayName} (${net.subnetPrefix}x)`;

      entries.push({
        value: uniqueValue,
        subnetPrefix: net.subnetPrefix,
        label: displayName
      });
    });
  });

  return entries;
}

function findNetworkOptionValueBySubnet(subnetPrefix) {
  const match = getActiveNetworkEntries().find(entry => entry.subnetPrefix === subnetPrefix);
  return match ? match.value : '';
}

function processWifiScannerMessage(message) {
  if (message.type !== 'wifi-heatmap') return;
  
  lastWifiScannerMessage = message;

  // Check if the scanner agent (PC) is on the same network as this client
  const agentNetworks = message.agentNetworks || [];
  const agentSubnetPrefixes = agentNetworks.map(n => n.subnetPrefix);

  // Extract and update unique subnets from scan data
  updateSubnetFilterDropdown();

  // ── Respective Network Filter Logic ──────────────────────────────────
  let filterToUse = activeSubnetFilter;
  let targetAgentIp = 'none';
  let targetSubnetPrefix = 'none';

  if (filterToUse && filterToUse.includes('|')) {
    [targetAgentIp, targetSubnetPrefix] = filterToUse.split('|');
  } else {
    targetSubnetPrefix = filterToUse;
  }

  // If no matching agent network is selected, block demo/live messages
  if ((targetAgentIp === 'none' || targetSubnetPrefix === 'none' || targetSubnetPrefix === '') && message.mode !== 'demo') {
    if (heatmapLayer) heatmapLayer.setLatLngs([]);
    const ipMsg = window.clientIpAddress ? ` (Your IP: ${window.clientIpAddress})` : '';
    let agentMsg = '';
    if (activeAgents.length > 0) {
      const agentIps = activeAgents.map(a => a.agentIp).join(', ');
      agentMsg = `<br/><span style="color: var(--text-muted); font-size: 0.6rem;">Connected agents found on other IPs: ${agentIps}</span>`;
    } else {
      agentMsg = `<br/><span style="color: var(--text-muted); font-size: 0.6rem;">(0 scanner agents connected to the server)</span>`;
    }
    updateWifiDevicesUI([], 'different-network',
      `No scanner agent detected on your network${ipMsg}. Please open the scanner on a PC connected to this network.${agentMsg}`);
    return;
  }

  // ── Filter Incoming Message ──────────────────────────────────────────
  if (message.mode !== 'demo') {
    // 1. If we target a specific agent, ignore messages from other agents
    if (targetAgentIp !== 'none' && message.agentIp !== targetAgentIp) {
      return; // Ignore data from other scanner PCs
    }

    // 2. If the message doesn't contain the subnet we want, ignore it
    const hasSubnet = agentSubnetPrefixes.includes(targetSubnetPrefix);
    if (!hasSubnet) {
      return; // Ignore messages that don't contain our target subnet
    }
  }

  // Filter devices and heatmap points
  let filteredDevices = message.devices || [];
  let filteredPoints = message.points || [];
  
  if (message.mode !== 'demo' && targetSubnetPrefix !== 'none') {
    filteredDevices = filteredDevices.filter(d => d.subnetPrefix === targetSubnetPrefix);
    
    // Match points 1-to-1 with devices
    const tempPoints = [];
    (message.devices || []).forEach((d, idx) => {
      if (d.subnetPrefix === targetSubnetPrefix) {
        tempPoints.push(message.points[idx]);
      }
    });
    filteredPoints = tempPoints;
  }
  
  // Determine local center (where active floor plan boundary or rooms are)
  const activeBoundary = savedBoundaries.find(b => b.floor === activeFloor);
  let centerLat = currentGpsCoords.lat;
  let centerLng = currentGpsCoords.lng;

  if (activeBoundary && activeBoundary.latlngs && activeBoundary.latlngs.length > 0) {
    let sumLat = 0, sumLng = 0;
    activeBoundary.latlngs.forEach(pt => {
      sumLat += pt[0];
      sumLng += pt[1];
    });
    centerLat = sumLat / activeBoundary.latlngs.length;
    centerLng = sumLng / activeBoundary.latlngs.length;
  } else {
    const roomsOnFloor = savedRooms.filter(r => r.floor === activeFloor);
    if (roomsOnFloor.length > 0) {
      let sumLat = 0, sumLng = 0, count = 0;
      roomsOnFloor.forEach(r => {
        r.latlngs.forEach(pt => {
          sumLat += pt[0];
          sumLng += pt[1];
          count++;
        });
      });
      if (count > 0) {
        centerLat = sumLat / count;
        centerLng = sumLng / count;
      }
    }
  }

  // Shifting offset from Googleplex (37.4220, -122.0841) to local active layout center
  const refLat = 37.4220;
  const refLng = -122.0841;

  // We map the filtered arrays to new objects/values so we don't mutate the cached lastWifiScannerMessage!
  const renderedDevices = filteredDevices.map(device => {
    const dLat = device.lat - refLat;
    const dLng = device.lng - refLng;
    return {
      ...device,
      lat: centerLat + dLat,
      lng: centerLng + dLng
    };
  });

  const renderedPoints = filteredPoints.map(pt => {
    const dLat = pt[0] - refLat;
    const dLng = pt[1] - refLng;
    return [centerLat + dLat, centerLng + dLng, pt[2]];
  });

  // Render heatmap coordinates
  if (heatmapLayer) {
    heatmapLayer.setLatLngs(renderedPoints);
  }
  
  // Update Devices directory UI
  updateWifiDevicesUI(renderedDevices);
}

function updateSubnetFilterDropdown() {
  if (!wifiNetworkFilter) return;
  
  const currentValue = wifiNetworkFilter.value;
  wifiNetworkFilter.innerHTML = ''; // Clear all options

  const entries = getActiveNetworkEntries();
  if (entries.length === 0) {
    const option = document.createElement('option');
    option.value = 'none';
    option.textContent = 'No Network Detected';
    wifiNetworkFilter.appendChild(option);
  } else {
    entries.forEach(entry => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      wifiNetworkFilter.appendChild(option);
    });
  }
  
  const options = Array.from(wifiNetworkFilter.options).map(o => o.value);
  if (options.includes(currentValue)) {
    wifiNetworkFilter.value = currentValue;
    activeSubnetFilter = currentValue;
  } else if (options.length > 0) {
    wifiNetworkFilter.value = options[0];
    activeSubnetFilter = options[0];
  } else {
    activeSubnetFilter = 'none';
  }

  // Update device count or status label if needed
  if (wifiDeviceCount && activeAgents.length > 0) {
    // We can show "X Networks Active" when scanning
  }
}

function disconnectWifiWS() {
  if (wifiWebSocket) {
    wifiWebSocket.close();
    wifiWebSocket = null;
  }
  updateWifiWsStatus('disconnected');
  
  lastWifiScannerMessage = null;
  activeAgents = [];
  activeSubnetFilter = 'all';
  detectedClientSubnetPrefix = null;
  if (wifiNetworkFilter) {
    wifiNetworkFilter.innerHTML = '<option value="all">All Networks</option>';
  }
  
  if (wifiDevicesList) {
    wifiDevicesList.innerHTML = '<div style="font-size: 0.65rem; color: var(--text-muted); text-align: center; padding: 10px;">Waiting for scanner connection...</div>';
  }
  if (wifiDeviceCount) {
    wifiDeviceCount.textContent = '0 Devices';
  }
}

function updateWifiDevicesUI(devices, type, customMessage) {
  if (!wifiDevicesList) return;
  wifiDevicesList.innerHTML = '';
  
  if (wifiDeviceCount) {
    const netCount = getActiveNetworkEntries().length;
    wifiDeviceCount.textContent = `${devices.length} Devices • ${netCount} Active Network${netCount !== 1 ? 's' : ''}`;
  }
  
  if (devices.length === 0) {
    const isDifferentNetwork = type === 'different-network';
    const msg = customMessage || 'Scanning network subnet... No active devices found.';
    const color = isDifferentNetwork ? '#f59e0b' : 'var(--text-muted)';
    const icon = isDifferentNetwork ? '⚠️ ' : '';
    wifiDevicesList.innerHTML = `<div style="font-size: 0.65rem; color: ${color}; text-align: center; padding: 10px; line-height: 1.5;">${icon}${msg}</div>`;
    return;
  }
  
  devices.forEach(device => {
    const card = document.createElement('div');
    card.className = 'wifi-device-card';
    
    const avgRssi = Math.round(device.rssi.reduce((a, b) => a + b, 0) / device.rssi.length);
    
    card.innerHTML = `
      <div class="wifi-device-meta">
        <span class="wifi-device-ip"><i class="fa-solid fa-laptop"></i> ${device.ip}</span>
        <span class="wifi-device-mac">${device.mac}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.6rem; margin-top: 2px;">
        <span style="color: var(--text-muted);">Triangulated Est: ${device.lat.toFixed(6)}, ${device.lng.toFixed(6)}</span>
        <span class="wifi-signal-pill">${avgRssi} dBm</span>
      </div>
    `;
    wifiDevicesList.appendChild(card);
  });
}

function request3DRefresh() {
  if (viewer3DOverlay && viewer3DOverlay.classList.contains('show')) {
    if (googleMap3DMode === 'google' && googleMap3D) {
      renderGoogle3DOverlays();
    } else {
      render3DScene();
    }
  }
}

function open3DView() {
  if (!viewer3DOverlay || !viewer3DStage) {
    showToast('3D viewer could not be loaded.');
    return;
  }

  viewer3DOverlay.classList.add('show');

  const savedKey = (localStorage.getItem('mazemap_google_maps_api_key') || '').trim();
  if (googleMapsApiKeyInput && !googleMapsApiKeyInput.value && savedKey) {
    googleMapsApiKeyInput.value = savedKey;
  }

  if (savedKey) {
    loadGoogle3DMap(savedKey).catch(err => {
      console.error('Google 3D load error:', err);
      googleMap3DMode = 'three';
      ensure3DViewer();
      render3DScene();
      handle3DResize();
      start3DAnimation();
      showToast('Google 3D failed to load, using local 3D fallback.');
    });
  } else {
    googleMap3DMode = 'three';
    ensure3DViewer();
    render3DScene();
    handle3DResize();
    start3DAnimation();
  }
}

function close3DView() {
  if (viewer3DOverlay) {
    viewer3DOverlay.classList.remove('show');
  }
  stop3DAnimation();
}

function applyGoogleMapsKey() {
  if (!googleMapsApiKeyInput) return;
  const key = googleMapsApiKeyInput.value.trim();
  if (!key) {
    showToast('Please paste your Google Maps Demo Key first.');
    return;
  }
  localStorage.setItem('mazemap_google_maps_api_key', key);
  showToast('Loading real Google Maps 3D...');
  loadGoogle3DMap(key).catch(err => {
    console.error('Google 3D load error:', err);
    showToast('Invalid key or network error. Using local 3D fallback.');
    googleMap3DMode = 'three';
    ensure3DViewer();
    render3DScene();
    handle3DResize();
    start3DAnimation();
  });
}

function loadGoogle3DMap(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      initGoogle3DMap(apiKey);
      return resolve();
    }

    const existingScript = document.getElementById('google-maps-js-api');
    if (existingScript) {
      existingScript.remove();
    }

    const script = document.createElement('script');
    script.id = 'google-maps-js-api';
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&libraries=maps`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      try {
        initGoogle3DMap(apiKey);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    script.onerror = () => reject(new Error('Failed to load Google Maps JS API'));
    document.head.appendChild(script);
  });
}

function initGoogle3DMap(apiKey) {
  if (!window.google || !window.google.maps) return;

  googleMap3DMode = 'google';
  stop3DAnimation();
  clearThree3DViewer();
  if (viewer3DStage) viewer3DStage.innerHTML = '';

  const center = { lat: currentGpsCoords.lat, lng: currentGpsCoords.lng };
  const map = new google.maps.Map(viewer3DStage, {
    center,
    zoom: 19,
    tilt: 67.5,
    heading: 0,
    mapId: 'DEMO_MAP_ID',
    disableDefaultUI: true,
    clickableIcons: false
  });

  googleMap3D = map;
  renderGoogle3DOverlays();

  if (viewer3DSubtitle) viewer3DSubtitle.textContent = 'Real Google Maps 3D view with your mapped overlays.';
  showToast('Google Maps 3D loaded.');
}

function clearThree3DViewer() {
  stop3DAnimation();
  if (threeSceneRoot) {
    clear3DSceneRoot();
  }
  threeRenderer = null;
  threeScene = null;
  threeCamera = null;
  threeControls = null;
  threeSceneRoot = null;
}

function ensure3DViewer() {
  if (threeRenderer || !window.THREE || !viewer3DStage) return;

  threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color(0x020617);

  threeCamera = new THREE.PerspectiveCamera(52, 1, 0.1, 3000);
  threeCamera.position.set(140, 140, 140);

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewer3DStage.innerHTML = '';
  viewer3DStage.appendChild(threeRenderer.domElement);

  threeControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
  threeControls.enableDamping = true;
  threeControls.dampingFactor = 0.08;
  threeControls.target.set(0, 16, 0);
  threeControls.maxPolarAngle = Math.PI / 2.05;
  threeControls.minDistance = 20;
  threeControls.maxDistance = 600;

  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  threeScene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.95);
  keyLight.position.set(120, 180, 80);
  threeScene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x60a5fa, 0.35);
  fillLight.position.set(-100, 120, -80);
  threeScene.add(fillLight);

  threeSceneRoot = new THREE.Group();
  threeScene.add(threeSceneRoot);
}

function start3DAnimation() {
  if (threeAnimationFrame) return;

  const loop = () => {
    if (!threeRenderer || !threeScene || !threeCamera) return;
    if (threeControls) threeControls.update();
    threeRenderer.render(threeScene, threeCamera);
    threeAnimationFrame = requestAnimationFrame(loop);
  };

  threeAnimationFrame = requestAnimationFrame(loop);
}

function stop3DAnimation() {
  if (threeAnimationFrame) {
    cancelAnimationFrame(threeAnimationFrame);
    threeAnimationFrame = null;
  }
}

function handle3DResize() {
  if (!threeRenderer || !threeCamera || !viewer3DStage || !viewer3DOverlay || !viewer3DOverlay.classList.contains('show')) return;

  const width = Math.max(viewer3DStage.clientWidth, 1);
  const height = Math.max(viewer3DStage.clientHeight, 1);
  threeCamera.aspect = width / height;
  threeCamera.updateProjectionMatrix();
  threeRenderer.setSize(width, height, false);
}

function clear3DSceneRoot() {
  if (!threeSceneRoot) return;

  while (threeSceneRoot.children.length > 0) {
    const child = threeSceneRoot.children.pop();
    disposeThreeObject(child);
  }
}

function disposeThreeObject(object) {
  if (!object) return;

  if (object.parent) {
    object.parent.remove(object);
  }

  if (object.children && object.children.length > 0) {
    [...object.children].forEach(disposeThreeObject);
  }

  if (object.geometry) {
    object.geometry.dispose();
  }

  if (object.material) {
    if (Array.isArray(object.material)) {
      object.material.forEach(mat => mat.dispose());
    } else {
      object.material.dispose();
    }
  }
}

function render3DScene() {
  ensure3DViewer();
  if (!threeSceneRoot || !viewer3DSubtitle || !viewer3DFloorPill) return;

  clear3DSceneRoot();

  const rooms = savedRooms.filter(r => r.floor === activeFloor);
  const walls = savedWalls.filter(w => w.floor === activeFloor);
  const windowsOnFloor = savedWindows.filter(w => w.floor === activeFloor);
  const doors = savedDoors.filter(d => d.floor === activeFloor);
  const boundary = savedBoundaries.find(b => b.floor === activeFloor) || null;

  viewer3DFloorPill.textContent = `Floor ${activeFloor}`;
  viewer3DSubtitle.textContent = `${rooms.length} rooms, ${walls.length} walls, ${doors.length} doors on the active floor.`;

  const metrics = create3DLayoutMetrics(boundary, rooms, walls, windowsOnFloor, doors);
  const gridSize = Math.max(80, Math.ceil(metrics.span / 10) * 10);

  const grid = new THREE.GridHelper(gridSize, 12, 0x334155, 0x1e293b);
  grid.position.y = 0;
  threeSceneRoot.add(grid);

  const basePlane = new THREE.Mesh(
    new THREE.CircleGeometry(Math.max(metrics.span * 0.58, 45), 64),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, transparent: true, opacity: 0.82 })
  );
  basePlane.rotation.x = -Math.PI / 2;
  basePlane.position.y = -0.05;
  threeSceneRoot.add(basePlane);

  if (boundary && boundary.latlngs.length >= 3) {
    addBoundaryMesh3D(boundary, metrics);
  }

  rooms.forEach(room => addRoomMesh3D(room, metrics));
  walls.forEach(wall => addPolylineBoxes3D(wall.latlngs, metrics, { color: 0x475569, height: 16, thickness: 2.2, y: 8 }));
  windowsOnFloor.forEach(win => addPolylineBoxes3D(win.latlngs, metrics, { color: 0x67e8f9, height: 8, thickness: 1.2, y: 10 }));
  doors.forEach(door => addDoorMesh3D(door, metrics));
  addUserMarker3D(metrics);

  const camDistance = Math.max(85, metrics.span * 0.72);
  threeCamera.position.set(camDistance, camDistance * 0.82, camDistance);
  threeControls.target.set(0, 16, 0);
  threeControls.update();
}

function create3DLayoutMetrics(boundary, rooms, walls, windowsOnFloor, doors) {
  const points = [];

  if (boundary && boundary.latlngs) points.push(...boundary.latlngs);
  rooms.forEach(room => points.push(...room.latlngs));
  walls.forEach(wall => points.push(...wall.latlngs));
  windowsOnFloor.forEach(win => points.push(...win.latlngs));
  doors.forEach(door => points.push(door.latlng));

  if (points.length === 0) {
    points.push([currentGpsCoords.lat, currentGpsCoords.lng]);
    points.push([currentGpsCoords.lat + 0.00015, currentGpsCoords.lng + 0.00015]);
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  points.forEach(pt => {
    minLat = Math.min(minLat, pt[0]);
    maxLat = Math.max(maxLat, pt[0]);
    minLng = Math.min(minLng, pt[1]);
    maxLng = Math.max(maxLng, pt[1]);
  });

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const latSpan = Math.max(maxLat - minLat, 0.00008);
  const lngSpan = Math.max(maxLng - minLng, 0.00008);
  const degreeSpan = Math.max(latSpan, lngSpan);
  const scale = 220 / degreeSpan;

  return {
    centerLat,
    centerLng,
    scale,
    span: Math.max(latSpan * scale, lngSpan * scale, 70)
  };
}

function projectLatLngTo3D(latlng, metrics) {
  return {
    x: (latlng[1] - metrics.centerLng) * metrics.scale,
    z: (metrics.centerLat - latlng[0]) * metrics.scale
  };
}

function createShapeFromLatLngs(latlngs, metrics) {
  const projected = latlngs.map(pt => projectLatLngTo3D(pt, metrics));
  if (projected.length < 3) return null;

  const shape = new THREE.Shape();
  shape.moveTo(projected[0].x, projected[0].z);
  for (let i = 1; i < projected.length; i++) {
    shape.lineTo(projected[i].x, projected[i].z);
  }
  shape.lineTo(projected[0].x, projected[0].z);
  return { shape, projected };
}

function addBoundaryMesh3D(boundary, metrics) {
  const data = createShapeFromLatLngs(boundary.latlngs, metrics);
  if (!data) return;

  const floorGeometry = new THREE.ShapeGeometry(data.shape);
  floorGeometry.rotateX(-Math.PI / 2);

  const floorMesh = new THREE.Mesh(
    floorGeometry,
    new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.11,
      side: THREE.DoubleSide
    })
  );
  floorMesh.position.y = 0.03;
  threeSceneRoot.add(floorMesh);

  const outlinePoints = data.projected.map(pt => new THREE.Vector3(pt.x, 0.18, pt.z));
  outlinePoints.push(new THREE.Vector3(data.projected[0].x, 0.18, data.projected[0].z));
  const outlineGeometry = new THREE.BufferGeometry().setFromPoints(outlinePoints);
  const outline = new THREE.Line(
    outlineGeometry,
    new THREE.LineBasicMaterial({ color: 0xf59e0b })
  );
  threeSceneRoot.add(outline);
}

function addRoomMesh3D(room, metrics) {
  const data = createShapeFromLatLngs(room.latlngs, metrics);
  if (!data) return;

  const height = getRoomHeight(room.category);
  const roomColor = getRoomColor(room.category);
  const geometry = new THREE.ExtrudeGeometry(data.shape, {
    depth: height,
    bevelEnabled: false
  });
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: roomColor,
    transparent: true,
    opacity: room.id === activeRoomId ? 0.92 : 0.82,
    roughness: 0.58,
    metalness: 0.08
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.1;
  threeSceneRoot.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: room.id === activeRoomId ? 0xffffff : 0x93c5fd })
  );
  edges.position.copy(mesh.position);
  threeSceneRoot.add(edges);
}

function addPolylineBoxes3D(latlngs, metrics, config) {
  if (!latlngs || latlngs.length < 2) return;

  for (let i = 0; i < latlngs.length - 1; i++) {
    const start = projectLatLngTo3D(latlngs[i], metrics);
    const end = projectLatLngTo3D(latlngs[i + 1], metrics);
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length === 0) continue;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(length, config.height, config.thickness),
      new THREE.MeshStandardMaterial({
        color: config.color,
        transparent: true,
        opacity: 0.95
      })
    );

    mesh.position.set((start.x + end.x) / 2, config.y, (start.z + end.z) / 2);
    mesh.rotation.y = Math.atan2(dz, dx);
    threeSceneRoot.add(mesh);
  }
}

function addDoorMesh3D(door, metrics) {
  const pos = projectLatLngTo3D(door.latlng, metrics);
  const doorMesh = new THREE.Mesh(
    new THREE.BoxGeometry(6, 8, 2),
    new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.35, metalness: 0.12 })
  );
  doorMesh.position.set(pos.x, 4, pos.z);
  threeSceneRoot.add(doorMesh);
}

function addUserMarker3D(metrics) {
  const pos = projectLatLngTo3D([currentGpsCoords.lat, currentGpsCoords.lng], metrics);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0x3b82f6, emissive: 0x1d4ed8, emissiveIntensity: 0.35 })
  );
  marker.position.set(pos.x, 6, pos.z);
  threeSceneRoot.add(marker);
}

function getRoomHeight(category) {
  const heights = {
    hallway: 10,
    stairs: 14,
    restroom: 11,
    conference: 13,
    lab: 14,
    classroom: 13,
    office: 12,
    other: 12
  };

  return heights[category] || 12;
}

function getRoomColor(category) {
  const colors = {
    office: 0x3b82f6,
    lab: 0x8b5cf6,
    conference: 0xf59e0b,
    classroom: 0x14b8a6,
    restroom: 0xef4444,
    hallway: 0x64748b,
    stairs: 0x10b981,
    other: 0x6366f1
  };

  return colors[category] || 0x6366f1;
}

// ─── Google Maps 3D Overlay Rendering ─────────────────────────────────
function renderGoogle3DOverlays() {
  if (!googleMap3D || !window.google || !window.google.maps) return;
  clearGoogle3DOverlays();

  const rooms = savedRooms.filter(r => r.floor === activeFloor);
  const walls = savedWalls.filter(w => w.floor === activeFloor);
  const windowsOnFloor = savedWindows.filter(w => w.floor === activeFloor);
  const doors = savedDoors.filter(d => d.floor === activeFloor);
  const boundary = savedBoundaries.find(b => b.floor === activeFloor) || null;

  if (viewer3DFloorPill) viewer3DFloorPill.textContent = `Floor ${activeFloor}`;
  if (viewer3DSubtitle) viewer3DSubtitle.textContent = `${rooms.length} rooms, ${walls.length} walls, ${doors.length} doors on the active floor (Google 3D).`;

  const bounds = new google.maps.LatLngBounds();

  if (boundary && boundary.latlngs.length >= 3) {
    boundary.latlngs.forEach(p => bounds.extend({ lat: p[0], lng: p[1] }));
    const poly = new google.maps.Polygon({
      paths: boundary.latlngs.map(p => ({ lat: p[0], lng: p[1] })),
      strokeColor: '#f59e0b',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      fillColor: '#f59e0b',
      fillOpacity: 0.08,
      map: googleMap3D
    });
    google3DOverlays.push({ kind: 'polygon', handle: poly });
  }

  rooms.forEach(room => {
    const path = room.latlngs.map(p => ({ lat: p[0], lng: p[1] }));
    path.forEach(p => bounds.extend(p));

    const poly = new google.maps.Polygon({
      paths: path,
      strokeColor: room.id === activeRoomId ? '#ffffff' : '#93c5fd',
      strokeOpacity: 0.95,
      strokeWeight: room.id === activeRoomId ? 4 : 2,
      fillColor: colorToHexString(getRoomColor(room.category)),
      fillOpacity: 0.45,
      map: googleMap3D
    });
    google3DOverlays.push({ kind: 'polygon', handle: poly });

    const label = new google.maps.Marker({
      position: polygonCentroid(path),
      map: googleMap3D,
      label: {
        text: room.name || 'Room',
        color: '#0f172a',
        fontSize: '11px',
        fontWeight: '600'
      },
      icon: {
        path: 'M 0,0 L 0,0',
        fillOpacity: 0,
        strokeOpacity: 0
      }
    });
    google3DOverlays.push({ kind: 'marker', handle: label });
  });

  walls.forEach(w => drawPolyline3D(w.latlngs, '#475569', 4, bounds));
  windowsOnFloor.forEach(w => drawPolyline3D(w.latlngs, '#67e8f9', 3, bounds));
  doors.forEach(door => {
    if (!door.latlng) return;
    const p = { lat: door.latlng[0], lng: door.latlng[1] };
    bounds.extend(p);
    const marker = new google.maps.Marker({
      position: p,
      map: googleMap3D,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 5,
        fillColor: '#10b981',
        fillOpacity: 0.95,
        strokeColor: '#ffffff',
        strokeWeight: 1.5
      }
    });
    google3DOverlays.push({ kind: 'marker', handle: marker });
  });

  const userMarker = new google.maps.Marker({
    position: { lat: currentGpsCoords.lat, lng: currentGpsCoords.lng },
    map: googleMap3D,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: '#3b82f6',
      fillOpacity: 0.9,
      strokeColor: '#ffffff',
      strokeWeight: 2
    }
  });
  google3DOverlays.push({ kind: 'marker', handle: userMarker });
  bounds.extend({ lat: currentGpsCoords.lat, lng: currentGpsCoords.lng });

  if (!bounds.isEmpty()) {
    googleMap3D.fitBounds(bounds, 60);
  }
}

function drawPolyline3D(latlngs, color, weight, bounds) {
  if (!latlngs || latlngs.length < 2) return;
  const path = latlngs.map(p => ({ lat: p[0], lng: p[1] }));
  path.forEach(p => bounds && bounds.extend(p));
  const line = new google.maps.Polyline({
    path,
    geodesic: true,
    strokeColor: color,
    strokeOpacity: 0.95,
    strokeWeight: weight,
    map: googleMap3D
  });
  google3DOverlays.push({ kind: 'polyline', handle: line });
}

function clearGoogle3DOverlays() {
  google3DOverlays.forEach(entry => {
    if (entry.handle && entry.handle.setMap) {
      entry.handle.setMap(null);
    }
  });
  google3DOverlays = [];
}

function colorToHexString(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

function polygonCentroid(path) {
  if (!path || path.length === 0) return { lat: 0, lng: 0 };
  let lat = 0, lng = 0;
  path.forEach(p => { lat += p.lat; lng += p.lng; });
  return { lat: lat / path.length, lng: lng / path.length };
}



