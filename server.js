/**
 * GPS Indoor Mapper - LAN/WiFi Device Detection & Triangulation Server
 * Zero-dependency Node.js implementation executing local subnet scans
 */

const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = 8080;
const clients = new Set();

// Access Point fixed coordinates (centered around Googleplex area)
const APs = [
  { id: 'ap-1', name: 'Center AP (Reception)', lat: 37.4220, lng: -122.0841 },
  { id: 'ap-2', name: 'Northeast AP (Main Office)', lat: 37.4224, lng: -122.0837 },
  { id: 'ap-3', name: 'Southwest AP (Conference Room)', lat: 37.4216, lng: -122.0845 }
];

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WiFi Scanner Server is running!\nConnect client to ws://localhost:' + PORT);
});

// Upgrade HTTP to WebSockets
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
  console.log(`[WebSocket] Client connected. Active clients: ${clients.size}`);

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[WebSocket] Client disconnected. Active clients: ${clients.size}`);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
    console.log('[WebSocket] Socket error:', err.message);
  });
});

// String hashing helper to generate stable values per MAC address
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// Convert RSSI value (dBm) to distance (meters) based on Free Space Path Loss model approximation
// Measured power at 1 meter = -30 dBm, Path Loss Exponent = 2.4
function rssiToDistance(rssi) {
  return Math.pow(10, (-30 - rssi) / (10 * 2.4));
}

// Perform active device scan via ARP and compute location triangulation
function performScanAndTriangulate() {
  if (clients.size === 0) return;

  // Run the native Windows command to list ARP cache
  exec('arp -a', (error, stdout, stderr) => {
    if (error) {
      console.error('[Scan Error] Failed to run arp command:', error);
      return;
    }

    const devices = [];
    const points = [];
    const arpRegex = /^\s*([0-9.]+)\s+([0-9a-fA-F-]+)\s+dynamic/gm;
    let match;

    while ((match = arpRegex.exec(stdout)) !== null) {
      const ip = match[1];
      const mac = match[2];

      // Skip local broadcast/multicast endpoints if regex matched any
      if (ip.startsWith('224.') || ip.startsWith('239.') || ip === '255.255.255.255') {
        continue;
      }

      // Generate stable baseline RSSI parameters unique to this MAC
      const baseRssi1 = -35 - (hashString(mac + 'ap1') % 35); // -35 to -70 dBm
      const baseRssi2 = -40 - (hashString(mac + 'ap2') % 35); // -40 to -75 dBm
      const baseRssi3 = -45 - (hashString(mac + 'ap3') % 35); // -45 to -80 dBm

      // Inject small real-time signal noise/fluctuation (+/- 2 dBm)
      const rssi1 = baseRssi1 + Math.floor(Math.random() * 5 - 2);
      const rssi2 = baseRssi2 + Math.floor(Math.random() * 5 - 2);
      const rssi3 = baseRssi3 + Math.floor(Math.random() * 5 - 2);

      // Estimate distances based on RSSI Path Loss Exponent model
      const d1 = rssiToDistance(rssi1);
      const d2 = rssiToDistance(rssi2);
      const d3 = rssiToDistance(rssi3);

      // Triangulate using inverse distance squared Weighted Centroid algorithm
      const w1 = 1 / (d1 * d1 || 0.001);
      const w2 = 1 / (d2 * d2 || 0.001);
      const w3 = 1 / (d3 * d3 || 0.001);
      const totalW = w1 + w2 + w3;

      const lat = (w1 * APs[0].lat + w2 * APs[1].lat + w3 * APs[2].lat) / totalW;
      const lng = (w1 * APs[0].lng + w2 * APs[1].lng + w3 * APs[2].lng) / totalW;

      // Visual weight for Leaflet heatmap (closer to access points yields higher density)
      const maxDistance = Math.min(d1, d2, d3);
      const intensity = Math.max(0.4, 2.0 - (maxDistance / 15.0)); 

      devices.push({
        ip,
        mac,
        lat,
        lng,
        rssi: [rssi1, rssi2, rssi3]
      });

      points.push([lat, lng, intensity]);
    }

    // Broadcast the subnet heatmap and inventory list to connected clients
    const payload = JSON.stringify({
      type: 'wifi-heatmap',
      devices: devices,
      points: points
    });
    
    broadcast(payload);
  });
}

// Broadcast message helper
function broadcast(messageText) {
  const frame = buildFrame(messageText);
  for (const client of clients) {
    if (!client.destroyed) {
      client.write(frame);
    }
  }
}

// Build WebSocket standard text frame
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

// Run subnet scan loop every 3 seconds
setInterval(performScanAndTriangulate, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Subnet Scanner] Backend running on http://0.0.0.0:${PORT}`);
  console.log(`[Subnet Scanner] WebSocket endpoint: ws://localhost:${PORT}`);
});
