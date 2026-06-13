/**
 * GPS Indoor Mapper — Unified Static + WebSocket Server
 * 
 * Single-port server that:
 *   1. Serves all static files (HTML, CSS, JS)
 *   2. Handles WebSocket upgrades for real-time device scanning
 *   3. Detects local vs cloud environment for ARP scanning or demo mode
 * 
 * Deploy to Render, Railway, Fly.io, or run locally — works everywhere.
 */

const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const IS_CLOUD = !!(process.env.RENDER || process.env.RAILWAY || process.env.FLY_APP_NAME || process.env.DYNO);

const clients = new Set();

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

// ─── Demo Devices (used on cloud where ARP is unavailable) ────────────
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
  // CORS headers
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: IS_CLOUD ? 'cloud-demo' : 'local-arp', clients: clients.size }));
    return;
  }

  // Resolve file path
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(__dirname, urlPath);

  // Security: prevent directory traversal
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

// ─── WebSocket Upgrade Handler ────────────────────────────────────────
server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(headers.join('\r\n'));
  clients.add(socket);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
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

function triangulateSingleDevice(ip, mac) {
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
    device: { ip, mac, lat, lng, rssi: [rssi1, rssi2, rssi3] },
    point: [lat, lng, intensity]
  };
}

// ─── ARP Parser (Cross-Platform) ──────────────────────────────────────
function parseArpOutput(stdout) {
  const results = [];
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    // Windows:  192.168.1.1    aa-bb-cc-dd-ee-ff    dynamic
    const regex = /^\s*([0-9.]+)\s+([0-9a-fA-F-]+)\s+dynamic/gm;
    let match;
    while ((match = regex.exec(stdout)) !== null) {
      const ip = match[1];
      if (!ip.startsWith('224.') && !ip.startsWith('239.') && ip !== '255.255.255.255') {
        results.push({ ip, mac: match[2] });
      }
    }
  } else {
    // Linux/Mac:  ? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0
    const regex = /\(([0-9.]+)\)\s+at\s+([0-9a-fA-F:]+)/gm;
    let match;
    while ((match = regex.exec(stdout)) !== null) {
      const ip = match[1];
      const mac = match[2].replace(/:/g, '-'); // normalize to Windows-style dashes
      if (!ip.startsWith('224.') && !ip.startsWith('239.') && ip !== '255.255.255.255' && mac !== 'ff-ff-ff-ff-ff-ff') {
        results.push({ ip, mac });
      }
    }
  }

  return results;
}

// ─── Scan & Triangulate ───────────────────────────────────────────────
function performScanAndTriangulate() {
  if (clients.size === 0) return;

  if (IS_CLOUD) {
    // Cloud mode: use demo devices with slight randomization
    const activeCount = 6 + Math.floor(Math.random() * 7); // 6–12 devices
    const activeDevices = DEMO_DEVICES.slice(0, activeCount);

    const devices = [];
    const points = [];

    activeDevices.forEach(d => {
      const result = triangulateSingleDevice(d.ip, d.mac);
      devices.push(result.device);
      points.push(result.point);
    });

    broadcastPayload(devices, points);
  } else {
    // Local mode: real ARP scan
    exec('arp -a', (error, stdout) => {
      if (error) {
        console.error('[Scan Error] ARP failed, falling back to demo:', error.message);
        // Fallback to demo devices
        const devices = [];
        const points = [];
        DEMO_DEVICES.slice(0, 8).forEach(d => {
          const result = triangulateSingleDevice(d.ip, d.mac);
          devices.push(result.device);
          points.push(result.point);
        });
        broadcastPayload(devices, points);
        return;
      }

      const parsed = parseArpOutput(stdout);
      const devices = [];
      const points = [];

      parsed.forEach(d => {
        const result = triangulateSingleDevice(d.ip, d.mac);
        devices.push(result.device);
        points.push(result.point);
      });

      broadcastPayload(devices, points);
    });
  }
}

function broadcastPayload(devices, points) {
  const payload = JSON.stringify({
    type: 'wifi-heatmap',
    mode: IS_CLOUD ? 'demo' : 'live',
    devices,
    points
  });
  broadcast(payload);
}

// ─── WebSocket Frame Builder & Broadcaster ────────────────────────────
function broadcast(messageText) {
  const frame = buildFrame(messageText);
  for (const client of clients) {
    if (!client.destroyed) {
      client.write(frame);
    }
  }
}

function buildFrame(messageText) {
  const dataBuffer = Buffer.from(messageText, 'utf8');
  const length = dataBuffer.length;
  let header;

  if (length <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return Buffer.concat([header, dataBuffer]);
}

// ─── Start ────────────────────────────────────────────────────────────
setInterval(performScanAndTriangulate, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`─────────────────────────────────────────────────`);
  console.log(`  GPS Indoor Mapper — Server Running`);
  console.log(`  Mode:      ${IS_CLOUD ? '☁️  Cloud (Demo Devices)' : '🖥️  Local (ARP Scan)'}`);
  console.log(`  HTTP:      http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`─────────────────────────────────────────────────`);
});
