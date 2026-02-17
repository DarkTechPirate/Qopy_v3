// ============================================================================
// QOPY CLOUD PRINTING SYSTEM v2.0
// Express + MongoDB + WebSocket (ws)
// Run with: node app.js
// ============================================================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { WebSocketServer } = require('ws');

const connectDB = require('./config/db');
const Device = require('./models/Device');
const PrintJob = require('./models/PrintJob');

// Route imports
const uploadRoutes = require('./routes/upload');
const jobRoutes = require('./routes/job');
const paymentRoutes = require('./routes/payment');
const deviceRoutes = require('./routes/device');
const adminRoutes = require('./routes/admin');

// WS handler imports
const { setupDeviceWS, sendJobToDevice } = require('./ws/deviceHandler');
const { setupClientWS, notifyJobUpdate } = require('./ws/clientHandler');

// Wire up WS handlers into payment route
const { setWSHandlers } = paymentRoutes;
setWSHandlers(sendJobToDevice, notifyJobUpdate);

const PORT = process.env.PORT || 5000;

// --- EXPRESS APP ---
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'device-id', 'authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- ROUTES ---
app.use('/api', uploadRoutes);
app.use('/api', jobRoutes);
app.use('/api', paymentRoutes);
app.use('/api', deviceRoutes);
app.use('/', adminRoutes);

// Root health check
app.get('/', (req, res) => {
  res.json({ service: 'Qopy Cloud Printing System', version: '2.0', status: 'running' });
});

// --- ERROR HANDLER ---
const multer = require('multer');
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 50MB.' });
    return res.status(400).json({ error: err.message });
  }
  if (err.message === 'Only PDF files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- HTTP SERVER ---
const server = http.createServer(app);

// --- WEBSOCKET SERVERS (noServer mode) ---
const deviceWSS = new WebSocketServer({ noServer: true });
const clientWSS = new WebSocketServer({ noServer: true });

// Route upgrade requests by URL path
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/ws/device') {
    deviceWSS.handleUpgrade(request, socket, head, (ws) => {
      deviceWSS.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/client') {
    clientWSS.handleUpgrade(request, socket, head, (ws) => {
      clientWSS.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Initialize WS handlers
setupDeviceWS(deviceWSS);
setupClientWS(clientWSS);

// --- STARTUP ---
async function start() {
  // Connect to MongoDB
  await connectDB();

  // Seed default device if it doesn't exist
  const existing = await Device.findOne({ deviceId: 'KIOSK_001' });
  if (!existing) {
    await Device.create({
      deviceId: 'KIOSK_001',
      apiKey: 'SECRET_KEY_123',
      name: 'Main Kiosk',
      location: 'Ground Floor',
    });
    console.log('  Seeded default device: KIOSK_001');
  }

  // Mark all devices as offline on startup (clean state)
  await Device.updateMany({}, { isOnline: false });

  // Job timeout checker: every 10 seconds
  // If job stuck in ASSIGNED for 60s, revert to PAID
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 60000);
      const timedOut = await PrintJob.find({
        status: 'ASSIGNED',
        assignedAt: { $lt: cutoff },
      });

      for (const job of timedOut) {
        job.status = 'PAID';
        job.assignedAt = null;
        job.statusMessage = 'Timed out, re-queued';
        await job.save();

        notifyJobUpdate(job.jobId, {
          status: 'PAID',
          message: 'Re-queued: printer did not respond in time',
        });

        console.log(`  Job ${job.jobId.slice(0, 8)} timed out, reverted to PAID`);
      }
    } catch (err) {
      console.error('  Timeout checker error:', err.message);
    }
  }, 10000);

  // Start server
  server.listen(PORT, () => {
    console.log('');
    console.log('  ================================================================');
    console.log('  QOPY Cloud Printing System v2.0');
    console.log('  ================================================================');
    console.log('');
    console.log('  HTTP API:     http://localhost:' + PORT);
    console.log('  Admin:        http://localhost:' + PORT + '/admin');
    console.log('  WS Device:    ws://localhost:' + PORT + '/ws/device');
    console.log('  WS Client:    ws://localhost:' + PORT + '/ws/client');
    console.log('');
    console.log('  MongoDB:      Connected');
    console.log('  Device:       KIOSK_001');
    console.log('');
    console.log('  ================================================================');
    console.log('  Status: RUNNING');
    console.log('  ================================================================');
    console.log('');
  });
}

start().catch(err => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
