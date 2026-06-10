/**
 * GPS Indoor Mapper - DensePose WebSocket Mock Bridge Server
 * Zero-dependency Node.js implementation
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 8080;
const clients = new Set();

// Create HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DensePose WebSocket Bridge Server is running!\nConnect your web client to ws://localhost:' + PORT);
});

// Handle upgrade request to initiate WebSocket protocol handshake
server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') {
    socket.destroy();
    return;
  }

  // Generate SHA-1 Sec-WebSocket-Accept response header value
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

  // Listen for raw TCP packets (incoming data from client)
  socket.on('data', (buffer) => {
    try {
      const data = parseFrame(buffer);
      if (data && data.op === 1) { // Text frame
        const msg = JSON.parse(data.payload);
        console.log('[WebSocket] Received message from client:', msg.type);
        
        // If the message is a heatmap coordinates packet from a Python DensePose bridge,
        // broadcast it to all other connected clients (like the web app UI)
        if (msg.type === 'heatmap' || msg.type === 'occupancy') {
          broadcast(JSON.stringify(msg), socket);
        }
      }
    } catch (err) {
      // Ignore framing or parse errors
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[WebSocket] Client disconnected. Active clients: ${clients.size}`);
  });

  socket.on('error', (err) => {
    clients.delete(socket);
    console.log('[WebSocket] Connection error:', err.message);
  });
});

// Helper: Broadcast data to all active clients
function broadcast(messageText, excludeSocket = null) {
  const frame = buildFrame(messageText);
  for (const client of clients) {
    if (client !== excludeSocket && !client.destroyed) {
      client.write(frame);
    }
  }
}

// Helper: Parse WebSocket data frame
function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  
  const isFinal = (firstByte & 0x80) !== 0;
  const op = firstByte & 0x0F;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7F;
  let offset = 2;

  if (op === 8) { // Close connection
    return null;
  }

  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    // Simple 32-bit approximation for length
    payloadLength = buffer.readUInt32BE(6);
    offset = 10;
  }

  let maskingKey;
  if (isMasked) {
    if (buffer.length < offset + 4) return null;
    maskingKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return null;
  const rawPayload = buffer.slice(offset, offset + payloadLength);
  
  let payload;
  if (isMasked) {
    payload = Buffer.alloc(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = rawPayload[i] ^ maskingKey[i % 4];
    }
  } else {
    payload = rawPayload;
  }

  return {
    op,
    payload: payload.toString('utf8')
  };
}

// Helper: Build WebSocket data frame to send text
function buildFrame(messageText) {
  const dataBuffer = Buffer.from(messageText, 'utf8');
  const length = dataBuffer.length;
  let header;

  if (length <= 125) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + Text Frame op-code
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
    // Write high-order 32 bits as 0, lower 32 bits as length
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return Buffer.concat([header, dataBuffer]);
}

// Start Mock Data Stream generator (runs continuously to simulate real-time tracking)
const baseLat = 37.4220;
const baseLng = -122.0841;
const agentsCount = 20;

// Initialize mock agents
const agents = Array.from({ length: agentsCount }, (_, i) => ({
  id: i,
  lat: baseLat + (Math.random() - 0.5) * 0.0006,
  lng: baseLng + (Math.random() - 0.5) * 0.0006,
  speedLat: (Math.random() - 0.5) * 0.00003,
  speedLng: (Math.random() - 0.5) * 0.00003
}));

setInterval(() => {
  if (clients.size === 0) return;

  // Move agents slightly inside a simulated boundary
  const points = agents.map(agent => {
    agent.lat += agent.speedLat;
    agent.lng += agent.speedLng;

    // Bounce agents off simulated perimeter walls
    if (Math.abs(agent.lat - baseLat) > 0.0005) {
      agent.speedLat = -agent.speedLat;
    }
    if (Math.abs(agent.lng - baseLng) > 0.0005) {
      agent.speedLng = -agent.speedLng;
    }

    // Add some random jitter
    agent.lat += (Math.random() - 0.5) * 0.000005;
    agent.lng += (Math.random() - 0.5) * 0.000005;

    // Output: [lat, lng, weight/intensity]
    return [agent.lat, agent.lng, 1.2 + Math.random() * 0.5];
  });

  const payload = JSON.stringify({
    type: 'heatmap',
    points: points
  });

  broadcast(payload);
}, 600); // Send updates every 600ms

server.listen(PORT, () => {
  console.log(`[DensePose Server] Zero-dependency server listening on http://localhost:${PORT}`);
  console.log(`[DensePose Server] WebSocket Endpoint: ws://localhost:${PORT}`);
  console.log('[DensePose Server] Keep this terminal open to test Live Camera (DensePose) mode.');
});
