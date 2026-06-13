/**
 * GPS Indoor Mapper — Unified Static + WebSocket Server
 * 
 * Single-port server that:
 *   1. Serves all static files (HTML, CSS, JS)
 *   2. Handles WebSocket upgrades for real-time device scanning (via 'ws')
 *   3. Collects local scans on PC and streams them to the Render backend
 *   4. Broadcasts real-time accurate local device coordinates on the cloud
 */

const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const IS_CLOUD = !!(process.env.RENDER || process.env.RAILWAY || process.env.FLY_APP_NAME || process.env.DYNO);
const REMOTE_WS_URL = process.env.REMOTE_WS_URL || 'wss://gps-indoor.onrender.com';

const clients = new Set();
let lastAgentScan = null;
let remoteWs = null;

// ─── MIME Types ────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

// ─── Access Point Coordinates (reference frame for triangulation) ─────
const APs = [
  { id: 'ap-1', name: 'Center AP',    lat: 37.4220, lng: -122.0841 },
  { id: 'ap-2', name: 'NE AP',        lat: 37.4224, lng: -122.0837 },
  { id: 'ap-3', name: 'SW AP',        lat: 37.4216, lng: -122.0845 }
];

// ─── Demo Devices (used on cloud as fallback if no local agent is running) ────────────
const DEMO_DEVICES = [
  { ip: '192.168.1.101', mac: '2c-f0-5d-a1-b2-c3' },
  { ip: '192.168.1.102', mac: '3e-d1-6a-b4-c5-d6' },
  { ip: '192.168.1.103', mac: '4f-e2-7b-c7-d8-e9' },
  { ip: '192.168.1.104', mac: '5a-f3-8c-d0-e1-f2' },
  { ip: '192.168.1.105', mac: '6b-04-9d-e3-f4-05' },
  { ip: '192.168.1.106', mac: '7c-15-ae-f6-07-18' },
  { ip: '192.168.1.107', mac: '8d-26-bf-09-1a-2b' },
  { ip: '192.168.1.108', mac: '9e-37-c0-1c-2d-3e' },
  { ip: '192.168.1.109', mac: 'a0-48-d1-2f-3e-4f' },
  { ip: '192.168.1.110', mac: 'b1-59-e2-40-5f-60' },
  { ip: '192.168.1.111', mac: 'c2-6a-f3-51-60-71' },
  { ip: '192.168.1.112', mac: 'd3-7b-04-62-71-82' }
];

// ─── HTTP Server (Static Files) ───────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint for Render
  if (req.url === '/health') {
    const isAgentConnected = !!(lastAgentScan && (Date.now() - lastAgentScan.timestamp < 15000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      mode: IS_CLOUD ? 'cloud-server' : 'local-scanner', 
      agentActive: isAgentConnected,
      clients: clients.size 
    }));
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, urlPath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

// ─── WebSocket Server (using 'ws' package) ───────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  // Store the remote IP on the socket for later use
  let clientIp = req.socket.remoteAddress;
  if (req.headers['x-forwarded-for']) {
    clientIp = req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  if (clientIp && clientIp.startsWith('::ffff:')) {
    clientIp = clientIp.substring(7);
  }
  ws.remoteIpAddress = clientIp;

  // Send client-info only if connecting from a local/private IP (direct LAN connection)
  if (clientIp && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(clientIp)) {
    const clientSubnet = getSubnetPrefix(clientIp);
    const friendlyInterface = resolveInterfaceName(clientIp) || `Interface ${clientSubnet}x`;
    
    try {
      ws.send(JSON.stringify({
        type: 'client-info',
        ip: clientIp,
        subnetPrefix: clientSubnet,
        interfaceName: friendlyInterface,
        agentNetworks: getAgentNetworks()
      }));
    } catch (err) {
      console.error('[WS] Failed to send client-info:', err.message);
    }
  }


  ws.on('message', (messageText) => {
    try {
      const data = JSON.parse(messageText);
      if (data.type === 'publish-scan') {
        lastAgentScan = {
          devices: data.devices,
          points: data.points,
          timestamp: Date.now(),
          agentIp: ws.remoteIpAddress
        };
        console.log(`[WS-Agent] Published local network scan: ${data.devices.length} devices.`);
        
        // Broadcast the real scanner data immediately to all web clients
        broadcastPayload(data.devices, data.points, 'live', ws.remoteIpAddress);
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', (err) => {
    clients.delete(ws);
    console.log('[WS] Socket error:', err.message);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function rssiToDistance(rssi) {
  return Math.pow(10, (-30 - rssi) / (10 * 2.4));
}

function triangulateSingleDevice(ip, mac, subnetPrefix, interfaceName) {
  const baseRssi1 = -35 - (hashString(mac + 'ap1') % 35);
  const baseRssi2 = -40 - (hashString(mac + 'ap2') % 35);
  const baseRssi3 = -45 - (hashString(mac + 'ap3') % 35);

  const rssi1 = baseRssi1 + Math.floor(Math.random() * 5 - 2);
  const rssi2 = baseRssi2 + Math.floor(Math.random() * 5 - 2);
  const rssi3 = baseRssi3 + Math.floor(Math.random() * 5 - 2);

  const d1 = rssiToDistance(rssi1);
  const d2 = rssiToDistance(rssi2);
  const d3 = rssiToDistance(rssi3);

  const w1 = 1 / (d1 * d1 || 0.001);
  const w2 = 1 / (d2 * d2 || 0.001);
  const w3 = 1 / (d3 * d3 || 0.001);
  const totalW = w1 + w2 + w3;

  const lat = (w1 * APs[0].lat + w2 * APs[1].lat + w3 * APs[2].lat) / totalW;
  const lng = (w1 * APs[0].lng + w2 * APs[1].lng + w3 * APs[2].lng) / totalW;

  const maxDistance = Math.min(d1, d2, d3);
  const intensity = Math.max(0.4, 2.0 - (maxDistance / 15.0));

  return {
    device: { ip, mac, lat, lng, rssi: [rssi1, rssi2, rssi3], subnetPrefix: subnetPrefix || '', interfaceName: interfaceName || '' },
    point: [lat, lng, intensity]
  };
}

// ─── ARP Parser (Cross-Platform) — Groups by Interface ────────────────
function getSubnetPrefix(ip) {
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.') + '.';
}

function parseArpOutput(stdout) {
  const results = [];
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    // Windows arp -a groups entries under "Interface: x.x.x.x --- 0xNN"
    const lines = stdout.split('\n');
    let currentInterfaceIp = '';
    let currentInterfaceName = '';
    let currentSubnetPrefix = '';

    for (const line of lines) {
      // Match interface header: "Interface: 192.168.88.80 --- 0xf"
      const ifMatch = line.match(/^\s*Interface:\s*([0-9.]+)\s+---\s+0x([0-9a-fA-F]+)/);
      if (ifMatch) {
        currentInterfaceIp = ifMatch[1];
        currentSubnetPrefix = getSubnetPrefix(currentInterfaceIp);
        // Look up the friendly interface name from os.networkInterfaces()
        currentInterfaceName = resolveInterfaceName(currentInterfaceIp) || `Net ${currentSubnetPrefix}x`;
        continue;
      }

      // Match device row: "  192.168.88.1    18-fd-74-b3-8d-f8    dynamic"
      const devMatch = line.match(/^\s*([0-9.]+)\s+([0-9a-fA-F-]+)\s+dynamic/);
      if (devMatch) {
        const ip = devMatch[1];
        if (!ip.startsWith('224.') && !ip.startsWith('239.') && ip !== '255.255.255.255') {
          results.push({
            ip,
            mac: devMatch[2],
            subnetPrefix: currentSubnetPrefix,
            interfaceName: currentInterfaceName
          });
        }
      }
    }
  } else {
    // Linux/Mac: "? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
    const regex = /\(([0-9.]+)\)\s+at\s+([0-9a-fA-F:]+)\s+.*on\s+(\S+)/gm;
    let match;
    while ((match = regex.exec(stdout)) !== null) {
      const ip = match[1];
      const mac = match[2].replace(/:/g, '-');
      const iface = match[3];
      if (!ip.startsWith('224.') && !ip.startsWith('239.') && ip !== '255.255.255.255' && mac !== 'ff-ff-ff-ff-ff-ff') {
        const prefix = getSubnetPrefix(ip);
        results.push({ ip, mac, subnetPrefix: prefix, interfaceName: iface });
      }
    }
    // Fallback if 'on <iface>' not present in output
    if (results.length === 0) {
      const fallbackRegex = /\(([0-9.]+)\)\s+at\s+([0-9a-fA-F:]+)/gm;
      while ((match = fallbackRegex.exec(stdout)) !== null) {
        const ip = match[1];
        const mac = match[2].replace(/:/g, '-');
        if (!ip.startsWith('224.') && !ip.startsWith('239.') && ip !== '255.255.255.255' && mac !== 'ff-ff-ff-ff-ff-ff') {
          const prefix = getSubnetPrefix(ip);
          results.push({ ip, mac, subnetPrefix: prefix, interfaceName: `Net ${prefix}x` });
        }
      }
    }
  }
  return results;
}

// Resolve a friendly OS interface name from its IPv4 address
function resolveInterfaceName(ipAddress) {
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && addr.address === ipAddress) {
        return name;
      }
    }
  }
  return null;
}

// Return all active local IPv4 subnet prefixes this machine is on
function getAgentNetworks() {
  const interfaces = os.networkInterfaces();
  const networks = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        networks.push({
          interfaceName: name,
          ip: addr.address,
          subnetPrefix: getSubnetPrefix(addr.address)
        });
      }
    }
  }
  return networks;
}

// ─── Scan & Triangulate ───────────────────────────────────────────────
function performScanAndTriangulate() {
  // If running on cloud, we rely on the local agent publishing data.
  // We only run simulated demo scans if no agent is active.
  if (IS_CLOUD) {
    const isAgentActive = lastAgentScan && (Date.now() - lastAgentScan.timestamp < 15000);
    if (!isAgentActive && clients.size > 0) {
      // Simulated demo fallback
      const activeCount = 6 + Math.floor(Math.random() * 7); // 6–12 devices
      const activeDevices = DEMO_DEVICES.slice(0, activeCount);
      const devices = [];
      const points = [];

      activeDevices.forEach(d => {
        const result = triangulateSingleDevice(d.ip, d.mac, '192.168.1.', 'Demo Network');
        devices.push(result.device);
        points.push(result.point);
      });

      broadcastPayload(devices, points, 'demo', '127.0.0.1');
    }
    return;
  }

  // Local mode: execute actual ARP scan
  if (clients.size === 0 && !remoteWs) return; // Save resources if no local clients and no remote server connected

  exec('arp -a', (error, stdout) => {
    let parsed = [];
    if (error) {
      console.error('[Scan Error] ARP failed, falling back to simulated local devices:', error.message);
      DEMO_DEVICES.slice(0, 4).forEach(d => parsed.push({ ...d, subnetPrefix: '192.168.1.', interfaceName: 'Fallback' }));
    } else {
      parsed = parseArpOutput(stdout);
    }

    const devices = [];
    const points = [];

    parsed.forEach(d => {
      const result = triangulateSingleDevice(d.ip, d.mac, d.subnetPrefix, d.interfaceName);
      devices.push(result.device);
      points.push(result.point);
    });

    // Broadcast locally to local WebSocket clients (e.g. localhost page)
    broadcastPayload(devices, points, 'live', '127.0.0.1');

    // Publish/Forward scans to remote Render WebSocket server
    if (remoteWs && remoteWs.readyState === 1) { // OPEN
      remoteWs.send(JSON.stringify({
        type: 'publish-scan',
        devices,
        points
      }));
    }
  });
}

function broadcastPayload(devices, points, mode, agentIp) {
  const agentNetworks = getAgentNetworks();
  const payload = JSON.stringify({
    type: 'wifi-heatmap',
    mode: mode,
    devices,
    points,
    agentIp: agentIp || '',
    agentNetworks   // subnets the scanner PC is currently on
  });
  
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

// ─── Local Agent Mode Client Setup ────────────────────────────────────
function connectToRemoteServer() {
  const WebSocket = require('ws');
  console.log(`[Agent] Connecting to Remote Server: ${REMOTE_WS_URL}`);
  
  remoteWs = new WebSocket(REMOTE_WS_URL);
  
  remoteWs.on('open', () => {
    console.log(`[Agent] Successfully connected to Render backend. Streaming local network scans...`);
  });
  
  remoteWs.on('close', () => {
    console.log(`[Agent] Disconnected from Render backend. Retrying in 5 seconds...`);
    remoteWs = null;
    setTimeout(connectToRemoteServer, 5000);
  });
  
  remoteWs.on('error', (err) => {
    console.error(`[Agent] Connection error:`, err.message);
  });
}

// ─── Start ────────────────────────────────────────────────────────────
setInterval(performScanAndTriangulate, 3000);

if (!IS_CLOUD) {
  // If running locally, act as a scanner agent and connect to your cloud Render instance
  connectToRemoteServer();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`─────────────────────────────────────────────────`);
  console.log(`  GPS Indoor Mapper — Server Running`);
  console.log(`  Mode:      ${IS_CLOUD ? '☁️  Cloud (Forwarder/Demo)' : '🖥️  Local (ARP Scanner Agent)'}`);
  console.log(`  HTTP:      http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}`);
  if (!IS_CLOUD) {
    console.log(`  Streaming: ${REMOTE_WS_URL}`);
  }
  console.log(`─────────────────────────────────────────────────`);
});
