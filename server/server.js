// ============================================================================
// QOPY CLOUD PRINTING SYSTEM v1.0
// Refactored modular version.
// Run with: node server.js
// ============================================================================

// --- AUTO DEPENDENCY INSTALLER ---
require("dotenv").config();
const { ensureDependencies } = require("./utils/autoInstall");
ensureDependencies();

// --- IMPORTS ---
const express = require("express");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");

const config = require("./config");

const apiRoutes = require("./routes/api");
const deviceRoutes = require("./routes/device");
const adminRoutes = require("./routes/admin");

// --- EXPRESS APP ---
const app = express();
app.use(
  cors({
    origin: "*", // Allow all origins for now; restrict to your Netlify domain in production
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "device-id", "authorization"],
  }),
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================================================
// ROUTES
// ============================================================================

// Public API
app.use("/api", apiRoutes);

// Device API
app.use("/api/device", deviceRoutes);

// Admin Routes (includes /admin and /api/admin/...)
app.use("/api", adminRoutes); // for /api/admin/... endpoints
app.use("/", adminRoutes); // for /admin UI

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "Qopy Cloud Printing System",
    version: "1.0",
    status: "running",
  });
});

// Serve frontend static files from `server/public` when present.
app.use(express.static(path.join(__dirname, "public")));

// Fallback to frontend index.html for non-API routes (allow API and WS to continue)
app.get(/.*/, (req, res, next) => {
  const url = req.path || "";
  if (
    url.startsWith("/api") ||
    url.startsWith("/ws") ||
    url.startsWith("/admin")
  )
    return next();
  const indexPath = path.join(__dirname, "public", "index.html");
  return res.sendFile(indexPath, (err) => {
    if (err) return next();
  });
});

// ============================================================================
// ERROR HANDLER
// ============================================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ error: "File too large. Max 50MB." });
    return res.status(400).json({ error: err.message });
  }
  if (err.message === "Only PDF files are allowed") {
    return res.status(400).json({ error: err.message });
  }
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- MONGODB ---
const connectDB = require("./config/db");

// --- DB MODELS ---
const Device = require("./models/Device");

const http = require("http");
const WebSocket = require("ws");
const { setupClientWS } = require("./ws/clientHandler");
const { setupDeviceWS } = require("./ws/deviceHandler");

// ============================================================================
// START SERVER
// ============================================================================
const startServer = async () => {
  // Wait for Database connection
  await connectDB();

  // Seed default Device if none exist
  try {
    const deviceCount = await Device.countDocuments();
    if (deviceCount === 0) {
      await Device.create({
        deviceId: "KIOSK_001",
        apiKey: "SECRET_KEY_123",
        name: "Main Kiosk",
        location: "Ground Floor",
      });
      console.log("seeded default Kiosk Device: KIOSK_001");
    }
  } catch (err) {
    console.error("Failed to seed default device:", err);
  }

  const device = await Device.findOne();

  const server = http.createServer(app);

  // Set up WebSockets
  const wssClient = new WebSocket.Server({ noServer: true });
  const wssDevice = new WebSocket.Server({ noServer: true });

  setupClientWS(wssClient);
  setupDeviceWS(wssDevice);

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`)
      .pathname;

    if (pathname === "/ws/client") {
      wssClient.handleUpgrade(request, socket, head, (ws) => {
        wssClient.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/device") {
      wssDevice.handleUpgrade(request, socket, head, (ws) => {
        wssDevice.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(config.PORT, () => {
    console.log("");
    console.log(
      "  ================================================================",
    );
    console.log("  QOPY Cloud Printing System v1.0 (Modular + WS)");
    console.log(
      "  ================================================================",
    );
    console.log("");
    console.log("  Main Site:  http://localhost:" + config.PORT);
    console.log("  Admin:      http://localhost:" + config.PORT + "/admin");
    console.log("");
    console.log(
      "  Device API: http://localhost:" + config.PORT + "/api/device/jobs",
    );
    console.log("  Device WS:  ws://localhost:" + config.PORT + "/ws/device");
    console.log("  Client WS:  ws://localhost:" + config.PORT + "/ws/client");
    console.log("");
    console.log(`  Device ID:  ${device ? device.deviceId : "NONE"}`);
    console.log(`  API Key:    ${device ? device.apiKey : "NONE"}`);
    console.log("");
    console.log(
      "  ================================================================",
    );
    console.log("  Status: RUNNING");
    console.log(
      "  ================================================================",
    );
    console.log("");
  });
};

startServer();
